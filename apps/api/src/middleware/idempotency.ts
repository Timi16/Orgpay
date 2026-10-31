import { createHash } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import type { NextFunction, Request, Response } from "express";
import type { Logger } from "pino";
import { AppError } from "../lib/errors";
import { authOf } from "./auth";

/** How long a key is remembered. Long enough for retries and double clicks; a repeat after this runs as a new request. */
export const IDEMPOTENCY_TTL_MS = 60 * 60_000;
/** A key still IN_PROGRESS after this was abandoned (crash, lost connection): the next request with it runs. */
export const IN_PROGRESS_STALE_MS = 2 * 60_000;
/** Largest response kept for replay. A bigger one is kept as its resource id only. */
export const MAX_STORED_BODY_BYTES = 64 * 1024;
const KEY = /^[A-Za-z0-9_\-:.]{8,255}$/;
/**
 * Routes left out: API-key creation answers with the full key, which must never be stored, and
 * funding wallets are unique per organization already. Paths are relative to /v1.
 */
const SKIPPED = ["/api-keys", "/wallets"];

/** JSON with object keys sorted, so the same body always hashes the same. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

const isUniqueViolation = (err: unknown) => err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";

/** What is kept for replay: the body, or for a very large one just the resource it created. */
function storable(body: unknown): Prisma.InputJsonValue | typeof Prisma.DbNull {
  if (body === undefined) return Prisma.DbNull;
  const text = JSON.stringify(body);
  if (Buffer.byteLength(text) <= MAX_STORED_BODY_BYTES) return JSON.parse(text) as Prisma.InputJsonValue;
  const run = (body as { run?: { id?: unknown } } | null)?.run;
  return typeof run?.id === "string" ? { run: { id: run.id }, truncated: true } : { truncated: true };
}

/**
 * Idempotency-Key on writes. The first request with a key runs; if it succeeds (2xx) its answer is
 * kept, and a repeat of the same request (same key, method, path and body) gets that answer back
 * without running again, so a double click or a retry after a dropped connection can't do the
 * work twice. A failed request (4xx or 5xx) frees its key, so the corrected request can use it. A
 * repeat while the first is still running gets 409 REQUEST_IN_PROGRESS; the same key on a different
 * request gets 422 IDEMPOTENCY_KEY_REUSED. `required` names the writes that must carry a key.
 *
 * Mounted after auth: keys belong to one company.
 */
export function idempotency(prisma: PrismaClient, logger: Logger, required: (req: Request) => boolean) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return next();
    if (SKIPPED.some((p) => req.path === p || req.path.startsWith(`${p}/`))) return next();
    const key = req.get("Idempotency-Key");
    if (key === undefined) {
      if (required(req)) {
        throw new AppError("IDEMPOTENCY_KEY_REQUIRED", "Send an Idempotency-Key header (a new random value per action) with this request");
      }
      return next();
    }
    if (!KEY.test(key)) {
      throw new AppError("VALIDATION_FAILED", "Idempotency-Key must be 8 to 255 letters, digits or - _ : .", {
        details: [{ path: "Idempotency-Key", message: "Invalid format" }],
      });
    }
    const { companyId } = authOf(req);
    const route = `${req.method} ${req.originalUrl.split("?")[0]}`;
    const requestHash = createHash("sha256").update(`${route}\n${canonical(req.body ?? null)}`).digest("hex");
    const now = new Date();

    // Expired keys, and keys abandoned mid-request, free up for this request.
    await prisma.idempotencyKey.deleteMany({
      where: {
        companyId,
        key,
        OR: [{ expiresAt: { lte: now } }, { state: "IN_PROGRESS", createdAt: { lt: new Date(now.getTime() - IN_PROGRESS_STALE_MS) } }],
      },
    });
    try {
      await prisma.idempotencyKey.create({
        data: { companyId, key, route, requestHash, state: "IN_PROGRESS", expiresAt: new Date(now.getTime() + IDEMPOTENCY_TTL_MS) },
      });
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      const existing = await prisma.idempotencyKey.findUnique({ where: { companyId_key: { companyId, key } } });
      if (existing && (existing.route !== route || existing.requestHash !== requestHash)) {
        throw new AppError("IDEMPOTENCY_KEY_REUSED", "This Idempotency-Key was already used for a different request. Use a new key for a new action.");
      }
      if (!existing || existing.state !== "DONE" || existing.responseStatus === null) {
        throw new AppError("REQUEST_IN_PROGRESS", "The first request with this Idempotency-Key is still running. Try again in a moment.", { retryAfter: 1 });
      }
      res.setHeader("Idempotent-Replayed", "true");
      res.status(existing.responseStatus);
      if (existing.responseBody === null) {
        res.end();
      } else {
        res.json(existing.responseBody);
      }
      return;
    }

    // Keep a successful answer before it is sent, so a repeat that arrives after it can only replay it.
    let settled = false;
    const settle = async (status: number, body: unknown) => {
      settled = true;
      if (status < 200 || status >= 300) {
        await prisma.idempotencyKey.deleteMany({ where: { companyId, key, state: "IN_PROGRESS" } });
        return;
      }
      await prisma.idempotencyKey.updateMany({ where: { companyId, key }, data: { state: "DONE", responseStatus: status, responseBody: storable(body) } });
    };
    const json = res.json.bind(res);
    res.json = (body: unknown) => {
      settle(res.statusCode, body)
        .catch((err: unknown) => logger.error({ err }, "could not store the idempotent response"))
        .finally(() => json(body));
      return res;
    };
    // Responses without a JSON body (204). A request whose handler never answers stays IN_PROGRESS
    // and is treated as abandoned after IN_PROGRESS_STALE_MS.
    res.on("finish", () => {
      if (!settled) settle(res.statusCode, undefined).catch((err: unknown) => logger.error({ err }, "could not store the idempotent response"));
    });
    next();
  };
}

export async function pruneIdempotencyKeys(prisma: PrismaClient, now: Date = new Date()): Promise<void> {
  await prisma.idempotencyKey.deleteMany({ where: { expiresAt: { lt: now } } });
}
