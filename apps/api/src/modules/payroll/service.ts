import { explorerTxUrl, type PaymentDetail, type PaymentVerification, type ReceiveProblem, type RunCheck } from "@orgpay/shared";
import type { PayrollBatch, PayrollItem, PayrollRun, RunStatus } from "@prisma/client";
import { env } from "../../config/env";
import type { Tx } from "../../db/prisma";
import type { AppDeps } from "../../deps";
import { formatStroops, parseAmount } from "../../lib/amount";
import { usdc } from "../../lib/asset";
import { encodeCursor } from "../../lib/cursor";
import { AppError, notFound } from "../../lib/errors";
import { fundingCheck, fundingError, receiveProblem } from "../../stellar/checks";
import { loadAccounts, type AccountState } from "../../stellar/gateway";
import { decodeResultXdr } from "../../stellar/results";
import { allPassed, verifyPayment } from "../../stellar/verify";
import { buildBatchTransaction, checkSignedBatch, transactionMemo } from "./batches";
import * as repo from "./repo";
import { serializePayment, serializeRun, serializeRunSummary, serializeTransaction } from "./serialize";
import { isOpen, settleBatch, type BatchOutcome } from "./settle";
import { assignToBatch, finishIfDone, lockRun, markSubmitted, recordEvent, transitionItems, transitionRun, type Actor } from "./transitions";

/** Most lines on one run. */
export const MAX_RUN_LINES = 1000;
/** Most runs one company can be paying at the same time. */
export const MAX_PAYING_RUNS = 10;
/** How long past its window a batch whose sequence number was used must stay unfound before it counts as expired. */
export const EXPIRY_GRACE_MS = 2 * 60_000;
/** Every expiry waits at least this long past the window, for ledgers still being ingested. */
export const EXPIRY_MIN_GRACE_MS = 30_000;
/** A signed batch with no answer is sent again at most this often. */
const REBROADCAST_EVERY_MS = 30_000;
const lastBroadcast = new Map<string, number>();

const locked = (message = "This run can only be changed while it is a draft") => new AppError("RUN_LOCKED", message);
const changedMeanwhile = () => locked("The run changed while OrgPay was checking it. Try again.");

function payDateValue(v: string | null | undefined): Date | null | undefined {
  return v === undefined ? undefined : v === null ? null : new Date(`${v}T00:00:00Z`);
}

/** Lines that were checked must be exactly the lines found again under the lock. */
function sameLines(checked: PayrollItem[], now: PayrollItem[]): boolean {
  if (checked.length !== now.length) return false;
  const byId = new Map(now.map((i) => [i.id, i]));
  return checked.every((c) => {
    const n = byId.get(c.id);
    return n !== undefined && n.amountStroops === c.amountStroops && n.walletAddress === c.walletAddress;
  });
}

/** Cancels whatever of a run has not been paid. Caller holds the run lock. Shared with account closing. */
export async function cancelRun(tx: Tx, run: PayrollRun, actor: Actor): Promise<void> {
  const unpaid = async (status: "PENDING" | "FAILED") =>
    (await tx.payrollItem.findMany({ where: { runId: run.id, status }, select: { id: true } })).map((i) => i.id);
  if (run.status === "DRAFT") {
    await transitionItems(tx, run.id, await unpaid("PENDING"), "PENDING", "CANCELLED");
    await transitionRun(tx, run, "CANCELLED", actor, { data: { finishedAt: new Date() }, event: { type: "cancelled", message: "Draft cancelled" } });
    return;
  }
  if (run.status === "COMPLETED" || run.status === "CANCELLED") throw new AppError("RUN_LOCKED", "This run is already finished");
  if (await tx.payrollBatch.count({ where: { runId: run.id, status: { in: ["AWAITING_SIGNATURE", "SUBMITTED"] } } })) {
    throw new AppError("RUN_LOCKED", "A transaction is waiting for a signature or for Stellar. Wait for it to finish or expire, then cancel.");
  }
  const pending = await unpaid("PENDING");
  const failed = await unpaid("FAILED");
  await transitionItems(tx, run.id, pending, "PENDING", "CANCELLED");
  await transitionItems(tx, run.id, failed, "FAILED", "CANCELLED");
  if (run.status === "PROCESSING") {
    await finishIfDone(tx, run.id, actor, { cancelled: true });
  } else {
    if (run.status === "FAILED") await transitionRun(tx, run, "CANCELLED", actor);
    await recordEvent(tx, run.id, actor, { type: "cancelled", message: `Gave up on ${failed.length} payment(s) that weren't sent` });
  }
}

export function createPayrollService(deps: AppDeps) {
  const { prisma, stellar } = deps;

  async function inRunLock<T>(companyId: string, runId: string, fn: (tx: Tx, run: PayrollRun) => Promise<T>): Promise<T> {
    return prisma.$transaction(
      async (tx) => {
        const run = await lockRun(tx, companyId, runId);
        if (!run) throw notFound("Payroll run");
        return fn(tx, run);
      },
      { timeout: 30_000 },
    );
  }

  async function getRun(companyId: string, id: string) {
    const run = await repo.findRunFull(prisma, companyId, id);
    if (!run) throw notFound("Payroll run");
    return serializeRun(run);
  }

  /** Active employees picked directly or through their groups, in name order, each once. */
  async function pickEmployees(companyId: string, groupIds: string[] = [], employeeIds: string[] = []) {
    if (groupIds.length > 0) {
      const found = await prisma.group.count({ where: { companyId, id: { in: groupIds } } });
      if (found !== new Set(groupIds).size) throw notFound("Group");
    }
    if (employeeIds.length > 0) {
      const found = await prisma.employee.count({ where: { companyId, id: { in: employeeIds }, deactivatedAt: null } });
      if (found !== new Set(employeeIds).size) {
        throw new AppError("VALIDATION_FAILED", "Some of the people picked were not found or are deactivated", {
          details: [{ path: "employeeIds", message: "Unknown or deactivated employee" }],
        });
      }
    }
    return prisma.employee.findMany({
      where: { companyId, deactivatedAt: null, OR: [{ id: { in: employeeIds } }, { groupId: { in: groupIds } }] },
      orderBy: [{ name: "asc" }, { id: "asc" }],
    });
  }

  async function addLines(tx: Tx, run: PayrollRun, employees: Awaited<ReturnType<typeof pickEmployees>>): Promise<number> {
    const existing = await tx.payrollItem.findMany({ where: { runId: run.id }, select: { employeeId: true, position: true } });
    const onRun = new Set(existing.map((e) => e.employeeId));
    const fresh = employees.filter((e) => !onRun.has(e.id));
    if (existing.length + fresh.length > MAX_RUN_LINES) {
      throw new AppError("LIMIT_REACHED", `A run can have at most ${MAX_RUN_LINES} people`);
    }
    let position = existing.reduce((max, e) => Math.max(max, e.position), 0);
    if (fresh.length > 0) {
      await tx.payrollItem.createMany({
        data: fresh.map((e) => ({
          runId: run.id,
          companyId: run.companyId,
          employeeId: e.id,
          position: ++position,
          name: e.name,
          walletAddress: e.walletAddress,
          amountStroops: e.salaryStroops,
        })),
      });
    }
    return fresh.length;
  }

  async function activeWallet(companyId: string, walletId: string) {
    const wallet = await prisma.wallet.findFirst({ where: { id: walletId, companyId, deletedAt: null } });
    if (!wallet) throw notFound("Wallet");
    return wallet;
  }

  /** Keeps People's "ready" column in step with what a payroll check just saw. Best effort. */
  async function rememberChecks(companyId: string, results: Map<string, ReceiveProblem | null>): Promise<void> {
    const checkedAt = new Date();
    await Promise.all(
      [...results].map(([walletAddress, problem]) =>
        prisma.employee.updateMany({ where: { companyId, walletAddress, deactivatedAt: null }, data: { checkReason: problem, checkedAt } }),
      ),
    ).catch((err: unknown) => deps.logger.warn({ err }, "could not store recipient checks"));
  }

  function problemsFor(items: PayrollItem[], accounts: Map<string, AccountState>): Map<string, ReceiveProblem | null> {
    const asset = usdc();
    const byItem = new Map<string, ReceiveProblem | null>();
    for (const item of items) {
      const account = accounts.get(item.walletAddress) ?? { exists: false as const };
      byItem.set(item.id, receiveProblem(account, asset, item.amountStroops));
    }
    return byItem;
  }

  function byAddress(items: PayrollItem[], problems: Map<string, ReceiveProblem | null>): Map<string, ReceiveProblem | null> {
    return new Map(items.map((i) => [i.walletAddress, problems.get(i.id) ?? null]));
  }

  async function markExcluded(tx: Tx, run: PayrollRun, items: PayrollItem[], problems: Map<string, ReceiveProblem | null>, actor: Actor) {
    for (const item of items) {
      const problem = problems.get(item.id);
      if (!problem) continue;
      await transitionItems(tx, run.id, [item.id], "PENDING", "FAILED", { failureCode: problem, failureDetail: null });
      await recordEvent(tx, run.id, actor, { type: "excluded", itemId: item.id, message: `${item.name} not sent: ${problem}` });
    }
  }

  /**
   * Asks Stellar what became of an open transaction and settles it if the answer is final. Only
   * the ledger's own record is final: found and successful → every payment in it is verified
   * against the record before it becomes SUCCESSFUL; found and failed → failed with per-payment
   * reasons. "Expired" must be certain, or the next transaction would pay the same people again,
   * so it needs all of:
   *  - a ledger that closed after the transaction's window (plus a grace period: 2 minutes when
   *    the funding account has already used its sequence number, 30 s otherwise),
   *  - read BEFORE the hash lookup (anything landed by then is findable), and
   *  - a "not found" from a Horizon node that had itself ingested at least that ledger.
   */
  async function resolveBatch(batch: PayrollBatch, actor: Actor): Promise<boolean> {
    const run = await prisma.payrollRun.findUnique({ where: { id: batch.runId }, select: { walletAddress: true } });
    if (!run) return false;
    const ledger = await stellar.latestLedger();
    const pastWindow = ledger.closedAt.getTime() > batch.maxTime.getTime() + EXPIRY_MIN_GRACE_MS;
    // The account only matters for the expiry decision, so it is only read once that's possible.
    const account = pastWindow ? await stellar.loadAccount(run.walletAddress) : null;
    const { found, nodeLedger } = await stellar.getTransaction(batch.txHash);
    let outcome: BatchOutcome | null = null;
    if (found) {
      outcome = found.successful
        ? { kind: "success", record: found }
        : { kind: "failed", ...decodeResultXdr(found.resultXdr), ledger: found.ledger, closedAt: found.closedAt };
    } else if (pastWindow && account) {
      const sequenceUsed = account.exists && BigInt(account.sequence) >= BigInt(batch.sequence);
      const deadline = batch.maxTime.getTime() + (sequenceUsed ? EXPIRY_GRACE_MS : EXPIRY_MIN_GRACE_MS);
      const nodeCaughtUp = nodeLedger === null ? false : nodeLedger >= ledger.sequence;
      if (ledger.closedAt.getTime() > deadline && nodeCaughtUp) outcome = { kind: "expired" };
    }
    if (!outcome) return false;
    const settled = outcome;
    const result = await inRunLock(batch.companyId, batch.runId, (tx) => settleBatch(tx, batch.id, settled, actor));
    if (result === "unverified") {
      // Can't happen for a transaction whose hash matched the one OrgPay built, but if it ever
      // does, nobody is marked paid: the payments stay where they are and a person looks.
      deps.logger.error(
        { alert: true, batchId: batch.id, txHash: batch.txHash },
        "ledger record does not match the payments OrgPay built; not marking them successful",
      );
    }
    return result === "settled";
  }

  /**
   * Sends a signed transaction to Stellar. Whatever Horizon answers, it is settled only from the
   * ledger's record (looked up straight away, then by the confirmer); a rejection is recorded so
   * the company can see it, but never taken as proof the envelope can't land.
   */
  async function broadcast(batch: PayrollBatch, signedXdr: string, actor: Actor): Promise<void> {
    const result = await stellar.submit(signedXdr);
    if (result.kind === "failed") {
      await prisma.payrollBatch.updateMany({ where: { id: batch.id, status: "SUBMITTED" }, data: { resultCode: result.txCode } });
    }
    if (result.kind !== "unknown") {
      await resolveBatch({ ...batch, status: "SUBMITTED" }, actor).catch((err: unknown) =>
        deps.logger.warn({ err, batchId: batch.id }, "submitted; the ledger record isn't readable yet"),
      );
    }
  }

  return {
    getRun,
    resolveBatch,

    /**
     * Worker: settle an open batch from the ledger; if it is SUBMITTED, still inside its window and
     * not on the ledger yet, send it again (the same envelope can only land once).
     */
    async confirm(batch: PayrollBatch): Promise<boolean> {
      if (await resolveBatch(batch, "system")) return true;
      const sentAt = Math.max(lastBroadcast.get(batch.id) ?? 0, batch.submittedAt?.getTime() ?? 0);
      if (batch.status === "SUBMITTED" && batch.signedXdr && batch.maxTime.getTime() > Date.now() && Date.now() - sentAt >= REBROADCAST_EVERY_MS) {
        lastBroadcast.set(batch.id, Date.now());
        await broadcast(batch, batch.signedXdr, "system");
        const after = await prisma.payrollBatch.findUnique({ where: { id: batch.id } });
        return after !== null && !isOpen(after);
      }
      return false;
    },

    async list(companyId: string, q: { status?: RunStatus; cursor?: string; limit: number }) {
      const rows = await repo.listRuns(prisma, companyId, q);
      const page = rows.slice(0, q.limit);
      const last = page[page.length - 1];
      return {
        data: page.map((r) => serializeRunSummary(r, r.items)),
        nextCursor: rows.length > q.limit && last ? encodeCursor(last.createdAt, last.id) : null,
      };
    },

    async create(
      companyId: string,
      input: { name: string; walletId: string; payDate?: string | null; paymentsPerTx?: number; groupIds?: string[]; employeeIds?: string[] },
      via: "dashboard" | "api",
    ) {
      const wallet = await activeWallet(companyId, input.walletId);
      const employees = await pickEmployees(companyId, input.groupIds, input.employeeIds);
      const asset = usdc();
      const id = await prisma.$transaction(async (tx) => {
        const company = await tx.company.update({ where: { id: companyId }, data: { runCounter: { increment: 1 } } });
        const run = await tx.payrollRun.create({
          data: {
            companyId,
            number: company.runCounter,
            name: input.name,
            payDate: payDateValue(input.payDate) ?? null,
            walletId: wallet.id,
            walletAddress: wallet.address,
            assetCode: asset.code,
            assetIssuer: asset.issuer,
            paymentsPerTx: input.paymentsPerTx ?? 1,
            createdVia: via,
          },
        });
        const added = await addLines(tx, run, employees);
        await recordEvent(tx, run.id, via === "api" ? "api" : "company", {
          type: "created",
          message: `Draft created with ${added} ${added === 1 ? "employee" : "employees"}`,
        });
        return run.id;
      });
      return getRun(companyId, id);
    },

    async update(companyId: string, id: string, input: { name?: string; payDate?: string | null; walletId?: string; paymentsPerTx?: number }) {
      const wallet = input.walletId ? await activeWallet(companyId, input.walletId) : null;
      await inRunLock(companyId, id, async (tx, run) => {
        if (run.status !== "DRAFT") throw locked();
        await tx.payrollRun.update({
          where: { id: run.id },
          data: {
            name: input.name,
            payDate: payDateValue(input.payDate),
            paymentsPerTx: input.paymentsPerTx,
            ...(wallet ? { walletId: wallet.id, walletAddress: wallet.address } : {}),
          },
        });
      });
      return getRun(companyId, id);
    },

    async addItems(companyId: string, id: string, input: { groupIds?: string[]; employeeIds?: string[] }) {
      const employees = await pickEmployees(companyId, input.groupIds, input.employeeIds);
      await inRunLock(companyId, id, async (tx, run) => {
        if (run.status !== "DRAFT") throw locked();
        await addLines(tx, run, employees);
        await tx.payrollRun.update({ where: { id: run.id }, data: { updatedAt: new Date() } });
      });
      return getRun(companyId, id);
    },

    async updateItem(companyId: string, id: string, itemId: string, amount: string) {
      const amountStroops = parseAmount(amount);
      if (amountStroops === null || amountStroops <= 0n) throw new AppError("VALIDATION_FAILED", "Amount must be greater than 0");
      await inRunLock(companyId, id, async (tx, run) => {
        if (run.status !== "DRAFT") throw locked();
        const updated = await tx.payrollItem.updateMany({ where: { id: itemId, runId: run.id }, data: { amountStroops } });
        if (updated.count === 0) throw notFound("Payment");
        await tx.payrollRun.update({ where: { id: run.id }, data: { updatedAt: new Date() } });
      });
      return getRun(companyId, id);
    },

    async removeItem(companyId: string, id: string, itemId: string) {
      await inRunLock(companyId, id, async (tx, run) => {
        if (run.status !== "DRAFT") throw locked();
        const deleted = await tx.payrollItem.deleteMany({ where: { id: itemId, runId: run.id } });
        if (deleted.count === 0) throw notFound("Payment");
        await tx.payrollRun.update({ where: { id: run.id }, data: { updatedAt: new Date() } });
      });
      return getRun(companyId, id);
    },

    async remove(companyId: string, id: string): Promise<void> {
      await inRunLock(companyId, id, async (tx, run) => {
        if (run.status !== "DRAFT") throw locked("Only a draft can be deleted. Cancel it instead.");
        await tx.payrollRun.delete({ where: { id: run.id } });
      });
    },

    /** Read-only pre-flight: who can receive, and can the funding wallet cover the rest. */
    async check(companyId: string, id: string): Promise<RunCheck> {
      const run = await repo.findRun(prisma, companyId, id);
      if (!run) throw notFound("Payroll run");
      const items = await prisma.payrollItem.findMany({
        where: { runId: run.id, status: { in: ["PENDING", "FAILED"] } },
        orderBy: { position: "asc" },
      });
      const accounts = await loadAccounts(stellar, [run.walletAddress, ...items.map((i) => i.walletAddress)]);
      const problems = problemsFor(items, accounts);
      await rememberChecks(companyId, byAddress(items, problems));
      const payable = items.filter((i) => !problems.get(i.id));
      const payableTotal = payable.reduce((sum, i) => sum + i.amountStroops, 0n);
      const funding = fundingCheck(accounts.get(run.walletAddress) ?? { exists: false }, usdc(), payableTotal, payable.length);
      // Another run for the same pay date that has already paid (or is paying) one of these
      // employees is most likely a duplicate payroll. It's allowed, but the admin is told.
      const alsoPaid = run.payDate
        ? await prisma.payrollItem.findMany({
            where: {
              companyId,
              runId: { not: run.id },
              employeeId: { in: items.flatMap((i) => (i.employeeId ? [i.employeeId] : [])) },
              status: { in: ["PENDING", "AWAITING_SIGNATURE", "SUBMITTED", "SUCCESSFUL"] },
              run: { payDate: run.payDate, status: { notIn: ["DRAFT", "CANCELLED"] } },
            },
            include: { run: { select: { id: true, number: true } } },
            orderBy: { run: { number: "asc" } },
          })
        : [];
      const byEmployee = new Map(items.map((i) => [i.employeeId, i]));
      return {
        payments: items.map((i) => ({ paymentId: i.id, ok: !problems.get(i.id), reason: problems.get(i.id) ?? null })),
        payableCount: payable.length,
        payableTotal: formatStroops(payableTotal),
        excludedCount: items.length - payable.length,
        funding: {
          address: run.walletAddress,
          usdcAvailable: funding.usdcAvailable === null ? null : formatStroops(funding.usdcAvailable),
          xlmAvailable: funding.xlmAvailable === null ? null : formatStroops(funding.xlmAvailable),
          feeXlm: formatStroops(funding.feeStroops),
          enough: funding.problem === null,
          problem: funding.problem,
          shortBy: funding.shortBy === null ? null : formatStroops(funding.shortBy),
        },
        alsoPaidElsewhere: alsoPaid.flatMap((other) => {
          const mine = other.employeeId ? byEmployee.get(other.employeeId) : undefined;
          return mine && other.employeeId
            ? [{ paymentId: mine.id, employeeId: other.employeeId, name: mine.name, runId: other.run.id, runNumber: other.run.number }]
            : [];
        }),
        checkedAt: new Date().toISOString(),
      };
    },

    /**
     * Executes a draft: DRAFT → PROCESSING. Every recipient and the funding wallet are loaded
     * fresh. Employees who can't receive are marked FAILED (never sent); if the wallet can't cover
     * the rest nothing changes. Executing a run twice is refused (409), so a repeated click can't
     * start anything again.
     */
    async start(companyId: string, id: string, actor: Actor) {
      const run = await repo.findRun(prisma, companyId, id);
      if (!run) throw notFound("Payroll run");
      if (run.status !== "DRAFT") throw new AppError("INVALID_TRANSITION", "This run has already been executed");
      if ((await prisma.payrollRun.count({ where: { companyId, status: "PROCESSING" } })) >= MAX_PAYING_RUNS) {
        throw new AppError("LIMIT_REACHED", `You already have ${MAX_PAYING_RUNS} runs being paid. Finish or cancel one first.`);
      }
      await activeWallet(companyId, run.walletId).catch(() => {
        throw new AppError("VALIDATION_FAILED", "This run's funding wallet was removed. Pick another one.", {
          details: [{ path: "walletId", message: "Funding wallet removed" }],
        });
      });
      const items = await repo.itemsByStatus(prisma, companyId, run.id, "PENDING");
      if (items.length === 0) throw new AppError("NOTHING_TO_PAY", "Add people to this run first");
      const accounts = await loadAccounts(stellar, [run.walletAddress, ...items.map((i) => i.walletAddress)]);
      const problems = problemsFor(items, accounts);
      await rememberChecks(companyId, byAddress(items, problems));
      const payable = items.filter((i) => !problems.get(i.id));
      if (payable.length === 0) {
        throw new AppError("NOTHING_TO_PAY", "Nobody on this run can receive USDC right now", {
          details: items.map((i) => ({ itemId: i.id, reason: problems.get(i.id) })),
        });
      }
      const total = payable.reduce((sum, i) => sum + i.amountStroops, 0n);
      const funding = fundingCheck(accounts.get(run.walletAddress) ?? { exists: false }, usdc(), total, payable.length);
      if (funding.problem) throw fundingError(funding, run.assetCode);

      await inRunLock(companyId, id, async (tx, current) => {
        if (current.status !== "DRAFT" || current.walletAddress !== run.walletAddress) throw changedMeanwhile();
        const now = await tx.payrollItem.findMany({ where: { runId: run.id, status: "PENDING" } });
        if (!sameLines(items, now)) throw changedMeanwhile();
        await markExcluded(tx, current, items, problems, actor);
        const excluded = items.length - payable.length;
        await transitionRun(tx, current, "PROCESSING", actor, {
          data: { startedAt: new Date() },
          event: {
            type: "started",
            message: `Executed: ${payable.length} to pay, ${formatStroops(total)} ${run.assetCode}${excluded ? `; ${excluded} can't receive and won't be sent` : ""}`,
          },
        });
      });
      return getRun(companyId, id);
    },

    /**
     * The transaction to sign next: the next `paymentsPerTx` pending payments (1 by default). While
     * a transaction is open (waiting for a signature or for Stellar) it is returned again, never
     * replaced: two envelopes that could both land would pay people twice.
     */
    async nextTransaction(companyId: string, id: string, actor: Actor) {
      const signable = async (b: PayrollBatch) => {
        const paymentIds = (await prisma.payrollItem.findMany({ where: { batchId: b.id }, orderBy: { opIndex: "asc" }, select: { id: true } })).map((i) => i.id);
        return { ...serializeTransaction(b), xdr: b.envelopeXdr, networkPassphrase: env.NETWORK_PASSPHRASE, paymentIds };
      };
      for (let round = 0; round < 12; round++) {
        const run = await repo.findRun(prisma, companyId, id);
        if (!run) throw notFound("Payroll run");
        if (run.status === "DRAFT") throw locked("Execute the run before signing");
        if (run.status !== "PROCESSING") return { transaction: null, run: await getRun(companyId, id) };

        const open = await repo.openBatch(prisma, companyId, run.id);
        if (open) {
          if (open.status === "AWAITING_SIGNATURE" && open.maxTime.getTime() > Date.now()) {
            return { transaction: await signable(open), run: await getRun(companyId, id) };
          }
          // Past its window by our clock, or with Stellar: settle it if the ledger agrees, else wait.
          if (await resolveBatch(open, actor)) continue;
          return { transaction: null, run: await getRun(companyId, id) };
        }

        const lines = await repo.itemsByStatus(prisma, companyId, run.id, "PENDING", run.paymentsPerTx);
        if (lines.length === 0) {
          await inRunLock(companyId, id, (tx) => finishIfDone(tx, run.id, actor));
          return { transaction: null, run: await getRun(companyId, id) };
        }
        const accounts = await loadAccounts(stellar, [run.walletAddress, ...lines.map((i) => i.walletAddress)]);
        const problems = problemsFor(lines, accounts);
        await rememberChecks(companyId, byAddress(lines, problems));
        const payable = lines.filter((i) => !problems.get(i.id));
        const funder = accounts.get(run.walletAddress) ?? { exists: false as const };

        const built = await inRunLock(companyId, id, async (tx, current) => {
          if (current.status !== "PROCESSING") throw changedMeanwhile();
          if (await repo.openBatch(tx, companyId, run.id)) throw changedMeanwhile();
          const now = await tx.payrollItem.findMany({ where: { runId: run.id, id: { in: lines.map((l) => l.id) }, status: "PENDING" } });
          if (!sameLines(lines, now)) throw changedMeanwhile();
          await markExcluded(tx, current, lines, problems, actor);
          if (payable.length === 0) {
            await finishIfDone(tx, run.id, actor);
            return null;
          }
          const total = payable.reduce((sum, i) => sum + i.amountStroops, 0n);
          const funding = fundingCheck(funder, usdc(), total, payable.length);
          if (funding.problem) throw fundingError(funding, current.assetCode);
          if (!funder.exists) throw fundingError(funding, current.assetCode);
          // Timebounds are whole seconds. Each new envelope ends strictly after the last one, so
          // a rebuilt batch can never be byte-identical to (and collide with) an expired one.
          const last = await tx.payrollBatch.findFirst({ where: { runId: run.id }, orderBy: { number: "desc" } });
          let maxSeconds = Math.floor(Date.now() / 1000) + deps.batchWindowSeconds;
          if (last) maxSeconds = Math.max(maxSeconds, Math.floor(last.maxTime.getTime() / 1000) + 1);
          const maxTime = new Date(maxSeconds * 1000);
          // A lagging Horizon node can report a sequence from before our last batch landed: never
          // build below the highest sequence this wallet is known to have used.
          const landed = await tx.payrollBatch.findMany({
            where: { companyId, run: { walletAddress: current.walletAddress }, OR: [{ status: "CONFIRMED" }, { status: "FAILED", ledger: { not: null } }] },
            select: { sequence: true },
          });
          const floor = landed.reduce((max, b) => (BigInt(b.sequence) > max ? BigInt(b.sequence) : max), BigInt(funder.sequence));
          const accountSequence = floor.toString();
          const number = (await tx.payrollBatch.count({ where: { runId: run.id } })) + 1;
          const envelope = buildBatchTransaction({
            source: current.walletAddress,
            accountSequence,
            asset: { code: current.assetCode, issuer: current.assetIssuer },
            lines: payable.map((i) => ({ destination: i.walletAddress, amountStroops: i.amountStroops })),
            memo: transactionMemo(current.number, payable.map((i) => i.position), number),
            maxTime,
          });
          const batch = await tx.payrollBatch.create({
            data: {
              runId: run.id,
              companyId,
              number,
              txHash: envelope.hash,
              envelopeXdr: envelope.xdr,
              sequence: envelope.sequence,
              maxTime,
              opCount: payable.length,
              totalStroops: total,
            },
          });
          await assignToBatch(tx, run.id, batch.id, payable.map((i) => i.id));
          const who = payable.length === 1 ? (payable[0]?.name ?? "1 payment") : `${payable.length} payments`;
          await recordEvent(tx, run.id, actor, {
            type: "transaction_built",
            batchId: batch.id,
            message: `Transaction ${number} ready to sign: ${who}, ${formatStroops(total)} ${current.assetCode}`,
          });
          return batch;
        });
        if (built) return { transaction: await signable(built), run: await getRun(companyId, id) };
      }
      return { transaction: null, run: await getRun(companyId, id) };
    },

    /** Takes the signed transaction, proves it is ours, submits it and records what Stellar says. */
    async submit(companyId: string, id: string, txId: string, signedXdr: string, actor: Actor) {
      const { batch, fresh } = await inRunLock(companyId, id, async (tx, run) => {
        const batch = await repo.findBatch(tx, companyId, run.id, txId);
        if (!batch) throw notFound("Transaction");
        checkSignedBatch(signedXdr, { hash: batch.txHash, source: run.walletAddress });
        if (batch.status !== "AWAITING_SIGNATURE") {
          // Already submitted (a retry, a double click, or the confirmer got there): never send twice.
          return { batch, fresh: false };
        }
        await markSubmitted(tx, batch, signedXdr);
        await recordEvent(tx, run.id, actor, { type: "submitted", batchId: batch.id, message: `Transaction ${batch.number} signed and submitted to Stellar` });
        return { batch, fresh: true };
      });

      if (fresh) await broadcast(batch, signedXdr, actor);
      // Anything else ("unknown", or a rejection that isn't final) stays SUBMITTED for the confirmer.
      const after = await prisma.payrollBatch.findUniqueOrThrow({ where: { id: batch.id } });
      return { transaction: serializeTransaction(after), run: await getRun(companyId, id), settled: !isOpen(after) };
    },

    /** FAILED payments that now pass a fresh check go back to PENDING; the rest keep failing, with the new reason. */
    async retry(companyId: string, id: string, itemIds: string[] | undefined, actor: Actor) {
      const run = await repo.findRun(prisma, companyId, id);
      if (!run) throw notFound("Payroll run");
      if (!["PROCESSING", "PARTIALLY_PAID", "FAILED"].includes(run.status)) throw locked("Only a run that has been executed can be retried");
      const failed = await prisma.payrollItem.findMany({
        where: { runId: run.id, status: "FAILED", ...(itemIds ? { id: { in: itemIds } } : {}) },
        orderBy: { position: "asc" },
      });
      if (failed.length === 0) throw new AppError("NOTHING_TO_PAY", "There are no failed payments to retry");
      const accounts = await loadAccounts(stellar, failed.map((i) => i.walletAddress));
      const problems = problemsFor(failed, accounts);
      await rememberChecks(companyId, byAddress(failed, problems));

      await inRunLock(companyId, id, async (tx, current) => {
        const now = await tx.payrollItem.findMany({ where: { runId: run.id, id: { in: failed.map((f) => f.id) }, status: "FAILED" } });
        if (!sameLines(failed, now)) throw changedMeanwhile();
        const ready = failed.filter((i) => !problems.get(i.id));
        for (const item of failed) {
          const problem = problems.get(item.id);
          if (problem) await tx.payrollItem.updateMany({ where: { id: item.id, status: "FAILED" }, data: { failureCode: problem, failureDetail: null } });
        }
        await transitionItems(tx, run.id, ready.map((i) => i.id), "FAILED", "PENDING", {
          failureCode: null,
          failureDetail: null,
          batchId: null,
          opIndex: null,
        });
        const message = `Retry: ${ready.length} ready to send${failed.length > ready.length ? `, ${failed.length - ready.length} still can't receive` : ""}`;
        if (ready.length > 0 && (current.status === "PARTIALLY_PAID" || current.status === "FAILED")) {
          await transitionRun(tx, current, "PROCESSING", actor, { data: { finishedAt: null }, event: { type: "retried", message } });
        } else {
          await recordEvent(tx, run.id, actor, { type: "retried", message });
        }
      });
      return getRun(companyId, id);
    },

    /**
     * A draft: cancelled outright. A run being paid: every line not yet sent (to pay, or failed)
     * is cancelled, so a later retry can't pay it; refused while a batch is open. A finished run
     * with failed lines: those lines are given up on.
     */
    async cancel(companyId: string, id: string, actor: Actor) {
      await inRunLock(companyId, id, (tx, run) => cancelRun(tx, run, actor));
      return getRun(companyId, id);
    },

    async getPayment(companyId: string, paymentId: string): Promise<PaymentDetail> {
      const item = await prisma.payrollItem.findFirst({ where: { id: paymentId, companyId }, include: { run: true, batch: true } });
      if (!item) throw notFound("Payment");
      const txNumbers = new Map(item.batch ? [[item.batch.id, item.batch.number]] : []);
      return {
        ...serializePayment(item, txNumbers),
        run: { id: item.run.id, number: item.run.number, name: item.run.name, status: item.run.status },
      };
    },

    /**
     * Re-checks a payment against the ledger, straight from Horizon: anyone can confirm a
     * record without trusting OrgPay's database. Read-only; it never changes a status.
     */
    async verify(companyId: string, paymentId: string): Promise<PaymentVerification> {
      const item = await prisma.payrollItem.findFirst({ where: { id: paymentId, companyId }, include: { run: true, batch: true } });
      if (!item) throw notFound("Payment");
      const txHash = item.txHash ?? item.batch?.txHash ?? null;
      const found = txHash ? (await stellar.getTransaction(txHash)).found : null;
      const checks = verifyPayment(
        found,
        { txHash: txHash ?? "", source: item.run.walletAddress, asset: { code: item.run.assetCode, issuer: item.run.assetIssuer } },
        { opIndex: item.opIndex ?? -1, walletAddress: item.walletAddress, amountStroops: item.amountStroops },
      );
      return {
        paymentId: item.id,
        status: item.status,
        txHash,
        verified: allPassed(checks),
        checks,
        ledger: found?.ledger ?? null,
        closedAt: found?.closedAt.toISOString() ?? null,
        explorerUrl: found && txHash ? explorerTxUrl(txHash) : null,
        checkedAt: new Date().toISOString(),
      };
    },

    /** Every payment on a run as CSV, with its hash and explorer link. */
    async exportCsv(companyId: string, id: string): Promise<string> {
      const run = await getRun(companyId, id);
      const header = ["run", "position", "employee_id", "name", "wallet", "amount", "asset", "status", "failure", "tx_hash", "ledger", "paid_at", "verified_at", "explorer_url"];
      const rows = run.payments.map((p) => [
        run.number,
        p.position,
        p.employeeId ?? "",
        p.name,
        p.walletAddress,
        p.amount,
        run.asset.code,
        p.status,
        p.failureCode ?? "",
        p.txHash ?? "",
        p.ledger ?? "",
        p.paidAt ?? "",
        p.verifiedAt ?? "",
        p.explorerUrl ?? "",
      ]);
      return [header, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
    },
  };
}

/** Quotes a CSV cell, and defuses text a spreadsheet would run as a formula. */
function csvCell(value: string | number): string {
  let s = String(value);
  if (/^[=+\-@\t\r]/.test(s) && typeof value === "string") s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export type PayrollService = ReturnType<typeof createPayrollService>;
