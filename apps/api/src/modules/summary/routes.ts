import { Router } from "express";
import { authOf } from "../../middleware/auth";
import type { SummaryService } from "./service";

export function summaryRoutes(service: SummaryService): Router {
  const router = Router();
  router.get("/", async (req, res) => {
    res.json(await service.get(authOf(req).companyId));
  });
  return router;
}
