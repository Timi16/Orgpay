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
  prisma/schema.prisma, prisma/migrations/
  src/
    server.ts                API process (port 4400)
    worker.ts                worker process: confirmer, notifier, housekeeping
    app.ts                   buildApp(), used by the server, the tests and the proof
    config/env.ts            Zod-validated env; refuses any non-testnet passphrase
    lib/                     amount, asset, errors, logger, ids, cursor, mailer, emails
    middleware/              requestId, auth, requireOrigin, rateLimit, idempotency, validate, errorHandler
    stellar/
      gateway.ts             StellarGateway interface
      horizonGateway.ts      Horizon implementation
      checks.ts              recipient and funding checks
      results.ts             decode result codes and result XDR per operation
      verify.ts              checks a ledger record against one payment
    modules/
      auth/  apiKeys/  health/  groups/  summary/
      wallets/               funding wallets: add, refresh, challenge, verify, remove
      employees/             list, create, update, deactivate, reactivate, check, import
      payroll/
        routes.ts            /v1/payroll-runs and /v1/payments
        service.ts           runs, review, execute, build, submit, settle, retry, cancel, verify, CSV
        repo.ts serialize.ts
        transitions.ts       the only place run, payment and transaction statuses change
        batches.ts           builds unsigned transactions; checks the signed one
        settle.ts            applies a ledger record (or expiry) to a transaction and its payments
    engine/
      confirmer.ts           settles open transactions from the ledger
      notifier.ts            emails when a run finishes
  scripts/
    seed.ts                  demo organization, employees and one draft (no payment history)
    proof.ts                 the Testnet proof (writes docs/TRANSACTIONS.md)
  test/unit, test/integration, test/helpers (fake Stellar network, harness)
packages/shared/             Zod schemas, amount helpers, types shared with the web app
```

Layering is routes → service → repo. Every repo function on organization data takes `companyId`
first and puts it in every `where`. In the database a payment is a `PayrollItem` and a Stellar
transaction is a `PayrollBatch`; the serializers turn them into `payments` and `transactions`.

## Rules

1. **Money is never a float.** Bigint stroops in code, `BigInt` columns, decimal strings in JSON
   (`"1500.0000000"`). ESLint bans `parseFloat` and `Number()` on amounts, scripts included.
2. **Statuses change only in `transitions.ts`**, conditionally on the expected current status, inside
   a database transaction that holds the run's row lock. ESLint forbids `status:` in any other
   payroll update.
3. **SUCCESSFUL is set only by `settle.ts`, from a ledger record that passes `verify.ts`** for every
   payment in the transaction.
4. **No secret keys.** Any input that looks like an `S…` secret is refused with `SECRET_KEY_REJECTED`
   and never stored or logged. Logs redact authorization, cookies, passwords and signed XDR.
5. **Testnet only.** Boot fails unless `NETWORK_PASSPHRASE` is the Testnet passphrase.
6. **Creating a run needs an `Idempotency-Key`**; every other write may carry one.

## Validation

Shared Zod schemas, `.strict()` on every body, query and param.

| Field | Rule |
|---|---|
| Wallet address | A valid Ed25519 public key (`G…`). Muxed `M…` addresses, contract addresses and secrets are refused. |
| Salary / payment amount | `^\d{1,12}(\.\d{1,7})?$`, converted to stroops, > 0, ≤ int64 max. |
| Name | 1–100 characters, trimmed, never a pasted secret. |
| `paymentsPerTx` | Integer 1–100, default 1. Changeable only while the run is a draft. |

Then a **receive check** on Horizon for each employee: the account exists, it has an authorized
trustline to the configured USDC issuer, and its limit minus balance minus buying liabilities covers
the amount. A failure is stored as `checkReason` and shown; it doesn't block saving the employee.
Employees are checked again at execute time and before every transaction is built.

**Funding check**: USDC balance minus selling liabilities ≥ the amount to send, and XLM balance minus
selling liabilities minus the minimum reserve ≥ fees.

## Idempotency

`middleware/idempotency.ts`, on every `POST`, `PATCH` and `DELETE` under `/v1`, after auth and the
rate limits. The dashboard sends `Idempotency-Key: <uuid>`, one per user action.

```
IdempotencyKey  primary key (companyId, key)
  route         "POST /v1/payroll-runs"
  requestHash   SHA-256 of the route and the body as canonical JSON (key order doesn't matter)
  state         IN_PROGRESS | DONE
  responseStatus, responseBody
  expiresAt     created + 24 h (the worker prunes expired keys)
```

| Case | Response |
|---|---|
| No key on `POST /v1/payroll-runs` | `400 IDEMPOTENCY_KEY_REQUIRED` |
| No key on any other write | Runs normally. |
| Key not 8–255 of `A–Z a–z 0–9 - _ : .` | `400 VALIDATION_FAILED` |
| New key | Stored IN_PROGRESS, the handler runs, its response is stored (DONE) before it is sent. |
| Same key, same route and body, DONE | The stored status and body, with `Idempotent-Replayed: true`. Nothing runs again. |
| Same key, still IN_PROGRESS | `409 REQUEST_IN_PROGRESS` (`Retry-After: 1`). |
| Same key, different body or route | `422 IDEMPOTENCY_KEY_REUSED` |
| The handler answered 5xx | The key is deleted, so the client can retry. 4xx answers are stored and replayed. |

Keys belong to one organization: another organization can use the same value. Idempotency covers
repeated HTTP requests; the payment engine's own rules (one open transaction per run, SUCCESSFUL is
final, the hash check, Execute only from DRAFT) cover delayed Stellar answers, the worker, and
repeats sent without a key.

## REST API

Auth: session cookie `op_session` (dashboard) or `Authorization: Bearer op_test_…` (API key).
Cookie writes must carry `Origin = WEB_ORIGIN`. The reference is served at `/docs`
(`/openapi.json`).

Errors: `{ "error": { "code", "message", "details", "requestId" } }`.

**Auth**: `POST /auth/signup` · `POST /auth/login` · `POST /auth/logout` · `GET /auth/me` · password
reset, email verification, sessions and account closing as in PayBridge.

**Funding wallets** (session only): `GET /v1/wallets` · `POST /v1/wallets {address, label?}` ·
`POST /v1/wallets/:id/refresh` · `DELETE /v1/wallets/:id`
→ `{ id, address, label, accountExists, usdcBalance, xlmBalance, hasUsdcTrustline, checkedAt, … }`

**Employees**

| Method and path | Purpose |
|---|---|
| `GET /v1/employees ?q, groupId, status=active\|inactive, cursor, limit` | List |
| `POST /v1/employees {name, email?, role?, walletAddress, salary, groupId?}` | Add (201). Runs the receive check. |
| `GET /v1/employees/:id` | One employee |
| `PATCH /v1/employees/:id {name?, email?, role?, walletAddress?, salary?, groupId?}` | Edit. Existing runs keep their snapshot. |
| `POST /v1/employees/:id/deactivate` · `/reactivate` | Leave out of, or return to, future runs |
| `POST /v1/employees/check {ids?}` | Re-check wallets on Horizon |
| `POST /v1/employees/import` | Up to 500 rows, all-or-nothing |

Employee: `{ id, name, email, role, walletAddress, salary, salaryStroops, group, active, check: {
status: "ready"|"problem"|"unchecked", reason, checkedAt }, createdAt, updatedAt }`

**Payroll runs**

| Method and path | Purpose |
|---|---|
| `GET /v1/payroll-runs ?status, cursor, limit` | Past and current runs: number, name, status, `employeeCount`, `total`, `paidTotal`, per-status `counts` |
| `POST /v1/payroll-runs {name, walletId, payDate?, paymentsPerTx?, employeeIds?, groupIds?}` + `Idempotency-Key` | Create a DRAFT (201): one payment per active employee, at their salary |
| `GET /v1/payroll-runs/:id` | The run with `payments`, `transactions` and `events` |
| `PATCH /v1/payroll-runs/:id {name?, payDate?, walletId?, paymentsPerTx?}` | DRAFT only |
| `POST /v1/payroll-runs/:id/payments {employeeIds?, groupIds?}` · `PATCH …/payments/:paymentId {amount}` · `DELETE …/payments/:paymentId` | Edit payments, DRAFT only (`409 RUN_LOCKED` otherwise) |
| `GET /v1/payroll-runs/:id/check` | Review: per-payment `{ paymentId, ok, reason }`, `payableCount`, `payableTotal`, funding `{ usdcAvailable, xlmAvailable, feeXlm, enough, problem, shortBy }`, `alsoPaidElsewhere` (employees already paid by another run with the same pay date) |
| `POST /v1/payroll-runs/:id/start` | Execute: DRAFT → PROCESSING (`400 INSUFFICIENT_FUNDS`, `409 NOTHING_TO_PAY`, `409 INVALID_TRANSITION` if already executed) |
| `POST /v1/payroll-runs/:id/transactions/next` | `{ transaction: { id, number, txHash, xdr, networkPassphrase, maxTime, opCount, total, paymentIds, … }, run }`, or `{ transaction: null, run }` when nothing is left to sign |
| `POST /v1/payroll-runs/:id/transactions/:txId/submit {signedXdr}` | 200 when settled, 202 when still SUBMITTED. `400 TX_MISMATCH` / `INVALID_SIGNATURE` if it isn't the transaction OrgPay built, signed by the funding wallet. Submitting again never sends twice. |
| `POST /v1/payroll-runs/:id/retry {paymentIds?}` | FAILED → PENDING after a fresh check |
| `POST /v1/payroll-runs/:id/cancel` | DRAFT, or PROCESSING with no open transaction |
| `DELETE /v1/payroll-runs/:id` | DRAFT only |
| `GET /v1/payroll-runs/:id/export.csv` | Payments with status, hash and explorer link (cells a spreadsheet would run as formulas are defused) |

**Payments**

| Method and path | Purpose |
|---|---|
| `GET /v1/payments/:id` | One payment with its run `{ id, number, name, status }` |
| `GET /v1/payments/:id/verify` | Reads the transaction from Horizon and re-runs the checks: `{ paymentId, status, txHash, verified, checks: { found, successful, hashMatches, source, destination, asset, amount, opResult }, ledger, closedAt, explorerUrl, checkedAt }`. Read-only. |

**Other**: `GET /v1/summary` (dashboard numbers: paid this month, failed payments, draft, active and
recent runs, monthly totals) · `GET /health` (`{ status, db, network, openTransactions }`)

Payment: `{ id, runId, position, employeeId, name, walletAddress, amount, amountStroops, status,
failureCode, failureDetail, txHash, ledger, paidAt, verifiedAt, transactionNumber, attempts,
explorerUrl }`. `txHash` and `explorerUrl`
(`https://stellar.expert/explorer/testnet/tx/<hash>`) are set only on a SUCCESSFUL payment.
Transaction: `{ id, number, status, txHash, opCount, total, maxTime, ledger, closedAt, resultCode,
submittedAt, settledAt, createdAt, explorerUrl }`, with `explorerUrl` once it reached a ledger.

## Stellar

```ts
interface StellarGateway {
  loadAccount(address): { exists: false } | { exists: true, sequence, balances, subentries, … }
  latestLedger(): { sequence, closedAt }
  getTransaction(hash): { found: null | { successful, ledger, closedAt, envelopeXdr, resultXdr }, nodeLedger }
  submit(signedXdr): { kind: "success", ledger } | { kind: "failed", txCode, opCodes[] } | { kind: "unknown" }
}
```

Horizon errors throw `HORIZON_UNAVAILABLE` (503) and change nothing. Tests use an in-memory fake
network with the same interface.

**Building** (`batches.ts`): source is the funding wallet, sequence is the account's sequence + 1
(never below the highest sequence a transaction from this wallet already used on the ledger), one
`payment` operation per payment, memo `OrgPay R<run> P<position>` (or `OrgPay R<run> T<number>` for
more than one payment; at most 28 bytes), fee 1000 stroops per operation, timebounds now → now +
`BATCH_WINDOW_SECONDS` (always later than the run's previous transaction, so a rebuilt envelope is
never identical).

**Verifying** (`verify.ts`): given the ledger record of a hash and a payment, check that the
transaction succeeded, that it hashes to the stored hash, that its source is the funding wallet, and
that the operation at the payment's index is a payment to the payment's wallet of exactly its amount
of the configured USDC, with `op_success`. Each check is reported on its own, so `/verify` can show
them.

**Settling** (`settle.ts`), from a ledger record:

| Ledger says | Transaction | Each payment |
|---|---|---|
| Successful, every payment verifies | CONFIRMED with ledger and close time | SUCCESSFUL with hash, ledger, `paidAt`, `verifiedAt` |
| Successful, a payment doesn't verify | unchanged, alert logged | unchanged (never SUCCESSFUL) |
| Failed | FAILED with result code, ledger and close time | `op_no_destination` → FAILED `ACCOUNT_NOT_FOUND`; `op_no_trust` → FAILED `NO_TRUSTLINE`; `op_not_authorized` → FAILED `NOT_AUTHORIZED`; `op_line_full` → FAILED `TRUSTLINE_LIMIT_TOO_LOW`; source-side codes or `op_success` in a failed transaction → PENDING; anything else → FAILED `PAYMENT_FAILED` |
| Not found, and a ledger closed > 30 s past `maxTime` (2 min if the sequence was used), from a node that has ingested that ledger | EXPIRED | PENDING |
| Not found yet | unchanged | unchanged |

A submit rejection (even `tx_failed` or `tx_bad_seq` at validation) or a timeout is never final on its
own: the code is recorded and the transaction stays SUBMITTED until the ledger decides.

## Worker

One `orgpay-worker` process. Never run two.

| Loop | Every | Does |
|---|---|---|
| confirmer | 5 s | Settles SUBMITTED transactions (and unsigned ones every 30 s or once past their window) from the ledger, organizations taking turns. Re-sends a SUBMITTED envelope with no answer at most every 30 s inside its window. Finishes runs with nothing open. |
| notifier | 15 s | Emails the organization when a run finishes (needs `SMTP_URL`). |
| housekeeping | 10 min | Deletes old login throttles, rate-limit counters and expired idempotency keys. |

## Environment

`NODE_ENV`, `PORT` (4400), `HOST`, `DATABASE_URL`, `HORIZON_URL`, `NETWORK_PASSPHRASE` (Testnet only),
`USDC_ISSUER`, `WEB_ORIGIN` (no trailing slash), `SESSION_SECRET` (64 hex), `SMTP_URL?`, `MAIL_FROM`,
`EMAIL_VERIFICATION`, `BATCH_WINDOW_SECONDS` (300), `ALERT_TELEGRAM_*?`, `LOG_LEVEL`. See
`.env.example`.

## Tests

`pnpm test`: 111 tests. Integration tests run on a real Postgres (Testcontainers) against the fake
Stellar network. Every case below has a test whose name starts with its ID.

**Employees** (`people.test.ts`)
- E1 Invalid, muxed, contract or secret address → 400; the secret is never stored or logged.
- E2 Same wallet on two active employees → `409 WALLET_IN_USE` (deactivated ones don't count).
- E3 Salary or payment amount 0, negative, more than 7 decimals, too large or not a string → 400.
- E4 A deactivated employee is left out of new runs and stays on old ones as drafted.
- E5 Deleting a group ungroups its employees.
- E6 Receive check: missing account, no trustline, not authorized, limit too low → reason stored and shown.

**Runs and payments** (`payroll.test.ts`)
- R1 Run from groups and employees: one payment each at their salary; total = exact bigint sum.
- R2 Edits outside DRAFT → `409 RUN_LOCKED`; Execute twice → `409 INVALID_TRANSITION`.
- R3 Execute: employees who can't receive → FAILED with the reason, never sent; the rest are paid.
- R4 Execute with a short funding wallet → `400 INSUFFICIENT_FUNDS`, nothing changes.
- R5 Nothing payable → `409 NOTHING_TO_PAY`.
- R6 A transaction has at most `paymentsPerTx` operations, the right sequence, memo and timebounds; asking again returns the same envelope.
- R7 A different, unsigned or wrongly signed transaction → refused, nothing submitted.
- R8 Default: one transaction per payment, each SUCCESSFUL with its own verified hash and memo `OrgPay R1 P<n>`; with `paymentsPerTx > 1` payments share a transaction.
- R9 `op_no_trust` on one operation → that payment FAILED, the others back to PENDING.
- R10 Submit timeout → SUBMITTED, settled from the ledger; a signed transaction the network never got is sent again.
- R11 A transaction submitted outside OrgPay is found and settled once.
- R12 Window passes by ledger time with nothing on chain → EXPIRED, payments PENDING, a new envelope next.
- R13 Retry only after a passing check; a SUCCESSFUL payment is never queued again.
- R14 Cancel rules (DRAFT; PROCESSING without an open transaction; refused with one).
- R15 Run status: all successful → COMPLETED; some → PARTIALLY_PAID; none → FAILED; one email per finish.
- R16 Same signed transaction twice, submit racing the confirmer, landed elsewhere first, lagging Horizon node → settled once.
- R17 A rejection before a ledger is never final; it expires by ledger time and the payments go back.
- R18 `paymentsPerTx` is 1–100, editable on the draft only, and decides how many payments go in each transaction.
- R19 The review warns about employees already paid by another run with the same pay date.
- R20 CSV export with status, hash and explorer link; formula-like cells are defused.

**Verification** (`verification.test.ts`)
- V1 A successful submit answer alone doesn't make a payment SUCCESSFUL; the ledger record does.
- V2 A timeout leaves the payment SUBMITTED and the run PROCESSING until the ledger shows it.
- V3 A transaction that failed on the ledger → FAILED with the reason, no hash.
- V4 A ledger record that doesn't match the payment → never SUCCESSFUL; `/verify` shows which check failed.
- V5 COMPLETED only when every payment is SUCCESSFUL.
- V6 `/verify` re-checks a payment on the ledger and agrees with its status.

**Repeated requests** (`duplicates.test.ts`)
- D1 The same create-run request and key twice → one run, identical responses (key order in the body doesn't matter).
- D2 No key → 400; a reused key on a different request → 422; keys are per organization.
- D3 Concurrent requests with one key → one run.
- D4 Execute pressed twice → started once; replayed with its key → the first answer.
- D5 Next transaction asked twice at once → one envelope.
- D6 A delayed submit retried, and the same signed transaction sent again → each employee paid exactly once.
- D7 Retry never re-sends a SUCCESSFUL payment; other writes replay with a key too.

**System**: S1 Horizon down → 503, nothing changes. S2 Postgres down → 503. S3 Worker restart still
settles SUBMITTED transactions. S4 Boot refuses a non-Testnet passphrase. Tenant isolation: every
route returns 404 for another organization's IDs.

## Testnet proof

`pnpm proof` (`apps/api/scripts/proof.ts`) runs the API in-process against the real Testnet and
**Circle Testnet USDC** (`GBBD47IF…LLFLA5`). A local key signs in place of Freighter.

1. **Setup**: the funding wallet's key is kept in `apps/api/.proof-keys.json` (git-ignored, Testnet
   only) so re-runs reuse it. It is created with Friendbot if missing, adds a USDC trustline, and buys
   USDC on the Testnet DEX with its XLM when it holds less than the run needs. Six fresh employee
   accounts are created with Friendbot each run; five add a USDC trustline.
2. **Employees**: six added with salaries from 1.0000000 to 2.5000000 USDC; the sixth shows
   `NO_TRUSTLINE`.
3. **Run**: created twice with the same `Idempotency-Key` (one run), six employees, one payment per
   transaction, total exactly 10.0000001 USDC; the review says five payable.
4. **Execute** (twice: the second is 409): the sixth is FAILED and never sent. Five transactions are
   built, signed, submitted and confirmed: five SUCCESSFUL payments, five distinct hashes, run
   PARTIALLY_PAID. Sending a signed transaction again sends nothing.
5. **Retry**: the sixth adds a trustline; retry; the sixth payment succeeds; run COMPLETED.
6. **Independent check**: every hash is read from Horizon (not OrgPay's database): successful, from
   the funding wallet, one USDC payment of the right amount to the right wallet, memo
   `OrgPay R<run> P<position>`. Every employee's balance equals their salary (paid once), and
   `/v1/payments/:id/verify` passes.
7. **Output**: [TRANSACTIONS.md](TRANSACTIONS.md) and `testnet-proof.json` in `docs/`. Exits non-zero
   if any check fails.
