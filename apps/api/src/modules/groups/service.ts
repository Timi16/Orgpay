import type { Group as GroupDto } from "@orgpay/shared";
import type { Group } from "@prisma/client";
import { uniqueViolation } from "../../db/prisma";
import type { AppDeps } from "../../deps";
import { AppError, notFound } from "../../lib/errors";

export function serializeGroup(g: Group, employeeCount: number): GroupDto {
  return { id: g.id, name: g.name, employeeCount, createdAt: g.createdAt.toISOString() };
}

const taken = () =>
  new AppError("NAME_TAKEN", "There is already a group with this name", { details: [{ path: "name", message: "Name already used" }] });

export function createGroupService(deps: AppDeps) {
  const { prisma } = deps;

  async function withCount(companyId: string, group: Group): Promise<GroupDto> {
    const count = await prisma.employee.count({ where: { companyId, groupId: group.id, deactivatedAt: null } });
    return serializeGroup(group, count);
  }

  return {
    async list(companyId: string): Promise<GroupDto[]> {
      const [groups, counts] = await Promise.all([
        prisma.group.findMany({ where: { companyId }, orderBy: { name: "asc" } }),
        prisma.employee.groupBy({ by: ["groupId"], where: { companyId, deactivatedAt: null }, _count: { _all: true } }),
      ]);
      const byGroup = new Map(counts.map((c) => [c.groupId, c._count._all]));
      return groups.map((g) => serializeGroup(g, byGroup.get(g.id) ?? 0));
    },

    async create(companyId: string, name: string): Promise<GroupDto> {
      try {
        return await withCount(companyId, await prisma.group.create({ data: { companyId, name } }));
      } catch (err) {
        if (uniqueViolation(err)) throw taken();
        throw err;
      }
    },

    async rename(companyId: string, id: string, name: string): Promise<GroupDto> {
      try {
        const updated = await prisma.group.updateMany({ where: { id, companyId }, data: { name } });
        if (updated.count === 0) throw notFound("Group");
      } catch (err) {
        if (uniqueViolation(err)) throw taken();
        throw err;
      }
      return withCount(companyId, await prisma.group.findUniqueOrThrow({ where: { id } }));
    },

    /** Members are kept and become ungrouped (E5). */
    async remove(companyId: string, id: string): Promise<void> {
      const deleted = await prisma.group.deleteMany({ where: { id, companyId } });
      if (deleted.count === 0) throw notFound("Group");
    },
  };
}

export type GroupService = ReturnType<typeof createGroupService>;
