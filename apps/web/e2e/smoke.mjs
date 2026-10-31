// End-to-end smoke test: the real dashboard (http://localhost:3400) against the real API
// (http://localhost:4400) and Stellar Testnet. Signs up through the UI, sets up a funding wallet
// and two employees, creates and pays a run (a local Testnet key signs in place of Freighter),
// then checks the dashboard shows the verified payments and that Verify passes.
//
//   node apps/web/e2e/smoke.mjs        (API, worker and web running; `pnpm proof` run once)
//
// Uses the funding wallet from apps/api/.proof-keys.json and two employee wallets from the proof
// (docs/testnet-proof.json), which already trust USDC. Screenshots go to apps/web/e2e/shots.

import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Keypair, Networks, TransactionBuilder } from "@stellar/stellar-sdk";
import { chromium } from "playwright-core";

const WEB = process.env.WEB_URL ?? "http://localhost:3400";
const API = process.env.API_URL ?? "http://localhost:4400";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../../..");
const SHOTS = path.join(HERE, "shots");
const CHROME = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const funder = Keypair.fromSecret(JSON.parse(readFileSync(path.join(ROOT, "apps/api/.proof-keys.json"), "utf8")).funder);
const proof = JSON.parse(readFileSync(path.join(ROOT, "docs/testnet-proof.json"), "utf8"));
const staff = proof.payments.slice(0, 2).map((p, i) => ({ name: p.name, wallet: p.wallet, salary: i === 0 ? "0.3000000" : "0.4500001" }));

let step = 0;
const ok = (msg) => console.log(`✓ ${++step}. ${msg}`);
const fail = (msg) => {
  throw new Error(`FAILED: ${msg}`);
};

mkdirSync(SHOTS, { recursive: true });
const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const context = await browser.newContext({ viewport: { width: 1360, height: 900 } });
const page = await context.newPage();
const shot = (name) => page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));

/** The API with the browser's own session cookie and the web app's Origin, as the dashboard calls it. */
const call = async (method, route, data) => {
  const res = await context.request.fetch(`${API}${route}`, {
    method,
    headers: { Origin: WEB, "Content-Type": "application/json", ...(method !== "GET" ? { "Idempotency-Key": randomUUID() } : {}) },
    data: data === undefined ? undefined : JSON.stringify(data),
  });
  const body = res.status() === 204 ? null : await res.json();
  if (res.status() >= 300) fail(`${method} ${route} → ${res.status()} ${JSON.stringify(body)}`);
  return body;
};

try {
  // 1. Landing
  await page.goto(WEB, { waitUntil: "networkidle" });
  if (!(await page.getByText("Prove every payment.").first().isVisible())) fail("landing hero");
  await shot("01-landing");
  ok("landing page renders");

  // 2. Sign up through the UI
  await page.goto(`${WEB}/signup`, { waitUntil: "networkidle" });
  const email = `smoke-${Date.now()}@orgpay.test`;
  await page.fill("#biz", "Smoke Test Org");
  await page.fill("#email", email);
  await page.fill("#pw", "smoke test password 123");
  await page.locator('input[type="checkbox"]').first().check();
  await page.getByRole("button", { name: "Create account" }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/signup"), { timeout: 20_000 });
  ok(`signed up in the UI as ${email} → ${new URL(page.url()).pathname}`);
  const me = await call("GET", "/auth/me");
  if (!me.company) fail("session cookie not shared with the API");
  ok("the browser's session cookie works against the API");

  // 3. Funding wallet and employees (through the API, as the dialogs do)
  const { wallet } = await call("POST", "/v1/wallets", { address: funder.publicKey(), label: "Payroll treasury" });
  ok(`funding wallet added: ${wallet.usdcBalance} USDC on Testnet`);
  for (const s of staff) await call("POST", "/v1/employees", { name: s.name, walletAddress: s.wallet, salary: s.salary });
  await page.goto(`${WEB}/people`, { waitUntil: "networkidle" });
  for (const s of staff) await page.getByText(s.name).first().waitFor({ timeout: 15_000 });
  await shot("02-employees");
  ok("employees list shows both employees");

  // 4. Run: create, then open it in the UI and review
  const employees = (await call("GET", "/v1/employees")).data;
  const { run } = await call("POST", "/v1/payroll-runs", { name: "Smoke payroll", walletId: wallet.id, employeeIds: employees.map((e) => e.id) });
  if (run.total !== "0.7500001") fail(`run total ${run.total}`);
  await page.goto(`${WEB}/payroll/${run.id}`, { waitUntil: "networkidle" });
  await page.getByText("Smoke payroll").first().waitFor();
  await shot("03-run-draft");
  ok(`run #${run.number} open in the UI: 2 employees, total ${run.total} USDC`);

  // 5. Execute and pay on Testnet (a local key signs, as Freighter would)
  await call("POST", `/v1/payroll-runs/${run.id}/start`);
  for (let i = 0; i < 5; i++) {
    const { transaction } = await call("POST", `/v1/payroll-runs/${run.id}/transactions/next`);
    if (!transaction) break;
    const tx = TransactionBuilder.fromXDR(transaction.xdr, Networks.TESTNET);
    tx.sign(funder);
    let res = await call("POST", `/v1/payroll-runs/${run.id}/transactions/${transaction.id}/submit`, { signedXdr: tx.toXDR() });
    for (let w = 0; res.transaction.status === "SUBMITTED" && w < 20; w++) {
      await new Promise((r) => setTimeout(r, 3000));
      res = { transaction: (await call("GET", `/v1/payroll-runs/${run.id}`)).run.transactions.find((t) => t.id === transaction.id) };
    }
    ok(`transaction ${transaction.number} ${res.transaction.status}: ${res.transaction.explorerUrl ?? res.transaction.txHash}`);
  }
  const paid = (await call("GET", `/v1/payroll-runs/${run.id}`)).run;
  if (paid.status !== "COMPLETED") fail(`run status ${paid.status}`);

  // 6. The UI shows the verified payments
  await page.goto(`${WEB}/payroll/${run.id}`, { waitUntil: "networkidle" });
  await page.getByText("Completed").first().waitFor({ timeout: 15_000 });
  const hashes = paid.payments.map((p) => p.txHash);
  for (const h of hashes) {
    const link = page.locator(`a[href$="${h}"]`).first();
    if ((await link.count()) === 0) fail(`no explorer link for ${h}`);
  }
  await shot("04-run-completed");
  ok("run page shows Completed, two Successful payments and their explorer links");

  // 7. Verify a payment from the UI
  await page.getByRole("button", { name: "Verify" }).first().click();
  await page.getByText("Verified on Stellar just now.").waitFor({ timeout: 20_000 });
  await shot("05-verify");
  ok("Verify dialog: all 8 checks pass, read from Horizon");

  // 8. Overview
  await page.goto(`${WEB}/dashboard`, { waitUntil: "networkidle" });
  await page.getByText("Smoke payroll").first().waitFor({ timeout: 15_000 });
  await shot("06-overview");
  ok("overview lists the run");

  if (errors.length) fail(`page errors: ${errors.join(" | ")}`);
  console.log(`\nSmoke test passed. Screenshots in ${path.relative(process.cwd(), SHOTS)}`);
  for (const h of hashes) console.log(`  https://stellar.expert/explorer/testnet/tx/${h}`);
} catch (err) {
  await shot("zz-failure").catch(() => {});
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await browser.close();
}
