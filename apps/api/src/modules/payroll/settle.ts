import type { FailureCode } from "@orgpay/shared";
import type { PayrollBatch } from "@prisma/client";
import type { Tx } from "../../db/prisma";
import type { FoundTransaction } from "../../stellar/gateway";
import { allPassed, verifyPayment } from "../../stellar/verify";
import { finishIfDone, recordEvent, transitionBatch, transitionItems, type Actor } from "./transitions";

/** What Stellar says happened to a transaction. */
export type BatchOutcome =
  /** The ledger's own record of a successful transaction; every payment in it is verified against it. */
  | { kind: "success"; record: FoundTransaction }
  /**
   * tx_failed: in a ledger, every operation rolled back (ledger and closedAt say which; it used
   * the sequence number and has an explorer page). Or rejected before a ledger and provably unable to land.
   */
  | { kind: "failed"; txCode: string; opCodes: string[]; ledger?: number; closedAt?: Date }
  /** The window passed by ledger close time and the transaction is not on the network. */
  | { kind: "expired" };

/**
 * settled: the outcome was applied. already: someone else settled it first; nothing changed.
 * unverified: the ledger says successful but a payment didn't match it; nothing changed, never SUCCESSFUL.
 */
export type SettleResult = "settled" | "already" | "unverified";

/**
 * Operation codes that are about the recipient. These payments fail; every other payment in a
 * failed transaction was simply not sent (a Stellar transaction is all or nothing) and goes back
 * to PENDING.
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
 * Applies an outcome to a transaction that is still open (AWAITING_SIGNATURE or SUBMITTED). Must
 * run inside a database transaction holding the run lock.
 */
export async function settleBatch(tx: Tx, batchId: string, outcome: BatchOutcome, actor: Actor): Promise<SettleResult> {
  const batch = await tx.payrollBatch.findUnique({ where: { id: batchId }, include: { run: true } });
  if (!batch || (batch.status !== "AWAITING_SIGNATURE" && batch.status !== "SUBMITTED")) return "already";
  // A transaction's payments always share its status.
  const from = batch.status;
  const items = await tx.payrollItem.findMany({ where: { batchId: batch.id, status: from }, orderBy: { opIndex: "asc" } });
  const ids = items.map((i) => i.id);
  const now = new Date();
  const label = `Transaction ${batch.number}`;

  if (outcome.kind === "success") {
    const expected = { txHash: batch.txHash, source: batch.run.walletAddress, asset: { code: batch.run.assetCode, issuer: batch.run.assetIssuer } };
    const verified = items.every(
      (i) => i.opIndex !== null && allPassed(verifyPayment(outcome.record, expected, { opIndex: i.opIndex, walletAddress: i.walletAddress, amountStroops: i.amountStroops })),
    );
    if (!verified) return "unverified";
    const { ledger, closedAt } = outcome.record;
    await transitionBatch(tx, batch, "CONFIRMED", { ledger, closedAt, settledAt: now });
    await transitionItems(tx, batch.runId, ids, from, "SUCCESSFUL", {
      txHash: batch.txHash,
      ledger,
      paidAt: closedAt,
      verifiedAt: now,
      failureCode: null,
      failureDetail: null,
    });
    await recordEvent(tx, batch.runId, actor, {
      type: "confirmed",
      batchId: batch.id,
      message:
        items.length === 1
          ? `${label} verified in ledger ${ledger}: ${items[0]?.name ?? "1 payment"} paid`
          : `${label} verified in ledger ${ledger}: ${items.length} payments successful`,
    });
  } else if (outcome.kind === "failed") {
    await transitionBatch(tx, batch, "FAILED", { resultCode: outcome.txCode, ledger: outcome.ledger ?? null, closedAt: outcome.closedAt ?? null, settledAt: now });
    let failedCount = 0;
    for (const item of items) {
      const opCode = item.opIndex === null ? undefined : outcome.opCodes[item.opIndex];
      const failure = lineFailure(opCode);
      if (failure) {
        failedCount++;
        await transitionItems(tx, batch.runId, [item.id], from, "FAILED", { failureCode: failure, failureDetail: opCode ?? null });
        await recordEvent(tx, batch.runId, actor, {
          type: "payment_failed",
          itemId: item.id,
          batchId: batch.id,
          message: `${item.name} not paid: ${opCode ?? outcome.txCode}`,
        });
      } else {
        await transitionItems(tx, batch.runId, [item.id], from, "PENDING", { batchId: null, opIndex: null });
      }
    }
    await recordEvent(tx, batch.runId, actor, {
      type: "transaction_failed",
      batchId: batch.id,
      message:
        failedCount > 0
          ? `${label} failed (${outcome.txCode}). Nobody in it was paid; ${failedCount} payment(s) failed, ${items.length - failedCount} will go in the next transaction.`
          : `${label} was not accepted (${outcome.txCode}). Nobody in it was paid; ${items.length} payment(s) will go in the next transaction.`,
    });
  } else {
    await transitionBatch(tx, batch, "EXPIRED", { settledAt: now });
    await transitionItems(tx, batch.runId, ids, from, "PENDING", { batchId: null, opIndex: null });
    await recordEvent(tx, batch.runId, actor, {
      type: "expired",
      batchId: batch.id,
      message: `${label} was not signed in time and can no longer go through. Nothing was sent.`,
    });
  }
  await finishIfDone(tx, batch.runId, actor);
  return "settled";
}

/** True when a transaction can still be signed or land: the caller must not build another one. */
export function isOpen(batch: Pick<PayrollBatch, "status">): boolean {
  return batch.status === "AWAITING_SIGNATURE" || batch.status === "SUBMITTED";
}
