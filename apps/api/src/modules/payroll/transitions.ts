import type { BatchStatus, ItemStatus, PayrollBatch, PayrollRun, Prisma, RunStatus } from "@prisma/client";
import type { Tx } from "../../db/prisma";
import { AppError } from "../../lib/errors";

// The ONLY place run, payment and transaction statuses change (ESLint enforces it). Every change
// is a conditional update on the expected current status, made while the caller holds the run's
// row lock (lockRun), so concurrent requests and the worker can never race a status.
//
// In the database a payment is a PayrollItem and a Stellar transaction is a PayrollBatch.

export const RUN_ALLOWED: Record<RunStatus, RunStatus[]> = {
  DRAFT: ["PROCESSING", "CANCELLED"],
  PROCESSING: ["COMPLETED", "PARTIALLY_PAID", "FAILED", "CANCELLED"],
  PARTIALLY_PAID: ["PROCESSING"], // retry
  FAILED: ["PROCESSING", "CANCELLED"], // retry, or give up on everyone
  COMPLETED: [],
  CANCELLED: [],
};

export const ITEM_ALLOWED: Record<ItemStatus, ItemStatus[]> = {
  PENDING: ["AWAITING_SIGNATURE", "FAILED", "CANCELLED"],
  // Straight to SUCCESSFUL or FAILED when the signed transaction was submitted outside OrgPay.
  AWAITING_SIGNATURE: ["SUBMITTED", "SUCCESSFUL", "FAILED", "PENDING"],
  SUBMITTED: ["SUCCESSFUL", "FAILED", "PENDING"],
  FAILED: ["PENDING", "CANCELLED"], // retry, or give up
  SUCCESSFUL: [], // a successful payment never changes again
  CANCELLED: [],
};

export const BATCH_ALLOWED: Record<BatchStatus, BatchStatus[]> = {
  AWAITING_SIGNATURE: ["SUBMITTED", "CONFIRMED", "FAILED", "EXPIRED"],
  SUBMITTED: ["CONFIRMED", "FAILED", "EXPIRED"],
  CONFIRMED: [],
  FAILED: [],
  EXPIRED: [],
};

/** Payment statuses that mean "in a transaction that may still land". */
export const IN_FLIGHT: ItemStatus[] = ["AWAITING_SIGNATURE", "SUBMITTED"];

export type Actor = "company" | "api" | "system";

export interface EventInput {
  type: string;
  message: string;
  itemId?: string | null;
  batchId?: string | null;
}

const invalid = (what: string, from: string, to: string) =>
  new AppError("INVALID_TRANSITION", `A ${what} cannot go from ${from} to ${to}`);

/** SELECT … FOR UPDATE on the run. Every payroll write takes this lock first, so there is one lock order. */
export async function lockRun(tx: Tx, companyId: string, runId: string): Promise<PayrollRun | null> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM "PayrollRun" WHERE id = ${runId} AND "companyId" = ${companyId} FOR UPDATE`;
  if (rows.length === 0) return null;
  return tx.payrollRun.findUnique({ where: { id: runId } });
}

export async function recordEvent(tx: Tx, runId: string, actor: Actor, event: EventInput): Promise<void> {
  await tx.payrollEvent.create({
    data: { runId, actor, type: event.type, message: event.message, itemId: event.itemId ?? null, batchId: event.batchId ?? null },
  });
}

export async function transitionRun(
  tx: Tx,
  run: Pick<PayrollRun, "id" | "status">,
  to: RunStatus,
  actor: Actor,
  opts: { data?: Prisma.PayrollRunUpdateManyMutationInput; event?: EventInput } = {},
): Promise<void> {
  if (!RUN_ALLOWED[run.status].includes(to)) throw invalid("run", run.status, to);
  const updated = await tx.payrollRun.updateMany({
    where: { id: run.id, status: run.status },
    data: { ...opts.data, status: to },
  });
  if (updated.count !== 1) throw invalid("run", run.status, to);
  if (opts.event) await recordEvent(tx, run.id, actor, opts.event);
}

/**
 * Moves payments of one run from `from` to `to`. All of them must be in `from`: a mismatch means
 * something else changed them, and the whole transaction is rolled back.
 */
export async function transitionItems(
  tx: Tx,
  runId: string,
  itemIds: string[],
  from: ItemStatus,
  to: ItemStatus,
  data: Prisma.PayrollItemUncheckedUpdateManyInput = {},
): Promise<void> {
  if (itemIds.length === 0) return;
  if (!ITEM_ALLOWED[from].includes(to)) throw invalid("payment", from, to);
  const updated = await tx.payrollItem.updateMany({
    where: { runId, id: { in: itemIds }, status: from },
    data: { ...data, status: to },
  });
  if (updated.count !== itemIds.length) throw invalid("payment", from, to);
}

/** Puts PENDING payments into a built transaction: they wait for its signature. */
export async function assignToBatch(tx: Tx, runId: string, batchId: string, itemIds: string[]): Promise<void> {
  for (const [opIndex, id] of itemIds.entries()) {
    const updated = await tx.payrollItem.updateMany({
      where: { runId, id, status: "PENDING" },
      data: { status: "AWAITING_SIGNATURE", batchId, opIndex, attempts: { increment: 1 } },
    });
    if (updated.count !== 1) throw invalid("payment", "PENDING", "AWAITING_SIGNATURE");
  }
}

export async function transitionBatch(
  tx: Tx,
  batch: Pick<PayrollBatch, "id" | "status">,
  to: BatchStatus,
  data: Prisma.PayrollBatchUpdateManyMutationInput = {},
): Promise<void> {
  if (!BATCH_ALLOWED[batch.status].includes(to)) throw invalid("transaction", batch.status, to);
  const updated = await tx.payrollBatch.updateMany({ where: { id: batch.id, status: batch.status }, data: { ...data, status: to } });
  if (updated.count !== 1) throw invalid("transaction", batch.status, to);
}

/** The signed transaction goes to Stellar: it and its payments become SUBMITTED together. */
export async function markSubmitted(tx: Tx, batch: Pick<PayrollBatch, "id" | "runId" | "status">, signedXdr: string): Promise<void> {
  await transitionBatch(tx, batch, "SUBMITTED", { signedXdr, submittedAt: new Date() });
  const items = await tx.payrollItem.findMany({ where: { batchId: batch.id, status: "AWAITING_SIGNATURE" }, select: { id: true } });
  await transitionItems(tx, batch.runId, items.map((i) => i.id), "AWAITING_SIGNATURE", "SUBMITTED");
}

/**
 * A PROCESSING run with nothing left to send or confirm is finished: COMPLETED when every
 * payment succeeded, PARTIALLY_PAID when some did and some failed, FAILED when none did. After a
 * cancel, a run that paid nobody is CANCELLED and one that paid some is PARTIALLY_PAID (never
 * COMPLETED: not everyone was paid). Returns the new status, or null when the run is not finished.
 */
export async function finishIfDone(tx: Tx, runId: string, actor: Actor, opts: { cancelled?: boolean } = {}): Promise<RunStatus | null> {
  const run = await tx.payrollRun.findUnique({ where: { id: runId }, select: { id: true, status: true } });
  if (!run || run.status !== "PROCESSING") return null;
  const groups = await tx.payrollItem.groupBy({ by: ["status"], where: { runId }, _count: { _all: true } });
  const count = (s: ItemStatus) => groups.find((g) => g.status === s)?._count._all ?? 0;
  if (count("PENDING") > 0 || IN_FLIGHT.some((s) => count(s) > 0)) return null;
  const paid = count("SUCCESSFUL");
  const failed = count("FAILED");
  const cancelled = count("CANCELLED");
  let to: RunStatus;
  let message: string;
  if (opts.cancelled || (paid === 0 && failed === 0)) {
    to = paid > 0 ? "PARTIALLY_PAID" : "CANCELLED";
    message = paid > 0 ? `Cancelled after ${paid} successful; ${cancelled + failed} not paid` : "Cancelled: nobody was paid";
  } else if (failed === 0) {
    to = "COMPLETED";
    message = `Completed: all ${paid} payments successful`;
  } else if (paid === 0) {
    to = "FAILED";
    message = `Finished: none of ${failed} payments went through`;
  } else {
    to = "PARTIALLY_PAID";
    message = `Finished: ${paid} successful, ${failed} failed`;
  }
  await transitionRun(tx, run, to, actor, {
    // A cancelled finish sends no "run finished" email (notifiedAt set).
    data: { finishedAt: new Date(), notifiedAt: opts.cancelled ? new Date() : null },
    event: { type: opts.cancelled ? "cancelled" : "finished", message },
  });
  return to;
}
