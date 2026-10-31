import type { Run } from "@orgpay/shared";
import { Account, Asset, Keypair, Operation, TransactionBuilder } from "@stellar/stellar-sdk";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { confirmOpenBatches } from "../../src/engine/confirmer";
import { USDC_ISSUER } from "../helpers/fakes";
import { createRun, getRun, makeApp, nextBatch, PASSPHRASE, payAll, post, prisma, resetDb, setupPayroll, sign, silentLogger, submit, type TestApp } from "../helpers/harness";

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
const statuses = (run: Run) => run.payments.map((p) => p.status);

describe("verification", () => {
  it("V1: Stellar's submit answer alone never makes a payment SUCCESSFUL; only the verified ledger record does", async () => {
    const { company, wallet, people } = await setupPayroll(t, 1);
    const run = await createRun(company, wallet, { employeeIds: [people[0]?.id] });
    await post(company, `/v1/payroll-runs/${run.id}/start`);
    const b = (await nextBatch(company, run.id)).batch!;
    // Horizon accepts the transaction, but the node OrgPay reads from hasn't ingested it yet.
    t.stellar.lagging.add(b.txHash);
    const res = await submit(company, run.id, b, sign(b, wallet.keypair));
    expect(res.status).toBe(202);
    expect(res.body.run.status).toBe("PROCESSING");
    expect(res.body.run.payments[0]).toMatchObject({ status: "SUBMITTED", txHash: null, verifiedAt: null, explorerUrl: null });
    expect(t.stellar.usdcBalance(people[0]?.walletAddress ?? "")).toBe("1000.0000000"); // it did land
    t.stellar.lagging.clear();
    expect(await confirm()).toBe(1);
    const after = await getRun(company, run.id);
    expect(after.status).toBe("COMPLETED");
    expect(after.payments[0]).toMatchObject({ status: "SUCCESSFUL", txHash: b.txHash });
    expect(after.payments[0]?.verifiedAt).not.toBeNull();
  });

  it("V2: a submit with no answer (timeout) stays SUBMITTED and the run PROCESSING until the ledger shows it", async () => {
    const { company, wallet, people } = await setupPayroll(t, 2);
    const run = await createRun(company, wallet, { employeeIds: people.map((p) => p.id) });
    await post(company, `/v1/payroll-runs/${run.id}/start`);
    const b = (await nextBatch(company, run.id)).batch!;
    t.stellar.submitMode = "unknown";
    const res = await submit(company, run.id, b, sign(b, wallet.keypair));
    expect(res.status).toBe(202);
    expect(statuses(res.body.run)).toEqual(["SUBMITTED", "PENDING"]);
    // Nothing more can be signed while it might still land, and the run is not finished.
    expect((await nextBatch(company, run.id)).batch).toBeNull();
    expect(await confirm()).toBe(0);
    expect((await getRun(company, run.id)).status).toBe("PROCESSING");
    t.stellar.landInFlight();
    expect(await confirm()).toBe(1);
    expect(statuses(await getRun(company, run.id))).toEqual(["SUCCESSFUL", "PENDING"]);
  });

  it("V3: a transaction that failed on the ledger leaves its payment FAILED with the reason and no hash, never SUCCESSFUL", async () => {
    const { company, wallet, people } = await setupPayroll(t, 1);
    const run = await createRun(company, wallet, { employeeIds: [people[0]?.id] });
    await post(company, `/v1/payroll-runs/${run.id}/start`);
    const b = (await nextBatch(company, run.id)).batch!;
    t.stellar.noTrustline(people[0]?.walletAddress ?? "");
    const after = (await submit(company, run.id, b, sign(b, wallet.keypair))).body.run as Run;
    expect(after.status).toBe("FAILED");
    expect(after.payments[0]).toMatchObject({ status: "FAILED", failureCode: "NO_TRUSTLINE", txHash: null, verifiedAt: null, explorerUrl: null });
    expect(after.transactions[0]).toMatchObject({ status: "FAILED", resultCode: "tx_failed" });
    // The failed transaction is on the ledger, so it has an explorer page; the payment doesn't claim it.
    expect(after.transactions[0]?.explorerUrl).toContain(b.txHash);
    expect(after.counts).toMatchObject({ successful: 0, failed: 1 });
  });

  it("V4: a ledger record that doesn't match the payment (other destination) is never marked SUCCESSFUL", async () => {
    const { company, wallet, people } = await setupPayroll(t, 1);
    const run = await createRun(company, wallet, { employeeIds: [people[0]?.id] });
    await post(company, `/v1/payroll-runs/${run.id}/start`);
    const b = (await nextBatch(company, run.id)).batch!;
    t.stellar.submitMode = "unknown";
    await submit(company, run.id, b, sign(b, wallet.keypair));
    t.stellar.landInFlight();
    // The record for this hash comes back with someone else's payment in it.
    const other = new TransactionBuilder(new Account(wallet.address, "100"), { fee: "1000", networkPassphrase: PASSPHRASE })
      .addOperation(Operation.payment({ destination: Keypair.random().publicKey(), asset: new Asset("USDC", USDC_ISSUER), amount: "1000" }))
      .setTimeout(300)
      .build();
    other.sign(wallet.keypair);
    const record = t.stellar.txs.get(b.txHash)!;
    t.stellar.txs.set(b.txHash, { ...record, envelopeXdr: other.toXDR() });

    expect(await confirm()).toBe(0);
    const after = await getRun(company, run.id);
    expect(after.status).toBe("PROCESSING");
    expect(after.payments[0]).toMatchObject({ status: "SUBMITTED", txHash: null, verifiedAt: null });
    expect(after.transactions[0]?.status).toBe("SUBMITTED");
    const v = (await company.agent.get(`/v1/payments/${after.payments[0]?.id}/verify`)).body.verification;
    expect(v).toMatchObject({ verified: false, checks: { found: true, successful: true, hashMatches: false, destination: false } });
  });

  it("V5: a run is COMPLETED only when every payment is SUCCESSFUL; one failure makes it PARTIALLY_PAID", async () => {
    const { company, wallet, people } = await setupPayroll(t, 3);
    t.stellar.noTrustline(people[2]?.walletAddress ?? "");
    const run = await createRun(company, wallet, { employeeIds: people.map((p) => p.id) });
    const done = await payAll(company, run.id, wallet);
    expect(done.status).toBe("PARTIALLY_PAID");
    expect(statuses(done)).toEqual(["SUCCESSFUL", "SUCCESSFUL", "FAILED"]);
    expect(done).toMatchObject({ total: "3000.0000000", paidTotal: "2000.0000000", failedTotal: "1000.0000000" });
  });

  it("V6: GET /payments/:id/verify re-checks the payment on the ledger and agrees with its status", async () => {
    const { company, wallet, people } = await setupPayroll(t, 2);
    const run = await createRun(company, wallet, { employeeIds: [people[0]?.id] });
    const done = await payAll(company, run.id, wallet);
    const paid = done.payments[0]!;
    const res = await company.agent.get(`/v1/payments/${paid.id}/verify`);
    expect(res.status).toBe(200);
    expect(res.body.verification).toMatchObject({
      paymentId: paid.id,
      status: "SUCCESSFUL",
      txHash: paid.txHash,
      verified: true,
      checks: { found: true, successful: true, hashMatches: true, source: true, destination: true, asset: true, amount: true, opResult: true },
      ledger: paid.ledger,
      explorerUrl: `https://stellar.expert/explorer/testnet/tx/${paid.txHash}`,
    });
    // The payment, with its run, on its own.
    const one = (await company.agent.get(`/v1/payments/${paid.id}`)).body.payment;
    expect(one).toMatchObject({ id: paid.id, status: "SUCCESSFUL", txHash: paid.txHash, run: { id: run.id, number: 1, status: "COMPLETED" } });
    // A payment that was never sent has nothing to verify.
    const draft = await createRun(company, wallet, { employeeIds: [people[1]?.id] });
    const nothing = (await company.agent.get(`/v1/payments/${draft.payments[0]?.id}/verify`)).body.verification;
    expect(nothing).toMatchObject({ status: "PENDING", txHash: null, verified: false, checks: { found: false }, explorerUrl: null });
  });
});
