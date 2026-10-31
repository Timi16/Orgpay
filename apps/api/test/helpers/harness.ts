import { randomUUID } from "node:crypto";
import type { Employee, Run, SignableTransaction, Wallet as WalletDto } from "@orgpay/shared";
import { Keypair, TransactionBuilder } from "@stellar/stellar-sdk";
import pino from "pino";
import request from "supertest";
import type TestAgent from "supertest/lib/agent";
import { buildApp } from "../../src/app";
import { prisma } from "../../src/db/prisma";
import type { Limits } from "../../src/deps";
import type { Mail, Mailer } from "../../src/lib/mailer";
import { createPayrollService } from "../../src/modules/payroll/service";
import { DEFAULT_LIMITS } from "../../src/deps";
import { FakeStellar } from "./fakes";
import { TEST_WEB_ORIGIN } from "./setupEnv";

export { prisma };
export const ORIGIN = TEST_WEB_ORIGIN;
export const PASSPHRASE = "Test SDF Network ; September 2015";
export const silentLogger = pino({ level: "silent" });

const NO_LIMITS: Partial<Limits> = {
  authPerMin: 10_000,
  authReadPerMin: 10_000,
  v1PerMin: 10_000,
  stellarHeavyPerMin: 10_000,
  v1PerIpPerMin: 10_000,
};

export async function resetDb(): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE "PayrollEvent", "PayrollItem", "PayrollBatch", "PayrollRun", "Employee", "Group", "WalletChallenge", "Wallet", "ApiKey", "Session", "PasswordReset", "EmailVerification", "TrustedDevice", "LoginThrottle", "RateLimit", "Company" CASCADE',
  );
}

/** Captures outgoing email instead of sending it. */
export class CapturingMailer implements Mailer {
  readonly sent: Mail[] = [];
  async send(mail: Mail): Promise<void> {
    this.sent.push(mail);
  }
}

export function makeApp(limits: Partial<Limits> = {}, opts: { mailer?: Mailer | null; verifyEmail?: boolean; batchWindowSeconds?: number } = {}) {
  const stellar = new FakeStellar();
  const mailer = opts.mailer === undefined ? new CapturingMailer() : opts.mailer;
  const batchWindowSeconds = opts.batchWindowSeconds ?? 300;
  const built = buildApp({
    prisma,
    stellar,
    logger: silentLogger,
    mailer,
    verifyEmail: opts.verifyEmail ?? false,
    limits: { ...NO_LIMITS, ...limits },
    batchWindowSeconds,
  });
  // The same service the worker runs (confirmer), over the same fake network.
  const payroll = createPayrollService({ prisma, stellar, logger: silentLogger, limits: DEFAULT_LIMITS, mailer, verifyEmail: false, batchWindowSeconds });
  return { ...built, stellar, payroll, mailer: mailer as CapturingMailer };
}
export type TestApp = ReturnType<typeof makeApp>;

let counter = 0;

export interface TestCompany {
  agent: TestAgent;
  id: string;
  email: string;
  password: string;
}

/** Signs a company up through the API and returns a cookie-carrying agent. */
export async function signup(t: TestApp, businessName = "Northwind Studio"): Promise<TestCompany> {
  const agent = request.agent(t.app);
  const email = `company${++counter}-${Date.now()}@example.com`;
  const password = "correct horse battery";
  const res = await agent.post("/auth/signup").set("Origin", ORIGIN).send({ email, password, businessName });
  if (res.status !== 201) throw new Error(`signup failed: ${res.status} ${JSON.stringify(res.body)}`);
  return { agent, id: (res.body as { company: { id: string } }).company.id, email, password };
}

export interface TestWallet {
  id: string;
  address: string;
  keypair: Keypair;
}

/** Adds a funding wallet and gives it USDC and XLM on the fake network. */
export async function addFundingWallet(t: TestApp, c: TestCompany, usdc = "100000", keypair = Keypair.random()): Promise<TestWallet> {
  t.stellar.fund(keypair.publicKey(), usdc);
  const added = await c.agent.post("/v1/wallets").set("Origin", ORIGIN).send({ address: keypair.publicKey(), label: "Payroll" });
  if (added.status !== 201) throw new Error(`add wallet failed: ${JSON.stringify(added.body)}`);
  const wallet = (added.body as { wallet: WalletDto }).wallet;
  return { id: wallet.id, address: wallet.address, keypair };
}

export async function addEmployee(c: TestCompany, body: Partial<{ name: string; walletAddress: string; salary: string; groupId: string | null; email: string }> = {}): Promise<Employee> {
  const res = await c.agent
    .post("/v1/employees")
    .set("Origin", ORIGIN)
    .send({ name: `Person ${++counter}`, walletAddress: Keypair.random().publicKey(), salary: "1000", ...body });
  if (res.status !== 201) throw new Error(`add employee failed: ${res.status} ${JSON.stringify(res.body)}`);
  return (res.body as { employee: Employee }).employee;
}

export async function createRun(c: TestCompany, wallet: TestWallet, body: Record<string, unknown>): Promise<Run> {
  const res = await c.agent
    .post("/v1/payroll-runs")
    .set("Origin", ORIGIN)
    .set("Idempotency-Key", randomUUID())
    .send({ name: "October payroll", walletId: wallet.id, ...body });
  if (res.status !== 201) throw new Error(`create run failed: ${res.status} ${JSON.stringify(res.body)}`);
  return (res.body as { run: Run }).run;
}

/** Company, funded wallet and `n` people who can all receive. */
export async function setupPayroll(t: TestApp, n = 3, amount = "1000") {
  const company = await signup(t);
  const wallet = await addFundingWallet(t, company);
  const people: Employee[] = [];
  for (let i = 0; i < n; i++) people.push(await addEmployee(company, { salary: amount }));
  return { company, wallet, people };
}

export function post(c: TestCompany, path: string, body: unknown = {}) {
  return c.agent.post(path).set("Origin", ORIGIN).send(body as object);
}

/** A POST that is one user action: a fresh Idempotency-Key, unless the test repeats one on purpose. */
export function postOnce(c: TestCompany, path: string, body: unknown = {}, key: string = randomUUID()) {
  return c.agent.post(path).set("Origin", ORIGIN).set("Idempotency-Key", key).send(body as object);
}

/** The transaction to sign, as the tests call it: a batch of `paymentsPerTx` payments. */
export type SignableBatch = SignableTransaction;

/** Signs a transaction envelope as Freighter would. */
export function sign(batch: SignableBatch, keypair: Keypair): string {
  const tx = TransactionBuilder.fromXDR(batch.xdr, PASSPHRASE);
  tx.sign(keypair);
  return tx.toXDR();
}

export async function nextBatch(c: TestCompany, runId: string): Promise<{ batch: SignableBatch | null; run: Run }> {
  const res = await post(c, `/v1/payroll-runs/${runId}/transactions/next`);
  if (res.status !== 200) throw new Error(`next transaction failed: ${res.status} ${JSON.stringify(res.body)}`);
  const body = res.body as { transaction: SignableBatch | null; run: Run };
  return { batch: body.transaction, run: body.run };
}

export async function submit(c: TestCompany, runId: string, batch: SignableBatch, signedXdr: string) {
  return post(c, `/v1/payroll-runs/${runId}/transactions/${batch.id}/submit`, { signedXdr });
}

/** Execute, then sign and submit every transaction until there is nothing left to sign. */
export async function payAll(c: TestCompany, runId: string, wallet: TestWallet): Promise<Run> {
  const started = await post(c, `/v1/payroll-runs/${runId}/start`);
  if (started.status !== 200) throw new Error(`start failed: ${started.status} ${JSON.stringify(started.body)}`);
  for (let i = 0; i < 50; i++) {
    const { batch, run } = await nextBatch(c, runId);
    if (!batch) return run;
    const res = await submit(c, runId, batch, sign(batch, wallet.keypair));
    if (res.status !== 200) throw new Error(`submit failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  throw new Error("too many transactions");
}

export async function getRun(c: TestCompany, runId: string): Promise<Run> {
  const res = await c.agent.get(`/v1/payroll-runs/${runId}`);
  return (res.body as { run: Run }).run;
}

export const USDC = (units: string | number): bigint => BigInt(units) * 10_000_000n;
