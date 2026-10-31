import type { Batch, FailureCode, Run, RunEvent, RunItem, RunSummary } from "@orgpay/shared";
import type { PayrollBatch, PayrollEvent, PayrollItem, PayrollRun, Wallet } from "@prisma/client";
import { formatStroops } from "../../lib/amount";

export type RunWithWallet = PayrollRun & { wallet: Pick<Wallet, "id" | "address" | "label"> };
type ItemTotals = Pick<PayrollItem, "status" | "amountStroops">[];

function day(d: Date | null): string | null {
  return d ? d.toISOString().slice(0, 10) : null;
}

export function serializeRunSummary(run: RunWithWallet, items: ItemTotals): RunSummary {
  let total = 0n;
  let paid = 0n;
  let failed = 0n;
  const counts = { lines: items.length, pending: 0, sending: 0, paid: 0, failed: 0, cancelled: 0 };
  for (const i of items) {
    if (i.status !== "CANCELLED") total += i.amountStroops;
    if (i.status === "PAID") paid += i.amountStroops;
    if (i.status === "FAILED") failed += i.amountStroops;
    if (i.status === "PENDING") counts.pending++;
    else if (i.status === "SENDING") counts.sending++;
    else if (i.status === "PAID") counts.paid++;
    else if (i.status === "FAILED") counts.failed++;
    else counts.cancelled++;
  }
  return {
    id: run.id,
    number: run.number,
    name: run.name,
    payDate: day(run.payDate),
    status: run.status,
    // The snapshot is what the run pays from; the label is the wallet's current one.
    wallet: { id: run.wallet.id, address: run.walletAddress, label: run.wallet.label },
    asset: { code: run.assetCode, issuer: run.assetIssuer },
    total: formatStroops(total),
    totalStroops: total.toString(),
    paid: formatStroops(paid),
    paidStroops: paid.toString(),
    failedTotal: formatStroops(failed),
    counts,
    startedAt: run.startedAt?.toISOString() ?? null,
    finishedAt: run.finishedAt?.toISOString() ?? null,
    createdAt: run.createdAt.toISOString(),
    updatedAt: run.updatedAt.toISOString(),
  };
}

export function serializeBatch(b: PayrollBatch): Batch {
  return {
    id: b.id,
    number: b.number,
    status: b.status,
    txHash: b.txHash,
    opCount: b.opCount,
    total: formatStroops(b.totalStroops),
    maxTime: b.maxTime.toISOString(),
    ledger: b.ledger,
    closedAt: b.closedAt?.toISOString() ?? null,
    resultCode: b.resultCode,
    submittedAt: b.submittedAt?.toISOString() ?? null,
    settledAt: b.settledAt?.toISOString() ?? null,
    createdAt: b.createdAt.toISOString(),
  };
}

export function serializeItem(i: PayrollItem, batchNumbers: Map<string, number>): RunItem {
  return {
    id: i.id,
    position: i.position,
    employeeId: i.employeeId,
    name: i.name,
    walletAddress: i.walletAddress,
    amount: formatStroops(i.amountStroops),
    amountStroops: i.amountStroops.toString(),
    status: i.status,
    failureCode: (i.failureCode as FailureCode | null) ?? null,
    failureDetail: i.failureDetail,
    txHash: i.txHash,
    ledger: i.ledger,
    paidAt: i.paidAt?.toISOString() ?? null,
    batchNumber: i.batchId ? (batchNumbers.get(i.batchId) ?? null) : null,
    attempts: i.attempts,
  };
}

function serializeEvent(e: PayrollEvent): RunEvent {
  return {
    id: e.id,
    type: e.type,
    message: e.message,
    actor: e.actor,
    itemId: e.itemId,
    batchId: e.batchId,
    createdAt: e.createdAt.toISOString(),
  };
}

export function serializeRun(
  run: RunWithWallet & { items: PayrollItem[]; batches: PayrollBatch[]; events: PayrollEvent[] },
): Run {
  const batchNumbers = new Map(run.batches.map((b) => [b.id, b.number]));
  return {
    ...serializeRunSummary(run, run.items),
    items: run.items.map((i) => serializeItem(i, batchNumbers)),
    batches: run.batches.map(serializeBatch),
    events: run.events.map(serializeEvent),
  };
}
