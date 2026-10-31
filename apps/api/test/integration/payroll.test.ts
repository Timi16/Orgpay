import type { Run } from "@orgpay/shared";
import { Account, Asset, Keypair, Operation, TransactionBuilder, type Transaction } from "@stellar/stellar-sdk";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { confirmOpenBatches } from "../../src/engine/confirmer";
import { notifyRuns } from "../../src/engine/notifier";
import {
  addEmployee,
  addFundingWallet,
  createRun,
  getRun,
  makeApp,
  nextBatch,
  ORIGIN,
  PASSPHRASE,
  payAll,
  post,
  prisma,
  resetDb,
  setupPayroll,
  sign,
  signup,
  silentLogger,
  submit,
  type TestApp,
} from "../helpers/harness";

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
const statuses = (run: Run) => run.payments.map((i) => i.status);
/** Moves the fake network's clock past every batch window. */
const passWindow = () => t.stellar.closeLedger(10 * 60_000);

describe("payroll runs", () => {
  it("R1: a run from groups and people has one line per active person, no duplicates, default amounts, and an exact total", async () => {
    const { company, wallet } = await setupPayroll(t, 0);
    const eng = (await post(company, "/v1/groups", { name: "Engineering" })).body.group;
    const ada = await addEmployee(company, { name: "Ada", groupId: eng.id, salary: "3200.10" });
    const bob = await addEmployee(company, { name: "Bob", groupId: eng.id, salary: "0.0000001" });
    const cy = await addEmployee(company, { name: "Cy", salary: "2850" });
    await addEmployee(company, { name: "Dee" }); // not picked
    const run = await createRun(company, wallet, { groupIds: [eng.id], employeeIds: [ada.id, cy.id], payDate: "2026-10-31" });
    expect(run).toMatchObject({ number: 1, status: "DRAFT", payDate: "2026-10-31", total: "6050.1000001", totalStroops: "60501000001" });
    expect(run.payments.map((i) => [i.position, i.name, i.amount])).toEqual([
      [1, "Ada", "3200.1000000"],
      [2, "Bob", "0.0000001"],
      [3, "Cy", "2850.0000000"],
    ]);
    // Adding the group again adds nobody twice; numbers count up per company.
    const again = await post(company, `/v1/payroll-runs/${run.id}/payments`, { groupIds: [eng.id], employeeIds: [bob.id] });
    expect(again.body.run.payments).toHaveLength(3);
    expect((await createRun(company, wallet, { employeeIds: [ada.id] })).number).toBe(2);
    const other = await signup(t);
    expect((await createRun(other, await addFundingWallet(t, other), {})).number).toBe(1);
  });

  it("R2: payments, name, date and wallet can only change while the run is a draft (409 RUN_LOCKED); executing twice is 409", async () => {
    const { company, wallet, people } = await setupPayroll(t, 2);
    const run = await createRun(company, wallet, { employeeIds: [people[0]?.id] });
    const item = run.payments[0]?.id;
    expect((await company.agent.patch(`/v1/payroll-runs/${run.id}/payments/${item}`).set("Origin", ORIGIN).send({ amount: "1234.5" })).body.run.total).toBe("1234.5000000");
    expect((await post(company, `/v1/payroll-runs/${run.id}/start`)).status).toBe(200);
    for (const res of [
      await company.agent.patch(`/v1/payroll-runs/${run.id}/payments/${item}`).set("Origin", ORIGIN).send({ amount: "1" }),
      await company.agent.delete(`/v1/payroll-runs/${run.id}/payments/${item}`).set("Origin", ORIGIN),
      await post(company, `/v1/payroll-runs/${run.id}/payments`, { employeeIds: [people[1]?.id] }),
      await company.agent.patch(`/v1/payroll-runs/${run.id}`).set("Origin", ORIGIN).send({ name: "Renamed" }),
      await company.agent.delete(`/v1/payroll-runs/${run.id}`).set("Origin", ORIGIN),
    ]) {
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("RUN_LOCKED");
    }
    const twice = await post(company, `/v1/payroll-runs/${run.id}/start`);
    expect(twice.status).toBe(409);
    expect(twice.body.error.code).toBe("INVALID_TRANSITION");
    expect((await getRun(company, run.id)).payments[0]?.amount).toBe("1234.5000000");
  });

  it("R3: at start, people who can't receive are marked failed with the reason and never sent anything; the rest are paid", async () => {
    const { company, wallet, people } = await setupPayroll(t, 3);
    const tomas = people[1];
    t.stellar.noTrustline(tomas?.walletAddress ?? "");
    const run = await createRun(company, wallet, { employeeIds: people.map((p) => p.id), paymentsPerTx: 100 });
    const check = await company.agent.get(`/v1/payroll-runs/${run.id}/check`);
    expect(check.body.check).toMatchObject({ payableCount: 2, payableTotal: "2000.0000000", excludedCount: 1, funding: { enough: true, problem: null } });
    expect(check.body.check.payments.find((l: { ok: boolean }) => !l.ok)).toMatchObject({ reason: "NO_TRUSTLINE" });

    const started = (await post(company, `/v1/payroll-runs/${run.id}/start`)).body.run as Run;
    expect(started.status).toBe("PROCESSING");
    expect(started.payments.find((i) => i.employeeId === tomas?.id)).toMatchObject({ status: "FAILED", failureCode: "NO_TRUSTLINE", txHash: null });
    const { batch } = await nextBatch(company, run.id);
    expect(batch?.opCount).toBe(2);
    const done = (await submit(company, run.id, batch!, sign(batch!, wallet.keypair))).body.run as Run;
    expect(done.status).toBe("PARTIALLY_PAID");
    expect(done).toMatchObject({ paidTotal: "2000.0000000", failedTotal: "1000.0000000", counts: { successful: 2, failed: 1 } });
    expect(t.stellar.usdcBalance(tomas?.walletAddress ?? "")).toBe("none");
    expect(t.stellar.usdcBalance(people[0]?.walletAddress ?? "")).toBe("1000.0000000");
  });

  it("R4: a funding wallet short of USDC or XLM refuses the start with INSUFFICIENT_FUNDS and nothing changes", async () => {
    const { company, wallet, people } = await setupPayroll(t, 2, "600");
    t.stellar.noTrustline(people[1]?.walletAddress ?? "");
    t.stellar.fund(wallet.address, "500");
    const run = await createRun(company, wallet, { employeeIds: people.map((p) => p.id) });
    const res = await post(company, `/v1/payroll-runs/${run.id}/start`);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({ code: "INSUFFICIENT_FUNDS", details: [{ problem: "INSUFFICIENT_USDC", shortBy: "100.0000000" }] });
    const after = await getRun(company, run.id);
    expect(after.status).toBe("DRAFT");
    expect(statuses(after)).toEqual(["PENDING", "PENDING"]); // the exclusion was rolled back too

    t.stellar.fund(wallet.address, "5000", "1"); // 1 XLM is all locked in the reserve
    expect((await post(company, `/v1/payroll-runs/${run.id}/start`)).body.error.details[0].problem).toBe("INSUFFICIENT_XLM");
    t.stellar.noTrustline(wallet.address);
    expect((await post(company, `/v1/payroll-runs/${run.id}/start`)).body.error.details[0].problem).toBe("NO_TRUSTLINE");
    t.stellar.noAccount(wallet.address);
    expect((await post(company, `/v1/payroll-runs/${run.id}/start`)).body.error.details[0].problem).toBe("ACCOUNT_NOT_FOUND");
    expect((await getRun(company, run.id)).status).toBe("DRAFT");
  });

  it("R5: starting with nobody on the run, or nobody who can receive, is 409 NOTHING_TO_PAY", async () => {
    const { company, wallet, people } = await setupPayroll(t, 1);
    const empty = await createRun(company, wallet, {});
    expect((await post(company, `/v1/payroll-runs/${empty.id}/start`)).body.error.code).toBe("NOTHING_TO_PAY");
    t.stellar.noAccount(people[0]?.walletAddress ?? "");
    const run = await createRun(company, wallet, { employeeIds: [people[0]?.id] });
    const res = await post(company, `/v1/payroll-runs/${run.id}/start`);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("NOTHING_TO_PAY");
    expect((await getRun(company, run.id)).status).toBe("DRAFT");
  });

  it("R6: a batch is at most 100 payments with the right sequence, memo and timebounds; asking again returns the same envelope", async () => {
    const { company, wallet, people } = await setupPayroll(t, 101, "10");
    const run = await createRun(company, wallet, { employeeIds: people.map((p) => p.id), paymentsPerTx: 100 });
    await post(company, `/v1/payroll-runs/${run.id}/start`);
    const first = await nextBatch(company, run.id);
    const b = first.batch!;
    expect(b).toMatchObject({ number: 1, opCount: 100, total: "1000.0000000", status: "AWAITING_SIGNATURE", networkPassphrase: PASSPHRASE });
    const tx = TransactionBuilder.fromXDR(b.xdr, PASSPHRASE) as Transaction;
    expect(tx.source).toBe(wallet.address);
    expect(tx.sequence).toBe("101"); // the fake account starts at 100
    expect(tx.operations).toHaveLength(100);
    expect(tx.operations[0]).toMatchObject({ type: "payment", destination: run.payments[0]?.walletAddress, amount: "10.0000000", asset: { code: "USDC" } });
    expect(Buffer.from(tx.memo.value as Uint8Array).toString()).toBe("OrgPay R1 T1");
    const maxTime = Number.parseInt(tx.timeBounds?.maxTime ?? "0", 10) * 1000;
    expect(maxTime - Date.now()).toBeGreaterThan(290_000);
    expect(maxTime - Date.now()).toBeLessThanOrEqual(300_000);
    expect(new Date(b.maxTime).getTime()).toBe(maxTime);
    // Asking again (a reload, a second tab) gets the very same envelope, never a second one.
    const again = await nextBatch(company, run.id);
    expect(again.batch).toMatchObject({ id: b.id, txHash: b.txHash, xdr: b.xdr });
    expect(await prisma.payrollBatch.count()).toBe(1);
    // After it lands, the 101st person goes in batch 2 at the next sequence number.
    await submit(company, run.id, b, sign(b, wallet.keypair));
    const second = (await nextBatch(company, run.id)).batch!;
    expect(second).toMatchObject({ number: 2, opCount: 1 });
    expect(TransactionBuilder.fromXDR(second.xdr, PASSPHRASE)).toMatchObject({ sequence: "102" });
    await submit(company, run.id, second, sign(second, wallet.keypair));
    expect((await getRun(company, run.id)).status).toBe("COMPLETED");
  });

  it("R7: a different transaction, an unsigned one, or one signed by another key is refused and nothing is submitted", async () => {
    const { company, wallet, people } = await setupPayroll(t, 1);
    const run = await createRun(company, wallet, { employeeIds: [people[0]?.id] });
    await post(company, `/v1/payroll-runs/${run.id}/start`);
    const b = (await nextBatch(company, run.id)).batch!;
    // The browser swaps the destination for its own address and signs that instead.
    const swapped = new TransactionBuilder(new Account(wallet.address, "100"), { fee: "1000", networkPassphrase: PASSPHRASE })
      .addOperation(Operation.payment({ destination: Keypair.random().publicKey(), asset: new Asset("USDC", "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5"), amount: "1000" }))
      .setTimeout(300)
      .build();
    swapped.sign(wallet.keypair);
    expect((await submit(company, run.id, b, swapped.toXDR())).body.error.code).toBe("TX_MISMATCH");
    // The right transaction, but nobody signed it.
    const unsigned = TransactionBuilder.fromXDR(b.xdr, PASSPHRASE).toXDR();
    expect((await submit(company, run.id, b, unsigned)).body.error.code).toBe("INVALID_SIGNATURE");
    expect((await submit(company, run.id, b, sign(b, Keypair.random()))).body.error.code).toBe("INVALID_SIGNATURE");
    expect((await submit(company, run.id, b, "not xdr")).body.error.code).toBe("VALIDATION_FAILED");
    expect(t.stellar.submits).toBe(0);
    expect((await prisma.payrollBatch.findUniqueOrThrow({ where: { id: b.id } })).status).toBe("AWAITING_SIGNATURE");
  });

  it("R8: by default every payment is its own transaction: each is SUCCESSFUL with its own verified hash, ledger and close time, and the run COMPLETED", async () => {
    const { company, wallet, people } = await setupPayroll(t, 3);
    const run = await createRun(company, wallet, { employeeIds: people.map((p) => p.id) });
    expect(run).toMatchObject({ paymentsPerTx: 1, employeeCount: 3, total: "3000.0000000" });
    const done = await payAll(company, run.id, wallet);
    expect(done.status).toBe("COMPLETED");
    expect(done.counts).toMatchObject({ payments: 3, successful: 3, pending: 0, submitted: 0, failed: 0 });
    expect(done.transactions).toHaveLength(3);
    expect(new Set(done.transactions.map((tx) => tx.txHash)).size).toBe(3);
    for (const [i, payment] of done.payments.entries()) {
      const tx = done.transactions[i]!;
      expect(tx).toMatchObject({ number: i + 1, status: "CONFIRMED", opCount: 1, explorerUrl: `https://stellar.expert/explorer/testnet/tx/${tx.txHash}` });
      expect(payment).toMatchObject({ status: "SUCCESSFUL", txHash: tx.txHash, ledger: tx.ledger, transactionNumber: i + 1, attempts: 1, explorerUrl: tx.explorerUrl });
      expect(payment.paidAt).toBe(tx.closedAt);
      expect(payment.verifiedAt).not.toBeNull();
      // On the ledger: the memo names the run and the payment's position; one payment to this employee.
      const landed = TransactionBuilder.fromXDR(t.stellar.txs.get(tx.txHash)!.envelopeXdr, PASSPHRASE) as Transaction;
      expect(Buffer.from(landed.memo.value as Uint8Array).toString()).toBe(`OrgPay R1 P${payment.position}`);
      expect(landed.operations).toEqual([expect.objectContaining({ type: "payment", destination: payment.walletAddress, amount: payment.amount })]);
    }
    const perTx = ["transaction_built", "submitted", "confirmed"];
    expect(done.events.map((e) => e.type)).toEqual(["created", "started", ...perTx, ...perTx, ...perTx, "finished"]);
    expect((await company.agent.get("/v1/summary")).body).toMatchObject({ paidThisMonth: "3000.0000000", peoplePaidThisMonth: 3, recentRuns: [{ id: run.id }] });
  });

  it("R8: with paymentsPerTx > 1 the payments share one transaction, each verified at its own operation", async () => {
    const { company, wallet, people } = await setupPayroll(t, 3);
    const run = await createRun(company, wallet, { employeeIds: people.map((p) => p.id), paymentsPerTx: 100 });
    const done = await payAll(company, run.id, wallet);
    expect(done.status).toBe("COMPLETED");
    const tx = done.transactions[0]!;
    expect(done.transactions).toHaveLength(1);
    expect(tx).toMatchObject({ status: "CONFIRMED", opCount: 3, ledger: t.stellar.ledger });
    for (const payment of done.payments) {
      expect(payment).toMatchObject({ status: "SUCCESSFUL", txHash: tx.txHash, ledger: tx.ledger, transactionNumber: 1, attempts: 1 });
    }
    expect(done.events.map((e) => e.type)).toEqual(["created", "started", "transaction_built", "submitted", "confirmed", "finished"]);
  });

  it("R9: tx_failed with op_no_trust fails that line only; the others were not sent and go in the next batch", async () => {
    const { company, wallet, people } = await setupPayroll(t, 3);
    const run = await createRun(company, wallet, { employeeIds: people.map((p) => p.id), paymentsPerTx: 100 });
    await post(company, `/v1/payroll-runs/${run.id}/start`);
    const b = (await nextBatch(company, run.id)).batch!;
    t.stellar.noTrustline(people[1]?.walletAddress ?? ""); // removed between the check and the signature
    const res = await submit(company, run.id, b, sign(b, wallet.keypair));
    expect(res.status).toBe(200);
    expect(res.body.transaction).toMatchObject({ status: "FAILED", resultCode: "tx_failed" });
    const after = res.body.run as Run;
    expect(after.status).toBe("PROCESSING");
    expect(after.payments.map((i) => [i.status, i.failureCode])).toEqual([["PENDING", null], ["FAILED", "NO_TRUSTLINE"], ["PENDING", null]]);
    expect(after.payments[1]?.failureDetail).toBe("op_no_trust");
    expect(t.stellar.usdcBalance(people[0]?.walletAddress ?? "")).toBe("0.0000000"); // all or nothing
    // The next batch carries the two who weren't paid.
    const b2 = (await nextBatch(company, run.id)).batch!;
    expect(b2).toMatchObject({ number: 2, opCount: 2 });
    const final = (await submit(company, run.id, b2, sign(b2, wallet.keypair))).body.run as Run;
    expect(final.status).toBe("PARTIALLY_PAID");
    expect(final.payments.map((i) => i.attempts)).toEqual([2, 1, 2]);
  });

  it("R10: a submit that times out leaves the batch SUBMITTED (202); the confirmer finds it on the ledger and marks it paid", async () => {
    const { company, wallet, people } = await setupPayroll(t, 2);
    const run = await createRun(company, wallet, { employeeIds: people.map((p) => p.id), paymentsPerTx: 100 });
    await post(company, `/v1/payroll-runs/${run.id}/start`);
    const b = (await nextBatch(company, run.id)).batch!;
    t.stellar.submitMode = "unknown";
    const res = await submit(company, run.id, b, sign(b, wallet.keypair));
    expect(res.status).toBe(202);
    expect(res.body.transaction.status).toBe("SUBMITTED");
    expect(statuses(res.body.run)).toEqual(["SUBMITTED", "SUBMITTED"]);
    // Nothing new can be built while it might still land.
    expect((await nextBatch(company, run.id)).batch).toBeNull();
    expect(await confirm()).toBe(0); // not on the ledger yet, window still open
    t.stellar.landInFlight();
    expect(await confirm()).toBe(1);
    expect((await getRun(company, run.id)).status).toBe("COMPLETED");
  });

  it("R11: a batch signed and submitted somewhere else is found by the confirmer and marked paid, never paid again", async () => {
    const { company, wallet, people } = await setupPayroll(t, 2);
    const run = await createRun(company, wallet, { employeeIds: people.map((p) => p.id), paymentsPerTx: 100 });
    await post(company, `/v1/payroll-runs/${run.id}/start`);
    const b = (await nextBatch(company, run.id)).batch!;
    t.stellar.apply(sign(b, wallet.keypair)); // e.g. Freighter or a script submitted it directly
    expect(await confirm()).toBe(1);
    const after = await getRun(company, run.id);
    expect(after.status).toBe("COMPLETED");
    expect(after.payments.every((i) => i.txHash === b.txHash)).toBe(true);
    expect((await nextBatch(company, run.id)).batch).toBeNull();
    expect(t.stellar.usdcBalance(people[0]?.walletAddress ?? "")).toBe("1000.0000000");
  });

  it("R12: a batch never signed expires only once a ledger closes after its window; then a new envelope is built", async () => {
    const quick = makeApp({}, { batchWindowSeconds: 1 });
    const { company, wallet, people } = await setupPayroll(quick, 2);
    const run = await createRun(company, wallet, { employeeIds: people.map((p) => p.id), paymentsPerTx: 100 });
    await post(company, `/v1/payroll-runs/${run.id}/start`);
    const b = (await nextBatch(company, run.id)).batch!;
    const quickConfirm = () => confirmOpenBatches({ prisma, payroll: quick.payroll, logger: silentLogger });
    expect(await quickConfirm()).toBe(0);
    // Our clock says the window is over, but no ledger has closed after it: still open.
    await new Promise((r) => setTimeout(r, 2100));
    quick.stellar.ledgerTime = new Date(new Date(b.maxTime).getTime() - 1000);
    expect((await nextBatch(company, run.id)).batch).toBeNull();
    expect((await prisma.payrollBatch.findUniqueOrThrow({ where: { id: b.id } })).status).toBe("AWAITING_SIGNATURE");
    // A ledger closes inside the 30 s grace after the window: still not trusted as final.
    quick.stellar.closeLedger(10_000);
    expect((await nextBatch(company, run.id)).batch).toBeNull();
    // Past the grace too: it can never land now, so a new envelope is built.
    quick.stellar.closeLedger(40_000);
    const fresh = (await nextBatch(company, run.id)).batch!;
    expect(fresh).toMatchObject({ number: 2, opCount: 2 });
    expect(fresh.txHash).not.toBe(b.txHash);
    expect(new Date(fresh.maxTime).getTime()).toBeGreaterThan(new Date(b.maxTime).getTime());
    expect((await prisma.payrollBatch.findUniqueOrThrow({ where: { id: b.id } })).status).toBe("EXPIRED");
    // The expired envelope is refused by the network, even if someone tries.
    expect(quick.stellar.apply(sign(b, wallet.keypair))).toMatchObject({ kind: "failed", txCode: "tx_too_late" });
  });

  it("R13: retry puts a failed line back only after a passing check; paid lines are never queued again", async () => {
    const { company, wallet, people } = await setupPayroll(t, 2);
    t.stellar.noTrustline(people[1]?.walletAddress ?? "");
    const run = await createRun(company, wallet, { employeeIds: people.map((p) => p.id) });
    const first = await payAll(company, run.id, wallet);
    expect(first.status).toBe("PARTIALLY_PAID");
    // Still no trustline: retry keeps it failed and the run as it is.
    const still = (await post(company, `/v1/payroll-runs/${run.id}/retry`)).body.run as Run;
    expect(still.status).toBe("PARTIALLY_PAID");
    expect(still.payments[1]).toMatchObject({ status: "FAILED", failureCode: "NO_TRUSTLINE" });
    t.stellar.addTrustline(people[1]?.walletAddress ?? "");
    const retried = (await post(company, `/v1/payroll-runs/${run.id}/retry`)).body.run as Run;
    expect(retried.status).toBe("PROCESSING");
    expect(statuses(retried)).toEqual(["SUCCESSFUL", "PENDING"]);
    const b = (await nextBatch(company, run.id)).batch!;
    expect(b.opCount).toBe(1);
    const final = (await submit(company, run.id, b, sign(b, wallet.keypair))).body.run as Run;
    expect(final.status).toBe("COMPLETED");
    expect(t.stellar.usdcBalance(people[0]?.walletAddress ?? "")).toBe("1000.0000000"); // once, not twice
    expect((await post(company, `/v1/payroll-runs/${run.id}/retry`)).body.error.code).toBe("RUN_LOCKED");
  });

  it("R14: cancel works on a draft and on unsent payments, but not while a batch is open", async () => {
    const { company, wallet, people } = await setupPayroll(t, 2);
    const draft = await createRun(company, wallet, { employeeIds: [people[0]?.id] });
    expect(((await post(company, `/v1/payroll-runs/${draft.id}/cancel`)).body.run as Run).status).toBe("CANCELLED");
    expect((await post(company, `/v1/payroll-runs/${draft.id}/start`)).body.error.code).toBe("INVALID_TRANSITION");

    const run = await createRun(company, wallet, { employeeIds: people.map((p) => p.id) });
    await post(company, `/v1/payroll-runs/${run.id}/start`);
    await nextBatch(company, run.id);
    expect((await post(company, `/v1/payroll-runs/${run.id}/cancel`)).body.error.code).toBe("RUN_LOCKED");
    passWindow();
    await confirm(); // the unsigned batch expires; its lines are pending again
    const cancelled = (await post(company, `/v1/payroll-runs/${run.id}/cancel`)).body.run as Run;
    expect(cancelled.status).toBe("CANCELLED");
    expect(statuses(cancelled)).toEqual(["CANCELLED", "CANCELLED"]);
    expect(t.stellar.submits).toBe(0);
  });

  it("R15: a finished run is PAID when everyone was paid, PARTIAL when some failed, FAILED when nobody was paid", async () => {
    const { company, wallet, people } = await setupPayroll(t, 2);
    const ok = await payAll(company, (await createRun(company, wallet, { employeeIds: people.map((p) => p.id) })).id, wallet);
    expect(ok.status).toBe("COMPLETED");

    // Nobody paid: both trustlines disappear after the start, so the batch fails on both.
    const run = await createRun(company, wallet, { employeeIds: people.map((p) => p.id), paymentsPerTx: 100 });
    await post(company, `/v1/payroll-runs/${run.id}/start`);
    const b = (await nextBatch(company, run.id)).batch!;
    for (const p of people) t.stellar.noTrustline(p.walletAddress);
    const failed = (await submit(company, run.id, b, sign(b, wallet.keypair))).body.run as Run;
    expect(failed.status).toBe("FAILED");
    expect(failed.finishedAt).not.toBeNull();
    // The company is emailed once about each finish.
    await notifyRuns({ prisma, mailer: t.mailer, webOrigin: ORIGIN, logger: silentLogger });
    await notifyRuns({ prisma, mailer: t.mailer, webOrigin: ORIGIN, logger: silentLogger });
    const subjects = t.mailer.sent.map((m) => m.subject);
    expect(subjects.filter((s) => s.startsWith("Payroll #1 paid"))).toHaveLength(1);
    expect(subjects.filter((s) => s.startsWith("Payroll #2: nobody was paid"))).toHaveLength(1);
    expect(t.mailer.sent.find((m) => m.subject.startsWith("Payroll #2"))?.text).toContain("no USDC trustline");
  });

  it("R16: the same signed batch submitted twice, or racing the confirmer, is sent and settled once", async () => {
    const { company, wallet, people } = await setupPayroll(t, 2);
    const run = await createRun(company, wallet, { employeeIds: people.map((p) => p.id), paymentsPerTx: 100 });
    await post(company, `/v1/payroll-runs/${run.id}/start`);
    const b = (await nextBatch(company, run.id)).batch!;
    const signed = sign(b, wallet.keypair);
    const results = await Promise.all([submit(company, run.id, b, signed), submit(company, run.id, b, signed), confirm()]);
    expect(t.stellar.submits).toBe(1);
    // One of the two submits did the work; the other saw it was already in flight or settled.
    for (const r of results.slice(0, 2)) expect([200, 202]).toContain((r as { status: number }).status);
    const again = await submit(company, run.id, b, signed);
    expect(again.status).toBe(200);
    expect(again.body.transaction.status).toBe("CONFIRMED");
    expect(t.stellar.submits).toBe(1);
    const after = await getRun(company, run.id);
    expect(after.status).toBe("COMPLETED");
    expect(after.events.filter((e) => e.type === "confirmed")).toHaveLength(1);
    expect(t.stellar.usdcBalance(people[0]?.walletAddress ?? "")).toBe("1000.0000000");
  });

  it("R17: a rejection before a ledger (here tx_bad_seq) is never taken as final: the batch waits, then expires by ledger time and the lines go back", async () => {
    const { company, wallet, people } = await setupPayroll(t, 1);
    const run = await createRun(company, wallet, { employeeIds: [people[0]?.id] });
    await post(company, `/v1/payroll-runs/${run.id}/start`);
    const b = (await nextBatch(company, run.id)).batch!;
    t.stellar.bumpSequence(wallet.address); // the company sent something else from this wallet first
    const res = await submit(company, run.id, b, sign(b, wallet.keypair));
    expect(res.status).toBe(202);
    expect(res.body.transaction).toMatchObject({ status: "SUBMITTED", resultCode: "tx_bad_seq" });
    expect((await nextBatch(company, run.id)).batch).toBeNull(); // nothing new while it could still land
    // Past the window, but the sequence was used: wait out the grace period first.
    t.stellar.closeLedger(301_000);
    expect(await confirm()).toBe(0);
    passWindow();
    expect(await confirm()).toBe(1);
    expect(statuses(await getRun(company, run.id))).toEqual(["PENDING"]);
    t.stellar.ledgerTime = new Date(); // back in step with the server's clock
    const b2 = (await nextBatch(company, run.id)).batch!;
    expect(TransactionBuilder.fromXDR(b2.xdr, PASSPHRASE)).toMatchObject({ sequence: "102" });
    expect(((await submit(company, run.id, b2, sign(b2, wallet.keypair))).body.run as Run).status).toBe("COMPLETED");
  });

  it("R16: a batch that landed elsewhere first, so OrgPay's own submit gets tx_bad_seq, is recorded as paid and never re-queued", async () => {
    const { company, wallet, people } = await setupPayroll(t, 2);
    const run = await createRun(company, wallet, { employeeIds: people.map((p) => p.id), paymentsPerTx: 100 });
    await post(company, `/v1/payroll-runs/${run.id}/start`);
    const b = (await nextBatch(company, run.id)).batch!;
    const signed = sign(b, wallet.keypair);
    t.stellar.apply(signed); // e.g. the wallet also submitted it
    t.stellar.lagging.add(b.txHash); // and the Horizon node OrgPay asks hasn't seen it yet
    const res = await submit(company, run.id, b, signed);
    expect(res.body.transaction).toMatchObject({ status: "SUBMITTED", resultCode: "tx_bad_seq" });
    expect(statuses(res.body.run)).toEqual(["SUBMITTED", "SUBMITTED"]);
    // Even past the window, a lagging node's 404 is not trusted while the sequence is used.
    t.stellar.closeLedger(301_000);
    expect(await confirm()).toBe(0);
    t.stellar.lagging.clear();
    expect(await confirm()).toBe(1);
    const after = await getRun(company, run.id);
    expect(after.status).toBe("COMPLETED");
    expect(t.stellar.usdcBalance(people[0]?.walletAddress ?? "")).toBe("1000.0000000");
  });

  it("R16: a 'not found' from a Horizon node that is behind never expires a batch, even long past its window", async () => {
    const { company, wallet, people } = await setupPayroll(t, 1);
    const run = await createRun(company, wallet, { employeeIds: [people[0]?.id] });
    await post(company, `/v1/payroll-runs/${run.id}/start`);
    const b = (await nextBatch(company, run.id)).batch!;
    t.stellar.lagging.add(b.txHash);
    passWindow();
    expect(await confirm()).toBe(0);
    expect((await prisma.payrollBatch.findUniqueOrThrow({ where: { id: b.id } })).status).toBe("AWAITING_SIGNATURE");
    t.stellar.lagging.clear();
    // The confirmer looks at an unsigned batch at most every 30 s.
    expect(await confirmOpenBatches({ prisma, payroll: t.payroll, logger: silentLogger }, Date.now() + 31_000)).toBe(1);
    expect((await prisma.payrollBatch.findUniqueOrThrow({ where: { id: b.id } })).status).toBe("EXPIRED");
  });

  it("R9: a tx_failed answer at submission is final only once the ledger shows it", async () => {
    const { company, wallet, people } = await setupPayroll(t, 2);
    const run = await createRun(company, wallet, { employeeIds: people.map((p) => p.id), paymentsPerTx: 100 });
    await post(company, `/v1/payroll-runs/${run.id}/start`);
    const b = (await nextBatch(company, run.id)).batch!;
    t.stellar.submitMode = { reject: "tx_failed" }; // e.g. op_bad_auth at validation: never reached a ledger
    const res = await submit(company, run.id, b, sign(b, wallet.keypair));
    expect(res.status).toBe(202);
    expect(res.body.transaction).toMatchObject({ status: "SUBMITTED", resultCode: "tx_failed" });
    expect(statuses(res.body.run)).toEqual(["SUBMITTED", "SUBMITTED"]);
  });

  it("R8: the paid time is the ledger's close time, not the server's clock", async () => {
    const { company, wallet, people } = await setupPayroll(t, 1);
    t.stellar.ledgerTime = new Date("2026-09-30T23:59:50Z");
    const run = await createRun(company, wallet, { employeeIds: [people[0]?.id] });
    await post(company, `/v1/payroll-runs/${run.id}/start`);
    const b = (await nextBatch(company, run.id)).batch!;
    await submit(company, run.id, b, sign(b, wallet.keypair));
    const after = await getRun(company, run.id);
    expect(after.payments[0]?.paidAt).toBe(t.stellar.txs.get(b.txHash)?.closedAt.toISOString());
    expect(after.payments[0]?.paidAt?.startsWith("2026-09-30")).toBe(true);
  });

  it("R10: a signed batch the network never received is sent again by the confirmer while its window is open", async () => {
    const { company, wallet, people } = await setupPayroll(t, 1);
    const run = await createRun(company, wallet, { employeeIds: [people[0]?.id] });
    await post(company, `/v1/payroll-runs/${run.id}/start`);
    const b = (await nextBatch(company, run.id)).batch!;
    t.stellar.submitMode = { reject: "tx_insufficient_fee" }; // e.g. a fee surge
    expect((await submit(company, run.id, b, sign(b, wallet.keypair))).status).toBe(202);
    t.stellar.submitMode = "apply";
    // Not re-sent straight away (at most every 30 s)…
    expect(await confirm()).toBe(0);
    expect(t.stellar.submits).toBe(1);
    // …but once 30 s have passed since it was sent, it is.
    await prisma.payrollBatch.update({ where: { id: b.id }, data: { submittedAt: new Date(Date.now() - 31_000) } });
    expect(await confirm()).toBe(1);
    expect((await getRun(company, run.id)).status).toBe("COMPLETED");
    expect(t.stellar.submits).toBe(2);
  });

  it("R14: cancelling part-way leaves the run PARTIAL (not PAID), cancels failed lines too, and retry can't undo it", async () => {
    const { company, wallet, people } = await setupPayroll(t, 3);
    t.stellar.noTrustline(people[2]?.walletAddress ?? "");
    const run = await createRun(company, wallet, { employeeIds: people.map((p) => p.id), paymentsPerTx: 100 });
    await post(company, `/v1/payroll-runs/${run.id}/start`);
    // Pay only the first person, then cancel the rest.
    const b = (await nextBatch(company, run.id)).batch!;
    expect(b.opCount).toBe(2);
    await submit(company, run.id, b, sign(b, wallet.keypair));
    await prisma.$executeRaw`UPDATE "PayrollItem" SET status = 'PENDING', "txHash" = NULL, "paidAt" = NULL WHERE "runId" = ${run.id} AND position = 2`;
    await prisma.$executeRaw`UPDATE "PayrollRun" SET status = 'PROCESSING', "finishedAt" = NULL WHERE id = ${run.id}`;
    const cancelled = (await post(company, `/v1/payroll-runs/${run.id}/cancel`)).body.run as Run;
    expect(cancelled.status).toBe("PARTIALLY_PAID");
    expect(statuses(cancelled)).toEqual(["SUCCESSFUL", "CANCELLED", "CANCELLED"]);
    expect(cancelled.events.at(-1)?.message).toContain("Cancelled after 1 successful");
    expect((await post(company, `/v1/payroll-runs/${run.id}/retry`)).body.error.code).toBe("NOTHING_TO_PAY");
  });
});

describe("review and records", () => {
  it("R18: payments per transaction is 1 to 100, set at creation or on the draft, and fixed once executed", async () => {
    const { company, wallet, people } = await setupPayroll(t, 3);
    const patch = (id: string, body: object) => company.agent.patch(`/v1/payroll-runs/${id}`).set("Origin", ORIGIN).send(body);
    for (const bad of [0, 101, 1.5, "2"]) {
      expect((await post(company, "/v1/payroll-runs", { name: "x", walletId: wallet.id, paymentsPerTx: bad })).status).toBe(400);
    }
    const run = await createRun(company, wallet, { employeeIds: people.map((p) => p.id) });
    expect((await patch(run.id, { paymentsPerTx: 2 })).body.run.paymentsPerTx).toBe(2);
    await post(company, `/v1/payroll-runs/${run.id}/start`);
    expect((await patch(run.id, { paymentsPerTx: 1 })).body.error.code).toBe("RUN_LOCKED");
    const first = (await nextBatch(company, run.id)).batch!;
    expect(first.opCount).toBe(2);
    await submit(company, run.id, first, sign(first, wallet.keypair));
    expect((await nextBatch(company, run.id)).batch?.opCount).toBe(1);
  });

  it("R19: the review warns about employees already paid by another run with the same pay date", async () => {
    const { company, wallet, people } = await setupPayroll(t, 2);
    const october = await createRun(company, wallet, { employeeIds: [people[0]?.id], payDate: "2026-10-31" });
    await payAll(company, october.id, wallet);
    const again = await createRun(company, wallet, { employeeIds: people.map((p) => p.id), payDate: "2026-10-31" });
    const check = (await company.agent.get(`/v1/payroll-runs/${again.id}/check`)).body.check;
    expect(check.alsoPaidElsewhere).toEqual([
      { paymentId: again.payments[0]?.id, employeeId: people[0]?.id, name: people[0]?.name, runId: october.id, runNumber: 1 },
    ]);
    const otherDate = await createRun(company, wallet, { employeeIds: [people[0]?.id], payDate: "2026-11-30" });
    expect((await company.agent.get(`/v1/payroll-runs/${otherDate.id}/check`)).body.check.alsoPaidElsewhere).toEqual([]);
  });

  it("R20: a run exports as CSV with each payment's status, hash and explorer link", async () => {
    const { company, wallet } = await setupPayroll(t, 0);
    const odd = await addEmployee(company, { name: '=Sum, "Ada"', salary: "12.5" });
    const run = await createRun(company, wallet, { employeeIds: [odd.id] });
    const done = await payAll(company, run.id, wallet);
    const res = await company.agent.get(`/v1/payroll-runs/${run.id}/export.csv`);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/csv");
    const [header, row] = res.text.trim().split("\r\n");
    expect(header).toBe("run,position,employee_id,name,wallet,amount,asset,status,failure,tx_hash,ledger,paid_at,verified_at,explorer_url");
    const hash = done.payments[0]?.txHash ?? "";
    // A name a spreadsheet would run as a formula is defused and quoted.
    expect(row).toContain(`"'=Sum, ""Ada"""`);
    expect(row).toContain(`,12.5000000,USDC,SUCCESSFUL,,${hash},`);
    expect(row?.endsWith(`https://stellar.expert/explorer/testnet/tx/${hash}`)).toBe(true);
  });
});

describe("system", () => {
  it("S1: Stellar down during check, start or batch build is 503 and nothing changes", async () => {
    const { company, wallet, people } = await setupPayroll(t, 1);
    const run = await createRun(company, wallet, { employeeIds: [people[0]?.id] });
    t.stellar.down = true;
    expect((await company.agent.get(`/v1/payroll-runs/${run.id}/check`)).status).toBe(503);
    const res = await post(company, `/v1/payroll-runs/${run.id}/start`);
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe("HORIZON_UNAVAILABLE");
    expect((await getRun(company, run.id)).status).toBe("DRAFT");
    t.stellar.down = false;
    await post(company, `/v1/payroll-runs/${run.id}/start`);
    t.stellar.down = true;
    expect((await post(company, `/v1/payroll-runs/${run.id}/transactions/next`)).status).toBe(503);
    expect(await prisma.payrollBatch.count()).toBe(0);
    expect(statuses(await getRun(company, run.id))).toEqual(["PENDING"]);
    expect(await confirm()).toBe(0);
  });

  it("S2: with Postgres unreachable the API answers 503 SERVICE_UNAVAILABLE", async () => {
    const { PrismaClient } = await import("@prisma/client");
    const dead = new PrismaClient({ datasourceUrl: "postgresql://nobody:nothing@127.0.0.1:1/none?connect_timeout=1" });
    const { buildApp } = await import("../../src/app");
    const { app } = buildApp({ prisma: dead, stellar: t.stellar, logger: silentLogger, mailer: null });
    const request = (await import("supertest")).default;
    const health = await request(app).get("/health");
    expect(health.status).toBe(503);
    expect(health.body).toMatchObject({ status: "degraded", db: "down" });
    const v1 = await request(app).get("/v1/employees").set("Authorization", "Bearer op_test_abcdefghijklmnop");
    expect(v1.status).toBe(503);
    expect(v1.body.error.code).toBe("SERVICE_UNAVAILABLE");
    await dead.$disconnect();
  });

  it("S3: a batch left SUBMITTED by a crash is still resolved by the confirmer after a restart", async () => {
    const { company, wallet, people } = await setupPayroll(t, 2);
    const run = await createRun(company, wallet, { employeeIds: people.map((p) => p.id), paymentsPerTx: 100 });
    await post(company, `/v1/payroll-runs/${run.id}/start`);
    const b = (await nextBatch(company, run.id)).batch!;
    t.stellar.submitMode = "unknown";
    await submit(company, run.id, b, sign(b, wallet.keypair));
    // The API dies here. Later the network lands it, and a fresh worker picks it up.
    t.stellar.landInFlight();
    const restarted = makeApp();
    restarted.stellar.txs.clear();
    for (const [hash, tx] of t.stellar.txs) restarted.stellar.txs.set(hash, tx);
    restarted.stellar.ledgerTime = t.stellar.ledgerTime;
    expect(await confirmOpenBatches({ prisma, payroll: restarted.payroll, logger: silentLogger })).toBe(1);
    expect((await getRun(company, run.id)).status).toBe("COMPLETED");
  });
});
