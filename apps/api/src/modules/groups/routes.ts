import { GroupNameBody, IdParamsSchema } from "@orgpay/shared";
import { Router } from "express";
import { authOf } from "../../middleware/auth";
import { parse } from "../../middleware/validate";
import type { GroupService } from "./service";

export function groupRoutes(service: GroupService): Router {
  const router = Router();

  router.get("/", async (req, res) => {
    res.json({ data: await service.list(authOf(req).companyId) });
  });

  router.post("/", async (req, res) => {
    const { name } = parse(GroupNameBody, req.body);
    res.status(201).json({ group: await service.create(authOf(req).companyId, name) });
  });

  router.patch("/:id", async (req, res) => {
    const { id } = parse(IdParamsSchema, req.params);
    const { name } = parse(GroupNameBody, req.body);
    res.json({ group: await service.rename(authOf(req).companyId, id, name) });
  });

  router.delete("/:id", async (req, res) => {
    const { id } = parse(IdParamsSchema, req.params);
    await service.remove(authOf(req).companyId, id);
    res.status(204).end();
  });

  return router;
}
