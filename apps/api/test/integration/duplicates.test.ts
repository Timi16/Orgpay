import type { Run } from "@orgpay/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { confirmOpenBatches } from "../../src/engine/confirmer";
import { createRun, getRun, makeApp, nextBatch, ORIGIN, post, postOnce, prisma, resetDb, setupPayroll, sign, silentLogger, submit, type TestApp } from "../helpers/harness";

let t: TestApp;

beforeAll(() => {
  t = makeApp();
});
beforeEach(async () => {
  await resetDb();
  t.stellar.down = false;
  t.stellar.submitMode = "apply";
  t.stellar.ledgerTime = new Date();
  t.stellar.submits = 0;
  t.stellar.inFlight.length = 0;
  t.stellar.lagging.clear();
});
afterAll(async () => {
  await prisma.$disconnect();
});

const confirm = () => confirmOpenBatches({ prisma, payroll: t.payroll, logger: silentLogger });

describe("repeated requests", () => {
  it("D1: the same create-run request sent twice with one Idempotency-Key makes one run and returns the same response", async () => {
    const { company, wallet, people } = await setupPayroll(t, 2);
    const body = { name: "November", walletId: wallet.id, employeeIds: people.map((p) => p.id) };
    const first = await postOnce(company, "/v1/payroll-runs", body, "create-november-0001");
    const again = await postOnce(company, "/v1/payroll-runs", body, "create-november-0001");
    expect(first.status).toBe(201);
    expect(again.status).toBe(201);
    expect(again.headers["idempotent-replayed"]).toBe("true");
    expect(again.body).toEqual(first.body);
    expect(await prisma.payrollRun.count()).toBe(1);
    // Key order in the body doesn't matter.
    const reordered = await postOnce(company, "/v1/payroll-runs", { employeeIds: body.employeeIds, walletId: wallet.id, name: "November" }, "create-november-0001");
    expect(reordered.body.run.id).toBe(first.body.run.id);
    // A new action is a new key.
    expect((await postOnce(company, "/v1/payroll-runs", body)).body.run.number).toBe(2);
  });

  it("D2: a run can't be created without a key, and a key reused for a different request is 422", async () => {
    const { company, wallet } = await setupPayroll(t, 1);
    const missing = await post(company, "/v1/payroll-runs", { name: "No key", walletId: wallet.id });
    expect(missing.status).toBe(400);
    expect(missing.body.error.code).toBe("IDEMPOTENCY_KEY_REQUIRED");
    await postOnce(company, "/v1/payroll-runs", { name: "A", walletId: wallet.id }, "same-key-0001");
    const reused = await postOnce(company, "/v1/payroll-runs", { name: "B", walletId: wallet.id }, "same-key-0001");
    expect(reused.status).toBe(422);
    expect(reused.body.error.code).toBe("IDEMPOTENCY_KEY_REUSED");
    const otherRoute = await postOnce(company, "/v1/groups", { name: "A" }, "same-key-0001");
    expect(otherRoute.body.error.code).toBe("IDEMPOTENCY_KEY_REUSED");
    expect((await postOnce(company, "/v1/payroll-runs", { name: "C", walletId: wallet.id }, "short")).body.error.code).toBe("VALIDATION_FAILED");
    expect(await prisma.payrollRun.count()).toBe(1);
    // Keys belong to one company: another company can use the same value.
    const other = await setupPayroll(t, 0);
    expect((await postOnce(other.company, "/v1/payroll-runs", { name: "B", walletId: other.wallet.id }, "same-key-0001")).status).toBe(201);
  });

  it("D3: two identical requests racing with one key make one run; the loser waits or gets the same answer", async () => {
    const { company, wallet, people } = await setupPayroll(t, 3);
    const body = { name: "Race", walletId: wallet.id, employeeIds: people.map((p) => p.id) };
    const results = await Promise.all([1, 2, 3].map(() => postOnce(company, "/v1/payroll-runs", body, "race-key-0001")));
    for (const r of results) {
      expect([201, 409]).toContain(r.status);
      if (r.status === 409) expect(r.body.error.code).toBe("REQUEST_IN_PROGRESS");
    }
    expect(results.some((r) => r.status === 201)).toBe(true);
    expect(await prisma.payrollRun.count()).toBe(1);
    expect(await prisma.payrollItem.count()).toBe(3);
  });

  it("D4: Execute pressed twice starts the run once and builds nothing extra", async () => {
    const { company, wallet, people } = await setupPayroll(t, 2);
    const run = await createRun(company, wallet, { employeeIds: people.map((p) => p.id) });
    const both = await Promise.all([post(company, `/v1/payroll-runs/${run.id}/start`), post(company, `/v1/payroll-runs/${run.id}/start`)]);
    expect(both.map((r) => r.status).sort()).toEqual([200, 409]);
    expect((await prisma.payrollEvent.findMany({ where: { runId: run.id, type: "started" } })).length).toBe(1);
    // The same Execute retried with its key gets the first answer back.
    const second = await createRun(company, wallet, { employeeIds: [people[0]?.id] });
    const once = await postOnce(company, `/v1/payroll-runs/${second.id}/start`, {}, "execute-second-01");
    const replay = await postOnce(company, `/v1/payroll-runs/${second.id}/start`, {}, "execute-second-01");
    expect(once.status).toBe(200);
    expect(replay.status).toBe(200);
    expect(replay.body.run.status).toBe("PROCESSING");
    expect(await prisma.payrollBatch.count()).toBe(0);
  });

  it("D5: asking for the next transaction twice at once never builds two envelopes", async () => {
    const { company, wallet, people } = await setupPayroll(t, 2);
    const run = await createRun(company, wallet, { employeeIds: people.map((p) => p.id) });
    await post(company, `/v1/payroll-runs/${run.id}/start`);
    const both = await Promise.all([1, 2].map(() => post(company, `/v1/payroll-runs/${run.id}/transactions/next`)));
    const built = both.filter((r) => r.status === 200 && r.body.transaction).map((r) => r.body.transaction.id as string);
    expect(new Set(built).size).toBe(1);
    expect(await prisma.payrollBatch.count()).toBe(1);
    expect((await nextBatch(company, run.id)).batch?.id).toBe(built[0]);
  });

  it("D6: a delayed submit retried by the client, and the same signed transaction sent again, pay each employee exactly once", async () => {
    const { company, wallet, people } = await setupPayroll(t, 3, "250");
    const run = await createRun(company, wallet, { employeeIds: people.map((p) => p.id) });
    await post(company, `/v1/payroll-runs/${run.id}/start`);
    for (let i = 0; i < 3; i++) {
      const b = (await nextBatch(company, run.id)).batch!;
      const signed = sign(b, wallet.keypair);
      if (i === 0) {
        // The first answer never comes back: the client gives up and presses again.
        t.stellar.submitMode = "unknown";
        expect((await submit(company, run.id, b, signed)).status).toBe(202);
        t.stellar.submitMode = "apply";
        const retried = await submit(company, run.id, b, signed);
        expect(retried.status).toBe(202); // already submitted: not sent a second time
        t.stellar.landInFlight();
        await confirm();
      } else {
        await submit(company, run.id, b, signed);
        // Pressed again after it settled: the same answer, nothing sent.
        const again = await submit(company, run.id, b, signed);
        expect(again.status).toBe(200);
        expect(again.body.transaction.status).toBe("CONFIRMED");
      }
    }
    const done = await getRun(company, run.id);
    expect(done.status).toBe("COMPLETED");
    expect(t.stellar.submits).toBe(3);
    for (const p of people) expect(t.stellar.usdcBalance(p.walletAddress)).toBe("250.0000000");
    expect(t.stellar.usdcBalance(wallet.address)).toBe("99250.0000000");
    expect(done.events.filter((e) => e.type === "confirmed")).toHaveLength(3);
  });

  it("D7: retrying a finished run never sends a SUCCESSFUL payment again", async () => {
    const { company, wallet, people } = await setupPayroll(t, 2);
    t.stellar.noTrustline(people[1]?.walletAddress ?? "");
    const run = await createRun(company, wallet, { employeeIds: people.map((p) => p.id) });
    await post(company, `/v1/payroll-runs/${run.id}/start`);
    const b = (await nextBatch(company, run.id)).batch!;
    expect(b.paymentIds).toEqual([run.payments[0]?.id]);
    await submit(company, run.id, b, sign(b, wallet.keypair));
    t.stellar.addTrustline(people[1]?.walletAddress ?? "");
    const retried = (await post(company, `/v1/payroll-runs/${run.id}/retry`)).body.run as Run;
    expect(retried.payments.map((p) => p.status)).toEqual(["SUCCESSFUL", "PENDING"]);
    const b2 = (await nextBatch(company, run.id)).batch!;
    expect(b2.paymentIds).toEqual([run.payments[1]?.id]);
    await submit(company, run.id, b2, sign(b2, wallet.keypair));
    expect((await post(company, `/v1/payroll-runs/${run.id}/retry`)).status).toBe(409);
    expect(t.stellar.usdcBalance(people[0]?.walletAddress ?? "")).toBe("1000.0000000");
    expect(t.stellar.usdcBalance(people[1]?.walletAddress ?? "")).toBe("1000.0000000");
    // Writes other than run creation may carry a key too, and a replay changes nothing.
    const g1 = await company.agent.post("/v1/groups").set("Origin", ORIGIN).set("Idempotency-Key", "group-create-01").send({ name: "Ops" });
    const g2 = await company.agent.post("/v1/groups").set("Origin", ORIGIN).set("Idempotency-Key", "group-create-01").send({ name: "Ops" });
    expect(g2.body).toEqual(g1.body);
    expect(await prisma.group.count()).toBe(1);
  });
});
