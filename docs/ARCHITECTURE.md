# OrgPay Architecture

OrgPay lets an organization pay its employees in USDC on **Stellar Testnet** through one payroll
workflow. An admin adds employees with a wallet and a salary, creates a payroll run, reviews the
total, executes it, and OrgPay tracks every payment until the Stellar ledger confirms it.

OrgPay is built on the PayBridge codebase (`~/Documents/Paybridge`), which already has the employee
model, payroll runs, the signed-transaction pipeline and ledger confirmation. This document is the
target design; [What changes from PayBridge](#what-changes-from-paybridge) lists the work.

Companion docs: [BACKEND.md](BACKEND.md) (API, data, worker, tests), [FRONTEND.md](FRONTEND.md)
(dashboard screens and flows).

## Decisions

| Topic | Decision |
|---|---|
| Network | Stellar Testnet only. The API refuses to boot with any other network passphrase. |
| Asset | Circle Testnet USDC, issuer `GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5` (overridable by `USDC_ISSUER`). XLM only pays fees. |
| Custody | Non-custodial. OrgPay never accepts, stores or logs a secret key. The admin signs each transaction in Freighter with the organization's funding wallet. |
| Payments per transaction | Set per run, 1 to 100. **Default 1**: every employee payment is its own Stellar transaction with its own hash. |
| Source of truth for "successful" | The ledger. A payment becomes SUCCESSFUL only from Horizon's record of its transaction hash, never from a submit response or the server clock. |
| Duplicate protection | Idempotency keys on every write, one open transaction per run, SUCCESSFUL is final, retries only touch FAILED payments. |
| Backend | Node.js 22, Express 5, TypeScript strict, Prisma 6, PostgreSQL 16. Two processes from one codebase: API and worker. No Redis. |
| Frontend | One Next.js 16 app (landing, auth, dashboard). |
| Stellar access | Horizon only: account checks, submission, transaction lookup, latest ledger. |

Out of scope: mainnet, scheduled runs, tax and deductions, fiat conversion, payslips, employee logins,
multi-approver sign-off.

## System overview

```
            Admin's browser
  ┌──────────────────────────────────┐
  │  OrgPay dashboard (Next.js)      │      Freighter extension
  │  employees · runs · run detail   │◄────►(signs the XDR with the
  └───────────────┬──────────────────┘       funding wallet's key)
                  │ HTTPS, session cookie, Idempotency-Key
                  ▼
  ┌──────────────────────────────────┐        ┌─────────────────────┐
  │  orgpay-api (Express)            │───────►│ Horizon (Testnet)   │
  │  validate · build unsigned tx ·  │ checks │ accounts, submit,   │
  │  check signed hash · submit      │ submit │ tx lookup, ledger   │
  └───────────────┬──────────────────┘        └─────────▲───────────┘
                  │                                      │ every 5 s
                  ▼                                      │
  ┌──────────────────────────────────┐        ┌──────────┴──────────┐
  │  PostgreSQL 16                   │◄──────►│ orgpay-worker       │
  │  employees, runs, payments,      │        │ confirmer: settles  │
  │  transactions, events, idem keys │        │ open transactions   │
  └──────────────────────────────────┘        │ from the ledger     │
                                              └─────────────────────┘
```

The API never holds a key. It builds an unsigned transaction, the browser has Freighter sign it, and
the API checks that the signed transaction has exactly the hash it built before submitting it. The
worker settles anything Stellar did not answer straight away.

## Data model

Prisma schema in `apps/api/prisma/schema.prisma`. Money is `BigInt` stroops (1 USDC = 10,000,000
stroops), never a float.

```
Organization 1──* Employee
Organization 1──* FundingWallet
Organization 1──* PayrollRun 1──* Payment *──1 Employee
                 PayrollRun 1──* StellarTx 1──* Payment
                 PayrollRun 1──* PayrollEvent        (append-only audit trail)
Organization 1──* IdempotencyKey
```

| Model | Key fields | Notes |
|---|---|---|
| Organization | id, name, email, passwordHash, runCounter | One admin login per organization (carried over from PayBridge's Company). |
| FundingWallet | id, orgId, address, label, cached balances, checkedAt | The account payroll is paid from. |
| Employee | id, orgId, name, email?, role?, walletAddress, salaryStroops, deactivatedAt?, checkReason?, checkedAt? | One **active** employee per (org, wallet). Deactivated employees can't be added to new runs. |
| PayrollRun | id, orgId, number, name, payDate?, fundingWalletId, walletAddress (snapshot), assetCode, assetIssuer, paymentsPerTx, status, startedAt?, finishedAt? | `number` is unique per org (Run #1, #2, …). Totals are calculated from payments, never stored. |
| Payment | id, runId, orgId, employeeId, position, name and walletAddress (snapshots), amountStroops, status, failureCode?, failureDetail?, txId?, opIndex?, txHash?, ledger?, verifiedAt?, attempts | Unique (runId, employeeId): an employee appears once per run. |
| StellarTx | id, runId, number, txHash (unique), envelopeXdr, signedXdr?, sequence, maxTime, opCount, totalStroops, status, resultCode?, ledger?, closedAt? | One Stellar transaction OrgPay built. Holds 1 payment by default. |
| PayrollEvent | runId, paymentId?, txId?, type, message, actor, createdAt | Every state change is written here. |
| IdempotencyKey | orgId, key, route, requestHash, state, responseStatus, responseBody, expiresAt | See [BACKEND.md](BACKEND.md#idempotency). |

A payment copies the employee's name and wallet when it is created, so later edits to the employee
never change who an existing run pays.

## Statuses

The status words match the spec: **pending, submitted, successful, failed**. Two more are needed to
be truthful: a payment whose transaction is built but not yet signed, and a payment the admin
cancelled.

**Payment**

| Status | Meaning | Next |
|---|---|---|
| PENDING | Waiting to be put in a transaction. | AWAITING_SIGNATURE, FAILED (pre-check), CANCELLED |
| AWAITING_SIGNATURE | In a built transaction the admin hasn't signed yet. | SUBMITTED, SUCCESSFUL (signed and submitted elsewhere), PENDING (window expired) |
| SUBMITTED | Signed transaction sent to Stellar, no ledger record yet. | SUCCESSFUL, FAILED, PENDING (can no longer land) |
| SUCCESSFUL | The ledger shows its transaction succeeded. **Final.** | none |
| FAILED | Not paid, with a reason (no account, no USDC trustline, not authorized, limit too low, other). | PENDING (retry), CANCELLED |
| CANCELLED | The admin gave up on it. **Final.** | none |

**Stellar transaction**: AWAITING_SIGNATURE → SUBMITTED → CONFIRMED | FAILED | EXPIRED.
AWAITING_SIGNATURE can also go straight to CONFIRMED, FAILED or EXPIRED.

**Payroll run** (overall status, calculated from its payments):

| Status | When |
|---|---|
| DRAFT | Being prepared; employees and amounts can still change. |
| PROCESSING | Executed; some payments are PENDING, AWAITING_SIGNATURE or SUBMITTED. |
| COMPLETED | Every payment SUCCESSFUL. |
| PARTIALLY_PAID | Finished with some SUCCESSFUL and some FAILED or CANCELLED. |
| FAILED | Finished with none SUCCESSFUL. |
| CANCELLED | Cancelled as a draft, or before anyone was paid. |

Statuses change only in `apps/api/src/modules/payroll/transitions.ts`, which checks the allowed
transitions and updates conditionally on the expected current status, inside a database transaction
holding row locks. ESLint forbids setting `status` anywhere else.

## Payroll lifecycle

1. **Set up employees.** Name, wallet address and USDC salary. OrgPay validates the address format and
   checks on Horizon that the account exists and can receive USDC.
2. **Create a run.** Select active employees. One PENDING payment per employee, at their salary
   (editable while DRAFT). The total is the exact bigint sum.
3. **Review.** The run page shows the employee count, each amount, the total, and a fresh pre-flight
   check: who can receive and whether the funding wallet holds enough USDC and XLM.
4. **Execute.** `POST /start` re-checks everything on Horizon. Employees who can't receive become
   FAILED with the reason, and nothing is sent to them. If the funding wallet can't cover the rest,
   nothing changes. Otherwise the run becomes PROCESSING and its amounts are frozen.
5. **Build.** `POST /transactions/next` takes the next `paymentsPerTx` PENDING payments and builds one
   unsigned transaction: the funding wallet is the source, one USDC payment operation per employee,
   memo `OrgPay R<run> P<position>` (or `R<run> T<tx>` when batched), valid for 5 minutes. Payments
   become AWAITING_SIGNATURE. While it is open, asking again returns the same transaction.
6. **Sign.** The dashboard asks Freighter to sign it with the funding wallet.
7. **Submit.** The API checks that the signed transaction's hash equals the stored hash (a signature
   doesn't change the hash, so any edit is caught), marks it SUBMITTED, and sends it to Horizon.
8. **Verify.** Whatever Horizon answers, the result is taken only from the ledger's record of that
   hash (looked up straight away, then by the worker). See [Verification](#verification).
9. **Repeat** steps 5–8 until no payments are PENDING. With the default of one payment per
   transaction, that's one Freighter signature per employee.
10. **Finish.** The run becomes COMPLETED, PARTIALLY_PAID or FAILED. FAILED payments can be retried
    once the employee fixes their wallet, and a SUCCESSFUL payment is never sent again.

## Verification

A payment is marked SUCCESSFUL only when all of these hold:

1. Horizon returns a ledger record for the stored `txHash` with `successful: true`.
2. The operation at the payment's `opIndex` is a payment from the run's funding wallet to the
   payment's `walletAddress`, in USDC from the configured issuer, for exactly `amountStroops`.
3. That operation's result is `op_success`.

The payment then records `txHash`, `ledger`, and `verifiedAt` (the ledger's close time). If check 2
ever fails (it can't for a transaction whose hash matched, but it is checked anyway), the payment
stays SUBMITTED and the worker raises an alert. It is never marked successful.

What is **not** proof of success: a 200 from the submit call, a Freighter "signed" event, a timeout,
or the server clock passing a deadline. A timeout leaves the payment SUBMITTED. An expired
transaction is judged by the **ledger's** close time passing its `maxTime`, and only then do its
payments go back to PENDING.

`GET /v1/payments/:id/verify` re-runs the checks against Horizon on demand, so anyone can confirm a
record without trusting the database.

## Duplicate-payment protection

| Risk | Protection |
|---|---|
| The same HTTP request sent twice (double click, retry after a network drop) | `Idempotency-Key` on every write. The same key returns the first response, and the work runs once. |
| Two runs paying the same person by accident | Allowed (it's a different payroll), but the review screen flags employees already paid in another run with the same pay date. |
| Same employee twice in one run | Unique (runId, employeeId). |
| Two transactions for the same payment both landing | One open transaction per run. A new one is built only after the ledger shows the old one can no longer land. |
| A signed transaction reused later | 5-minute timebounds, judged by ledger close time. |
| The browser swaps the transaction | The server compares the signed XDR's hash with the hash it built. |
| Submit times out, the admin presses again | The transaction stays SUBMITTED. Submitting the same XDR again is safe (Stellar applies a sequence number once). The worker settles it from the ledger. |
| Retry re-pays someone | Retry only moves FAILED payments to PENDING. SUCCESSFUL is final. |
| Submit and worker settle at the same time | `SELECT … FOR UPDATE` on the transaction row, plus conditional status updates. |

## Traceability

Every successful payment can be followed both ways:

```
Employee ──► Payment (run #, position, amount, status) ──► StellarTx (hash, ledger) ──► stellar.expert
   ▲                                                                                        │
   └──────── memo "OrgPay R<run> P<position>" + destination + amount on the ledger ◄────────┘
```

From the dashboard: run → payment row → hash link to
`https://stellar.expert/explorer/testnet/tx/<hash>`. From the explorer: the memo names the run and
position, and the destination and amount match the payment row.

## What changes from PayBridge

| # | Change | Why |
|---|---|---|
| 1 | `paymentsPerTx` per run, default 1 (PayBridge always batches up to 100) | Each payment gets its own transaction hash. Makes "at least five successful transactions" unambiguous. |
| 2 | Status words: SENDING → AWAITING_SIGNATURE / SUBMITTED, PAID → SUCCESSFUL, run PAYING → PROCESSING, PAID → COMPLETED, PARTIAL → PARTIALLY_PAID | Match the spec's vocabulary. |
| 3 | Rename models: Company → Organization, Wallet → FundingWallet, PayrollItem → Payment, PayrollBatch → StellarTx, archivedAt → deactivatedAt, defaultAmountStroops → salaryStroops | Spec words in code, API and UI. Done as one fresh migration. |
| 4 | Idempotency keys (table + middleware); today the header is only allowed by CORS | "Repeated requests do not cause duplicates." |
| 5 | Explicit operation check in verification (destination, asset, amount) + `/verify` endpoint | "Must not mark successful until verified." |
| 6 | Per-payment memo `OrgPay R<run> P<position>` | On-chain traceability to run and employee. |
| 7 | `pnpm proof` against **real** Circle Testnet USDC with ≥ 6 employees (the current scenario self-mints a fake USDC and pays 3) | The required Testnet evidence. |
| 8 | Generated `docs/TRANSACTIONS.md` + `evidence/` (screenshots, video) | Proof for reviewers. |
| 9 | Branding: PayBridge → OrgPay (`op_session`, `op_device`, `op_test_` key prefix) | Product name. |

Carried over unchanged: auth and sessions, funding-wallet checks, groups, CSV import, API keys, email
notifications, rate limits, deploy scripts and the "Pay stub" design system. Groups, CSV import, API
keys and emails go beyond the spec; they stay but are not part of the demo.

## Spec coverage

| Requirement | Where it is met |
|---|---|
| Add, edit and deactivate employees with name, wallet and USDC salary | Employee model, `/v1/employees`, Employees screen |
| Validate wallets and amounts | Shared Zod schemas (StrKey, amount regex) + Horizon receive check |
| Select employees, auto total, review before executing | Run draft, `GET /check`, run page review panel |
| Unique record per run and its payments | PayrollRun (number unique per org) + Payment rows |
| Initiate USDC payments on Testnet | Build → Freighter sign → submit |
| Link each payment to employee and run, record the hash | Payment.employeeId, runId, txHash, opIndex, memo |
| Pending / submitted / successful / failed | Payment statuses above |
| Failed payments never marked completed | Ledger-only verification; COMPLETED needs every payment SUCCESSFUL |
| No duplicates on repeated or delayed requests | Duplicate-protection table + D tests |
| Overall payroll status | Run status calculated from payments |
| Dashboard with hashes and explorer links, past runs | [FRONTEND.md](FRONTEND.md) |
| ≥ 5 successful Testnet transactions, each linked and verifiable | `pnpm proof` → `docs/TRANSACTIONS.md` |

## Demonstration plan

`pnpm proof` (details in [BACKEND.md](BACKEND.md#testnet-proof)) runs the whole workflow on Testnet
with real Testnet USDC and writes `docs/TRANSACTIONS.md`:

1. Six employees added with wallets and salaries. Five have a USDC trustline; one doesn't.
2. One run with all six, and the total checked against the exact sum.
3. Execute: the employee without a trustline is FAILED (not sent), and five payments are SUCCESSFUL
   in **five separate transactions**, each verified on Horizon independently of the database.
4. Repeated requests: same create-run key, double execute, same signed XDR twice. Assert that no extra
   run, transaction or payment appears and every balance moved exactly once.
5. The sixth employee adds a trustline, the admin retries, and the sixth payment succeeds.

The UI demo (`pnpm --filter @orgpay/web e2e`) does the same through the dashboard with a Freighter
stand-in, and records screenshots and a video into `evidence/`.
