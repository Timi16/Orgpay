import type { Company, Session } from "@prisma/client";
import type { Company as CompanyDto, Session as SessionDto, UpdateSettingsBody } from "@orgpay/shared";
import argon2 from "argon2";
import { randomInt, timingSafeEqual } from "node:crypto";
import { uniqueViolation } from "../../db/prisma";
import type { AppDeps } from "../../deps";
import { AppError } from "../../lib/errors";
import { generateSessionToken, hashSessionToken } from "../../lib/ids";
import { cancelRun } from "../payroll/service";
import { lockRun } from "../payroll/transitions";
import * as repo from "./repo";
import { ACCOUNT_RULE, accountKey, LoginThrottle, PAIR_RULE, pairKey, passwordChangeKey } from "./throttle";

export const SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1000;
/** "Keep me logged in" unticked: the cookie dies with the browser, and the session within a day. */
export const SHORT_SESSION_TTL_MS = 24 * 60 * 60 * 1000;
export const DEVICE_TTL_MS = 180 * 24 * 60 * 60 * 1000;
const RESET_TTL_MS = 60 * 60 * 1000;
const CODE_TTL_MS = 15 * 60 * 1000;
const CODE_COOLDOWN_MS = 60 * 1000;
const CODE_MAX_ATTEMPTS = 5;
const RESET_COOLDOWN_MS = 60 * 1000;
const MAX_DEVICES = 20;
const ARGON_OPTIONS = { type: argon2.argon2id } as const;

export interface ClientInfo {
  ip: string | null;
  userAgent: string | null;
}

export function serializeCompany(m: Company): CompanyDto {
  return {
    id: m.id,
    email: m.email,
    emailVerified: m.emailVerifiedAt !== null,
    businessName: m.businessName,
    notifyPaid: m.notifyPaid,
    notifyProblems: m.notifyProblems,
    createdAt: m.createdAt.toISOString(),
  };
}

export function serializeSession(s: Session, currentId: string): SessionDto {
  return {
    id: s.id,
    current: s.id === currentId,
    createdAt: s.createdAt.toISOString(),
    lastSeenAt: s.lastSeenAt.toISOString(),
    expiresAt: s.expiresAt.toISOString(),
    ip: s.ip,
    userAgent: s.userAgent,
  };
}

export function createAuthService(deps: AppDeps) {
  const { prisma } = deps;
  const throttle = new LoginThrottle(prisma);
  // Verified against when the email is unknown, so both failure paths cost the same time.
  const dummyHash = argon2.hash("orgpay-dummy-password", ARGON_OPTIONS);

  async function startSession(companyId: string, client: ClientInfo, ttlMs = SESSION_TTL_MS): Promise<string> {
    const token = generateSessionToken();
    await repo.createSession(prisma, companyId, {
      id: hashSessionToken(token),
      expiresAt: new Date(Date.now() + ttlMs),
      ip: client.ip,
      userAgent: client.userAgent?.slice(0, 256) ?? null,
    });
    return token;
  }

  async function isTrustedDevice(deviceToken: string, email: string): Promise<boolean> {
    if (deviceToken.length > 128) return false;
    const device = await prisma.trustedDevice.findUnique({
      where: { id: hashSessionToken(deviceToken) },
      select: { company: { select: { email: true } } },
    });
    return device?.company.email === email;
  }

  /** Marks this browser as one that has logged in to the account; returns its cookie token. */
  async function trustDevice(companyId: string, existingToken: string | null): Promise<string> {
    if (existingToken) {
      await prisma.trustedDevice.updateMany({
        where: { id: hashSessionToken(existingToken), companyId },
        data: { lastUsedAt: new Date() },
      });
      return existingToken;
    }
    const token = generateSessionToken();
    await prisma.trustedDevice.create({ data: { id: hashSessionToken(token), companyId } });
    const stale = await prisma.trustedDevice.findMany({
      where: { companyId },
      orderBy: { lastUsedAt: "desc" },
      skip: MAX_DEVICES,
      select: { id: true },
    });
    if (stale.length > 0) {
      await prisma.trustedDevice.deleteMany({ where: { id: { in: stale.map((d) => d.id) } } });
    }
    return token;
  }

  const hashCode = (companyId: string, code: string) => hashSessionToken(`email-code:${companyId}:${code}`);

  /** Makes a new six-digit code (replacing any earlier one) and emails it. */
  async function sendCode(company: Company): Promise<void> {
    if (!deps.mailer) throw new AppError("SERVICE_UNAVAILABLE", "Email isn't set up on this server yet");
    const code = randomInt(0, 1_000_000).toString().padStart(6, "0");
    const data = { codeHash: hashCode(company.id, code), expiresAt: new Date(Date.now() + CODE_TTL_MS), attempts: 0, sentAt: new Date() };
    await prisma.emailVerification.upsert({ where: { companyId: company.id }, create: { companyId: company.id, ...data }, update: data });
    await deps.mailer.send({
      to: company.email,
      subject: `${code} is your OrgPay code`,
      text: [
        `Hi ${company.businessName},`,
        "",
        `Your OrgPay confirmation code is: ${code}`,
        "",
        "It works for 15 minutes. If you didn't create a OrgPay account, ignore this email.",
      ].join("\n"),
    });
  }

  return {
    async updateSettings(companyId: string, input: UpdateSettingsBody): Promise<Company> {
      return prisma.company.update({ where: { id: companyId }, data: input });
    },

    /**
     * Closes the account after re-checking the password. Drafts are cancelled and payments not
     * yet sent are cancelled; refused while a batch is waiting for a signature or for Stellar.
     * Sessions and API keys are revoked. Wallets and their funds were never OrgPay's, so
     * nothing on-chain changes. The email becomes free to use again.
     */
    async closeAccount(companyId: string, password: string): Promise<void> {
      const company = await repo.findCompany(prisma, companyId);
      if (!company) throw new AppError("UNAUTHENTICATED", "Authentication required");
      const key = passwordChangeKey(companyId);
      await throttle.assertAllowed([key]);
      const ok = await argon2.verify(company.passwordHash, password).catch(() => false);
      if (!ok) {
        await throttle.recordFailure(key, PAIR_RULE);
        throw new AppError("INVALID_CREDENTIALS", "Password is incorrect");
      }
      await throttle.clear([key]);
      await prisma.$transaction(
        async (tx) => {
          // Every run that could still pay someone. Each is re-read under its lock, so a retry
          // that slipped in after this list is still seen.
          const open = await tx.payrollRun.findMany({
            where: { companyId, status: { in: ["DRAFT", "PROCESSING", "PARTIALLY_PAID", "FAILED"] } },
            select: { id: true },
            orderBy: { id: "asc" },
          });
          for (const { id } of open) {
            const run = await lockRun(tx, companyId, id);
            if (!run || run.status === "COMPLETED" || run.status === "CANCELLED") continue;
            await cancelRun(tx, run, "company").catch((err: unknown) => {
              if (err instanceof AppError && err.code === "RUN_LOCKED") {
                throw new AppError("RUN_LOCKED", `Payroll #${run.number} has a transaction waiting for a signature or for Stellar. Let it finish, then close the account.`);
              }
              throw err;
            });
          }
          const now = new Date();
          await tx.session.deleteMany({ where: { companyId } });
          await tx.trustedDevice.deleteMany({ where: { companyId } });
          await tx.apiKey.updateMany({ where: { companyId, revokedAt: null }, data: { revokedAt: now } });
          await tx.wallet.updateMany({ where: { companyId, deletedAt: null }, data: { deletedAt: now } });
          await tx.passwordReset.deleteMany({ where: { companyId } });
          await tx.emailVerification.deleteMany({ where: { companyId } });
          await tx.company.update({
            where: { id: companyId },
            // The hash is replaced with a value argon2 can never match: nobody can sign in again.
            data: { closedAt: now, email: `closed-${companyId}@closed.invalid`, passwordHash: "closed", notifyPaid: false, notifyProblems: false },
          });
        },
        { timeout: 60_000 },
      );
    },

    listSessions(companyId: string): Promise<Session[]> {
      return prisma.session.findMany({
        where: { companyId, expiresAt: { gt: new Date() } },
        orderBy: { createdAt: "desc" },
        take: 50,
      });
    },

    /** Signs one of the company's other sessions out. Returns false if it is not theirs. */
    async revokeSession(companyId: string, sessionId: string): Promise<boolean> {
      const deleted = await prisma.session.deleteMany({ where: { id: sessionId, companyId } });
      return deleted.count > 0;
    },

    async revokeOtherSessions(companyId: string, keepSessionId: string): Promise<void> {
      await repo.deleteOtherSessions(prisma, companyId, keepSessionId);
    },

    /**
     * Emails a one-hour reset link. Always succeeds from the caller's point of view, whether
     * or not the email has an account, so it cannot be used to find out who is a customer.
     */
    async forgotPassword(email: string, webOrigin: string): Promise<void> {
      if (!deps.mailer) {
        throw new AppError("SERVICE_UNAVAILABLE", "Password reset by email isn't set up on this server yet");
      }
      const company = await repo.findCompanyByEmail(prisma, email);
      if (!company || company.closedAt) return;
      const latest = await prisma.passwordReset.findFirst({
        where: { companyId: company.id },
        orderBy: { createdAt: "desc" },
      });
      // One email a minute per account, however many times the form is submitted.
      if (latest && Date.now() - latest.createdAt.getTime() < RESET_COOLDOWN_MS) return;
      const token = generateSessionToken();
      await prisma.passwordReset.create({
        data: { id: hashSessionToken(token), companyId: company.id, expiresAt: new Date(Date.now() + RESET_TTL_MS) },
      });
      const link = `${webOrigin}/reset-password?token=${token}`;
      // Not awaited: waiting for the mail server only when the account exists would let response
      // times reveal who has an account.
      void deps.mailer
        .send({
          to: company.email,
          subject: "Reset your OrgPay password",
          text: [
            `Hi ${company.businessName},`,
            "",
            "Use this link to choose a new OrgPay password. It works once, for one hour:",
            link,
            "",
            "If you didn't ask for this, ignore this email. Your password stays the same.",
          ].join("\n"),
        })
        .catch((err: unknown) => deps.logger.error({ err }, "password reset email failed to send"));
    },

    /** Sets a new password from an emailed link and signs the company out everywhere. */
    async resetPassword(token: string, newPassword: string): Promise<void> {
      const id = hashSessionToken(token);
      const passwordHash = await argon2.hash(newPassword, ARGON_OPTIONS);
      await prisma.$transaction(async (tx) => {
        // Single use, enforced atomically.
        const used = await tx.passwordReset.updateMany({
          where: { id, usedAt: null, expiresAt: { gt: new Date() } },
          data: { usedAt: new Date() },
        });
        if (used.count === 0) {
          throw new AppError("CHALLENGE_EXPIRED", "This reset link has expired or was already used. Ask for a new one.");
        }
        const reset = await tx.passwordReset.findUniqueOrThrow({ where: { id }, include: { company: { select: { closedAt: true } } } });
        if (reset.company.closedAt) {
          throw new AppError("CHALLENGE_EXPIRED", "This reset link has expired or was already used. Ask for a new one.");
        }
        const company = await tx.company.update({ where: { id: reset.companyId }, data: { passwordHash } });
        await tx.session.deleteMany({ where: { companyId: reset.companyId } });
        await tx.passwordReset.deleteMany({ where: { companyId: reset.companyId, id: { not: id } } });
        await tx.loginThrottle.deleteMany({ where: { key: accountKey(company.email) } });
      });
    },

    async signup(
      input: { email: string; password: string; businessName: string },
      client: ClientInfo,
    ): Promise<{ company: Company; token: string; deviceToken: string }> {
      const passwordHash = await argon2.hash(input.password, ARGON_OPTIONS);
      let company: Company;
      try {
        company = await prisma.company.create({
          data: {
            email: input.email,
            passwordHash,
            businessName: input.businessName,
            // Without a mail server there is no way to deliver a code, so nothing to confirm.
            emailVerifiedAt: deps.verifyEmail ? null : new Date(),
          },
        });
      } catch (err) {
        if (uniqueViolation(err)) {
          throw new AppError("EMAIL_TAKEN", "An account with this email already exists");
        }
        throw err;
      }
      // The account exists even if this email fails to go out; the code can be sent again.
      if (deps.verifyEmail) await sendCode(company).catch((err: unknown) => deps.logger.error({ err }, "sign-up code email failed"));
      return {
        company,
        token: await startSession(company.id, client),
        deviceToken: await trustDevice(company.id, null),
      };
    },

    /** Sends a fresh code, at most once a minute. A confirmed account gets nothing. */
    async resendEmailCode(companyId: string): Promise<void> {
      const company = await repo.findCompany(prisma, companyId);
      if (!company) throw new AppError("UNAUTHENTICATED", "Authentication required");
      if (company.emailVerifiedAt) return;
      const current = await prisma.emailVerification.findUnique({ where: { companyId } });
      const wait = current ? CODE_COOLDOWN_MS - (Date.now() - current.sentAt.getTime()) : 0;
      if (wait > 0) {
        throw new AppError("RATE_LIMITED", "A code was just sent. Give it a minute before asking again.", { retryAfter: Math.ceil(wait / 1000) });
      }
      await sendCode(company);
    },

    /**
     * Confirms the email with the six-digit code. A code lasts 15 minutes and allows five
     * wrong guesses; after that a new one must be sent, so the code cannot be brute-forced.
     */
    async verifyEmail(companyId: string, code: string): Promise<Company> {
      const company = await repo.findCompany(prisma, companyId);
      if (!company) throw new AppError("UNAUTHENTICATED", "Authentication required");
      if (company.emailVerifiedAt) return company;
      const expired = () => new AppError("CHALLENGE_EXPIRED", "This code has expired. Send a new one.");
      // Count the attempt first, atomically, so parallel guesses cannot exceed the limit.
      const counted = await prisma.emailVerification.updateMany({
        where: { companyId, expiresAt: { gt: new Date() }, attempts: { lt: CODE_MAX_ATTEMPTS } },
        data: { attempts: { increment: 1 } },
      });
      if (counted.count === 0) throw expired();
      const row = await prisma.emailVerification.findUnique({ where: { companyId } });
      if (!row) throw expired();
      const given = Buffer.from(hashCode(companyId, code), "hex");
      const wanted = Buffer.from(row.codeHash, "hex");
      if (given.length !== wanted.length || !timingSafeEqual(given, wanted)) {
        const left = CODE_MAX_ATTEMPTS - row.attempts;
        throw new AppError("INVALID_CODE", left > 0 ? `That code isn't right. ${left} ${left === 1 ? "try" : "tries"} left.` : "That code isn't right. Send a new one.");
      }
      const [updated] = await prisma.$transaction([
        prisma.company.update({ where: { id: companyId }, data: { emailVerifiedAt: new Date() } }),
        prisma.emailVerification.deleteMany({ where: { companyId } }),
      ]);
      return updated;
    },

    /**
     * `oldToken` is the session cookie presented with the login, if any: it is rotated away.
     * `deviceToken` is the trusted-device cookie, if any.
     */
    async login(
      input: { email: string; password: string },
      client: ClientInfo,
      oldToken: string | null,
      deviceToken: string | null,
      remember = true,
    ): Promise<{ company: Company; token: string; deviceToken: string }> {
      const pair = pairKey(input.email, client.ip);
      const account = accountKey(input.email);
      // A browser that has logged in to this account before is not subject to the
      // account-wide lock (only to its own), so failed attempts by others cannot lock it out.
      const trusted = deviceToken ? await isTrustedDevice(deviceToken, input.email) : false;
      await throttle.assertAllowed(trusted ? [pair] : [pair, account]);

      const found = await repo.findCompanyByEmail(prisma, input.email);
      const company = found && !found.closedAt ? found : null;
      const hash = company?.passwordHash ?? (await dummyHash);
      const ok = await argon2.verify(hash, input.password).catch(() => false);
      if (!company || !ok) {
        await throttle.recordFailure(pair, PAIR_RULE);
        await throttle.recordFailure(account, ACCOUNT_RULE);
        // Same error whether the email or the password was wrong.
        throw new AppError("INVALID_CREDENTIALS", "Incorrect email or password");
      }
      await throttle.clear([pair, account]);
      if (oldToken) await repo.deleteSession(prisma, hashSessionToken(oldToken));
      await repo.deleteExpiredSessions(prisma, company.id);
      return {
        company,
        token: await startSession(company.id, client, remember ? SESSION_TTL_MS : SHORT_SESSION_TTL_MS),
        deviceToken: await trustDevice(company.id, trusted ? deviceToken : null),
      };
    },

    async logout(sessionId: string): Promise<void> {
      await repo.deleteSession(prisma, sessionId);
    },

    async me(companyId: string): Promise<Company> {
      const company = await repo.findCompany(prisma, companyId);
      if (!company) throw new AppError("UNAUTHENTICATED", "Authentication required");
      return company;
    },

    async changePassword(
      companyId: string,
      sessionId: string,
      input: { currentPassword: string; newPassword: string },
    ): Promise<void> {
      const company = await repo.findCompany(prisma, companyId);
      if (!company) throw new AppError("UNAUTHENTICATED", "Authentication required");
      // Keyed by the signed-in company: only they can trip it, and it cannot block logins.
      const key = passwordChangeKey(companyId);
      await throttle.assertAllowed([key]);
      const ok = await argon2.verify(company.passwordHash, input.currentPassword).catch(() => false);
      if (!ok) {
        await throttle.recordFailure(key, PAIR_RULE);
        throw new AppError("INVALID_CREDENTIALS", "Current password is incorrect");
      }
      await throttle.clear([key]);
      const passwordHash = await argon2.hash(input.newPassword, ARGON_OPTIONS);
      await prisma.$transaction([
        prisma.company.update({ where: { id: companyId }, data: { passwordHash } }),
        prisma.session.deleteMany({ where: { companyId, id: { not: sessionId } } }),
      ]);
    },
  };
}

export type AuthService = ReturnType<typeof createAuthService>;
