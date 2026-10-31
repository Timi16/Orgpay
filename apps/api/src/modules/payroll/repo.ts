import type { Prisma, RunStatus } from "@prisma/client";
import type { Db } from "../../db/prisma";
import { decodeCursor } from "../../lib/cursor";

// Every function takes companyId first and includes it in the where.

const walletSelect = { select: { id: true, address: true, label: true } } as const;

export function findRunFull(db: Db, companyId: string, id: string) {
  return db.payrollRun.findFirst({
    where: { id, companyId },
    include: {
      wallet: walletSelect,
      items: { orderBy: { position: "asc" } },
      batches: { orderBy: { number: "asc" } },
      events: { orderBy: { createdAt: "asc" } },
    },
  });
}

export function findRun(db: Db, companyId: string, id: string) {
  return db.payrollRun.findFirst({ where: { id, companyId }, include: { wallet: walletSelect } });
}

export async function listRuns(
  db: Db,
  companyId: string,
  q: { status?: RunStatus; cursor?: string; limit: number },
) {
  const where: Prisma.PayrollRunWhereInput = { companyId };
  if (q.status) where.status = q.status;
  if (q.cursor) {
    const c = decodeCursor(q.cursor);
    where.OR = [{ createdAt: { lt: c.createdAt } }, { createdAt: c.createdAt, id: { lt: c.id } }];
  }
  return db.payrollRun.findMany({
    where,
    include: { wallet: walletSelect, items: { select: { status: true, amountStroops: true } } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: q.limit + 1,
  });
}

export function runsWithTotals(db: Db, companyId: string, where: Prisma.PayrollRunWhereInput, take: number, orderBy: Prisma.PayrollRunOrderByWithRelationInput[]) {
  return db.payrollRun.findMany({
    where: { ...where, companyId },
    include: { wallet: walletSelect, items: { select: { status: true, amountStroops: true } } },
    orderBy,
    take,
  });
}

export function findBatch(db: Db, companyId: string, runId: string, id: string) {
  return db.payrollBatch.findFirst({ where: { id, runId, companyId } });
}

export function openBatch(db: Db, companyId: string, runId: string) {
  return db.payrollBatch.findFirst({
    where: { runId, companyId, status: { in: ["AWAITING_SIGNATURE", "SUBMITTED"] } },
    orderBy: { number: "desc" },
  });
}

export function itemsByStatus(db: Db, companyId: string, runId: string, status: Prisma.PayrollItemWhereInput["status"], take?: number) {
  return db.payrollItem.findMany({ where: { runId, companyId, status }, orderBy: { position: "asc" }, take });
}
