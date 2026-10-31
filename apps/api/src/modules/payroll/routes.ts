import {
  AddPaymentsBody,
  CreateRunBody,
  IdParamsSchema,
  RetryBody,
  RunListQuery,
  RunPaymentParams,
  RunTransactionParams,
  SubmitTransactionBody,
  UpdatePaymentBody,
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

  router.get("/:id/export.csv", async (req, res) => {
    const { id } = parse(IdParamsSchema, req.params);
    const csv = await service.exportCsv(authOf(req).companyId, id);
    res.type("text/csv").attachment(`orgpay-run-${id}.csv`).send(csv);
  });

  router.post("/:id/payments", async (req, res) => {
    const { id } = parse(IdParamsSchema, req.params);
    const body = parse(AddPaymentsBody, req.body);
    res.json({ run: await service.addItems(authOf(req).companyId, id, body) });
  });

  router.patch("/:id/payments/:paymentId", async (req, res) => {
    const { id, paymentId } = parse(RunPaymentParams, req.params);
    const body = parse(UpdatePaymentBody, req.body);
    res.json({ run: await service.updateItem(authOf(req).companyId, id, paymentId, body.amount) });
  });

  router.delete("/:id/payments/:paymentId", async (req, res) => {
    const { id, paymentId } = parse(RunPaymentParams, req.params);
    res.json({ run: await service.removeItem(authOf(req).companyId, id, paymentId) });
  });

  router.get("/:id/check", async (req, res) => {
    const { id } = parse(IdParamsSchema, req.params);
    res.json({ check: await service.check(authOf(req).companyId, id) });
  });

  router.post("/:id/start", async (req, res) => {
    const { id } = parse(IdParamsSchema, req.params);
    res.json({ run: await service.start(authOf(req).companyId, id, actorOf(req)) });
  });

  router.post("/:id/transactions/next", async (req, res) => {
    const { id } = parse(IdParamsSchema, req.params);
    res.json(await service.nextTransaction(authOf(req).companyId, id, actorOf(req)));
  });

  router.post("/:id/transactions/:txId/submit", async (req, res) => {
    const { id, txId } = parse(RunTransactionParams, req.params);
    const body = parse(SubmitTransactionBody, req.body);
    const { transaction, run, settled } = await service.submit(authOf(req).companyId, id, txId, body.signedXdr, actorOf(req));
    // 202: Stellar has not given a final answer yet; the worker will settle it.
    res.status(settled ? 200 : 202).json({ transaction, run });
  });

  router.post("/:id/retry", async (req, res) => {
    const { id } = parse(IdParamsSchema, req.params);
    const body = parse(RetryBody, req.body ?? {});
    res.json({ run: await service.retry(authOf(req).companyId, id, body.paymentIds, actorOf(req)) });
  });

  router.post("/:id/cancel", async (req, res) => {
    const { id } = parse(IdParamsSchema, req.params);
    res.json({ run: await service.cancel(authOf(req).companyId, id, actorOf(req)) });
  });

  return router;
}

/** A single payment, wherever it is: GET /v1/payments/:id and /v1/payments/:id/verify. */
export function paymentRoutes(service: PayrollService): Router {
  const router = Router();

  router.get("/:id", async (req, res) => {
    const { id } = parse(IdParamsSchema, req.params);
    res.json({ payment: await service.getPayment(authOf(req).companyId, id) });
  });

  router.get("/:id/verify", async (req, res) => {
    const { id } = parse(IdParamsSchema, req.params);
    res.json({ verification: await service.verify(authOf(req).companyId, id) });
  });

  return router;
}
