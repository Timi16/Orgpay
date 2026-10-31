import type { ApiKey } from "@prisma/client";
import type { ApiKey as ApiKeyDto } from "@orgpay/shared";
import type { AppDeps } from "../../deps";
import { AppError, notFound } from "../../lib/errors";
import { generateApiKey } from "../../lib/ids";
import * as repo from "./repo";

const MAX_ACTIVE_KEYS = 20;

export function serializeApiKey(k: ApiKey): ApiKeyDto {
  return {
    id: k.id,
    name: k.name,
    prefix: k.prefix,
    lastUsedAt: k.lastUsedAt?.toISOString() ?? null,
    revokedAt: k.revokedAt?.toISOString() ?? null,
    createdAt: k.createdAt.toISOString(),
  };
}

export function createApiKeyService(deps: AppDeps) {
  const { prisma } = deps;
  return {
    list: (companyId: string) => repo.listApiKeys(prisma, companyId),

    /** The full key is returned exactly once; only its SHA-256 is stored. */
    async create(companyId: string, name: string): Promise<{ apiKey: ApiKey; key: string }> {
      if ((await repo.countActiveApiKeys(prisma, companyId)) >= MAX_ACTIVE_KEYS) {
        throw new AppError("LIMIT_REACHED", `You can have at most ${MAX_ACTIVE_KEYS} active API keys`);
      }
      const { key, prefix, keyHash } = generateApiKey();
      const apiKey = await repo.createApiKey(prisma, companyId, { name, prefix, keyHash });
      return { apiKey, key };
    },

    async revoke(companyId: string, id: string): Promise<void> {
      if (!(await repo.revokeApiKey(prisma, companyId, id))) throw notFound("API key");
    },
  };
}

export type ApiKeyService = ReturnType<typeof createApiKeyService>;
