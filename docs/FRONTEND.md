# OrgPay Frontend

The OrgPay web dashboard, where an admin manages employees, creates and reviews payroll runs,
executes them with Freighter, and tracks every payment to a verified Stellar transaction. Read
[ARCHITECTURE.md](ARCHITECTURE.md) for statuses and the payment lifecycle, and
[BACKEND.md](BACKEND.md) for the API.

## Stack

Next.js 16 (App Router), React 19, TypeScript strict, SWR for data, `@stellar/freighter-api` 6 for
signing, `@orgpay/shared` for Zod schemas, amount helpers and types. The visual system is the "Pay
stub" design from PayBridge, in `apps/web/DESIGN.md`.

```
apps/web/
  app/
    page.tsx                       landing
    (auth)/signup, login, forgot-password, reset-password, verify-email
    (app)/layout.tsx               app shell: sidebar, org name, Testnet badge
    (app)/onboarding               organization name → funding wallet → done
    (app)/dashboard
    (app)/employees
    (app)/employees/[id]
    (app)/payroll
    (app)/payroll/new
    (app)/payroll/[id]
    (app)/settings
  components/                      AppShell, Dialog, Toast, StatusPill, CopyButton, TxHashLink, …
  components/payroll/              ReviewPanel, ExecuteDialog, SignPanel, PaymentRow, RunProgress, …
  lib/
    api.ts                         fetch wrapper: credentials, Idempotency-Key, error codes
    freighter.ts                   connect, network check, address check, sign
    payroll.ts                     status labels and colours
    config.ts                      API URL, explorer URLs
    usePayRun.ts                   the execute → sign → submit loop
```

## Routes

| Route | What the admin sees and does |
|---|---|
| `/` | What OrgPay does, how signing works, a Testnet notice, sign up / log in. |
| `/onboarding` | Name the organization, add the funding wallet (address, live USDC and XLM balance, trustline status). |
| `/dashboard` | Funding wallet balance; paid this month; counts of successful, pending and failed payments (each links to a filtered list); the next draft run with a "Review and execute" button; recent runs. |
| `/employees` | Table: name, wallet (short, copy, explorer link), salary, wallet status ("Ready" or the reason), active/inactive. Search, status filter, "Add employee", "Check wallets". |
| `/employees/[id]` | Details with edit and deactivate/reactivate, plus this employee's payment history across runs (run, amount, status, hash link). |
| `/payroll` | All runs, newest first: run number, name, pay date, status, employee count, total, successful / failed / pending counts. Status filter. "New payroll run". |
| `/payroll/new` | Name, pay date, funding wallet, employee picker (active employees, select all, search), live total and count. Creates a DRAFT and opens it. |
| `/payroll/[id]` | The run: review, execute and track. See below. |
| `/settings` | Organization, funding wallets, notifications, security, API keys. |

## Employees

- **Add / edit dialog**: name, email, role, wallet address, USDC salary. The address and salary are
  checked in the browser with the shared Zod schema as you type (a `G…` key; a positive amount with
  at most 7 decimals). A pasted `S…` secret is refused on the spot with a warning not to share it.
  After saving, the wallet check result shows on the row ("No USDC trustline", "Account not found").
- **Deactivate**: confirm dialog ("They won't be added to new payroll runs. Past runs keep their
  records."). Inactive employees are hidden by default and can be reactivated.
- **Editing a wallet** shows a note that runs already created keep the old address.

## Payroll run page (`/payroll/[id]`)

One page that changes with the run's status.

**DRAFT: review**

- Header: run number and name, pay date, funding wallet, status pill.
- Summary: **employee count**, **total USDC**, and payments per transaction (default 1, editable).
- Payments table: #, employee name, wallet, amount (editable), wallet check, remove. "Add employees".
- Review panel (from `GET /check`): who can receive and who can't (with the reason); funding wallet
  USDC and XLM against what's needed, and "Short by X USDC" if it isn't enough; a warning for
  employees already paid in another run with the same pay date.
- **Execute payroll** opens a confirm dialog that repeats the employee count, the total, the funding
  wallet, and how many Freighter signatures to expect. The button stays disabled while the check
  says the wallet is short.

**PROCESSING: sign and track**

- Sign panel: "Transaction 3 of 6, 1 payment, 1.5000000 USDC to Ada", a "Sign in Freighter" button,
  and a countdown to the transaction's window closing. Then it shows "Submitting…", then "Confirming
  on Stellar…", then the next transaction.
- Progress bar split by status: successful, submitted, awaiting signature, pending, failed.
- Payments table updates live (polling every 2 s while anything is open).
- Leaving the page and coming back is safe: `transactions/next` returns the same open transaction.

**COMPLETED / PARTIALLY_PAID / FAILED: results**

- Result counts: successful, failed, cancelled, and the total actually paid compared with the total
  planned.
- Failed payments callout, with each reason and "Check again and retry".
- Export CSV (payments with hashes and explorer links).
- Event history: created, executed, transaction built, submitted, confirmed, failed, retried.

**Payment row** (on every state): # · name + wallet · amount · status pill · under it the tx hash
(short, copy, link to `https://stellar.expert/explorer/testnet/tx/<hash>`) and the ledger and
verification time, or the failure reason. A "Verify" action calls `/v1/payments/:id/verify` and
shows each check (found, successful, destination, asset, amount). Hashes and reasons stay visible on
mobile.

## Status labels

The UI shows only what the API returns. It never marks anything successful on its own (no optimistic
success after signing or submitting).

| API status | Label | Pill |
|---|---|---|
| PENDING | Pending | grey, clock icon |
| AWAITING_SIGNATURE | Waiting for signature | amber, pen icon |
| SUBMITTED | Submitted, confirming | blue, spinner |
| SUCCESSFUL | Successful | green, check icon + "Verified on Stellar" |
| FAILED | Failed | red, cross icon + reason |
| CANCELLED | Cancelled | grey, strike icon |

Runs: Draft · Processing · Completed · Partially paid · Failed · Cancelled.

Status is never colour alone; every pill has an icon and a word.

## Freighter flow (`lib/freighter.ts`, `usePayRun.ts`)

1. Check Freighter is installed, connected and on **Testnet**. If not, explain how to fix it.
2. Check the connected address equals the run's funding wallet. If not, ask the admin to switch accounts.
3. `POST transactions/next` → XDR. Ask Freighter to sign with the Testnet passphrase.
4. `POST …/submit` with the signed XDR. A 202 means "still confirming": keep polling the run, don't
   resubmit.
5. Loop until `next` returns `tx: null`.

If the admin rejects in Freighter, nothing changes: the transaction stays open until its window
passes, and "Sign in Freighter" signs the same one again.

## Duplicate protection in the UI

- `lib/api.ts` adds an `Idempotency-Key` to every write. The key is created **once per user action**
  (when the dialog opens or on the first click) and reused if that same action is retried after a
  network error or `409 REQUEST_IN_PROGRESS`. A new action gets a new key.
- Buttons that start work (save, create run, execute, sign, retry) disable while their request is in
  flight.
- On a timeout or network error after submitting, the page shows "Confirming on Stellar…" and
  polls. It never offers to "send again".

## Amounts

Amounts stay decimal strings from the API to the screen. `parseFloat` and `Number()` on amounts are
banned (ESLint). Totals in the new-run form use the shared bigint helpers. Amounts use a mono font
with 7 decimals in tables and a shorter form in headlines (`1,500.50 USDC`).

## States and layout

- Every list and panel has loading, empty and error states. Empty employees: "Add your first
  employee". Empty runs: "Create your first payroll run".
- API errors show the message from `error.message` and the request ID.
- Tables become stacked rows below 640 px; works at 360 px wide.
- The "Stellar Testnet" badge is always in the header.
- One polite `aria-live` region announces status changes ("Payment to Ada successful").

## End-to-end and evidence

`pnpm --filter @orgpay/web e2e` drives the real dashboard against the local API and Testnet with
Playwright. A Freighter stand-in (same pattern as Sisonke's `web/e2e/lib/freighter-stand-in.mjs`)
signs with a throwaway Testnet key. The run:

1. Signs up and adds the funding wallet.
2. Adds six employees (one without a trustline), then edits one and deactivates and reactivates another.
3. Creates a run with all six and checks the count and total on the review panel.
4. Executes and signs five transactions; checks five "Successful" rows with distinct hash links and
   one "Failed: No USDC trustline".
5. Double-clicks Execute and reloads mid-signing; checks that no extra transaction appears.
6. Fixes the trustline, retries, and checks the run is Completed.
7. Opens each explorer link and checks that the explorer shows the same hash.

Screenshots of each screen and a demo video go to `evidence/`.
