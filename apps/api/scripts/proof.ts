// The OrgPay Testnet proof: the whole workflow on the real Stellar Testnet with Circle's Testnet
// USDC, from employee setup to verified transaction hashes.
//
//   pnpm proof        (needs DATABASE_URL with the migrations applied, and internet access)
//
// 1. A funding wallet (kept in apps/api/.proof-keys.json, git-ignored, Testnet only) is created
//    with Friendbot and buys Testnet USDC on the DEX with its XLM when it is short.
// 2. Six fresh employees: five add a USDC trustline, the sixth doesn't.
// 3. One payroll run with all six, one payment per transaction. The total is checked.
// 4. Execute: the sixth is FAILED (never sent); five payments are signed (with the funding key,
//    as Freighter would), submitted and verified: five transactions, five hashes.
// 5. Repeated requests: the same create-run key, Execute again, the same signed transaction again.
// 6. The sixth adds a trustline; retry; the sixth payment succeeds and the run is COMPLETED.
// 7. Every hash is read straight from Horizon (not OrgPay's database) and checked against its
//    payment, and every employee's balance must equal their salary: paid exactly once.
// 8. Writes docs/TRANSACTIONS.md and docs/testnet-proof.json. Exits non-zero if any check fails.

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { formatStroops, parseAmount, STROOPS_PER_UNIT, type Employee, type Payment, type PaymentVerification, type Run, type SignableTransaction } from "@orgpay/shared";
import { Asset, Horizon, Keypair, Networks, Operation, TransactionBuilder, type xdr } from "@stellar/stellar-sdk";

const HORIZON = process.env.HORIZON_URL ?? "https://horizon-testnet.stellar.org";
const USDC_ISSUER = process.env.USDC_ISSUER ?? "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
const USDC = new Asset("USDC", USDC_ISSUER);
const EXPLORER = "https://stellar.expert/explorer/testnet";
const API_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = path.resolve(API_DIR, "../..");
const KEYS_FILE = path.join(API_DIR, ".proof-keys.json");
/** Most XLM the funding wallet spends buying USDC in one run, in stroops. */
const MAX_XLM_FOR_USDC = 2000n * STROOPS_PER_UNIT;

const EMPLOYEES: { name: string; salary: string; trustline: boolean }[] = [
  { name: "Ada Okafor", salary: "1.0000000", trustline: true },
  { name: "Kenji Watanabe", salary: "1.2500000", trustline: true },
  { name: "Priya Raman", salary: "1.5000000", trustline: true },
  { name: "Marcus Silva", salary: "1.7500000", trustline: true },
  { name: "Amara Nwosu", salary: "2.0000001", trustline: true },
  { name: "Tomás Reyes", salary: "2.5000000", trustline: false },
];
const TOTAL = "10.0000001";

const horizon = new Horizon.Server(HORIZON);
const checks: { check: string; ok: boolean; detail: string }[] = [];

interface Row {
  payment: Payment;
  memo: string;
  verification: PaymentVerification;
  balance: string | null;
}

/** Stroops from a Horizon amount string; 0 for anything unexpected. */
const stroops = (amount: string | null | undefined) => (amount ? (parseAmount(amount) ?? 0n) : 0n);

function log(step: string, detail = ""): void {
  console.log(`• ${step}${detail ? `  ${detail}` : ""}`);
}
function assert(ok: unknown, check: string, detail = ""): asserts ok {
  checks.push({ check, ok: Boolean(ok), detail });
  if (!ok) throw new Error(`FAILED: ${check}${detail ? ` (${detail})` : ""}`);
}

async function friendbot(address: string): Promise<void> {
  const res = await fetch(`https://friendbot.stellar.org?addr=${address}`);
  if (!res.ok) throw new Error(`Friendbot refused ${address}: ${res.status}`);
}

async function exists(address: string): Promise<boolean> {
  try {
    await horizon.loadAccount(address);
    return true;
  } catch {
    return false;
  }
}

async function send(source: Keypair, op: xdr.Operation): Promise<void> {
  const account = await horizon.loadAccount(source.publicKey());
  const tx = new TransactionBuilder(account, { fee: "1000", networkPassphrase: Networks.TESTNET }).addOperation(op).setTimeout(60).build();
  tx.sign(source);
  await horizon.submitTransaction(tx);
}

async function usdcBalance(address: string): Promise<string | null> {
  const account = await horizon.loadAccount(address);
  const line = account.balances.find((b) => "asset_code" in b && b.asset_code === "USDC" && b.asset_issuer === USDC_ISSUER);
  return line?.balance ?? null;
}

/** Buys USDC for the funding wallet with its own XLM on the Testnet DEX (a path payment to itself). */
async function topUpUsdc(funder: Keypair, need: bigint): Promise<void> {
  const have = stroops(await usdcBalance(funder.publicKey()));
  if (have >= need) return log("Funding wallet already holds enough USDC", `${formatStroops(have)} USDC`);
  const want = formatStroops(need - have + 2n * STROOPS_PER_UNIT);
  const paths = await horizon.strictReceivePaths([Asset.native()], USDC, want).call();
  const best = paths.records
    .filter((r) => r.source_asset_type === "native")
    .sort((a, b) => (stroops(a.source_amount) < stroops(b.source_amount) ? -1 : 1))[0];
  if (!best) throw new Error(`No XLM → USDC path on the Testnet DEX. Send ${want} Testnet USDC to ${funder.publicKey()} from https://faucet.circle.com and run again.`);
  const quote = stroops(best.source_amount);
  if (quote > MAX_XLM_FOR_USDC) throw new Error(`The DEX wants ${best.source_amount} XLM for ${want} USDC, over the ${formatStroops(MAX_XLM_FOR_USDC)} XLM cap.`);
  // Generous slippage: 3× the quote, never more than the cap.
  const sendMax = formatStroops(quote * 3n < MAX_XLM_FOR_USDC ? quote * 3n : MAX_XLM_FOR_USDC);
  await send(
    funder,
    Operation.pathPaymentStrictReceive({
      sendAsset: Asset.native(),
      sendMax,
      destination: funder.publicKey(),
      destAsset: USDC,
      destAmount: want,
      path: best.path.map((p) => (p.asset_type === "native" ? Asset.native() : new Asset(p.asset_code, p.asset_issuer))),
    }),
  );
  log("Bought Testnet USDC on the DEX", `${want} USDC for at most ${sendMax} XLM`);
}

function loadFunder(): Keypair {
  if (existsSync(KEYS_FILE)) {
    const saved = JSON.parse(readFileSync(KEYS_FILE, "utf8")) as { funder?: string };
    if (saved.funder) return Keypair.fromSecret(saved.funder);
  }
  const funder = Keypair.random();
  writeFileSync(KEYS_FILE, `${JSON.stringify({ note: "Stellar TESTNET only. Never fund with real money.", funder: funder.secret() }, null, 2)}\n`, { mode: 0o600 });
  return funder;
}

async function main(): Promise<void> {
  Object.assign(process.env, {
    USDC_ISSUER,
    HORIZON_URL: HORIZON,
    NETWORK_PASSPHRASE: Networks.TESTNET,
    WEB_ORIGIN: process.env.WEB_ORIGIN?.replace(/\/$/, "") || "http://localhost:3000",
    SESSION_SECRET: process.env.SESSION_SECRET || "ab".repeat(32),
    LOG_LEVEL: "warn",
  });
  const { buildApp } = await import("../src/app");
  const { prisma } = await import("../src/db/prisma");
  const { HorizonGateway } = await import("../src/stellar/horizonGateway");
  const { createPayrollService } = await import("../src/modules/payroll/service");
  const { confirmOpenBatches } = await import("../src/engine/confirmer");
  const { DEFAULT_LIMITS } = await import("../src/deps");
  const pino = (await import("pino")).default;

  // ---- Stellar setup ----
  const funder = loadFunder();
  const staff = EMPLOYEES.map((e) => ({ ...e, keypair: Keypair.random() }));
  // OrgPay orders a run by name, so payments are matched to employees by wallet, never by index.
  const salaryOf = (wallet: string) => staff.find((s) => s.keypair.publicKey() === wallet)?.salary;
  const late = staff.find((s) => !s.trustline)!;
  const lateWallet = late.keypair.publicKey();
  log("Funding wallet", funder.publicKey());
  if (!(await exists(funder.publicKey()))) await friendbot(funder.publicKey());
  if ((await usdcBalance(funder.publicKey())) === null) await send(funder, Operation.changeTrust({ asset: USDC }));
  await topUpUsdc(funder, stroops(TOTAL) + STROOPS_PER_UNIT);
  log("Creating six employee accounts with Friendbot");
  for (const e of staff) await friendbot(e.keypair.publicKey());
  for (const e of staff.filter((s) => s.trustline)) await send(e.keypair, Operation.changeTrust({ asset: USDC }));
  log("Five employees added a USDC trustline", `${late.name} did not`);

  // ---- OrgPay, in-process, against the real Testnet ----
  const stellar = new HorizonGateway(HORIZON);
  const silent = pino({ level: "silent" });
  const { app } = buildApp({ prisma, stellar, logger: silent, mailer: null, verifyEmail: false });
  const payroll = createPayrollService({ prisma, stellar, logger: silent, limits: DEFAULT_LIMITS, mailer: null, verifyEmail: false, batchWindowSeconds: 300 });
  const confirm = () => confirmOpenBatches({ prisma, payroll, logger: silent }, Date.now() + 60_000);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const origin = process.env.WEB_ORIGIN as string;
  let cookie = "";

  const call = async <T>(method: string, route: string, body?: unknown, opts: { key?: string; expect?: number[] } = {}): Promise<{ status: number; body: T }> => {
    const res = await fetch(base + route, {
      method,
      headers: {
        Origin: origin,
        Cookie: cookie,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(opts.key ? { "Idempotency-Key": opts.key } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const setCookie = res.headers.get("set-cookie");
    if (setCookie) cookie = setCookie.split(";")[0] ?? cookie;
    const json = (res.status === 204 ? null : await res.json()) as T;
    if (!(opts.expect ?? [200, 201, 202]).includes(res.status)) throw new Error(`${method} ${route} → ${res.status} ${JSON.stringify(json)}`);
    return { status: res.status, body: json };
  };

  const signedByTx = new Map<string, string>();
  /** Signs and submits every transaction OrgPay builds until there is nothing left to sign. */
  const payAll = async (runId: string): Promise<void> => {
    for (let i = 0; i < 20; i++) {
      const { transaction } = (await call<{ transaction: SignableTransaction | null }>("POST", `/v1/payroll-runs/${runId}/transactions/next`)).body;
      if (!transaction) return;
      const tx = TransactionBuilder.fromXDR(transaction.xdr, Networks.TESTNET);
      tx.sign(funder); // what Freighter does in the browser
      signedByTx.set(transaction.id, tx.toXDR());
      let status = (await call<{ transaction: { status: string } }>("POST", `/v1/payroll-runs/${runId}/transactions/${transaction.id}/submit`, { signedXdr: tx.toXDR() })).body.transaction.status;
      for (let wait = 0; status === "SUBMITTED" && wait < 30; wait++) {
        await new Promise((r) => setTimeout(r, 2000));
        await confirm();
        status = (await prisma.payrollBatch.findUniqueOrThrow({ where: { id: transaction.id } })).status;
      }
      assert(status === "CONFIRMED", `transaction ${transaction.number} confirmed on the ledger`, `${transaction.txHash} → ${status}`);
      log(`Transaction ${transaction.number} confirmed`, `${transaction.total} USDC  ${EXPLORER}/tx/${transaction.txHash}`);
    }
  };
  const getRun = async (id: string) => (await call<{ run: Run }>("GET", `/v1/payroll-runs/${id}`)).body.run;

  try {
    await call("POST", "/auth/signup", { email: `proof-${Date.now()}@orgpay.test`, password: "orgpay proof password 123", businessName: "OrgPay Proof Org" });
    const { wallet } = (await call<{ wallet: { id: string; usdcBalance: string | null } }>("POST", "/v1/wallets", { address: funder.publicKey(), label: "Proof treasury" })).body;
    log("Organization signed up, funding wallet added", `${wallet.usdcBalance} USDC`);

    // Employees
    const people: (Employee & { keypair: Keypair })[] = [];
    for (const e of staff) {
      const { employee } = (await call<{ employee: Employee }>("POST", "/v1/employees", { name: e.name, walletAddress: e.keypair.publicKey(), salary: e.salary })).body;
      people.push({ ...employee, keypair: e.keypair });
    }
    assert(people.every((p, i) => p.salary === staff[i]?.salary && p.walletAddress === staff[i]?.keypair.publicKey()), "six employees stored with their wallet and USDC salary");
    assert(people.find((p) => p.walletAddress === lateWallet)?.check.reason === "NO_TRUSTLINE", `${late.name} is flagged NO_TRUSTLINE before any payroll`);

    // Run, created twice with the same Idempotency-Key
    const createKey = randomUUID();
    const runBody = { name: "Proof payroll", walletId: wallet.id, payDate: new Date().toISOString().slice(0, 10), employeeIds: people.map((p) => p.id) };
    const created = await call<{ run: Run }>("POST", "/v1/payroll-runs", runBody, { key: createKey });
    const repeated = await call<{ run: Run }>("POST", "/v1/payroll-runs", runBody, { key: createKey });
    const run = created.body.run;
    const allRuns = (await call<{ data: { id: string }[] }>("GET", "/v1/payroll-runs")).body.data;
    assert(repeated.body.run.id === run.id && allRuns.length === 1, "the same create-run request sent twice made one run");
    assert(run.employeeCount === 6 && run.paymentsPerTx === 1, "the run has six employees, one payment per transaction");
    assert(run.total === TOTAL, "the total is the exact sum of the salaries", `${run.total} USDC`);
    const { check } = (await call<{ check: { payableCount: number; excludedCount: number; payableTotal: string; funding: { enough: boolean } } }>("GET", `/v1/payroll-runs/${run.id}/check`)).body;
    assert(check.payableCount === 5 && check.excludedCount === 1 && check.funding.enough, "review: five payable, one can't receive, funding is enough", `${check.payableTotal} USDC payable`);
    log(`Run #${run.number} created and reviewed`, `6 employees, ${run.total} USDC`);

    // Execute (twice)
    await call("POST", `/v1/payroll-runs/${run.id}/start`);
    const twice = await call<{ error: { code: string } }>("POST", `/v1/payroll-runs/${run.id}/start`, undefined, { expect: [409] });
    assert(twice.body.error.code === "INVALID_TRANSITION", "Execute pressed again is refused (409)");
    let current = await getRun(run.id);
    const latePayment = current.payments.find((p) => p.walletAddress === lateWallet);
    assert(latePayment?.status === "FAILED" && latePayment.failureCode === "NO_TRUSTLINE" && !latePayment.txHash, `${late.name} is FAILED (no trustline) and never sent`);

    await payAll(run.id);
    current = await getRun(run.id);
    const firstFive = current.payments.filter((p) => p.walletAddress !== lateWallet);
    assert(firstFive.every((p) => p.status === "SUCCESSFUL" && p.txHash && p.verifiedAt), "five payments SUCCESSFUL, each verified with a hash");
    assert(new Set(firstFive.map((p) => p.txHash)).size === 5, "five separate transactions, five distinct hashes");
    assert(current.status === "PARTIALLY_PAID", "run is PARTIALLY_PAID while one payment failed", current.status);

    // The same signed transaction submitted again sends nothing.
    const firstTx = current.transactions[0];
    const resent = await call<{ transaction: { status: string } }>("POST", `/v1/payroll-runs/${run.id}/transactions/${firstTx?.id}/submit`, { signedXdr: signedByTx.get(firstTx?.id ?? "") });
    assert(resent.body.transaction.status === "CONFIRMED", "the same signed transaction submitted again is not sent twice");

    // The sixth employee fixes their wallet; retry.
    log(`${late.name} adds a USDC trustline; the admin retries`);
    await send(late.keypair, Operation.changeTrust({ asset: USDC }));
    await call("POST", `/v1/payroll-runs/${run.id}/retry`);
    await payAll(run.id);
    current = await getRun(run.id);
    assert(current.status === "COMPLETED", "run is COMPLETED after the retry", current.status);
    const next = (await call<{ transaction: unknown }>("POST", `/v1/payroll-runs/${run.id}/transactions/next`)).body;
    assert(next.transaction === null, "nothing left to sign on a completed run");

    // ---- Independent checks, straight from Horizon ----
    const rows: Row[] = [];
    for (const payment of current.payments) {
      const hash = payment.txHash ?? "";
      const record = await horizon.transactions().transaction(hash).call();
      const ops = await horizon.operations().forTransaction(hash).call();
      const op = ops.records[0] as unknown as { type: string; from: string; to: string; amount: string; asset_code?: string; asset_issuer?: string };
      const balance = await usdcBalance(payment.walletAddress);
      const memo = record.memo ?? "";
      assert(record.successful && record.source_account === funder.publicKey(), `${payment.name}: Horizon shows a successful transaction from the funding wallet`, hash);
      assert(ops.records.length === 1 && op.type === "payment" && op.to === payment.walletAddress && op.amount === payment.amount && op.asset_code === "USDC" && op.asset_issuer === USDC_ISSUER, `${payment.name}: one USDC payment of ${payment.amount} to their wallet`);
      assert(memo === `OrgPay R${run.number} P${payment.position}`, `${payment.name}: the memo names run #${run.number}, payment ${payment.position}`, memo);
      const salary = salaryOf(payment.walletAddress);
      assert(payment.amount === salary && balance === salary, `${payment.name}: on-chain balance equals the salary (paid exactly once)`, `${balance} USDC`);
      const { verification } = (await call<{ verification: PaymentVerification }>("GET", `/v1/payments/${payment.id}/verify`)).body;
      assert(verification.verified, `${payment.name}: OrgPay's /verify passes every check`);
      rows.push({ payment, memo, verification, balance });
    }
    const hashes = new Set(rows.map((r) => r.payment.txHash));
    assert(hashes.size === 6, "six successful transactions in total, all distinct");

    writeReports({ run: current, funder: funder.publicKey(), rows });
    console.log("");
    for (const r of rows) console.log(`    ${r.payment.name.padEnd(15)} ${r.payment.amount.padStart(10)} USDC  ${r.payment.status}  ${r.payment.explorerUrl}`);
    console.log(`\nProof passed: ${checks.length} checks. Wrote docs/TRANSACTIONS.md and docs/testnet-proof.json.`);
  } finally {
    server.close();
    await prisma.$disconnect();
  }

  function writeReports(data: { run: Run; funder: string; rows: Row[] }): void {
    const when = new Date().toISOString();
    const lines = [
      "# OrgPay Testnet transactions",
      "",
      `Generated by \`pnpm proof\` on ${when}. Every row was read back from Horizon and checked against its payment.`,
      "",
      "| | |",
      "|---|---|",
      `| Network | Stellar Testnet |`,
      `| Asset | USDC, issuer [\`${USDC_ISSUER}\`](${EXPLORER}/asset/USDC-${USDC_ISSUER}) |`,
      `| Funding wallet | [\`${data.funder}\`](${EXPLORER}/account/${data.funder}) |`,
      `| Payroll run | #${data.run.number} "${data.run.name}", status **${data.run.status}** |`,
      `| Employees | ${data.run.employeeCount} |`,
      `| Total | ${data.run.total} USDC (paid ${data.run.paidTotal} USDC) |`,
      `| Payments per transaction | ${data.run.paymentsPerTx} |`,
      "",
      "## Payments",
      "",
      "| # | Employee | Wallet | Amount (USDC) | Status | Attempts | Transaction | Ledger | Memo | Verified |",
      "|---|---|---|---|---|---|---|---|---|---|",
      ...data.rows.map(
        ({ payment: p, memo, verification }) =>
          `| ${p.position} | ${p.name} | [\`${p.walletAddress.slice(0, 6)}…${p.walletAddress.slice(-4)}\`](${EXPLORER}/account/${p.walletAddress}) | ${p.amount} | ${p.status} | ${p.attempts} | [\`${p.txHash?.slice(0, 12)}…\`](${p.explorerUrl}) | ${p.ledger} | \`${memo}\` | ${verification.verified ? "yes" : "NO"} |`,
      ),
      "",
      `Payment ${data.rows.find((r) => r.payment.walletAddress === lateWallet)?.payment.position} (${late.name}) had no USDC trustline when the run was executed: it was marked FAILED and left out of every transaction. After the trustline was added, a retry paid it (attempts counts the transactions a payment was put in).`,
      "",
      "## Checks",
      "",
      "| Check | Result | Detail |",
      "|---|---|---|",
      ...checks.map((c) => `| ${c.check} | ${c.ok ? "pass" : "FAIL"} | ${c.detail.replace(/\|/g, "\\|")} |`),
      "",
    ];
    writeFileSync(path.join(ROOT, "docs/TRANSACTIONS.md"), lines.join("\n"));
    writeFileSync(
      path.join(ROOT, "docs/testnet-proof.json"),
      `${JSON.stringify(
        {
          generatedAt: when,
          network: "testnet",
          usdcIssuer: USDC_ISSUER,
          fundingWallet: data.funder,
          run: { id: data.run.id, number: data.run.number, status: data.run.status, employeeCount: data.run.employeeCount, total: data.run.total },
          payments: data.rows.map(({ payment: p, memo, verification }) => ({
            paymentId: p.id,
            position: p.position,
            employeeId: p.employeeId,
            name: p.name,
            wallet: p.walletAddress,
            amount: p.amount,
            status: p.status,
            txHash: p.txHash,
            ledger: p.ledger,
            memo,
            verified: verification.verified,
            explorerUrl: p.explorerUrl,
          })),
          checks,
        },
        null,
        2,
      )}\n`,
    );
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
