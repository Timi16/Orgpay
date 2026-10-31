// End-to-end payroll on the real Stellar Testnet. Proves the whole path a company takes:
// people → run → pre-check → start → sign each batch (here with a local keypair, as Freighter
// would) → submit → Paid with a hash Horizon confirms, a person with no trustline left out →
// trustline added → retry → paid, and nobody paid twice.
//
//   pnpm scenario        (needs DATABASE_URL with the migrations applied, and internet access)
//
// Uses fresh Friendbot accounts and its own "USDC" issuer so it can mint test money; the API runs
// in-process with USDC_ISSUER set to that issuer. Throwaway testnet keys live in memory only.

import { Asset, Horizon, Keypair, Networks, Operation, TransactionBuilder } from "@stellar/stellar-sdk";
import type { AddressInfo } from "node:net";

const HORIZON = process.env.HORIZON_URL ?? "https://horizon-testnet.stellar.org";
const horizon = new Horizon.Server(HORIZON);
const issuer = Keypair.random();
const USDC = new Asset("USDC", issuer.publicKey());

function log(step: string, detail = ""): void {
  console.log(`• ${step}${detail ? `  ${detail}` : ""}`);
}
function assert(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error(`FAILED: ${message}`);
}

async function friendbot(kp: Keypair): Promise<void> {
  const res = await fetch(`https://friendbot.stellar.org?addr=${kp.publicKey()}`);
  if (!res.ok) throw new Error(`Friendbot refused ${kp.publicKey()}: ${res.status}`);
}

async function send(source: Keypair, ops: ReturnType<typeof Operation.payment>[]): Promise<void> {
  const account = await horizon.loadAccount(source.publicKey());
  const builder = new TransactionBuilder(account, { fee: "1000", networkPassphrase: Networks.TESTNET }).setTimeout(60);
  for (const op of ops) builder.addOperation(op);
  const tx = builder.build();
  tx.sign(source);
  await horizon.submitTransaction(tx);
}

const trust = (kp: Keypair) => send(kp, [Operation.changeTrust({ asset: USDC })]);

async function main(): Promise<void> {
  // The API must trust this run's issuer: set it before any app module reads the env.
  Object.assign(process.env, {
    USDC_ISSUER: issuer.publicKey(),
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

  const funder = Keypair.random();
  const [ada, bea, cyd] = [Keypair.random(), Keypair.random(), Keypair.random()];
  log("Funding accounts with Friendbot", "issuer, funding wallet and three employees");
  await Promise.all([issuer, funder, ada, bea, cyd].map(friendbot));
  log("Trustlines", "funding wallet, Ada and Bea trust USDC; Cyd does not");
  await Promise.all([trust(funder), trust(ada), trust(bea)]);
  await send(issuer, [Operation.payment({ destination: funder.publicKey(), asset: USDC, amount: "50000" })]);
  log("Minted 50,000 test USDC to the funding wallet");

  const stellar = new HorizonGateway(HORIZON);
  const silent = pino({ level: "silent" });
  const { app } = buildApp({ prisma, stellar, logger: silent, mailer: null, verifyEmail: false });
  // The worker's confirmer, for a batch Horizon hasn't finished recording when the submit returns.
  const payroll = createPayrollService({ prisma, stellar, logger: silent, limits: DEFAULT_LIMITS, mailer: null, verifyEmail: false, batchWindowSeconds: 300 });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const origin = process.env.WEB_ORIGIN as string;
  let cookie = "";

  const call = async <T>(method: string, path: string, body?: unknown, expect = [200, 201, 202, 204]): Promise<T> => {
    const res = await fetch(base + path, {
      method,
      headers: { Origin: origin, Cookie: cookie, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const setCookie = res.headers.get("set-cookie");
    if (setCookie) cookie = setCookie.split(";")[0] ?? cookie;
    const json = res.status === 204 ? null : ((await res.json()) as unknown);
    if (!expect.includes(res.status)) throw new Error(`${method} ${path} → ${res.status} ${JSON.stringify(json)}`);
    return json as T;
  };

  type Run = { id: string; status: string; items: { name: string; status: string; failureCode: string | null; txHash: string | null }[] };
  type Batch = { id: string; number: number; xdr: string; opCount: number; total: string; status: string } | null;

  try {
    await call("POST", "/auth/signup", { email: `scenario-${Date.now()}@orgpay.test`, password: "scenario password 123", businessName: "Scenario Co" });
    const { wallet } = await call<{ wallet: { id: string; usdcBalance: string | null } }>("POST", "/v1/wallets", { address: funder.publicKey(), label: "Scenario treasury" });
    assert(wallet.usdcBalance === "50000.0000000", `funding wallet shows 50,000 USDC (got ${wallet.usdcBalance})`);
    log("Company signed up, funding wallet added", `${wallet.usdcBalance} USDC`);

    const people: { id: string; check: { status: string; reason: string | null } }[] = [];
    for (const [name, kp, amount] of [["Ada", ada, "1200.50"], ["Bea", bea, "980"], ["Cyd", cyd, "1500.0000001"]] as const) {
      const { employee } = await call<{ employee: (typeof people)[number] }>("POST", "/v1/employees", { name, walletAddress: kp.publicKey(), salary: amount });
      people.push(employee);
    }
    assert(people[2]?.check.reason === "NO_TRUSTLINE", "Cyd is flagged NO_TRUSTLINE on People");
    log("Three people added", "Cyd shows 'No USDC trustline'");

    const { run } = await call<{ run: Run & { total: string } }>("POST", "/v1/payroll-runs", { name: "Scenario payroll", walletId: wallet.id, employeeIds: people.map((p) => p.id) });
    assert(run.total === "3680.5000001", `total is the exact sum (got ${run.total})`);
    const { check } = await call<{ check: { payableCount: number; excludedCount: number; funding: { enough: boolean } } }>("GET", `/v1/payroll-runs/${run.id}/check`);
    assert(check.payableCount === 2 && check.excludedCount === 1 && check.funding.enough, "pre-check: 2 payable, 1 excluded, funding enough");
    log("Draft created and checked", `total ${run.total} USDC; 2 payable, Cyd excluded`);

    const payAll = async () => {
      for (let i = 0; i < 10; i++) {
        const { batch } = await call<{ batch: Batch }>("POST", `/v1/payroll-runs/${run.id}/batches/next`);
        if (!batch) return;
        const tx = TransactionBuilder.fromXDR(batch.xdr, Networks.TESTNET);
        tx.sign(funder); // what Freighter does in the browser
        const res = await call<{ batch: { status: string; txHash: string; ledger: number | null } }>("POST", `/v1/payroll-runs/${run.id}/batches/${batch.id}/submit`, { signedXdr: tx.toXDR() });
        let status = res.batch.status;
        let ledger = res.batch.ledger;
        for (let wait = 0; status === "SUBMITTED" && wait < 30; wait++) {
          await new Promise((r) => setTimeout(r, 2000));
          await confirmOpenBatches({ prisma, payroll, logger: silent }, Date.now() + 60_000);
          const after = await prisma.payrollBatch.findUniqueOrThrow({ where: { id: batch.id } });
          status = after.status;
          ledger = after.ledger;
        }
        log(`Batch ${batch.number} submitted`, `${batch.opCount} payments, ${batch.total} USDC → ${status} (ledger ${ledger ?? "pending"})`);
        assert(status === "CONFIRMED", `batch ${batch.number} confirmed (got ${status})`);
        // Double submission of the same signed envelope must not send anything twice.
        const again = await call<{ batch: { status: string } }>("POST", `/v1/payroll-runs/${run.id}/batches/${batch.id}/submit`, { signedXdr: tx.toXDR() });
        assert(again.batch.status === "CONFIRMED", "re-submitting the same batch is a no-op");
      }
    };

    await call("POST", `/v1/payroll-runs/${run.id}/start`);
    await payAll();
    let after = (await call<{ run: Run }>("GET", `/v1/payroll-runs/${run.id}`)).run;
    assert(after.status === "PARTIAL", `run is PARTIAL (got ${after.status})`);
    const [a, b, c] = after.items;
    assert(a?.status === "PAID" && b?.status === "PAID" && a.txHash && a.txHash === b.txHash, "Ada and Bea paid in one transaction");
    assert(c?.status === "FAILED" && c.failureCode === "NO_TRUSTLINE" && !c.txHash, "Cyd not sent, NO_TRUSTLINE");
    const onChain = await horizon.transactions().transaction(a.txHash).call();
    assert(onChain.successful, "Horizon confirms the transaction");
    log("Run partly paid", `Ada + Bea paid in tx ${a.txHash}; Cyd not sent (no trustline)`);

    log("Cyd adds a USDC trustline, company retries");
    await trust(cyd);
    await call("POST", `/v1/payroll-runs/${run.id}/retry`);
    await payAll();
    after = (await call<{ run: Run }>("GET", `/v1/payroll-runs/${run.id}`)).run;
    assert(after.status === "PAID", `run is PAID after the retry (got ${after.status})`);

    const balance = async (kp: Keypair) => {
      const acc = await horizon.loadAccount(kp.publicKey());
      return acc.balances.find((x) => "asset_code" in x && x.asset_code === "USDC" && x.asset_issuer === issuer.publicKey())?.balance;
    };
    const [ba, bb, bc] = await Promise.all([balance(ada), balance(bea), balance(cyd)]);
    assert(ba === "1200.5000000" && bb === "980.0000000" && bc === "1500.0000001", `exact balances on chain, paid once each (got ${ba}, ${bb}, ${bc})`);
    log("All paid, exactly once", `on-chain balances: Ada ${ba}, Bea ${bb}, Cyd ${bc}`);
    for (const item of after.items) console.log(`    ${item.name.padEnd(4)} ${item.status}  https://stellar.expert/explorer/testnet/tx/${item.txHash}`);
    console.log("\nScenario passed.");
  } finally {
    server.close();
    await prisma.$disconnect();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
