import { explorerTxUrl, type FailureCode, type Payment, type Run, type RunEvent, type RunSummary, type StellarTransaction } from "@orgpay/shared";
import type { PayrollBatch, PayrollEvent, PayrollItem, PayrollRun, Wallet } from "@prisma/client";
import { formatStroops } from "../../lib/amount";

// In the database a payment is a PayrollItem and a Stellar transaction is a PayrollBatch; the API
// speaks of payments and transactions.

export type RunWithWallet = PayrollRun & { wallet: Pick<Wallet, "id" | "address" | "label"> };
type ItemTotals = Pick<PayrollItem, "status" | "amountStroops">[];

function day(d: Date | null): string | null {
  return d ? d.toISOString().slice(0, 10) : null;
}

export function serializeRunSummary(run: RunWithWallet, items: ItemTotals): RunSummary {
  let total = 0n;
  let paid = 0n;
  let failed = 0n;
  const counts = { payments: items.length, pending: 0, awaitingSignature: 0, submitted: 0, successful: 0, failed: 0, cancelled: 0 };
  for (const i of items) {
    if (i.status !== "CANCELLED") total += i.amountStroops;
    if (i.status === "SUCCESSFUL") paid += i.amountStroops;
    if (i.status === "FAILED") failed += i.amountStroops;
    if (i.status === "PENDING") counts.pending++;
    else if (i.status === "AWAITING_SIGNATURE") counts.awaitingSignature++;
    else if (i.status === "SUBMITTED") counts.submitted++;
    else if (i.status === "SUCCESSFUL") counts.successful++;
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
    paymentsPerTx: run.paymentsPerTx,
    employeeCount: items.length - counts.cancelled,
    total: formatStroops(total),
    totalStroops: total.toString(),
    paidTotal: formatStroops(paid),
    paidTotalStroops: paid.toString(),
    failedTotal: formatStroops(failed),
    counts,
    startedAt: run.startedAt?.toISOString() ?? null,
    finishedAt: run.finishedAt?.toISOString() ?? null,
    createdAt: run.createdAt.toISOString(),
    updatedAt: run.updatedAt.toISOString(),
  };
}

export function serializeTransaction(b: PayrollBatch): StellarTransaction {
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
    // Only a transaction that reached a ledger has an explorer page.
    explorerUrl: b.ledger !== null ? explorerTxUrl(b.txHash) : null,
  };
}

export function serializePayment(i: PayrollItem, txNumbers: Map<string, number>): Payment {
  return {
    id: i.id,
    runId: i.runId,
    position: i.position,
    employeeId: i.employeeId,
    name: i.name,
    walletAddress: i.walletAddress,
    amount: formatStroops(i.amountStroops),
    amountStroops: i.amountStroops.toString(),
    status: i.status,
    failureCode: (i.failureCode as FailureCode | null) ?? null,
    failureDetail: i.failureDetail,
    // txHash is only set once the ledger record was verified against this payment.
    txHash: i.txHash,
    ledger: i.ledger,
    paidAt: i.paidAt?.toISOString() ?? null,
    verifiedAt: i.verifiedAt?.toISOString() ?? null,
    transactionNumber: i.batchId ? (txNumbers.get(i.batchId) ?? null) : null,
    attempts: i.attempts,
    explorerUrl: i.txHash ? explorerTxUrl(i.txHash) : null,
  };
}

function serializeEvent(e: PayrollEvent): RunEvent {
  return {
    id: e.id,
    type: e.type,
    message: e.message,
    actor: e.actor,
    paymentId: e.itemId,
    transactionId: e.batchId,
    createdAt: e.createdAt.toISOString(),
  };
}

export function serializeRun(
  run: RunWithWallet & { items: PayrollItem[]; batches: PayrollBatch[]; events: PayrollEvent[] },
): Run {
  const txNumbers = new Map(run.batches.map((b) => [b.id, b.number]));
  return {
    ...serializeRunSummary(run, run.items),
    payments: run.items.map((i) => serializePayment(i, txNumbers)),
    transactions: run.batches.map(serializeTransaction),
    events: run.events.map(serializeEvent),
  };
}
