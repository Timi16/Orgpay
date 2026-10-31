# OrgPay

Payroll in USDC on **Stellar Testnet** (no real money). An organization adds its employees with a
Stellar wallet and a USDC salary, creates a payroll run, reviews the total, executes it, and OrgPay
tracks every payment until the Stellar ledger confirms it: **successful** with a verified
transaction hash, or **failed** with the reason. OrgPay never holds a secret key: it builds each
transaction unsigned, the organization signs it with its funding wallet (Freighter), and OrgPay
submits it and checks the ledger record against the payment before calling it successful.

| | |
|---|---|
| Design | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) |
| Deploying to a server | [docs/DEPLOY.md](docs/DEPLOY.md) |
| API, worker, tests | [docs/BACKEND.md](docs/BACKEND.md) |
| Dashboard | [docs/FRONTEND.md](docs/FRONTEND.md) |
| Testnet proof | [docs/TRANSACTIONS.md](docs/TRANSACTIONS.md): six payments, six verified transactions |

`apps/api` is the backend (API + worker); `apps/web` is the Next.js dashboard; `packages/shared` holds
the schemas both use.

## Run it locally

Needs Node 22+, pnpm and Docker (for Postgres 16).

```sh
pnpm install
cp .env.example .env            # then set SESSION_SECRET: openssl rand -hex 32
pnpm db:up                      # Postgres 16 on localhost:5437
pnpm --filter @orgpay/api db:deploy
pnpm dev                        # API on http://127.0.0.1:4400 (reference at /docs)
pnpm dev:worker                 # confirmer, notifier, housekeeping
cp apps/web/.env.example apps/web/.env.local
pnpm dev:web                    # dashboard on http://localhost:3400 (talks to the API on :4400)
pnpm seed                       # optional: demo@orgpay.local / demo-password-123 (employees + a draft)
```

`GET http://127.0.0.1:4400/health` answers `{"status":"ok","db":"up","network":"testnet",...}`. Paying from the dashboard
needs the Freighter extension on Testnet, holding the funding wallet's account. The API only accepts the
dashboard from `WEB_ORIGIN` (`http://localhost:3400` in `.env.example`).

## The workflow, through the API

```text
POST /v1/employees                              name, walletAddress, salary
POST /v1/payroll-runs   + Idempotency-Key       walletId, employeeIds  → DRAFT with the exact total
GET  /v1/payroll-runs/:id/check                 who can receive, funding, duplicates by pay date
POST /v1/payroll-runs/:id/start                 execute → PROCESSING
POST /v1/payroll-runs/:id/transactions/next     unsigned XDR (one payment by default)
     sign it with the funding wallet
POST /v1/payroll-runs/:id/transactions/:txId/submit
     … repeat until `transaction` is null → COMPLETED / PARTIALLY_PAID / FAILED
GET  /v1/payments/:id/verify                    re-check a payment on the ledger
```

Payment statuses: PENDING → AWAITING_SIGNATURE → SUBMITTED → SUCCESSFUL or FAILED (or CANCELLED).
A payment is SUCCESSFUL only after its ledger record is verified: the hash OrgPay built, from the
funding wallet, to the employee's wallet, the exact amount of USDC, `op_success`.

## Checks

```sh
pnpm lint && pnpm typecheck && pnpm test
```

`pnpm test` starts a throwaway Postgres with Testcontainers and runs 113 tests against an in-memory
fake Stellar network, including verification (V1–V6) and repeated-request (D1–D7) cases.

## Proving it on real Testnet

```sh
pnpm proof
```

Funds a wallet with Friendbot, buys Circle Testnet USDC on the DEX, pays six fresh employees one
transaction each (one without a trustline fails first, then succeeds after a retry), repeats requests
to show nothing is paid twice, re-reads every hash from Horizon, checks balances, and writes
[docs/TRANSACTIONS.md](docs/TRANSACTIONS.md). Takes about a minute.

Then `node apps/web/e2e/smoke.mjs` drives the real dashboard in Chrome against the running API and
Testnet: signs up in the UI, pays a two-person run, and checks the run page, explorer links and the
Verify dialog (screenshots in `apps/web/e2e/shots`).
