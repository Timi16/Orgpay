import {
  CheckEmployeesBody,
  CreateEmployeeBody,
  EmployeeListQuery,
  IdParamsSchema,
  ImportEmployeesBody,
  UpdateEmployeeBody,
} from "@orgpay/shared";
import { Router } from "express";
import { authOf } from "../../middleware/auth";
import { parse } from "../../middleware/validate";
import { serializeEmployee, type EmployeeService } from "./service";

export function employeeRoutes(service: EmployeeService): Router {
  const router = Router();

  router.get("/", async (req, res) => {
    const q = parse(EmployeeListQuery, req.query);
    res.json(await service.list(authOf(req).companyId, q));
  });

  router.post("/", async (req, res) => {
    const body = parse(CreateEmployeeBody, req.body);
    res.status(201).json({ employee: serializeEmployee(await service.create(authOf(req).companyId, body)) });
  });

  // Parsed with a 200 kb limit (app.ts): a few hundred people is more than the default 50 kb.
  router.post("/import", async (req, res) => {
    const body = parse(ImportEmployeesBody, req.body);
    res.status(201).json({ created: await service.import(authOf(req).companyId, body) });
  });

  router.post("/check", async (req, res) => {
    const body = parse(CheckEmployeesBody, req.body ?? {});
    const rows = await service.check(authOf(req).companyId, body.ids);
    res.json({ data: rows.map(serializeEmployee) });
  });

  router.get("/:id", async (req, res) => {
    const { id } = parse(IdParamsSchema, req.params);
    res.json({ employee: serializeEmployee(await service.getOwned(authOf(req).companyId, id)) });
  });

  router.patch("/:id", async (req, res) => {
    const { id } = parse(IdParamsSchema, req.params);
    const body = parse(UpdateEmployeeBody, req.body);
    res.json({ employee: serializeEmployee(await service.update(authOf(req).companyId, id, body)) });
  });

  router.post("/:id/archive", async (req, res) => {
    const { id } = parse(IdParamsSchema, req.params);
    res.json({ employee: serializeEmployee(await service.archive(authOf(req).companyId, id)) });
  });

  router.post("/:id/restore", async (req, res) => {
    const { id } = parse(IdParamsSchema, req.params);
    res.json({ employee: serializeEmployee(await service.restore(authOf(req).companyId, id)) });
  });

  return router;
}
