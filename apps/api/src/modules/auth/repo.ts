import type { Company } from "@prisma/client";
import type { Db } from "../../db/prisma";

export function findCompanyByEmail(db: Db, email: string): Promise<Company | null> {
  return db.company.findUnique({ where: { email } });
}

export function findCompany(db: Db, companyId: string): Promise<Company | null> {
  return db.company.findUnique({ where: { id: companyId } });
}

export function createCompany(
  db: Db,
  data: { email: string; passwordHash: string; businessName: string },
): Promise<Company> {
  return db.company.create({ data });
}

export async function createSession(
  db: Db,
  companyId: string,
  data: { id: string; expiresAt: Date; ip: string | null; userAgent: string | null },
): Promise<void> {
  await db.session.create({ data: { companyId, ...data } });
}

export async function deleteSession(db: Db, sessionId: string): Promise<void> {
  await db.session.deleteMany({ where: { id: sessionId } });
}

export async function deleteOtherSessions(db: Db, companyId: string, keepId: string): Promise<void> {
  await db.session.deleteMany({ where: { companyId, id: { not: keepId } } });
}

export async function deleteExpiredSessions(db: Db, companyId: string): Promise<void> {
  await db.session.deleteMany({ where: { companyId, expiresAt: { lt: new Date() } } });
}
