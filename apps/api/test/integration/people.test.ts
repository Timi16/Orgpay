import { Keypair } from "@stellar/stellar-sdk";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  addEmployee,
  addFundingWallet,
  createRun,
  getRun,
  makeApp,
  ORIGIN,
  post as postAs,
  postOnce,
  prisma,
  resetDb,
  signup,
  type TestApp,
  type TestCompany,
} from "../helpers/harness";

let t: TestApp;
let m: TestCompany;

beforeAll(() => {
  t = makeApp();
});
beforeEach(async () => {
  await resetDb();
  t.stellar.down = false;
  m = await signup(t);
});
afterAll(async () => {
  await prisma.$disconnect();
});

const post = (path: string, body?: object) => postAs(m, path, body);
const patch = (path: string, body: object) => m.agent.patch(path).set("Origin", ORIGIN).send(body);

describe("people", () => {
  it("E1: an invalid address, an M-address or a pasted S… secret is 400 for employees and funding wallets; the secret is never stored", async () => {
    const secret = Keypair.random().secret();
    for (const [path, body] of [
      ["/v1/wallets", { address: secret }],
      ["/v1/employees", { name: "Ada", walletAddress: secret, salary: "100" }],
      ["/v1/employees/import", { employees: [{ name: "Ada", walletAddress: secret, salary: "100" }] }],
    ] as const) {
      const res = await post(path, body);
      expect(res.status, path).toBe(400);
      expect(JSON.stringify(res.body)).not.toContain(secret);
    }
    expect((await post("/v1/wallets", { address: secret })).body.error.code).toBe("SECRET_KEY_REJECTED");
    const muxed = "MA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVAAAAAAAAAAAAAJLK";
    for (const address of [muxed, "GABC", "not-an-address", Keypair.random().publicKey().slice(0, 55) + "A"]) {
      expect((await post("/v1/employees", { name: "X", walletAddress: address, salary: "1" })).status, address).toBe(400);
      expect((await post("/v1/wallets", { address })).status, address).toBe(400);
    }
    // A secret pasted into any free-text field (names, roles, labels, groups) is refused too.
    for (const [path, body] of [
      ["/v1/employees", { name: `Ada ${secret}`, walletAddress: Keypair.random().publicKey(), salary: "1" }],
      ["/v1/employees", { name: "Ada", role: secret, walletAddress: Keypair.random().publicKey(), salary: "1" }],
      ["/v1/groups", { name: secret }],
      ["/v1/wallets", { address: Keypair.random().publicKey(), label: secret }],
      ["/v1/api-keys", { name: secret }],
    ] as const) {
      const res = await post(path, body);
      expect(res.status, path).toBe(400);
      expect(JSON.stringify(res.body)).not.toContain(secret);
    }
    expect(await prisma.employee.count()).toBe(0);
    expect(await prisma.wallet.count()).toBe(0);
    const dump = JSON.stringify(await prisma.$queryRawUnsafe('SELECT * FROM "Employee"')) + JSON.stringify(await prisma.$queryRawUnsafe('SELECT * FROM "Wallet"'));
    expect(dump).not.toContain(secret);
  });

  it("E2: the same wallet on two active people of one company is 409 WALLET_IN_USE; deactivated employees and other companies don't count", async () => {
    const wallet = Keypair.random().publicKey();
    const ada = await addEmployee(m, { name: "Ada", walletAddress: wallet });
    const dup = await post("/v1/employees", { name: "Bob", walletAddress: wallet, salary: "1" });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe("WALLET_IN_USE");
    const bob = await addEmployee(m, { name: "Bob" });
    expect((await patch(`/v1/employees/${bob.id}`, { walletAddress: wallet })).body.error.code).toBe("WALLET_IN_USE");
    // Import refuses duplicates within the file and against the team, and adds nobody.
    const imp = await post("/v1/employees/import", { employees: [{ name: "C", walletAddress: wallet, salary: "1" }] });
    expect(imp.body.error.code).toBe("WALLET_IN_USE");
    const twice = Keypair.random().publicKey();
    const imp2 = await post("/v1/employees/import", { employees: [{ name: "C", walletAddress: twice, salary: "1" }, { name: "D", walletAddress: twice, salary: "1" }] });
    expect(imp2.status).toBe(400);
    expect(imp2.body.error.details[0].message).toContain("row 1");
    expect(await prisma.employee.count()).toBe(2);

    // Deactivated: the wallet is free; reactivating the old employee is then refused.
    expect((await post(`/v1/employees/${ada.id}/deactivate`)).body.employee.active).toBe(false);
    const carol = await addEmployee(m, { name: "Carol", walletAddress: wallet });
    expect((await post(`/v1/employees/${ada.id}/reactivate`)).body.error.code).toBe("WALLET_IN_USE");
    await post(`/v1/employees/${carol.id}/deactivate`);
    expect((await post(`/v1/employees/${ada.id}/reactivate`)).body.employee.active).toBe(true);
    // Another company can pay the same person.
    const other = await signup(t, "Other");
    expect((await postAs(other, "/v1/employees", { name: "Ada", walletAddress: wallet, salary: "1" })).status).toBe(201);
  });

  it("E3: an amount of 0, negative, more than 7 decimals, too large or not a string is 400 (people and run lines)", async () => {
    const wallet = await addFundingWallet(t, m);
    const person = await addEmployee(m, { salary: "1500.5" });
    expect(person).toMatchObject({ salary: "1500.5000000", salaryStroops: "15005000000" });
    const run = await createRun(m, wallet, { employeeIds: [person.id] });
    const item = run.payments[0]?.id;
    for (const amount of ["0", "-5", "1.12345678", "1e5", "9999999999999", "", " 1", 100]) {
      expect((await post("/v1/employees", { name: "X", walletAddress: Keypair.random().publicKey(), salary: amount })).status, String(amount)).toBe(400);
      expect((await patch(`/v1/employees/${person.id}`, { salary: amount })).status, String(amount)).toBe(400);
      expect((await patch(`/v1/payroll-runs/${run.id}/payments/${item}`, { amount })).status, String(amount)).toBe(400);
    }
    const ok = await patch(`/v1/payroll-runs/${run.id}/payments/${item}`, { amount: "0.0000001" });
    expect(ok.body.run).toMatchObject({ total: "0.0000001", totalStroops: "1" });
  });

  it("E4: a deactivated employee is left out of new runs and keeps their line on old ones", async () => {
    const wallet = await addFundingWallet(t, m);
    const g = (await post("/v1/groups", { name: "Engineering" })).body.group;
    const ada = await addEmployee(m, { name: "Ada", groupId: g.id });
    const bob = await addEmployee(m, { name: "Bob", groupId: g.id });
    const before = await createRun(m, wallet, { groupIds: [g.id] });
    await post(`/v1/employees/${ada.id}/deactivate`);
    const after = await createRun(m, wallet, { groupIds: [g.id] });
    expect(after.payments.map((i) => i.name)).toEqual(["Bob"]);
    const withAda = await postOnce(m, "/v1/payroll-runs", { name: "x", walletId: wallet.id, employeeIds: [ada.id] });
    expect(withAda.status).toBe(400);
    expect(withAda.body.error.code).toBe("VALIDATION_FAILED");
    // The old run still has Ada as drafted, even after an edit.
    await patch(`/v1/employees/${ada.id}`, { name: "Ada Lovelace" });
    expect((await getRun(m, before.id)).payments.map((i) => i.name)).toEqual(["Ada", "Bob"]);
    expect((await m.agent.get("/v1/employees")).body.data.map((e: { id: string }) => e.id)).toEqual([bob.id]);
    expect((await m.agent.get("/v1/employees?status=inactive")).body.data.map((e: { id: string }) => e.id)).toEqual([ada.id]);
  });

  it("E5: deleting a group ungroups its people; group names are unique per company", async () => {
    const g = (await post("/v1/groups", { name: "Contractors" })).body.group;
    expect((await post("/v1/groups", { name: "Contractors" })).body.error.code).toBe("NAME_TAKEN");
    const ada = await addEmployee(m, { groupId: g.id });
    expect((await m.agent.get("/v1/groups")).body.data).toMatchObject([{ id: g.id, name: "Contractors", employeeCount: 1 }]);
    expect((await patch(`/v1/groups/${g.id}`, { name: "Freelancers" })).body.group.name).toBe("Freelancers");
    expect((await m.agent.delete(`/v1/groups/${g.id}`).set("Origin", ORIGIN)).status).toBe(204);
    const after = (await m.agent.get(`/v1/employees/${ada.id}`)).body.employee;
    expect(after.group).toBeNull();
    expect((await m.agent.get("/v1/employees?groupId=none")).body.data).toHaveLength(1);
  });

  it("E6: the recipient check reports a missing account, no trustline, an unauthorised trustline and a limit too low", async () => {
    const [missing, noTrust, unauth, lowLimit, fine] = Array.from({ length: 5 }, () => Keypair.random().publicKey()) as [string, string, string, string, string];
    t.stellar.noAccount(missing);
    t.stellar.noTrustline(noTrust);
    t.stellar.fund(unauth, "0");
    t.stellar.setTrustline(unauth, { authorized: false });
    t.stellar.fund(lowLimit, "0");
    t.stellar.setTrustline(lowLimit, { limit: "500" });
    const reasons: Record<string, string | null> = {};
    for (const [address, name] of [[missing, "missing"], [noTrust, "noTrust"], [unauth, "unauth"], [lowLimit, "lowLimit"], [fine, "fine"]] as const) {
      const e = await addEmployee(m, { name, walletAddress: address, salary: "1000" });
      reasons[name] = e.check.status === "ready" ? null : e.check.reason;
    }
    expect(reasons).toEqual({ missing: "ACCOUNT_NOT_FOUND", noTrust: "NO_TRUSTLINE", unauth: "NOT_AUTHORIZED", lowLimit: "TRUSTLINE_LIMIT_TOO_LOW", fine: null });

    // When Stellar is down the person is still added, unchecked; a later check fills it in.
    t.stellar.down = true;
    const later = await addEmployee(m, { walletAddress: Keypair.random().publicKey() });
    expect(later.check).toMatchObject({ status: "unchecked", reason: null, checkedAt: null });
    expect((await post("/v1/employees/check", { ids: [later.id] })).status).toBe(503);
    t.stellar.down = false;
    const checked = await post("/v1/employees/check", { ids: [later.id] });
    expect(checked.body.data[0].check.status).toBe("ready");
    // Fixing the wallet and checking again clears the problem.
    t.stellar.addTrustline(noTrust);
    const all = await post("/v1/employees/check", {});
    expect(all.body.data.find((e: { name: string }) => e.name === "noTrust").check.status).toBe("ready");
  });

  it("lists by name with search, group filter and cursor paging", async () => {
    const g = (await post("/v1/groups", { name: "Design" })).body.group;
    for (const name of ["Zoe", "Ada", "Mia", "Bob"]) await addEmployee(m, { name, email: `${name.toLowerCase()}@x.example`, groupId: name === "Mia" ? g.id : null });
    const p1 = await m.agent.get("/v1/employees?limit=2");
    expect(p1.body.data.map((e: { name: string }) => e.name)).toEqual(["Ada", "Bob"]);
    expect(p1.body.total).toBe(4);
    const p2 = await m.agent.get(`/v1/employees?limit=2&cursor=${p1.body.nextCursor}`);
    expect(p2.body.data.map((e: { name: string }) => e.name)).toEqual(["Mia", "Zoe"]);
    expect(p2.body.nextCursor).toBeNull();
    expect((await m.agent.get("/v1/employees?q=ZOE")).body.data.map((e: { name: string }) => e.name)).toEqual(["Zoe"]);
    expect((await m.agent.get(`/v1/employees?groupId=${g.id}`)).body.data.map((e: { name: string }) => e.name)).toEqual(["Mia"]);
    for (const bad of ["limit=0", "limit=501", "cursor=%%%", "status=gone", "groupId=../x", "extra=1"]) {
      expect((await m.agent.get(`/v1/employees?${bad}`)).status, bad).toBe(400);
    }
  });

  it("imports up to 500 people at once, creating groups by name", async () => {
    const rows = [
      { name: "Ada", walletAddress: Keypair.random().publicKey(), salary: "3200", group: "Contractors", email: "ada@x.example" },
      { name: "Kenji", walletAddress: Keypair.random().publicKey(), salary: "2850.50", group: "Contractors" },
      { name: "Priya", walletAddress: Keypair.random().publicKey(), salary: "4100", group: null },
    ];
    const res = await post("/v1/employees/import", { employees: rows });
    expect(res.status).toBe(201);
    expect(res.body.created).toBe(3);
    expect((await m.agent.get("/v1/groups")).body.data).toMatchObject([{ name: "Contractors", employeeCount: 2 }]);
    expect((await post("/v1/employees/import", { employees: [] })).status).toBe(400);
  });
});

describe("funding wallets", () => {
  it("adds a wallet with its balances from Stellar; the same address twice is WALLET_TAKEN; removal is refused while an open run uses it", async () => {
    const wallet = await addFundingWallet(t, m, "2500.75");
    const list = (await m.agent.get("/v1/wallets")).body.data;
    expect(list).toMatchObject([{ id: wallet.id, accountExists: true, usdcBalance: "2500.7500000", xlmBalance: "100.0000000", hasUsdcTrustline: true, verified: false }]);
    expect((await post("/v1/wallets", { address: wallet.address })).body.error.code).toBe("WALLET_TAKEN");
    const person = await addEmployee(m);
    await createRun(m, wallet, { employeeIds: [person.id] });
    expect((await m.agent.delete(`/v1/wallets/${wallet.id}`).set("Origin", ORIGIN)).body.error.code).toBe("RUN_LOCKED");
    await prisma.payrollRun.deleteMany();
    expect((await m.agent.delete(`/v1/wallets/${wallet.id}`).set("Origin", ORIGIN)).status).toBe(204);
    // Re-adding restores it.
    expect((await post("/v1/wallets", { address: wallet.address })).body.wallet.id).toBe(wallet.id);
  });

  it("is still added when Stellar is down, and refresh reports 503 until it is back", async () => {
    t.stellar.down = true;
    const kp = Keypair.random();
    const added = await post("/v1/wallets", { address: kp.publicKey() });
    expect(added.status).toBe(201);
    expect(added.body.wallet.checkedAt).toBeNull();
    expect((await post(`/v1/wallets/${added.body.wallet.id}/refresh`)).status).toBe(503);
    t.stellar.down = false;
    t.stellar.noTrustline(kp.publicKey());
    const fresh = await post(`/v1/wallets/${added.body.wallet.id}/refresh`);
    expect(fresh.body.wallet).toMatchObject({ accountExists: true, hasUsdcTrustline: false, usdcBalance: null });
  });

  it("verifies ownership with a signed challenge: single use, 10-minute expiry, right signer only", async () => {
    const kp = Keypair.random();
    const added = await post("/v1/wallets", { address: kp.publicKey() });
    const id = added.body.wallet.id as string;
    const challenge = await post(`/v1/wallets/${id}/challenge`);
    expect(challenge.status).toBe(200);
    const { challengeId, message, expiresAt } = challenge.body;
    expect(message).toContain("OrgPay wallet verification");
    expect(message).toContain(`Company: ${m.id}`);
    expect(message).toContain(`Wallet: ${kp.publicKey()}`);
    expect(message).toMatch(/Nonce: [0-9a-f]{32}/);
    const ttl = new Date(expiresAt).getTime() - Date.now();
    expect(ttl).toBeGreaterThan(9 * 60_000);
    expect(ttl).toBeLessThanOrEqual(10 * 60_000);

    const sign = (key: Keypair, text: string) => Buffer.from(key.signMessage(text)).toString("base64");
    // Wrong signer, tampered message, garbage.
    for (const signature of [sign(Keypair.random(), message), sign(kp, message + " "), "AAAA", "zz".repeat(64)]) {
      const bad = await post(`/v1/wallets/${id}/verify`, { challengeId, signature });
      expect(bad.status).toBe(400);
      expect(bad.body.error.code).toBe("INVALID_SIGNATURE");
    }
    expect((await post(`/v1/wallets/${id}/verify`, { challengeId: "missing", signature: sign(kp, message) })).status).toBe(404);

    const ok = await post(`/v1/wallets/${id}/verify`, { challengeId, signature: sign(kp, message) });
    expect(ok.status).toBe(200);
    expect(ok.body.wallet.verified).toBe(true);
    expect(ok.body.wallet.verifiedAt).toBeTruthy();
    // Replay of a used challenge.
    const replay = await post(`/v1/wallets/${id}/verify`, { challengeId, signature: sign(kp, message) });
    expect(replay.status).toBe(400);
    expect(replay.body.error.code).toBe("CHALLENGE_EXPIRED");

    // An expired challenge.
    const second = await post(`/v1/wallets/${id}/challenge`);
    await prisma.walletChallenge.update({ where: { id: second.body.challengeId }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const expired = await post(`/v1/wallets/${id}/verify`, { challengeId: second.body.challengeId, signature: sign(kp, second.body.message) });
    expect(expired.body.error.code).toBe("CHALLENGE_EXPIRED");
  });

  it("accepts every form Freighter returns a signature in: base64, hex, Buffer JSON, bytes, and the pre-SEP-53 raw form", async () => {
    const forms: ((kp: Keypair, message: string) => unknown)[] = [
      (kp, msg) => Buffer.from(kp.signMessage(msg)).toString("base64"),
      (kp, msg) => Buffer.from(kp.signMessage(msg)).toString("hex"),
      (kp, msg) => ({ type: "Buffer", data: [...kp.signMessage(msg)] }),
      (kp, msg) => [...kp.signMessage(msg)],
      (kp, msg) => Buffer.from(kp.sign(Buffer.from(msg, "utf8"))).toString("base64"),
    ];
    for (const sign of forms) {
      const kp = Keypair.random();
      const added = await post("/v1/wallets", { address: kp.publicKey() });
      const challenge = await post(`/v1/wallets/${added.body.wallet.id}/challenge`);
      const res = await post(`/v1/wallets/${added.body.wallet.id}/verify`, { challengeId: challenge.body.challengeId, signature: sign(kp, challenge.body.message) });
      expect(res.status).toBe(200);
      expect(res.body.wallet.verified).toBe(true);
    }
    const kp = Keypair.random();
    const added = await post("/v1/wallets", { address: kp.publicKey() });
    const challenge = await post(`/v1/wallets/${added.body.wallet.id}/challenge`);
    for (const signature of [[1, 2, 3], { type: "Buffer", data: [] }, { type: "Buffer", data: Array(64).fill(0) }, 12345, null]) {
      const res = await post(`/v1/wallets/${added.body.wallet.id}/verify`, { challengeId: challenge.body.challengeId, signature });
      expect(res.status).toBe(400);
    }
  });

  it("a challenge issued for one wallet cannot verify another", async () => {
    const a = Keypair.random();
    const b = Keypair.random();
    const wa = await post("/v1/wallets", { address: a.publicKey() });
    const wb = await post("/v1/wallets", { address: b.publicKey() });
    const challenge = await post(`/v1/wallets/${wa.body.wallet.id}/challenge`);
    const signature = Buffer.from(b.signMessage(challenge.body.message)).toString("base64");
    const res = await post(`/v1/wallets/${wb.body.wallet.id}/verify`, { challengeId: challenge.body.challengeId, signature });
    expect(res.status).toBe(404);
    expect((await prisma.wallet.findUniqueOrThrow({ where: { id: wb.body.wallet.id } })).verifiedAt).toBeNull();
  });

});
