import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  addFundingWallet,
  createRun,
  makeApp,
  nextBatch,
  ORIGIN,
  post,
  postOnce,
  prisma,
  resetDb,
  setupPayroll,
  signup,
  type TestApp,
} from "../helpers/harness";

let t: TestApp;

beforeAll(() => {
  t = makeApp();
});
beforeEach(async () => {
  await resetDb();
});
afterAll(async () => {
  await prisma.$disconnect();
});

const creds = { email: "owner@shop.example", password: "correct horse battery", businessName: "Shop" };
const anon = () => request(t.app);

describe("auth", () => {
  it("signs up, sets an httpOnly SameSite=Lax cookie, and never returns the password hash", async () => {
    const res = await anon().post("/auth/signup").set("Origin", ORIGIN).send({ ...creds, email: "  Owner@Shop.Example " });
    expect(res.status).toBe(201);
    expect(res.body.company).toMatchObject({ email: "owner@shop.example", businessName: "Shop" });
    expect(JSON.stringify(res.body)).not.toMatch(/password|argon/i);
    const cookie = String(res.headers["set-cookie"]);
    expect(cookie).toMatch(/^op_session=[A-Za-z0-9_-]{43};/);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Lax/);
    // Only a keyed hash of the token is stored, and the password is argon2id.
    const token = /op_session=([^;]+)/.exec(cookie)?.[1] as string;
    const session = await prisma.session.findFirstOrThrow();
    expect(session.id).not.toContain(token);
    expect(session.id).toMatch(/^[0-9a-f]{64}$/);
    const days = (session.expiresAt.getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(13.9);
    expect((await prisma.company.findFirstOrThrow()).passwordHash).toMatch(/^\$argon2id\$/);
  });

  it("rejects weak passwords, bad emails, unknown fields and duplicate emails", async () => {
    const signupWith = (body: object) => anon().post("/auth/signup").set("Origin", ORIGIN).send(body);
    expect((await signupWith({ ...creds, password: "short" })).status).toBe(400);
    expect((await signupWith({ ...creds, email: "nope" })).status).toBe(400);
    expect((await signupWith({ ...creds, admin: true })).status).toBe(400);
    expect((await signupWith({ ...creds, businessName: "  " })).status).toBe(400);
    expect((await signupWith(creds)).status).toBe(201);
    const dup = await signupWith({ ...creds, email: "OWNER@shop.example" });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe("EMAIL_TAKEN");
  });

  it("logs in with the same error for a wrong email or a wrong password, and rotates the session", async () => {
    await anon().post("/auth/signup").set("Origin", ORIGIN).send(creds);
    const wrongPw = await anon().post("/auth/login").set("Origin", ORIGIN).send({ email: creds.email, password: "wrong password!" });
    const wrongEmail = await anon().post("/auth/login").set("Origin", ORIGIN).send({ email: "nobody@shop.example", password: creds.password });
    expect(wrongPw.status).toBe(401);
    expect(wrongEmail.status).toBe(401);
    expect(wrongPw.body.error.code).toBe("INVALID_CREDENTIALS");
    expect(wrongEmail.body.error.message).toBe(wrongPw.body.error.message);

    const agent = request.agent(t.app);
    const login = { email: creds.email, password: creds.password };
    const first = await agent.post("/auth/login").set("Origin", ORIGIN).send(login);
    expect(first.status).toBe(200);
    const before = await prisma.session.findMany();
    const second = await agent.post("/auth/login").set("Origin", ORIGIN).send(login);
    expect(second.status).toBe(200);
    const after = await prisma.session.findMany();
    // The presented session was replaced, not kept alongside the new one.
    expect(after).toHaveLength(before.length);
    expect(after.map((s) => s.id).sort()).not.toEqual(before.map((s) => s.id).sort());
    expect((await agent.get("/auth/me")).body.company.email).toBe(creds.email);
  });

  it("locks the account with a growing delay after repeated failures", async () => {
    await anon().post("/auth/signup").set("Origin", ORIGIN).send(creds);
    const attempt = (password: string) => anon().post("/auth/login").set("Origin", ORIGIN).send({ email: creds.email, password });
    for (let i = 0; i < 3; i++) expect((await attempt("wrong password!")).status).toBe(401);
    const locked = await attempt(creds.password); // even the right password waits
    expect(locked.status).toBe(429);
    expect(locked.body.error.code).toBe("RATE_LIMITED");
    expect(Number.parseInt(locked.headers["retry-after"] as string, 10)).toBeGreaterThan(0);
  });

  it("an attacker who knows the email cannot lock the company out of a browser they have used before", async () => {
    const owner = request.agent(t.app); // signs up here, so this browser becomes a trusted device
    await owner.post("/auth/signup").set("Origin", ORIGIN).send(creds);
    const login = { email: creds.email, password: creds.password };
    // 25 wrong passwords from 25 different addresses: no single IP trips its own lock,
    // but together they trip the account-wide one.
    for (let i = 0; i < 25; i++) {
      const res = await anon().post("/auth/login").set("Origin", ORIGIN).set("X-Forwarded-For", `203.0.113.${i + 1}`).send({ ...login, password: "wrong password!" });
      expect([401, 429]).toContain(res.status);
    }
    // A browser that has never logged in to this account is held back, even with the right password…
    const stranger = await anon().post("/auth/login").set("Origin", ORIGIN).set("X-Forwarded-For", "198.51.100.7").send(login);
    expect(stranger.status).toBe(429);
    expect(stranger.body.error.code).toBe("RATE_LIMITED");
    // …but the company's own browser gets straight in.
    const mine = await owner.post("/auth/login").set("Origin", ORIGIN).send(login);
    expect(mine.status).toBe(200);
    // A successful login clears the account-wide lock for everyone.
    expect((await anon().post("/auth/login").set("Origin", ORIGIN).set("X-Forwarded-For", "198.51.100.7").send(login)).status).toBe(200);
    // The device cookie is httpOnly, scoped to /auth, and only its hash is stored.
    const cookies = (await request(t.app).post("/auth/login").set("Origin", ORIGIN).send(login)).headers["set-cookie"] as unknown as string[];
    const device = cookies.find((c) => c.startsWith("op_device=")) as string;
    expect(device).toMatch(/HttpOnly/);
    expect(device).toMatch(/Path=\/auth/);
    const token = /op_device=([^;]+)/.exec(device)?.[1] as string;
    expect(await prisma.trustedDevice.findUnique({ where: { id: token } })).toBeNull();
  });

  it("a device trusted for one account gives no exemption on another", async () => {
    const attacker = request.agent(t.app);
    await attacker.post("/auth/signup").set("Origin", ORIGIN).send({ ...creds, email: "attacker@evil.example" });
    await anon().post("/auth/signup").set("Origin", ORIGIN).send(creds);
    for (let i = 0; i < 25; i++) {
      await anon().post("/auth/login").set("Origin", ORIGIN).set("X-Forwarded-For", `203.0.113.${i + 1}`).send({ email: creds.email, password: "wrong password!" });
    }
    // The attacker's own trusted-device cookie is for a different company: still locked.
    const res = await attacker.post("/auth/login").set("Origin", ORIGIN).set("X-Forwarded-For", "198.51.100.9").send({ email: creds.email, password: creds.password });
    expect(res.status).toBe(429);
  });

  it("login throttling and the credential rate limit hold across API instances", async () => {
    await anon().post("/auth/signup").set("Origin", ORIGIN).send(creds);
    const a = makeApp();
    const b = makeApp();
    const wrong = { email: creds.email, password: "wrong password!" };
    // Failures spread over two instances add up to one lock.
    expect((await request(a.app).post("/auth/login").set("Origin", ORIGIN).send(wrong)).status).toBe(401);
    expect((await request(b.app).post("/auth/login").set("Origin", ORIGIN).send(wrong)).status).toBe(401);
    expect((await request(a.app).post("/auth/login").set("Origin", ORIGIN).send(wrong)).status).toBe(401);
    expect((await request(b.app).post("/auth/login").set("Origin", ORIGIN).send(wrong)).status).toBe(429);

    // The 5-per-minute limit on credential endpoints is one budget, not one per instance.
    await prisma.loginThrottle.deleteMany();
    await prisma.rateLimit.deleteMany();
    const c = makeApp({ authPerMin: 5 });
    const d = makeApp({ authPerMin: 5 });
    let n = 0;
    const attempt = (app: typeof c) => request(app.app).post("/auth/login").set("Origin", ORIGIN).send({ email: `nobody${n++}@x.example`, password: "whatever it is" });
    for (const app of [c, d, c, d, c]) expect((await attempt(app)).status).toBe(401);
    expect((await attempt(d)).status).toBe(429);
    expect((await attempt(c)).status).toBe(429);
  });

  it("company settings: name and notification emails; unknown fields and empty bodies are refused", async () => {
    const m = await signup(t, "Old Name");
    expect((await m.agent.get("/auth/me")).body.company).toMatchObject({ businessName: "Old Name", notifyPaid: true, notifyProblems: true });
    const save = (body: object) => m.agent.post("/auth/settings").set("Origin", ORIGIN).send(body);
    const res = await save({ businessName: "  Ada's Kitchen ", notifyPaid: false });
    expect(res.status).toBe(200);
    expect(res.body.company).toMatchObject({ businessName: "Ada's Kitchen", notifyPaid: false, notifyProblems: true });
    for (const bad of [{}, { businessName: "" }, { notifyPaid: "yes" }, { email: "new@x.example" }, { brandColor: "#000000" }]) {
      expect((await save(bad)).status, JSON.stringify(bad)).toBe(400);
    }
    expect((await m.agent.post("/auth/settings").send({ notifyPaid: true })).status).toBe(403);
    expect((await anon().post("/auth/settings").set("Origin", ORIGIN).send({ notifyPaid: true })).status).toBe(401);
  });

  it("closing the account needs the password, cancels drafts and unsent payments, signs out everywhere, revokes keys and frees the email", async () => {
    const { company, wallet, people } = await setupPayroll(t, 2);
    const draft = await createRun(company, wallet, { employeeIds: [people[0]?.id] });
    const paying = await createRun(company, wallet, { employeeIds: people.map((p) => p.id) });
    expect((await post(company, `/v1/payroll-runs/${paying.id}/start`)).status).toBe(200);
    const key = (await post(company, "/v1/api-keys", { name: "k" })).body.key as string;

    const close = (body: object) => company.agent.post("/auth/close").set("Origin", ORIGIN).send(body);
    expect((await close({ password: company.password, confirm: "close" })).status).toBe(400);
    expect((await close({ confirm: "CLOSE" })).status).toBe(400);
    expect((await close({ password: "wrong password!", confirm: "CLOSE" })).status).toBe(401);
    expect((await company.agent.post("/auth/close").send({ password: company.password, confirm: "CLOSE" })).status).toBe(403); // CSRF guard

    // A batch waiting for a signature blocks closing: it could still be signed and land.
    await nextBatch(company, paying.id);
    expect((await close({ password: company.password, confirm: "CLOSE" })).body.error.code).toBe("RUN_LOCKED");
    await prisma.payrollItem.updateMany({ where: { runId: paying.id }, data: { batchId: null } });
    await prisma.payrollBatch.deleteMany({ where: { runId: paying.id } });
    await prisma.$executeRaw`UPDATE "PayrollItem" SET status = 'PENDING' WHERE "runId" = ${paying.id}`;

    expect((await close({ password: company.password, confirm: "CLOSE" })).status).toBe(204);
    const status = async (id: string) => (await prisma.payrollRun.findUniqueOrThrow({ where: { id } })).status;
    expect([await status(draft.id), await status(paying.id)]).toEqual(["CANCELLED", "CANCELLED"]);
    expect(await prisma.payrollItem.count({ where: { runId: paying.id, status: "CANCELLED" } })).toBe(2);
    expect((await company.agent.get("/auth/me")).status).toBe(401);
    expect((await anon().get("/v1/employees").set("Authorization", `Bearer ${key}`)).status).toBe(401);
    expect((await anon().post("/auth/login").set("Origin", ORIGIN).send({ email: company.email, password: company.password })).status).toBe(401);
    // The closed account itself can never be signed into again, even with its rewritten email.
    const closedEmail = `closed-${company.id}@closed.invalid`;
    expect((await anon().post("/auth/login").set("Origin", ORIGIN).send({ email: closedEmail, password: company.password })).status).toBe(401);
    expect(await prisma.passwordReset.count({ where: { companyId: company.id } })).toBe(0);
    const again = await anon().post("/auth/signup").set("Origin", ORIGIN).send({ email: company.email, password: "a brand new password", businessName: "Again" });
    expect(again.status).toBe(201);
    // The funding wallet is free for another company to add.
    const other = await signup(t);
    expect((await addFundingWallet(t, other, "10", wallet.keypair)).address).toBe(wallet.address);
  });

  it("'keep me logged in' unticked gives a browser-session cookie and a one-day session", async () => {
    await anon().post("/auth/signup").set("Origin", ORIGIN).send(creds);
    await prisma.session.deleteMany();
    const short = await anon().post("/auth/login").set("Origin", ORIGIN).send({ email: creds.email, password: creds.password, remember: false });
    expect(short.status).toBe(200);
    const cookie = (short.headers["set-cookie"] as unknown as string[]).find((c) => c.startsWith("op_session=")) as string;
    expect(cookie).not.toMatch(/Max-Age|Expires/i);
    const session = await prisma.session.findFirstOrThrow();
    const hours = (session.expiresAt.getTime() - Date.now()) / 3_600_000;
    expect(hours).toBeGreaterThan(23);
    expect(hours).toBeLessThanOrEqual(24);
    const long = await anon().post("/auth/login").set("Origin", ORIGIN).send({ email: creds.email, password: creds.password, remember: true });
    expect(String(long.headers["set-cookie"])).toMatch(/op_session=[^;]+; Max-Age=1209600/);
  });

  it("sessions: lists where you're signed in, signs one out, and signs out everywhere else", async () => {
    const m = await signup(t);
    const login = () => request.agent(t.app).post("/auth/login").set("Origin", ORIGIN).set("User-Agent", "Mozilla/5.0 (iPhone)").send({ email: m.email, password: m.password });
    const phoneAgent = request.agent(t.app);
    await phoneAgent.post("/auth/login").set("Origin", ORIGIN).set("User-Agent", "Mozilla/5.0 (iPhone)").send({ email: m.email, password: m.password });
    await login();
    const list = await m.agent.get("/auth/sessions");
    expect(list.status).toBe(200);
    expect(list.body.data).toHaveLength(3);
    expect(list.body.data.filter((s: { current: boolean }) => s.current)).toHaveLength(1);
    expect(list.body.data.some((s: { userAgent: string }) => s.userAgent === "Mozilla/5.0 (iPhone)")).toBe(true);
    expect(JSON.stringify(list.body)).not.toMatch(/token/i);
    // Last-active time: set at sign-in, then refreshed when the session is used after a while.
    const mine = list.body.data.find((x: { current: boolean }) => x.current) as { id: string; lastSeenAt: string };
    await prisma.session.update({ where: { id: mine.id }, data: { lastSeenAt: new Date(Date.now() - 3_600_000) } });
    await m.agent.get("/auth/me");
    const seen = (await prisma.session.findUniqueOrThrow({ where: { id: mine.id } })).lastSeenAt;
    expect(Date.now() - seen.getTime()).toBeLessThan(10_000);

    const others = list.body.data.filter((s: { current: boolean }) => !s.current) as { id: string }[];
    expect((await m.agent.delete(`/auth/sessions/${others[0]!.id}`).set("Origin", ORIGIN)).status).toBe(204);
    expect((await m.agent.delete(`/auth/sessions/${others[0]!.id}`).set("Origin", ORIGIN)).status).toBe(404);
    expect((await m.agent.delete("/auth/sessions/not-a-session").set("Origin", ORIGIN)).status).toBe(400);
    expect((await m.agent.delete(`/auth/sessions/${others[1]!.id}`)).status).toBe(403); // CSRF guard

    // Another company cannot see or end these sessions.
    const stranger = await signup(t);
    expect((await stranger.agent.get("/auth/sessions")).body.data).toHaveLength(1);
    expect((await stranger.agent.delete(`/auth/sessions/${others[1]!.id}`).set("Origin", ORIGIN)).status).toBe(404);

    expect((await m.agent.post("/auth/sessions/logout-others").set("Origin", ORIGIN)).status).toBe(204);
    expect((await m.agent.get("/auth/sessions")).body.data).toMatchObject([{ current: true }]);
    expect((await phoneAgent.get("/auth/me")).status).toBe(401);
    expect((await m.agent.get("/auth/me")).status).toBe(200);
    expect((await anon().get("/auth/sessions")).status).toBe(401);
  });

  it("password reset: a one-hour, single-use emailed link that signs out everywhere", async () => {
    const m = await signup(t);
    t.mailer.sent.length = 0;
    const forgot = (email: string) => anon().post("/auth/password/forgot").set("Origin", ORIGIN).send({ email });
    // Unknown address: the same answer, and no email.
    expect((await forgot("nobody@nowhere.example")).status).toBe(204);
    expect(t.mailer.sent).toHaveLength(0);
    expect((await forgot(m.email.toUpperCase())).status).toBe(204);
    expect(t.mailer.sent).toHaveLength(1);
    expect(t.mailer.sent[0]).toMatchObject({ to: m.email, subject: "Reset your OrgPay password" });
    const token = /reset-password\?token=([A-Za-z0-9_-]+)/.exec(t.mailer.sent[0]!.text)?.[1] as string;
    expect(t.mailer.sent[0]!.text).toContain(`${ORIGIN}/reset-password?token=${token}`);
    // Only a hash of the token is stored.
    expect(await prisma.passwordReset.findUnique({ where: { id: token } })).toBeNull();
    // Asking again straight away does not send a second email.
    expect((await forgot(m.email)).status).toBe(204);
    expect(t.mailer.sent).toHaveLength(1);

    const reset = (body: object) => anon().post("/auth/password/reset").set("Origin", ORIGIN).send(body);
    expect((await reset({ token, newPassword: "short" })).status).toBe(400);
    expect((await reset({ token: "x".repeat(43), newPassword: "a whole new password" })).body.error.code).toBe("CHALLENGE_EXPIRED");
    expect((await reset({ token, newPassword: "a whole new password" })).status).toBe(204);
    // Used once: it cannot be replayed.
    expect((await reset({ token, newPassword: "another new password" })).status).toBe(400);
    // Every session is gone; the old password no longer works; the new one does.
    expect((await m.agent.get("/auth/me")).status).toBe(401);
    expect((await anon().post("/auth/login").set("Origin", ORIGIN).send({ email: m.email, password: m.password })).status).toBe(401);
    expect((await anon().post("/auth/login").set("Origin", ORIGIN).send({ email: m.email, password: "a whole new password" })).status).toBe(200);

    // An expired link is refused.
    await prisma.passwordReset.deleteMany();
    await forgot(m.email);
    const second = /token=([A-Za-z0-9_-]+)/.exec(t.mailer.sent.at(-1)!.text)?.[1] as string;
    await prisma.passwordReset.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await reset({ token: second, newPassword: "yet another password" })).body.error.code).toBe("CHALLENGE_EXPIRED");
    expect((await anon().post("/auth/password/forgot").send({ email: m.email })).status).toBe(403); // CSRF guard
  });

  it("password reset says so plainly when email is not set up", async () => {
    const noMail = makeApp({}, { mailer: null });
    const res = await request(noMail.app).post("/auth/password/forgot").set("Origin", ORIGIN).send({ email: "a@b.example" });
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe("SERVICE_UNAVAILABLE");
  });

  it("logout ends the session; me requires one; expired sessions are refused", async () => {
    const m = await signup(t);
    expect((await anon().get("/auth/me")).status).toBe(401);
    expect((await m.agent.get("/auth/me")).status).toBe(200);
    await prisma.session.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await m.agent.get("/auth/me")).status).toBe(401);
    expect(await prisma.session.count()).toBe(0); // swept on sight

    const again = await signup(t);
    expect((await again.agent.post("/auth/logout").set("Origin", ORIGIN)).status).toBe(204);
    expect((await again.agent.get("/auth/me")).status).toBe(401);
    expect((await again.agent.get("/v1/wallets")).status).toBe(401);
  });

  it("changing the password needs the current one and signs out every other session", async () => {
    const m = await signup(t);
    const elsewhere = request.agent(t.app);
    await elsewhere.post("/auth/login").set("Origin", ORIGIN).send({ email: m.email, password: m.password });
    const change = (body: object) => m.agent.post("/auth/password").set("Origin", ORIGIN).send(body);
    expect((await change({ currentPassword: "not my password", newPassword: "a brand new password" })).status).toBe(401);
    expect((await change({ currentPassword: m.password, newPassword: "short" })).status).toBe(400);
    expect((await change({ currentPassword: m.password, newPassword: "a brand new password" })).status).toBe(204);
    expect((await m.agent.get("/auth/me")).status).toBe(200);
    expect((await elsewhere.get("/auth/me")).status).toBe(401);
    expect((await anon().post("/auth/login").set("Origin", ORIGIN).send({ email: m.email, password: m.password })).status).toBe(401);
    expect((await anon().post("/auth/login").set("Origin", ORIGIN).send({ email: m.email, password: "a brand new password" })).status).toBe(200);
  });

  it("CSRF: cookie-authenticated writes need Origin (or Referer) equal to the web origin", async () => {
    const m = await signup(t);
    const noOrigin = await m.agent.post("/v1/api-keys").send({ name: "k" });
    expect(noOrigin.status).toBe(403);
    expect(noOrigin.body.error.code).toBe("FORBIDDEN_ORIGIN");
    expect((await m.agent.post("/v1/api-keys").set("Origin", "https://evil.example").send({ name: "k" })).status).toBe(403);
    expect((await m.agent.post("/v1/api-keys").set("Origin", `${ORIGIN}.evil.example`).send({ name: "k" })).status).toBe(403);
    expect((await m.agent.post("/v1/api-keys").set("Origin", "null").send({ name: "k" })).status).toBe(403);
    // A sandboxed frame sends Origin: null; a matching Referer must not rescue it.
    expect((await m.agent.post("/v1/api-keys").set("Origin", "null").set("Referer", `${ORIGIN}/x`).send({ name: "k" })).status).toBe(403);
    expect((await m.agent.post("/v1/api-keys").set("Referer", `${ORIGIN}/dashboard/keys`).send({ name: "k" })).status).toBe(201);
    expect((await m.agent.post("/auth/logout")).status).toBe(403);
    expect((await anon().post("/auth/login").send({ email: creds.email, password: creds.password })).status).toBe(403);
    expect((await m.agent.get("/v1/api-keys")).status).toBe(200); // reads are not affected
    expect(await prisma.apiKey.count()).toBe(1);
  });

  it("CORS allows credentials only for the web origin; health is open without credentials", async () => {
    const pre = await anon().options("/v1/employees").set("Origin", ORIGIN).set("Access-Control-Request-Method", "POST");
    expect(pre.headers["access-control-allow-origin"]).toBe(ORIGIN);
    expect(pre.headers["access-control-allow-credentials"]).toBe("true");
    const evil = await anon().options("/v1/employees").set("Origin", "https://evil.example").set("Access-Control-Request-Method", "POST");
    expect(evil.headers["access-control-allow-origin"]).not.toBe("https://evil.example");
    const pub = await anon().get("/health").set("Origin", "https://anything.example");
    expect(pub.headers["access-control-allow-origin"]).toBe("*");
    expect(pub.headers["access-control-allow-credentials"]).toBeUndefined();
  });
});

describe("email confirmation at sign-up", () => {
  const strict = () => makeApp({}, { verifyEmail: true });
  const codeIn = (text: string) => /code is: (\d{6})/.exec(text)?.[1] as string;
  async function open(app: ReturnType<typeof strict>, email = `new-${Date.now()}-${Math.round(performance.now())}@example.com`) {
    const agent = request.agent(app.app);
    const res = await agent.post("/auth/signup").set("Origin", ORIGIN).send({ email, password: "correct horse battery", businessName: "New Shop" });
    return { agent, res, email, post: (path: string, body?: object) => agent.post(path).set("Origin", ORIGIN).send(body) };
  }

  it("a new account gets a six-digit code by email and is locked out of the dashboard until it is entered", async () => {
    const app = strict();
    const m = await open(app);
    expect(m.res.status).toBe(201);
    expect(m.res.body.company.emailVerified).toBe(false);
    const mail = app.mailer.sent.at(-1)!;
    expect(mail.to).toBe(m.email);
    expect(mail.subject).toMatch(/^\d{6} is your OrgPay code$/);
    const code = codeIn(mail.text);
    // Only a hash of the code is stored.
    const row = await prisma.emailVerification.findFirstOrThrow();
    expect(row.codeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(row)).not.toContain(code);

    // Signed in, but nothing under /v1 works yet.
    expect((await m.agent.get("/auth/me")).body.company.emailVerified).toBe(false);
    for (const path of ["/v1/wallets", "/v1/employees", "/v1/payroll-runs", "/v1/api-keys", "/v1/summary"]) {
      const blocked = await m.agent.get(path);
      expect(blocked.status, path).toBe(403);
      expect(blocked.body.error.code).toBe("EMAIL_NOT_VERIFIED");
    }
    expect((await m.post("/v1/wallets", { address: "GAE6HVGQRXFG5BVAAVZBKP44U6JMFHYVDRAVGADJFHBSVS6RX7PETWFV" })).status).toBe(403);

    for (const bad of ["12345", "1234567", "abcdef", ""]) expect((await m.post("/auth/email/verify", { code: bad })).status, bad).toBe(400);
    const ok = await m.post("/auth/email/verify", { code: ` ${code.slice(0, 3)} ${code.slice(3)} ` }); // typed with a space
    expect(ok.status).toBe(200);
    expect(ok.body.company.emailVerified).toBe(true);
    expect((await m.agent.get("/v1/wallets")).status).toBe(200);
    expect(await prisma.emailVerification.count()).toBe(0);
    // Confirming again is harmless; asking for another code sends nothing.
    expect((await m.post("/auth/email/verify", { code })).status).toBe(200);
    const sent = app.mailer.sent.length;
    expect((await m.post("/auth/email/resend")).status).toBe(204);
    expect(app.mailer.sent.length).toBe(sent);
  });

  it("a wrong code is refused and counted; after five the code is dead and a new one is needed", async () => {
    const app = strict();
    const m = await open(app);
    const code = codeIn(app.mailer.sent.at(-1)!.text);
    const wrong = code === "000000" ? "111111" : "000000";
    const first = await m.post("/auth/email/verify", { code: wrong });
    expect(first.status).toBe(400);
    expect(first.body.error).toMatchObject({ code: "INVALID_CODE", message: "That code isn't right. 4 tries left." });
    for (let i = 0; i < 4; i++) expect((await m.post("/auth/email/verify", { code: wrong })).body.error.code).toBe("INVALID_CODE");
    // The sixth attempt fails even with the right code.
    const dead = await m.post("/auth/email/verify", { code });
    expect(dead.status).toBe(400);
    expect(dead.body.error.code).toBe("CHALLENGE_EXPIRED");
    expect((await m.agent.get("/auth/me")).body.company.emailVerified).toBe(false);

    // A new code can be asked for once a minute.
    const tooSoon = await m.post("/auth/email/resend");
    expect(tooSoon.status).toBe(429);
    expect(Number.parseInt(tooSoon.headers["retry-after"] as string, 10)).toBeGreaterThan(0);
    await prisma.emailVerification.updateMany({ data: { sentAt: new Date(Date.now() - 61_000) } });
    expect((await m.post("/auth/email/resend")).status).toBe(204);
    const fresh = codeIn(app.mailer.sent.at(-1)!.text);
    expect((await m.post("/auth/email/verify", { code: fresh })).body.company.emailVerified).toBe(true);
  });

  it("a code expires after 15 minutes, is tied to its own account, and parallel guesses cannot beat the limit", async () => {
    const app = strict();
    const a = await open(app);
    const codeA = codeIn(app.mailer.sent.at(-1)!.text);
    const b = await open(app);
    const codeB = codeIn(app.mailer.sent.at(-1)!.text);
    // A's code does nothing for B (unless they happen to be equal).
    if (codeA !== codeB) expect((await b.post("/auth/email/verify", { code: codeA })).body.error.code).toBe("INVALID_CODE");
    // Ten guesses at once: at most five are even compared.
    const wrong = codeA === "999999" ? "888888" : "999999";
    const burst = await Promise.all(Array.from({ length: 10 }, () => a.post("/auth/email/verify", { code: wrong })));
    expect(burst.filter((r) => r.body.error.code === "INVALID_CODE").length).toBeLessThanOrEqual(5);
    expect((await prisma.emailVerification.findUniqueOrThrow({ where: { companyId: a.res.body.company.id } })).attempts).toBe(5);
    // Expiry.
    await prisma.emailVerification.updateMany({ where: { companyId: b.res.body.company.id }, data: { expiresAt: new Date(Date.now() - 1000), attempts: 0 } });
    expect((await b.post("/auth/email/verify", { code: codeB })).body.error.code).toBe("CHALLENGE_EXPIRED");
    // Both endpoints need a session and the CSRF origin.
    expect((await anon().post("/auth/email/verify").set("Origin", ORIGIN).send({ code: "123456" })).status).toBe(401);
    expect((await b.agent.post("/auth/email/resend")).status).toBe(403);
  });

  it("the account is still created when the code email cannot be sent, and logging in again keeps it locked", async () => {
    const failing = { async send() { throw new Error("smtp down"); } };
    const app = makeApp({}, { verifyEmail: true, mailer: failing });
    const m = await open(app);
    expect(m.res.status).toBe(201);
    expect(m.res.body.company.emailVerified).toBe(false);
    const again = request.agent(app.app);
    const login = await again.post("/auth/login").set("Origin", ORIGIN).send({ email: m.email, password: "correct horse battery" });
    expect(login.body.company.emailVerified).toBe(false);
    expect((await again.get("/v1/wallets")).status).toBe(403);
  });

  it("without a mail server there is nothing to confirm: accounts are usable straight away", async () => {
    const res = await anon().post("/auth/signup").set("Origin", ORIGIN).send({ ...creds, email: "plain@shop.example" });
    expect(res.body.company.emailVerified).toBe(true);
    const noMail = makeApp({}, { verifyEmail: true, mailer: null });
    const res2 = await request(noMail.app).post("/auth/signup").set("Origin", ORIGIN).send({ ...creds, email: "nomail@shop.example" });
    expect(res2.body.company.emailVerified).toBe(true);
  });
});

describe("API keys", () => {
  it("shows the full key once, stores only its hash, authenticates with Bearer, and can be revoked", async () => {
    const { company, wallet, people } = await setupPayroll(t, 1);
    const created = await company.agent.post("/v1/api-keys").set("Origin", ORIGIN).send({ name: "Storefront" });
    expect(created.status).toBe(201);
    const key = created.body.key as string;
    expect(key).toMatch(/^op_test_[A-Za-z0-9]{43}$/);
    expect(created.body.apiKey).toMatchObject({ name: "Storefront", prefix: key.slice(0, 12), revokedAt: null });
    const row = await prisma.apiKey.findFirstOrThrow();
    expect(row.keyHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(row)).not.toContain(key);
    const list = await company.agent.get("/v1/api-keys");
    expect(JSON.stringify(list.body)).not.toContain(key);

    // API-key requests need no Origin and are attributed to "api".
    const viaKey = await anon().post("/v1/payroll-runs").set("Authorization", `Bearer ${key}`).set("Idempotency-Key", "api-key-run-0001").send({ name: "Via API", walletId: wallet.id, employeeIds: [people[0]?.id] });
    expect(viaKey.status).toBe(201);
    expect((await prisma.payrollRun.findUniqueOrThrow({ where: { id: viaKey.body.run.id } })).createdVia).toBe("api");
    expect((await prisma.apiKey.findFirstOrThrow()).lastUsedAt).not.toBeNull();
    const cancel = await anon().post(`/v1/payroll-runs/${viaKey.body.run.id}/cancel`).set("Authorization", `Bearer ${key}`);
    expect(cancel.status).toBe(200);
    expect((await prisma.payrollEvent.findFirstOrThrow({ where: { type: "cancelled" } })).actor).toBe("api");

    // Wallet and key management and the dashboard stream are session-only.
    for (const path of ["/v1/wallets", "/v1/api-keys"]) {
      expect((await anon().get(path).set("Authorization", `Bearer ${key}`)).status, path).toBe(401);
    }
    expect((await anon().get("/auth/me").set("Authorization", `Bearer ${key}`)).status).toBe(401);

    const revoke = await company.agent.delete(`/v1/api-keys/${created.body.apiKey.id}`).set("Origin", ORIGIN);
    expect(revoke.status).toBe(204);
    expect((await anon().get("/v1/employees").set("Authorization", `Bearer ${key}`)).status).toBe(401);
    expect((await company.agent.delete(`/v1/api-keys/${created.body.apiKey.id}`).set("Origin", ORIGIN)).status).toBe(204);
  });

  it("rejects missing, malformed and unknown credentials with 401 UNAUTHENTICATED", async () => {
    const m = await signup(t);
    for (const header of ["Bearer op_test_doesnotexist", "Bearer ", "Basic abc", "op_test_x", `Bearer ${"x".repeat(500)}`]) {
      const res = await anon().get("/v1/employees").set("Authorization", header);
      expect(res.status, header).toBe(401);
      expect(res.body.error.code).toBe("UNAUTHENTICATED");
    }
    expect((await anon().get("/v1/employees")).status).toBe(401);
    expect((await anon().get("/v1/employees").set("Cookie", "op_session=forged")).status).toBe(401);
    // A bad Authorization header is never rescued by a valid cookie.
    expect((await m.agent.get("/v1/employees").set("Authorization", "Bearer op_test_bad")).status).toBe(401);
  });
});

describe("tenant isolation", () => {
  const expect404 = (res: { status: number; body: { error?: { code: string } } }) => {
    expect(res.status).toBe(404);
    expect(res.body.error?.code).toBe("NOT_FOUND");
  };

  /** Two companies; B has a group, a person, a draft run and a run being paid. */
  async function world() {
    const a = await setupPayroll(t, 1);
    const b = await setupPayroll(t, 2);
    const bGroup = (await post(b.company, "/v1/groups", { name: "Engineering" })).body.group as { id: string };
    const bDraft = await createRun(b.company, b.wallet, { employeeIds: [b.people[0]?.id] });
    const bPaying = await createRun(b.company, b.wallet, { employeeIds: b.people.map((p) => p.id) });
    await post(b.company, `/v1/payroll-runs/${bPaying.id}/start`);
    const { batch } = await nextBatch(b.company, bPaying.id);
    const bKeyId = (await post(b.company, "/v1/api-keys", { name: "b" })).body.apiKey.id as string;
    return { a, b, bGroup, bDraft, bPaying, bBatchId: batch?.id ?? "", bKeyId, bItemId: bDraft.payments[0]?.id ?? "" };
  }

  it("people and groups: lists show only the caller's; every id route is 404", async () => {
    const w = await world();
    const ac = w.a.company;
    expect((await ac.agent.get("/v1/employees")).body.data.map((e: { id: string }) => e.id)).toEqual([w.a.people[0]?.id]);
    expect((await ac.agent.get("/v1/groups")).body.data).toEqual([]);
    expect((await ac.agent.get(`/v1/employees?groupId=${w.bGroup.id}`)).body.data).toEqual([]);
    const bPerson = w.b.people[0]?.id;
    expect404(await ac.agent.get(`/v1/employees/${bPerson}`));
    expect404(await ac.agent.patch(`/v1/employees/${bPerson}`).set("Origin", ORIGIN).send({ name: "Hijacked" }));
    expect404(await post(ac, `/v1/employees/${bPerson}/deactivate`));
    expect404(await post(ac, `/v1/employees/${bPerson}/reactivate`));
    expect404(await ac.agent.patch(`/v1/groups/${w.bGroup.id}`).set("Origin", ORIGIN).send({ name: "Mine" }));
    expect404(await ac.agent.delete(`/v1/groups/${w.bGroup.id}`).set("Origin", ORIGIN));
    // Using B's group or person as one's own is refused too.
    expect404(await post(ac, "/v1/employees", { name: "X", walletAddress: w.b.wallet.address, salary: "1", groupId: w.bGroup.id }));
    expect((await post(ac, "/v1/employees/check", { ids: [bPerson] })).body.data).toEqual([]);
    expect((await prisma.employee.findUniqueOrThrow({ where: { id: bPerson } })).name).not.toBe("Hijacked");
  });

  it("payroll runs: lists show only the caller's; every id route is 404 and changes nothing", async () => {
    const w = await world();
    const ac = w.a.company;
    expect((await ac.agent.get("/v1/payroll-runs")).body.data).toEqual([]);
    for (const res of [
      await ac.agent.get(`/v1/payroll-runs/${w.bDraft.id}`),
      await ac.agent.get(`/v1/payroll-runs/${w.bDraft.id}/check`),
      await ac.agent.patch(`/v1/payroll-runs/${w.bDraft.id}`).set("Origin", ORIGIN).send({ name: "Mine" }),
      await post(ac, `/v1/payroll-runs/${w.bDraft.id}/payments`, { employeeIds: [w.a.people[0]?.id] }),
      await ac.agent.patch(`/v1/payroll-runs/${w.bDraft.id}/payments/${w.bItemId}`).set("Origin", ORIGIN).send({ amount: "1" }),
      await ac.agent.delete(`/v1/payroll-runs/${w.bDraft.id}/payments/${w.bItemId}`).set("Origin", ORIGIN),
      await post(ac, `/v1/payroll-runs/${w.bDraft.id}/start`),
      await post(ac, `/v1/payroll-runs/${w.bPaying.id}/transactions/next`),
      await post(ac, `/v1/payroll-runs/${w.bPaying.id}/transactions/${w.bBatchId}/submit`, { signedXdr: "AAAA" }),
      await post(ac, `/v1/payroll-runs/${w.bPaying.id}/retry`),
      await post(ac, `/v1/payroll-runs/${w.bDraft.id}/cancel`),
      await ac.agent.get(`/v1/payroll-runs/${w.bDraft.id}/export.csv`),
      await ac.agent.get(`/v1/payments/${w.bItemId}`),
      await ac.agent.get(`/v1/payments/${w.bItemId}/verify`),
      await ac.agent.delete(`/v1/payroll-runs/${w.bDraft.id}`).set("Origin", ORIGIN),
    ]) {
      expect404(res);
    }
    // A's run cannot pay from B's wallet or include B's people.
    expect404(await postOnce(ac, "/v1/payroll-runs", { name: "x", walletId: w.b.wallet.id }));
    const aRun = await createRun(ac, w.a.wallet, { employeeIds: [w.a.people[0]?.id] });
    expect((await post(ac, `/v1/payroll-runs/${aRun.id}/payments`, { employeeIds: [w.b.people[0]?.id] })).status).toBe(400);
    expect404(await post(ac, `/v1/payroll-runs/${aRun.id}/payments`, { groupIds: [w.bGroup.id] }));
    const draft = await prisma.payrollRun.findUniqueOrThrow({ where: { id: w.bDraft.id }, include: { items: true } });
    expect(draft).toMatchObject({ status: "DRAFT", name: "October payroll" });
    expect(draft.items).toHaveLength(1);
    expect((await ac.agent.get("/v1/summary")).body).toMatchObject({ draftRuns: [{ id: aRun.id }], activeRuns: [], activeEmployees: 1 });
  });

  it("wallets and API keys", async () => {
    const w = await world();
    const ac = w.a.company;
    expect((await ac.agent.get("/v1/wallets")).body.data.map((x: { id: string }) => x.id)).toEqual([w.a.wallet.id]);
    expect404(await post(ac, `/v1/wallets/${w.b.wallet.id}/refresh`));
    expect404(await post(ac, `/v1/wallets/${w.b.wallet.id}/challenge`));
    const challenge = await post(w.b.company, `/v1/wallets/${w.b.wallet.id}/challenge`);
    const signature = Buffer.from(w.b.wallet.keypair.signMessage(challenge.body.message)).toString("base64");
    expect404(await post(ac, `/v1/wallets/${w.b.wallet.id}/verify`, { challengeId: challenge.body.challengeId, signature }));
    expect404(await ac.agent.delete(`/v1/wallets/${w.b.wallet.id}`).set("Origin", ORIGIN));
    expect((await prisma.wallet.findUniqueOrThrow({ where: { id: w.b.wallet.id } })).deletedAt).toBeNull();
    expect((await ac.agent.get("/v1/api-keys")).body.data).toEqual([]);
    expect404(await ac.agent.delete(`/v1/api-keys/${w.bKeyId}`).set("Origin", ORIGIN));
    expect((await prisma.apiKey.findUniqueOrThrow({ where: { id: w.bKeyId } })).revokedAt).toBeNull();
  });
});

describe("platform", () => {
  it("health reports DB status and open Stellar transactions", async () => {
    const empty = await anon().get("/health");
    expect(empty.status).toBe(200);
    expect(empty.body).toEqual({ status: "ok", db: "up", network: "testnet", openTransactions: 0 });
    const { company, wallet, people } = await setupPayroll(t, 1);
    const run = await createRun(company, wallet, { employeeIds: [people[0]?.id] });
    await post(company, `/v1/payroll-runs/${run.id}/start`);
    await nextBatch(company, run.id);
    expect((await anon().get("/health")).body.openTransactions).toBe(1);
  });

  it("every error uses the shared shape with a request id; unknown routes are NOT_FOUND", async () => {
    const res = await anon().get("/nope").set("X-Request-Id", "req-abc_123");
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: { code: "NOT_FOUND", message: "Route not found", details: [], requestId: "req-abc_123" } });
    expect(res.headers["x-request-id"]).toBe("req-abc_123");
    const generated = await anon().get("/nope").set("X-Request-Id", "bad id\twith junk");
    expect(generated.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(generated.body.error.requestId).toBe(generated.headers["x-request-id"]);
  });

  it("sends hardening headers and hides the framework", async () => {
    const res = await anon().get("/health");
    expect(res.headers["x-powered-by"]).toBeUndefined();
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["strict-transport-security"]).toMatch(/max-age=/);
    expect(res.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(res.headers["referrer-policy"]).toBe("no-referrer");
  });

  it("serves the OpenAPI document and the Scalar reference", async () => {
    const spec = await anon().get("/openapi.json");
    expect(spec.status).toBe(200);
    expect(spec.body.openapi).toBe("3.0.3");
    const paths = Object.keys(spec.body.paths);
    for (const path of [
      "/v1/employees", "/v1/employees/{id}", "/v1/employees/import", "/v1/groups", "/v1/payroll-runs", "/v1/payroll-runs/{id}",
      "/v1/payroll-runs/{id}/start", "/v1/payroll-runs/{id}/transactions/next", "/v1/payroll-runs/{id}/transactions/{txId}/submit",
      "/v1/payroll-runs/{id}/export.csv", "/v1/payments/{id}", "/v1/payments/{id}/verify",
      "/v1/payroll-runs/{id}/retry", "/v1/summary", "/health",
    ]) {
      expect(paths, path).toContain(path);
    }
    // The published reference is for API-key users: nothing that needs the dashboard session.
    expect(paths.filter((p) => p.startsWith("/auth") || p.startsWith("/v1/api-keys") || p.startsWith("/v1/wallets"))).toEqual([]);
    expect(Object.keys(spec.body.components.securitySchemes)).toEqual(["apiKey"]);
    expect(JSON.stringify(spec.body)).not.toContain("op_session");
    expect(spec.body.servers[0].url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(spec.body.components.schemas.PayrollRun.properties.total).toEqual({ type: "string" });
    const docs = await anon().get("/docs");
    expect(docs.status).toBe(200);
    expect(docs.headers["content-type"]).toMatch(/html/);
    expect(docs.text).toContain("/openapi.json");
  });

  it("rate limits with 429 RATE_LIMITED and Retry-After: 5/min on credentials, per company on /v1", async () => {
    const limited = makeApp({ authPerMin: 5, v1PerMin: 3 });
    let n = 0; // a fresh email each time, so only the per-IP limit is in play
    const login = () => request(limited.app).post("/auth/login").set("Origin", ORIGIN).send({ email: `x${n++}@y.example`, password: "whatever it is" });
    for (let i = 0; i < 5; i++) expect((await login()).status).toBe(401);
    const blocked = await login();
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe("RATE_LIMITED");
    expect(Number.parseInt(blocked.headers["retry-after"] as string, 10)).toBeGreaterThan(0);

    const a = await signup(t);
    const b = await signup(t);
    const cookieOf = async (email: string, password: string) => {
      const res = await request(t.app).post("/auth/login").set("Origin", ORIGIN).send({ email, password });
      return String(res.headers["set-cookie"]).split(";")[0] as string;
    };
    const cookieA = await cookieOf(a.email, a.password);
    const cookieB = await cookieOf(b.email, b.password);
    for (let i = 0; i < 3; i++) expect((await request(limited.app).get("/v1/employees").set("Cookie", cookieA)).status).toBe(200);
    expect((await request(limited.app).get("/v1/employees").set("Cookie", cookieA)).status).toBe(429);
    // The limit is per company: B is unaffected by A's burst.
    expect((await request(limited.app).get("/v1/employees").set("Cookie", cookieB)).status).toBe(200);
  });

  it("Horizon-heavy routes have their own, lower budget per company", async () => {
    const limited = makeApp({ stellarHeavyPerMin: 2 });
    const c = await signup(limited);
    for (let i = 0; i < 2; i++) expect((await c.agent.post("/v1/employees/check").set("Origin", ORIGIN).send({})).status).toBe(200);
    const blocked = await c.agent.post("/v1/employees/check").set("Origin", ORIGIN).send({});
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe("RATE_LIMITED");
    // Ordinary reads are unaffected.
    expect((await c.agent.get("/v1/employees")).status).toBe(200);
  });

  it("the 50 kb body limit holds everywhere except bulk import, which takes up to 200 kb", async () => {
    const { company } = await setupPayroll(t, 0);
    const big = { name: "x".repeat(60_000), walletAddress: "G", salary: "1" };
    expect((await post(company, "/v1/employees", big)).status).toBe(413);
    const rows = Array.from({ length: 400 }, (_, i) => ({ name: `Person ${i} ${"y".repeat(80)}`, walletAddress: "GBAD", salary: "1" }));
    const res = await post(company, "/v1/employees/import", { employees: rows });
    expect(res.status).toBe(400); // parsed (not 413), then refused row by row
    expect(res.body.error.code).toBe("VALIDATION_FAILED");
  });
});
