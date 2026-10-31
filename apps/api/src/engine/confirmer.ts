import type { PayrollBatch, PrismaClient } from "@prisma/client";
import type { Logger } from "pino";
import type { PayrollService } from "../modules/payroll/service";

export const CONFIRM_INTERVAL_MS = 5000;
/** Batches looked at per tick, shared fairly between companies. */
const PER_TICK = 40;
/** An unsigned batch inside its window only needs an occasional look (in case it was submitted elsewhere). */
const UNSIGNED_EVERY_MS = 30_000;

const lastLook = new Map<string, number>();

/** One batch from each company in turn, oldest first within a company. */
function roundRobin(batches: PayrollBatch[]): PayrollBatch[] {
  const byCompany = new Map<string, PayrollBatch[]>();
  for (const b of batches) byCompany.set(b.companyId, [...(byCompany.get(b.companyId) ?? []), b]);
  const queues = [...byCompany.values()];
  const out: PayrollBatch[] = [];
  for (let i = 0; out.length < batches.length; i++) {
    for (const q of queues) if (q[i]) out.push(q[i] as PayrollBatch);
  }
  return out;
}

/**
 * Settles every open batch Stellar has a final answer for: found on the ledger (submitted by
 * OrgPay or anywhere else) → confirmed or failed; past its window by ledger close time and
 * not on the ledger → expired. A signed batch with no answer yet is sent again while its window
 * is open (it can only land once); anything else is left for the next tick. Companies take turns,
 * so one company's many open batches can't starve the others.
 */
export async function confirmOpenBatches(deps: { prisma: PrismaClient; payroll: PayrollService; logger: Logger }, now = Date.now()): Promise<number> {
  const open = await deps.prisma.payrollBatch.findMany({
    where: { status: { in: ["AWAITING_SIGNATURE", "SUBMITTED"] } },
    orderBy: { createdAt: "asc" },
    take: 1000,
  });
  const due = open.filter(
    (b) => b.status === "SUBMITTED" || b.maxTime.getTime() <= now || now - (lastLook.get(b.id) ?? 0) >= UNSIGNED_EVERY_MS,
  );
  let settled = 0;
  for (const batch of roundRobin(due).slice(0, PER_TICK)) {
    lastLook.set(batch.id, now);
    try {
      if (await deps.payroll.confirm(batch)) {
        settled++;
        lastLook.delete(batch.id);
      }
    } catch (err) {
      deps.logger.warn({ err, batchId: batch.id }, "could not resolve batch yet");
    }
  }
  return settled;
}
