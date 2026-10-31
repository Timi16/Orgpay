import { Router } from "express";
import type { Health } from "@orgpay/shared";
import type { AppDeps } from "../../deps";

/** DB status and the number of batches still open. 503 when the DB is down. */
export function healthRoutes(deps: AppDeps): Router {
  const router = Router();
  router.get("/", async (_req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      const openBatches = await deps.prisma.payrollBatch.count({ where: { status: { in: ["AWAITING_SIGNATURE", "SUBMITTED"] } } });
      const body: Health = { status: "ok", db: "up", network: "testnet", openBatches };
      res.json(body);
    } catch (err) {
      deps.logger.error({ err }, "health check failed");
      const body: Health = { status: "degraded", db: "down", network: "testnet", openBatches: null };
      res.status(503).json(body);
    }
  });
  return router;
}
