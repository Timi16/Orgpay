import type { Summary } from "@orgpay/shared";
import type { AppDeps } from "../../deps";
import { formatStroops } from "../../lib/amount";
import * as repo from "../payroll/repo";
import { serializeRunSummary } from "../payroll/serialize";

function monthStart(d: Date, offset = 0): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + offset, 1));
}

/** Overview numbers. Months are calendar months in UTC; "paid" is by ledger close time. */
export function createSummaryService(deps: AppDeps) {
  const { prisma } = deps;
  return {
    async get(companyId: string, now = new Date()): Promise<Summary> {
      const thisMonth = monthStart(now);
      const sixAgo = monthStart(now, -5);
      const [paidRows, failedPayments, activeEmployees, employeesWithProblems, drafts, active, recent] = await Promise.all([
        prisma.payrollItem.findMany({
          where: { companyId, status: "SUCCESSFUL", paidAt: { gte: sixAgo } },
          select: { paidAt: true, amountStroops: true, employeeId: true, walletAddress: true },
        }),
        prisma.payrollItem.count({ where: { companyId, status: "FAILED" } }),
        prisma.employee.count({ where: { companyId, deactivatedAt: null } }),
        prisma.employee.count({ where: { companyId, deactivatedAt: null, checkReason: { not: null } } }),
        repo.runsWithTotals(prisma, companyId, { status: "DRAFT" }, 5, [{ payDate: { sort: "asc", nulls: "last" } }, { createdAt: "desc" }]),
        repo.runsWithTotals(prisma, companyId, { status: "PROCESSING" }, 5, [{ startedAt: "desc" }]),
        repo.runsWithTotals(prisma, companyId, { status: { in: ["COMPLETED", "PARTIALLY_PAID", "FAILED"] } }, 6, [{ finishedAt: "desc" }]),
      ]);

      const monthly = Array.from({ length: 6 }, (_, i) => ({ start: monthStart(now, i - 5), paid: 0n }));
      let paidThisMonth = 0n;
      const people = new Set<string>();
      const monthIndex = (d: Date) => d.getUTCFullYear() * 12 + d.getUTCMonth();
      const first = monthIndex(sixAgo);
      for (const row of paidRows) {
        if (!row.paidAt) continue;
        const bucket = monthly[monthIndex(row.paidAt) - first];
        if (bucket) bucket.paid += row.amountStroops;
        if (row.paidAt >= thisMonth) {
          paidThisMonth += row.amountStroops;
          people.add(row.employeeId ?? row.walletAddress);
        }
      }
      return {
        paidThisMonth: formatStroops(paidThisMonth),
        peoplePaidThisMonth: people.size,
        failedPayments,
        activeEmployees,
        employeesWithProblems,
        draftRuns: drafts.map((r) => serializeRunSummary(r, r.items)),
        activeRuns: active.map((r) => serializeRunSummary(r, r.items)),
        recentRuns: recent.map((r) => serializeRunSummary(r, r.items)),
        monthly: monthly.map((m) => ({ month: m.start.toISOString().slice(0, 7), paid: formatStroops(m.paid) })),
      };
    },
  };
}

export type SummaryService = ReturnType<typeof createSummaryService>;
