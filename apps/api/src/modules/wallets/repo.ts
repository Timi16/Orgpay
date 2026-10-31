import type { Prisma, Wallet } from "@prisma/client";
import type { Db } from "../../db/prisma";

// Every function takes companyId first and includes it in the where.

export function listWallets(db: Db, companyId: string): Promise<Wallet[]> {
  return db.wallet.findMany({
    where: { companyId, deletedAt: null },
    orderBy: { createdAt: "asc" },
  });
}

export function findWallet(db: Db, companyId: string, id: string): Promise<Wallet | null> {
  return db.wallet.findFirst({ where: { id, companyId, deletedAt: null } });
}

/** This company's rows for an address, removed ones included (newest first). */
export function findCompanyWalletsByAddress(db: Db, companyId: string, address: string): Promise<Wallet[]> {
  return db.wallet.findMany({ where: { companyId, address }, orderBy: { createdAt: "desc" } });
}

export function createWallet(
  db: Db,
  companyId: string,
  data: { address: string; label: string | null },
): Promise<Wallet> {
  return db.wallet.create({ data: { companyId, ...data } });
}

export async function updateWallet(
  db: Db,
  companyId: string,
  id: string,
  data: Prisma.WalletUpdateManyMutationInput,
): Promise<Wallet | null> {
  await db.wallet.updateMany({ where: { id, companyId }, data });
  return db.wallet.findFirst({ where: { id, companyId } });
}

/** Runs still using the wallet: a draft that would pay from it, or a run being paid. */
export function countOpenRuns(db: Db, companyId: string, walletId: string): Promise<number> {
  return db.payrollRun.count({ where: { companyId, walletId, status: { in: ["DRAFT", "PAYING"] } } });
}
