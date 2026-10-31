import { Router } from "express";
import type { Health } from "@orgpay/shared";
import type { AppDeps } from "../../deps";

/** DB status and the number of Stellar transactions still open. 503 when the DB is down. */
export function healthRoutes(deps: AppDeps): Router {
  const router = Router();
  router.get("/", async (_req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      const openTransactions = await deps.prisma.payrollBatch.count({ where: { status: { in: ["AWAITING_SIGNATURE", "SUBMITTED"] } } });
      const body: Health = { status: "ok", db: "up", network: "testnet", openTransactions };
      res.json(body);
    } catch (err) {
      deps.logger.error({ err }, "health check failed");
      const body: Health = { status: "degraded", db: "down", network: "testnet", openTransactions: null };
      res.status(503).json(body);
    }
  });
  return router;
}
