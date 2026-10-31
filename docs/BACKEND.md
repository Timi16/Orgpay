# OrgPay Backend

The API and worker for OrgPay. Read [ARCHITECTURE.md](ARCHITECTURE.md) first for the data model,
statuses and payment lifecycle; this document covers how the backend implements them.

## Stack

Node.js 22, Express 5, TypeScript strict (`noUncheckedIndexedAccess`), PostgreSQL 16 via Prisma 6,
Zod with zod-to-openapi (Scalar reference at `/docs`), `@stellar/stellar-sdk` 17, helmet, cors,
express-rate-limit, cookie-parser, argon2, pino. Tests: Vitest, supertest, Testcontainers.

## Layout

```
apps/api/
  prisma/schema.prisma
  src/
    server.ts                API process
    worker.ts                worker process (confirmer, notifier)
    app.ts                   buildApp(), used by server and tests
    config/env.ts            Zod-validated env; refuses any non-testnet passphrase
    lib/                     amount, errors, logger, ids, cursor, mailer
    middleware/              requestId, auth, requireOrigin, rateLimit, idempotency, validate, errorHandler
    stellar/
      gateway.ts             StellarGateway interface
      horizonGateway.ts      Horizon implementation
      results.ts             decode result codes and result XDR per operation
      verify.ts              ledger verification of a payment (see below)
    modules/
      auth/  health/  apiKeys/  groups/
      wallets/               funding wallets: add, refresh, remove
      employees/             list, create, update, deactivate, reactivate, check, import
      payroll/
        routes.ts service.ts repo.ts serialize.ts
        transitions.ts       the only place run, payment and transaction statuses change
        checks.ts            recipient and funding checks from fresh Horizon data
        build.ts             build unsigned transactions
        settle.ts            apply a ledger record to a transaction and its payments
      payments/              GET one payment, /verify
      summary/               dashboard numbers
    engine/
      confirmer.ts           settles open transactions from the ledger
      notifier.ts            emails when a run finishes
  scripts/
    seed.ts                  demo organization, employees and runs
    proof.ts                 the Testnet proof (writes docs/TRANSACTIONS.md)
  test/unit, test/integration, test/helpers (fake Stellar network)
packages/shared/             Zod schemas, amount helpers, types shared with the web app
```

Layering is routes → service → repo. Every repo function on organization data takes `orgId` first
and puts it in every `where`.

## Rules

1. **Money is never a float.** Bigint stroops in code, `BigInt` columns, decimal strings in JSON
   (`"1500.0000000"`). ESLint bans `parseFloat` and `Number()` on amounts.
2. **Statuses change only in `transitions.ts`**, conditionally on the expected current status, inside
   a database transaction that holds row locks.
3. **SUCCESSFUL is set only by `settle.ts`, from a ledger record that passes `verify.ts`.**
4. **No secret keys.** Any input that looks like an `S…` secret is refused with `SECRET_KEY_REJECTED`
   and never stored or logged. Logs redact authorization, cookies, passwords and signed XDR.
5. **Testnet only.** Boot fails unless `NETWORK_PASSPHRASE` is the Testnet passphrase.
6. **Every write takes an `Idempotency-Key`.**

## Validation

Shared Zod schemas, `.strict()` on every body, query and param.

| Field | Rule |
|---|---|
| Wallet address | A valid Ed25519 public key (`StrKey.isValidEd25519PublicKey`, `G…`). Muxed `M…` addresses, contract `C…` addresses and secrets are refused. |
| Salary / payment amount | `^\d{1,12}(\.\d{1,7})?$`, converted to stroops, > 0, ≤ int64 max. |
| Name | 1–120 characters, trimmed, shown as plain text. |
| `paymentsPerTx` | Integer 1–100, default 1. |

Then a **receive check** on Horizon for each employee: the account exists, it has an authorized
trustline to the configured USDC issuer, and its limit minus balance minus buying liabilities covers
the amount. Failures are stored as `checkReason` and shown, and don't block saving the employee.
Employees are re-checked at execute time and before every transaction is built.

**Funding check**: USDC balance minus selling liabilities ≥ amount to send, and XLM balance minus
selling liabilities minus minimum reserve ≥ fees.

## Idempotency

Middleware on every `POST`, `PATCH` and `DELETE` under `/v1`. The client sends
`Idempotency-Key: <uuid>`, and the dashboard creates one per user action.

```
IdempotencyKey(orgId, key) unique
  route         "POST /v1/payroll-runs"
  requestHash   SHA-256 of the canonical JSON body
  state         IN_PROGRESS | DONE
  responseStatus, responseBody
  expiresAt     created + 24 h (pruned hourly by the worker)
```

| Case | Response |
|---|---|
| New key | Insert IN_PROGRESS, run the handler, store the response, mark DONE. |
| Same key, same route and body, DONE | Replay the stored status and body. Nothing runs again. |
| Same key, still IN_PROGRESS | `409 REQUEST_IN_PROGRESS` (the client waits and retries). |
| Same key, different body or route | `422 IDEMPOTENCY_KEY_REUSED`. |
| Missing on a write | `400 IDEMPOTENCY_KEY_REQUIRED`. |
| Handler threw a 5xx | The key is deleted so the client can retry. 4xx responses are stored and replayed. |

Idempotency covers repeated HTTP requests. The payment engine's own rules (one open transaction per
run, SUCCESSFUL is final, hash check) cover delayed Stellar responses and the worker. Both layers
apply.

## REST API

Auth: session cookie `op_session` (dashboard) or `Authorization: Bearer op_test_…` (API key).
Cookie writes must carry `Origin = WEB_ORIGIN`.

Errors: `{ "error": { "code", "message", "details", "requestId" } }`.

**Auth**: `POST /auth/signup` · `POST /auth/login` · `POST /auth/logout` · `GET /auth/me` · password
reset and email verification as in PayBridge.

**Funding wallets**: `GET /v1/wallets` · `POST /v1/wallets {address, label?}` ·
`POST /v1/wallets/:id/refresh` · `DELETE /v1/wallets/:id`
→ `{ id, address, label, accountExists, usdcBalance, xlmBalance, hasUsdcTrustline, checkedAt }`

**Employees**

| Method and path | Purpose |
|---|---|
| `GET /v1/employees ?q, status=active\|inactive, cursor, limit` | List |
| `POST /v1/employees {name, email?, role?, walletAddress, salary}` | Add (201). Runs the receive check. |
| `GET /v1/employees/:id` | One employee with their payment history |
| `PATCH /v1/employees/:id {name?, email?, role?, walletAddress?, salary?}` | Edit. Existing runs keep their snapshot. |
| `POST /v1/employees/:id/deactivate` · `/reactivate` | Remove from or return to future payrolls |
| `POST /v1/employees/check {ids?}` | Re-check wallets on Horizon |
| `POST /v1/employees/import` | CSV rows, all-or-nothing (carried over) |

Employee: `{ id, name, email, role, walletAddress, salary, salaryStroops, active, check: { status:
"ready"|"problem"|"unchecked", reason, checkedAt } }`

**Payroll runs**

| Method and path | Purpose |
|---|---|
| `GET /v1/payroll-runs ?status, cursor, limit` | Past and current runs: number, name, status, employee count, total, successful/failed/pending counts |
| `POST /v1/payroll-runs {name, fundingWalletId, payDate?, employeeIds, paymentsPerTx?}` | Create a DRAFT (201) |
| `GET /v1/payroll-runs/:id` | Run with payments, transactions and events |
| `PATCH /v1/payroll-runs/:id {name?, payDate?, fundingWalletId?, paymentsPerTx?}` | DRAFT only |
| `POST /v1/payroll-runs/:id/payments {employeeIds}` · `PATCH …/payments/:paymentId {amount}` · `DELETE …/payments/:paymentId` | Edit lines, DRAFT only (`409 RUN_LOCKED` otherwise) |
| `GET /v1/payroll-runs/:id/check` | Read-only review: employee count, total, per-payment `{ ok, reason }`, funding `{ usdcAvailable, xlmAvailable, enough, shortBy }`, employees already paid in another run with the same pay date |
| `POST /v1/payroll-runs/:id/start` | Execute: DRAFT → PROCESSING (`400 INSUFFICIENT_FUNDS`, `409 NOTHING_TO_PAY`) |
| `POST /v1/payroll-runs/:id/transactions/next` | `{ tx: { id, number, xdr, txHash, maxTime, opCount, total, paymentIds }, run }`, or `{ tx: null, run }` when nothing is left to sign |
| `POST /v1/payroll-runs/:id/transactions/:txId/submit {signedXdr}` | 200 when settled, 202 when still SUBMITTED. `400 TX_MISMATCH` if the hash differs. |
| `POST /v1/payroll-runs/:id/retry {paymentIds?}` | FAILED → PENDING after a fresh check |
| `POST /v1/payroll-runs/:id/cancel` | DRAFT, or PROCESSING with no open transaction |
| `DELETE /v1/payroll-runs/:id` | DRAFT only |
| `GET /v1/payroll-runs/:id/export.csv` | Payments with hashes and explorer links |

**Payments**

| Method and path | Purpose |
|---|---|
| `GET /v1/payments/:id` | One payment with its run, employee and transaction |
| `GET /v1/payments/:id/verify` | Re-runs ledger verification against Horizon: `{ verified, checks: { found, successful, source, destination, asset, amount, opResult }, ledger, closedAt, explorerUrl }` |

**Other**: `GET /v1/summary` (dashboard numbers) · `GET /health` · `GET /openapi.json` · `GET /docs`

Payment in responses: `{ id, position, employeeId, name, walletAddress, amount, status, failureCode,
failureDetail, txHash, ledger, verifiedAt, explorerUrl }`, where `explorerUrl` is
`https://stellar.expert/explorer/testnet/tx/<hash>` and is present only when the payment has a hash.

## Stellar

```ts
interface StellarGateway {
  loadAccount(address): { exists: false } | { exists: true, sequence, balances, subentries, … }
  latestLedger(): { sequence, closedAt }
  getTransaction(hash): null | { successful, ledger, closedAt, envelopeXdr, resultXdr, memo }
  submit(signedXdr): { kind: "success", ledger } | { kind: "failed", txCode, opCodes[] } | { kind: "unknown" }
}
```

Horizon errors throw `HORIZON_UNAVAILABLE` (503) and change nothing. Tests use an in-memory fake
network that implements the same interface.

**Building** (`build.ts`): source is the funding wallet, sequence is the account's sequence + 1 (never
behind the last transaction this wallet landed), one `payment` operation per payment, memo
`OrgPay R<run> P<position>` (or `OrgPay R<run> T<tx>` for more than one payment, max 28 bytes), fee
1000 stroops per operation, timebounds now → now + `TX_WINDOW_SECONDS` (always later than the run's
previous transaction, so a rebuilt envelope is never identical).

**Verifying** (`verify.ts`): given a payment and the ledger record of its hash, check `successful`,
the source account, and at `opIndex` the operation type, destination, asset code and issuer, amount,
and `op_success`. Return each check separately so `/verify` can show them.

**Settling** (`settle.ts`), from a ledger record:

| Ledger says | Transaction | Each payment |
|---|---|---|
| Successful, verification passes | CONFIRMED | SUCCESSFUL with hash, ledger, `verifiedAt` |
| Successful, verification fails | stays SUBMITTED, alert raised | unchanged (never SUCCESSFUL) |
| Failed | FAILED | `op_no_destination` → FAILED `ACCOUNT_NOT_FOUND`; `op_no_trust` → FAILED `NO_TRUSTLINE`; `op_not_authorized` → FAILED `NOT_AUTHORIZED`; `op_line_full` → FAILED `TRUSTLINE_LIMIT_TOO_LOW`; source-side or `op_success` in a failed tx → PENDING; anything else → FAILED `PAYMENT_FAILED` |
| Not found, and the ledger closed > 30 s past `maxTime` (2 min if the sequence was used) | EXPIRED | PENDING |
| Not found yet | unchanged | unchanged |

A submit rejection (including `tx_failed` or `tx_bad_seq` at validation) or a timeout is never final
on its own. The code is recorded and the transaction stays SUBMITTED until the ledger decides.

## Worker

One `orgpay-worker` process. Never run two.

| Loop | Every | Does |
|---|---|---|
| confirmer | 5 s | For each SUBMITTED or AWAITING_SIGNATURE transaction: read the funding account and latest ledger, then look the hash up and settle. Re-sends a SUBMITTED envelope with no answer at most every 30 s inside its window. Finishes runs that have nothing open. |
| notifier | 15 s | Emails the organization when a run finishes. |
| pruner | 1 h | Deletes expired idempotency keys and rate-limit counters. |

## Environment

`NODE_ENV`, `PORT` (4200), `HOST`, `DATABASE_URL`, `HORIZON_URL`, `NETWORK_PASSPHRASE` (Testnet only),
`USDC_ISSUER`, `WEB_ORIGIN`, `SESSION_SECRET`, `TX_WINDOW_SECONDS` (300), `SMTP_URL?`, `MAIL_FROM`,
`LOG_LEVEL`.

## Tests

Every case has at least one test whose name starts with its ID. Integration tests run on a real
Postgres (Testcontainers) against the fake Stellar network.

**Employees**
- E1 Invalid, muxed, contract or secret address → 400; the secret is never stored or logged.
- E2 Same wallet on two active employees → `409 WALLET_IN_USE` (deactivated ones don't count).
- E3 Salary 0, negative, more than 7 decimals, or too large → 400.
- E4 Deactivated employee: can't be added to new runs, still shown on old runs.
- E5 Editing an employee's wallet doesn't change payments already on a run.
- E6 Receive check: missing account, no trustline, not authorized, limit too low → reason stored and shown.

**Runs and payments**
- R1 Run from selected employees: one payment each at their salary; total = exact bigint sum; count is correct.
- R2 Edits outside DRAFT → `409 RUN_LOCKED`.
- R3 Execute: employees who can't receive → FAILED with reason; the rest proceed.
- R4 Execute with a short funding wallet → `400 INSUFFICIENT_FUNDS`, nothing changes.
- R5 `paymentsPerTx = 1`: each payment gets its own transaction and hash; the memo names run and position.
- R6 `paymentsPerTx = n`: at most n operations; one hash shared, `opIndex` per payment.
- R7 Submit with a different transaction → `400 TX_MISMATCH`.
- R8 `op_no_trust` on one operation → that payment FAILED, the others back to PENDING.
- R9 Window passes by ledger time with nothing on chain → EXPIRED, payments PENDING, the next build is a new envelope.
- R10 Run status: all successful → COMPLETED; some → PARTIALLY_PAID; none → FAILED.
- R11 Cancel rules (DRAFT; PROCESSING without an open transaction; `409` with one).

**Verification**
- V1 A submit that returns success → SUCCESSFUL only after the ledger record is read and verified.
- V2 Submit timeout or unknown → SUBMITTED, never SUCCESSFUL; the confirmer settles it later.
- V3 Ledger shows the transaction failed → FAILED or PENDING, never SUCCESSFUL.
- V4 Ledger record whose operation doesn't match the payment → stays SUBMITTED, alert raised.
- V5 Run with a FAILED or SUBMITTED payment is never COMPLETED.
- V6 `/verify` reports each check and agrees with the stored status.

**Duplicates**
- D1 Same create-run request and key twice → one run, identical responses.
- D2 Same key with a different body → `422 IDEMPOTENCY_KEY_REUSED`.
- D3 Two concurrent requests with one key → one runs, the other gets `409 REQUEST_IN_PROGRESS`.
- D4 Execute pressed twice (new keys) → second gets `409 INVALID_TRANSITION`; no extra transaction.
- D5 Next transaction asked twice while one is open → the same envelope.
- D6 Same signed XDR submitted twice, or submit racing the confirmer → settled once.
- D7 Transaction submitted outside OrgPay → found by the confirmer, settled once.
- D8 Retry never re-queues a SUCCESSFUL payment.
- D9 After every D case, each employee's balance moved by exactly their amount once (fake network ledger).

**System**
- S1 Horizon down during check, execute or build → 503, nothing changes.
- S2 Postgres down → 503.
- S3 Worker restart: SUBMITTED transactions are still settled.
- S4 Boot refuses a non-Testnet passphrase.
- S5 Tenant isolation: another organization's IDs → 404 on every route.

## Testnet proof

`pnpm proof` (`apps/api/scripts/proof.ts`) runs the API in-process against real Testnet and
**Circle Testnet USDC**. A local throwaway keypair signs in place of Freighter. Keys go in a
git-ignored `scripts/.env` so re-runs reuse funded accounts.

1. **Setup**: Friendbot-fund the funding wallet and six employee accounts. Five employees add a USDC
   trustline; the sixth doesn't. The funding wallet adds a trustline and buys USDC on the Testnet DEX
   with XLM (as Sisonke's `make e2e-setup` does) until it holds enough.
2. **Employees**: add six with different salaries (for example 1.0000000 to 2.5000001 USDC). Assert
   the sixth shows `NO_TRUSTLINE`.
3. **Run**: create one run with all six and `paymentsPerTx = 1`. Assert the employee count is 6 and
   the total is the exact sum.
4. **Execute**: assert the sixth is FAILED and never in a transaction. Build, sign and submit five
   transactions. Assert five SUCCESSFUL payments with **five distinct hashes**.
5. **Duplicates**: resend the create-run request with the same key (same run back), execute again
   (`409`), resubmit a signed XDR (settled once), ask for the next transaction (`null`).
6. **Retry**: the sixth employee adds a trustline, retry, sign and submit. Assert it is SUCCESSFUL
   and the run is COMPLETED.
7. **Independent check**: for every hash, read the transaction straight from Horizon (not the
   database) and check source, destination, asset, amount and memo. Read every employee's USDC
   balance and assert it rose by exactly their salary, once.
8. **Output**: `docs/TRANSACTIONS.md` (run, employee, wallet, amount, status, hash, ledger, explorer
   link) and `deployments/testnet-proof.json`. Exit non-zero if any check fails.
