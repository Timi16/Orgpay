import type { ApiKey } from "@prisma/client";
import type { Db } from "../../db/prisma";

export function listApiKeys(db: Db, companyId: string): Promise<ApiKey[]> {
  return db.apiKey.findMany({ where: { companyId }, orderBy: { createdAt: "desc" } });
}

export function countActiveApiKeys(db: Db, companyId: string): Promise<number> {
  return db.apiKey.count({ where: { companyId, revokedAt: null } });
}

export function createApiKey(
  db: Db,
  companyId: string,
  data: { name: string; prefix: string; keyHash: string },
): Promise<ApiKey> {
  return db.apiKey.create({ data: { companyId, ...data } });
}

/** Returns false when the key does not exist for this company. Revoking twice is a no-op. */
export async function revokeApiKey(db: Db, companyId: string, id: string): Promise<boolean> {
  const key = await db.apiKey.findFirst({ where: { id, companyId } });
  if (!key) return false;
  if (!key.revokedAt) {
    await db.apiKey.updateMany({ where: { id, companyId }, data: { revokedAt: new Date() } });
  }
  return true;
}
