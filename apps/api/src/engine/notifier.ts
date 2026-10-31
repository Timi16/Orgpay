import type { PrismaClient } from "@prisma/client";
import type { Logger } from "pino";
import { runFinishedEmail } from "../lib/emails";
import type { Mailer } from "../lib/mailer";

export const NOTIFY_INTERVAL_MS = 15_000;
/** Runs that finished longer ago than this are never emailed about (e.g. after a long outage). */
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

export interface NotifierDeps {
  prisma: PrismaClient;
  mailer: Mailer;
  webOrigin: string;
  logger: Logger;
}

/**
 * Emails the company when a run finishes. Each run is claimed before sending, so an email goes
 * out at most once per finish even if the worker restarts; a failed send is logged, not retried.
 */
export async function notifyRuns(deps: NotifierDeps, limit = 25): Promise<number> {
  const { prisma, mailer, webOrigin, logger } = deps;
  const runs = await prisma.payrollRun.findMany({
    where: { status: { in: ["PAID", "PARTIAL", "FAILED"] }, notifiedAt: null, finishedAt: { gt: new Date(Date.now() - MAX_AGE_MS) } },
    include: { company: true },
    orderBy: { finishedAt: "asc" },
    take: limit,
  });
  let sent = 0;
  for (const run of runs) {
    // Only the finish we read: a retry that reopened the run in the meantime is left for its next finish.
    const claimed = await prisma.payrollRun.updateMany({
      where: { id: run.id, notifiedAt: null, status: run.status, finishedAt: run.finishedAt },
      data: { notifiedAt: new Date() },
    });
    if (claimed.count === 0) continue;
    const company = run.company;
    if (company.closedAt) continue;
    const wanted = run.status === "PAID" ? company.notifyPaid : company.notifyProblems;
    if (!wanted) continue;
    const items = await prisma.payrollItem.findMany({
      where: { runId: run.id, status: { in: ["PAID", "FAILED"] } },
      select: { status: true, amountStroops: true, name: true, failureCode: true },
      orderBy: { position: "asc" },
    });
    const paid = items.filter((i) => i.status === "PAID");
    try {
      await mailer.send(
        runFinishedEmail(
          company.email,
          company.businessName,
          {
            id: run.id,
            number: run.number,
            name: run.name,
            status: run.status as "PAID" | "PARTIAL" | "FAILED",
            assetCode: run.assetCode,
            paidCount: paid.length,
            paidStroops: paid.reduce((s, i) => s + i.amountStroops, 0n),
            failed: items.filter((i) => i.status === "FAILED").map((i) => ({ name: i.name, reason: i.failureCode ?? "PAYMENT_FAILED" })),
          },
          webOrigin,
        ),
      );
      sent++;
    } catch (err) {
      logger.error({ err, runId: run.id }, "run email failed to send");
    }
  }
  return sent;
}
