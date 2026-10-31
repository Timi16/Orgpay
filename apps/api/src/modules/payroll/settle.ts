import type { FailureCode } from "@orgpay/shared";
import type { PayrollBatch } from "@prisma/client";
import type { Tx } from "../../db/prisma";
import { finishIfDone, recordEvent, transitionBatch, transitionItems, type Actor } from "./transitions";

/** What Stellar says happened to a batch's transaction. */
export type BatchOutcome =
  | { kind: "success"; ledger: number; closedAt: Date }
  /** tx_failed: in a ledger, every operation rolled back. Or rejected before a ledger and provably unable to land. */
  | { kind: "failed"; txCode: string; opCodes: string[] }
  /** The window passed by ledger close time and the transaction is not on the network. */
  | { kind: "expired" };

/**
 * Operation codes that are about the recipient. These lines fail; every other line in a failed
 * batch was simply not sent (a Stellar transaction is all or nothing) and goes back to PENDING.
 */
const RECIPIENT_CODES: Record<string, FailureCode> = {
  op_no_destination: "ACCOUNT_NOT_FOUND",
  op_no_trust: "NO_TRUSTLINE",
  op_not_authorized: "NOT_AUTHORIZED",
  op_line_full: "TRUSTLINE_LIMIT_TOO_LOW",
};
/** Codes that are not the recipient's fault (or are success inside a failed transaction). */
const NOT_RECIPIENT = new Set(["op_success", "op_underfunded", "op_src_no_trust", "op_src_not_authorized", "op_no_issuer", "op_bad_auth", "op_no_account", "op_too_many_subentries"]);

export function lineFailure(opCode: string | undefined): FailureCode | null {
  if (!opCode || NOT_RECIPIENT.has(opCode)) return null;
  return RECIPIENT_CODES[opCode] ?? "PAYMENT_FAILED";
}

/**
 * Applies an outcome to a batch that is still open (AWAITING_SIGNATURE or SUBMITTED). Must run
 * inside a transaction holding the run lock. Returns false when the batch was already settled
 * (someone else got there first), in which case nothing changes.
 */
export async function settleBatch(tx: Tx, batchId: string, outcome: BatchOutcome, actor: Actor): Promise<boolean> {
  const batch = await tx.payrollBatch.findUnique({ where: { id: batchId } });
  if (!batch || (batch.status !== "AWAITING_SIGNATURE" && batch.status !== "SUBMITTED")) return false;
  const items = await tx.payrollItem.findMany({
    where: { batchId: batch.id, status: "SENDING" },
    orderBy: { opIndex: "asc" },
  });
  const ids = items.map((i) => i.id);
  const now = new Date();

  if (outcome.kind === "success") {
    await transitionBatch(tx, batch, "CONFIRMED", { ledger: outcome.ledger, closedAt: outcome.closedAt, settledAt: now });
    await transitionItems(tx, batch.runId, ids, "SENDING", "PAID", {
      txHash: batch.txHash,
      ledger: outcome.ledger,
      paidAt: outcome.closedAt,
      failureCode: null,
      failureDetail: null,
    });
    await recordEvent(tx, batch.runId, actor, {
      type: "confirmed",
      batchId: batch.id,
      message: `Batch ${batch.number} confirmed in ledger ${outcome.ledger}: ${ids.length} paid`,
    });
  } else if (outcome.kind === "failed") {
    await transitionBatch(tx, batch, "FAILED", { resultCode: outcome.txCode, settledAt: now });
    let failedCount = 0;
    for (const item of items) {
      const opCode = item.opIndex === null ? undefined : outcome.opCodes[item.opIndex];
      const failure = lineFailure(opCode);
      if (failure) {
        failedCount++;
        await transitionItems(tx, batch.runId, [item.id], "SENDING", "FAILED", { failureCode: failure, failureDetail: opCode ?? null });
        await recordEvent(tx, batch.runId, actor, {
          type: "line_failed",
          itemId: item.id,
          batchId: batch.id,
          message: `${item.name} not paid: ${opCode ?? outcome.txCode}`,
        });
      } else {
        await transitionItems(tx, batch.runId, [item.id], "SENDING", "PENDING", { batchId: null, opIndex: null });
      }
    }
    await recordEvent(tx, batch.runId, actor, {
      type: "batch_failed",
      batchId: batch.id,
      message:
        failedCount > 0
          ? `Batch ${batch.number} failed (${outcome.txCode}). Nobody in it was paid; ${failedCount} line(s) failed, ${items.length - failedCount} will go in the next batch.`
          : `Batch ${batch.number} was not accepted (${outcome.txCode}). Nobody in it was paid; ${items.length} line(s) will go in the next batch.`,
    });
  } else {
    await transitionBatch(tx, batch, "EXPIRED", { settledAt: now });
    await transitionItems(tx, batch.runId, ids, "SENDING", "PENDING", { batchId: null, opIndex: null });
    await recordEvent(tx, batch.runId, actor, {
      type: "expired",
      batchId: batch.id,
      message: `Batch ${batch.number} was not signed in time and can no longer go through. Nothing was sent.`,
    });
  }
  await finishIfDone(tx, batch.runId, actor);
  return true;
}

/** True when a batch can still be signed or land: the caller must not build another one. */
export function isOpen(batch: Pick<PayrollBatch, "status">): boolean {
  return batch.status === "AWAITING_SIGNATURE" || batch.status === "SUBMITTED";
}
