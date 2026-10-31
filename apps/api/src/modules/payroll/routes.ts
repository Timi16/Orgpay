import {
  AddItemsBody,
  CreateRunBody,
  IdParamsSchema,
  RetryBody,
  RunBatchParams,
  RunItemParams,
  RunListQuery,
  SubmitBatchBody,
  UpdateItemBody,
  UpdateRunBody,
} from "@orgpay/shared";
import { Router, type Request } from "express";
import { authOf } from "../../middleware/auth";
import { parse } from "../../middleware/validate";
import type { PayrollService } from "./service";
import type { Actor } from "./transitions";

const actorOf = (req: Request): Actor => (authOf(req).via === "apiKey" ? "api" : "company");

export function payrollRoutes(service: PayrollService): Router {
  const router = Router();

  router.get("/", async (req, res) => {
    const q = parse(RunListQuery, req.query);
    res.json(await service.list(authOf(req).companyId, q));
  });

  router.post("/", async (req, res) => {
    const body = parse(CreateRunBody, req.body);
    const run = await service.create(authOf(req).companyId, body, authOf(req).via === "apiKey" ? "api" : "dashboard");
    res.status(201).json({ run });
  });

  router.get("/:id", async (req, res) => {
    const { id } = parse(IdParamsSchema, req.params);
    res.json({ run: await service.getRun(authOf(req).companyId, id) });
  });

  router.patch("/:id", async (req, res) => {
    const { id } = parse(IdParamsSchema, req.params);
    const body = parse(UpdateRunBody, req.body);
    res.json({ run: await service.update(authOf(req).companyId, id, body) });
  });

  router.delete("/:id", async (req, res) => {
    const { id } = parse(IdParamsSchema, req.params);
    await service.remove(authOf(req).companyId, id);
    res.status(204).end();
  });

  router.post("/:id/items", async (req, res) => {
    const { id } = parse(IdParamsSchema, req.params);
    const body = parse(AddItemsBody, req.body);
    res.json({ run: await service.addItems(authOf(req).companyId, id, body) });
  });

  router.patch("/:id/items/:itemId", async (req, res) => {
    const { id, itemId } = parse(RunItemParams, req.params);
    const body = parse(UpdateItemBody, req.body);
    res.json({ run: await service.updateItem(authOf(req).companyId, id, itemId, body.amount) });
  });

  router.delete("/:id/items/:itemId", async (req, res) => {
    const { id, itemId } = parse(RunItemParams, req.params);
    res.json({ run: await service.removeItem(authOf(req).companyId, id, itemId) });
  });

  router.get("/:id/check", async (req, res) => {
    const { id } = parse(IdParamsSchema, req.params);
    res.json({ check: await service.check(authOf(req).companyId, id) });
  });

  router.post("/:id/start", async (req, res) => {
    const { id } = parse(IdParamsSchema, req.params);
    res.json({ run: await service.start(authOf(req).companyId, id, actorOf(req)) });
  });

  router.post("/:id/batches/next", async (req, res) => {
    const { id } = parse(IdParamsSchema, req.params);
    res.json(await service.nextBatch(authOf(req).companyId, id, actorOf(req)));
  });

  router.post("/:id/batches/:batchId/submit", async (req, res) => {
    const { id, batchId } = parse(RunBatchParams, req.params);
    const body = parse(SubmitBatchBody, req.body);
    const { batch, run, settled } = await service.submit(authOf(req).companyId, id, batchId, body.signedXdr, actorOf(req));
    // 202: Stellar has not given a final answer yet; the worker will settle it.
    res.status(settled ? 200 : 202).json({ batch, run });
  });

  router.post("/:id/retry", async (req, res) => {
    const { id } = parse(IdParamsSchema, req.params);
    const body = parse(RetryBody, req.body ?? {});
    res.json({ run: await service.retry(authOf(req).companyId, id, body.itemIds, actorOf(req)) });
  });

  router.post("/:id/cancel", async (req, res) => {
    const { id } = parse(IdParamsSchema, req.params);
    res.json({ run: await service.cancel(authOf(req).companyId, id, actorOf(req)) });
  });

  return router;
}
