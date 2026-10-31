import type { Wallet } from "@prisma/client";
import type { Wallet as WalletDto } from "@orgpay/shared";
import { StrKey } from "@stellar/stellar-sdk";
import type { AppDeps } from "../../deps";
import { usdc } from "../../lib/asset";
import { AppError, notFound } from "../../lib/errors";
import { randomNonce } from "../../lib/ids";
import { findTrustline } from "../../stellar/checks";
import * as repo from "./repo";
import { parseTrustlines } from "./trustlines";
import { verifyWalletSignature, type SignatureInput } from "./signature";

const CHALLENGE_TTL_MS = 10 * 60_000;

export function serializeWallet(w: Wallet): WalletDto {
  const line = w.accountExists ? findTrustline(parseTrustlines(w.trustlines), usdc()) : undefined;
  return {
    id: w.id,
    address: w.address,
    label: w.label,
    verified: w.verifiedAt !== null,
    verifiedAt: w.verifiedAt?.toISOString() ?? null,
    accountExists: w.accountExists,
    usdcBalance: line?.balance ?? null,
    xlmBalance: w.accountExists ? w.nativeBalance : null,
    hasUsdcTrustline: line !== undefined,
    checkedAt: w.checkedAt?.toISOString() ?? null,
    createdAt: w.createdAt.toISOString(),
  };
}

/** Rejects anything that is not a plain G address. A pasted secret is never echoed or stored. */
export function assertWalletAddress(address: string): void {
  if (/^S[A-Z2-7]{55}$/.test(address) || StrKey.isValidEd25519SecretSeed(address)) {
    throw new AppError(
      "SECRET_KEY_REJECTED",
      "That is a secret key (S…). Never share it. Paste the wallet's public address (G…) instead.",
    );
  }
  if (StrKey.isValidMed25519PublicKey(address)) {
    throw new AppError("VALIDATION_FAILED", "Muxed (M…) addresses are not supported; use the base G… address", {
      details: [{ path: "address", message: "Muxed addresses are not supported" }],
    });
  }
  if (!StrKey.isValidEd25519PublicKey(address)) {
    throw new AppError("VALIDATION_FAILED", "Not a valid Stellar public address (G…)", {
      details: [{ path: "address", message: "Invalid Stellar address" }],
    });
  }
}

export function createWalletService(deps: AppDeps) {
  const { prisma, stellar } = deps;
  const inFlight = new Map<string, Promise<Wallet>>();

  /** Reads the account from Horizon and caches existence, balances and trustlines on the wallet. */
  function refresh(wallet: Wallet): Promise<Wallet> {
    const running = inFlight.get(wallet.id);
    if (running) return running; // one Horizon call per wallet at a time
    const task = (async () => {
      const state = await stellar.loadAccount(wallet.address);
      const updated = await repo.updateWallet(prisma, wallet.companyId, wallet.id, {
        accountExists: state.exists,
        trustlines: state.exists ? state.trustlines : [],
        nativeBalance: state.exists ? state.nativeBalance : null,
        checkedAt: new Date(),
      });
      return updated ?? wallet;
    })().finally(() => inFlight.delete(wallet.id));
    inFlight.set(wallet.id, task);
    return task;
  }

  async function getOwned(companyId: string, id: string): Promise<Wallet> {
    const wallet = await repo.findWallet(prisma, companyId, id);
    if (!wallet) throw notFound("Wallet");
    return wallet;
  }

  return {
    getOwned,

    async list(companyId: string): Promise<Wallet[]> {
      return repo.listWallets(prisma, companyId);
    },

    /**
     * Adds a funding wallet. A wallet is the company's own business: adding someone else's
     * address gains nothing, because every payment still needs that account's signature.
     * Re-adding a removed address restores its row (and its ownership proof).
     */
    async add(companyId: string, input: { address: string; label?: string }): Promise<Wallet> {
      assertWalletAddress(input.address);
      const label = input.label ?? null;
      let wallet = await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`${companyId}:${input.address}`}))`;
        const rows = await repo.findCompanyWalletsByAddress(tx, companyId, input.address);
        if (rows.some((r) => r.deletedAt === null)) {
          throw new AppError("WALLET_TAKEN", "This wallet is already added");
        }
        const removed = rows[0];
        if (removed) {
          const restored = await repo.updateWallet(tx, companyId, removed.id, { deletedAt: null, label: label ?? removed.label });
          return restored ?? removed;
        }
        return repo.createWallet(tx, companyId, { address: input.address, label });
      });
      // Best effort: the wallet is still added if Horizon is unreachable right now.
      wallet = await refresh(wallet).catch(() => wallet);
      return wallet;
    },

    async refresh(companyId: string, id: string): Promise<Wallet> {
      return refresh(await getOwned(companyId, id));
    },

    async createChallenge(companyId: string, id: string) {
      const wallet = await getOwned(companyId, id);
      const expiresAt = new Date(Date.now() + CHALLENGE_TTL_MS);
      const message = [
        "OrgPay wallet verification",
        `Company: ${companyId}`,
        `Wallet: ${wallet.address}`,
        `Nonce: ${randomNonce()}`,
        `Expires: ${expiresAt.toISOString()}`,
      ].join("\n");
      const challenge = await prisma.walletChallenge.create({
        data: { companyId, address: wallet.address, message, expiresAt },
      });
      return { challengeId: challenge.id, message, expiresAt: expiresAt.toISOString() };
    },

    async verify(
      companyId: string,
      id: string,
      input: { challengeId: string; signature: SignatureInput },
    ): Promise<Wallet> {
      const wallet = await getOwned(companyId, id);
      const challenge = await prisma.walletChallenge.findFirst({
        where: { id: input.challengeId, companyId, address: wallet.address },
      });
      if (!challenge) throw notFound("Challenge");
      if (challenge.usedAt || challenge.expiresAt.getTime() <= Date.now()) {
        throw new AppError("CHALLENGE_EXPIRED", "This challenge has expired or was already used. Request a new one.");
      }
      if (!verifyWalletSignature(wallet.address, challenge.message, input.signature)) {
        throw new AppError("INVALID_SIGNATURE", "The signature does not match this wallet");
      }
      return prisma.$transaction(async (tx) => {
        // Single use, enforced atomically: two concurrent verifies cannot both consume it.
        const used = await tx.walletChallenge.updateMany({
          where: { id: challenge.id, usedAt: null, expiresAt: { gt: new Date() } },
          data: { usedAt: new Date() },
        });
        if (used.count === 0) {
          throw new AppError("CHALLENGE_EXPIRED", "This challenge has expired or was already used. Request a new one.");
        }
        const updated = await repo.updateWallet(tx, companyId, wallet.id, { verifiedAt: wallet.verifiedAt ?? new Date() });
        if (!updated) throw notFound("Wallet");
        return updated;
      });
    },

    /** Soft delete. Refused while a draft or a run being paid still uses it. */
    async remove(companyId: string, id: string): Promise<void> {
      const wallet = await getOwned(companyId, id);
      if ((await repo.countOpenRuns(prisma, companyId, wallet.id)) > 0) {
        throw new AppError("RUN_LOCKED", "A payroll run that is still open uses this wallet. Finish or cancel it first.");
      }
      await repo.updateWallet(prisma, companyId, wallet.id, { deletedAt: new Date() });
    },
  };
}

export type WalletService = ReturnType<typeof createWalletService>;
