# OrgPay

Stellar Testnet payroll in USDC: employees with wallets and salaries, payroll runs, one Stellar
transaction per payment by default, each payment tracked to a verified hash.

**Read `docs/ARCHITECTURE.md`, `docs/BACKEND.md` and `docs/FRONTEND.md` before any task.** They are
the spec. If something seems wrong, ask before building; when a change is agreed, update the doc in
the same commit.

## Working rules

1. TypeScript strict everywhere; no `any`, no unexplained `@ts-ignore`.
2. Money is never a float: bigint stroops in code, BigInt columns, decimal strings in JSON. `parseFloat`
   and `Number()` on amounts are banned (ESLint enforces it, scripts included).
3. Run, payment and transaction statuses change only in `apps/api/src/modules/payroll/transitions.ts`.
4. A payment becomes SUCCESSFUL only in `settle.ts`, from a ledger record that passes `stellar/verify.ts`.
   Never from a submit answer, a timeout or the server clock.
5. Never pay twice: one open transaction per run, SUCCESSFUL is final, retry touches only FAILED
   payments, an open envelope is replaced only after the ledger shows it can no longer land.
6. Creating a run needs an `Idempotency-Key`; every other write accepts one.
7. OrgPay never holds, accepts, stores or logs a Stellar secret key, and never logs passwords, tokens,
   API keys or signed XDR.
8. Testnet only. The dashboard must show only real records and verified transactions: no made-up hashes.
9. Every test is named with its ID (E, R, V, D, S); new edge cases get a new ID and a doc line.
10. Before saying a task is done, run `pnpm lint`, `pnpm typecheck` and `pnpm test` and report the results.
11. Small commits with conventional messages (`feat:`, `fix:`, `test:`, `docs:`).

## Layout

- `apps/api`: one codebase, two processes: `src/server.ts` (API, port 4300) and `src/worker.ts`.
  Layering routes → service → repo; repos take `companyId` first. In the database a payment is a
  `PayrollItem` and a transaction a `PayrollBatch`; the API says payments and transactions.
- `packages/shared`: Zod schemas, amount helpers and types shared with the web app.
- `apps/api/scripts`: `seed.ts` (employees and a draft), `proof.ts` (the Testnet proof).

## Commands

`pnpm db:up` (Postgres on 5437) · `pnpm --filter @orgpay/api db:deploy` · `pnpm dev` · `pnpm dev:worker` ·
`pnpm lint` · `pnpm typecheck` · `pnpm test` (needs Docker) · `pnpm proof` · `pnpm seed`
