import type {
  CreateEmployeeBody,
  Employee as EmployeeDto,
  EmployeeListQuery,
  ImportEmployeesBody,
  ReceiveProblem,
  UpdateEmployeeBody,
} from "@orgpay/shared";
import { RECEIVE_PROBLEMS } from "@orgpay/shared";
import type { Employee, Group, Prisma } from "@prisma/client";
import type { Db } from "../../db/prisma";
import type { AppDeps } from "../../deps";
import { formatStroops, parseAmount } from "../../lib/amount";
import { usdc } from "../../lib/asset";
import { AppError, notFound } from "../../lib/errors";
import { receiveProblem } from "../../stellar/checks";
import { loadAccounts } from "../../stellar/gateway";
import { assertWalletAddress } from "../wallets/service";

type EmployeeRow = Employee & { group: Pick<Group, "id" | "name"> | null };

const include = { group: { select: { id: true, name: true } } } as const;

function asProblem(v: string | null): ReceiveProblem | null {
  return v !== null && (RECEIVE_PROBLEMS as readonly string[]).includes(v) ? (v as ReceiveProblem) : null;
}

export function serializeEmployee(e: EmployeeRow): EmployeeDto {
  const reason = asProblem(e.checkReason);
  return {
    id: e.id,
    name: e.name,
    email: e.email,
    role: e.role,
    walletAddress: e.walletAddress,
    defaultAmount: formatStroops(e.defaultAmountStroops),
    defaultAmountStroops: e.defaultAmountStroops.toString(),
    group: e.group,
    archived: e.archivedAt !== null,
    check: { status: e.checkedAt === null ? "unchecked" : reason ? "problem" : "ready", reason, checkedAt: e.checkedAt?.toISOString() ?? null },
    createdAt: e.createdAt.toISOString(),
    updatedAt: e.updatedAt.toISOString(),
  };
}

/** Opaque cursor for the name-ordered list: base64url of [name, id]. */
function encodeNameCursor(name: string, id: string): string {
  return Buffer.from(JSON.stringify([name, id])).toString("base64url");
}
function decodeNameCursor(cursor: string): { name: string; id: string } {
  try {
    const v: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (Array.isArray(v) && typeof v[0] === "string" && typeof v[1] === "string") return { name: v[0], id: v[1] };
  } catch {
    // fall through
  }
  throw new AppError("VALIDATION_FAILED", "Invalid cursor", { details: [{ path: "cursor", message: "Invalid cursor" }] });
}

const walletInUse = (path = "walletAddress") =>
  new AppError("WALLET_IN_USE", "Another person on your team already uses this wallet", {
    details: [{ path, message: "Wallet already used by someone else" }],
  });

function amountOf(value: string): bigint {
  const s = parseAmount(value);
  if (s === null || s <= 0n) throw new AppError("VALIDATION_FAILED", "Amount must be greater than 0");
  return s;
}

export function createEmployeeService(deps: AppDeps) {
  const { prisma, stellar } = deps;

  async function getOwned(companyId: string, id: string): Promise<EmployeeRow> {
    const e = await prisma.employee.findFirst({ where: { id, companyId }, include });
    if (!e) throw notFound("Person");
    return e;
  }

  async function assertGroup(db: Db, companyId: string, groupId: string | null | undefined): Promise<void> {
    if (!groupId) return;
    if (!(await db.group.findFirst({ where: { id: groupId, companyId }, select: { id: true } }))) throw notFound("Group");
  }

  /** One active employee per wallet per company (E2). Run under the company's advisory lock. */
  async function assertWalletFree(db: Db, companyId: string, walletAddress: string, exceptId?: string): Promise<void> {
    const other = await db.employee.findFirst({
      where: { companyId, walletAddress, archivedAt: null, ...(exceptId ? { id: { not: exceptId } } : {}) },
      select: { id: true },
    });
    if (other) throw walletInUse();
  }

  async function lockCompanyPeople(db: Db, companyId: string): Promise<void> {
    await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`people:${companyId}`}))`;
  }

  /** Fresh Horizon checks for these employees; results stored on each. */
  async function runChecks(companyId: string, rows: Employee[]): Promise<void> {
    const accounts = await loadAccounts(stellar, rows.map((r) => r.walletAddress));
    const asset = usdc();
    const checkedAt = new Date();
    for (const r of rows) {
      const account = accounts.get(r.walletAddress) ?? { exists: false as const };
      const problem = receiveProblem(account, asset, r.defaultAmountStroops);
      await prisma.employee.updateMany({ where: { id: r.id, companyId }, data: { checkReason: problem, checkedAt } });
    }
  }

  return {
    getOwned,

    async list(companyId: string, q: EmployeeListQuery) {
      const where: Prisma.EmployeeWhereInput = { companyId, archivedAt: q.status === "archived" ? { not: null } : null };
      if (q.groupId === "none") where.groupId = null;
      else if (q.groupId) where.groupId = q.groupId;
      if (q.q) {
        where.OR = [
          { name: { contains: q.q, mode: "insensitive" } },
          { email: { contains: q.q, mode: "insensitive" } },
          { role: { contains: q.q, mode: "insensitive" } },
          { walletAddress: { startsWith: q.q.toUpperCase() } },
        ];
      }
      const page: Prisma.EmployeeWhereInput = { ...where };
      if (q.cursor) {
        const c = decodeNameCursor(q.cursor);
        page.AND = [{ OR: [{ name: { gt: c.name } }, { name: c.name, id: { gt: c.id } }] }];
      }
      const [rows, total] = await Promise.all([
        prisma.employee.findMany({ where: page, include, orderBy: [{ name: "asc" }, { id: "asc" }], take: q.limit + 1 }),
        prisma.employee.count({ where }),
      ]);
      const data = rows.slice(0, q.limit);
      const last = data[data.length - 1];
      return {
        data: data.map(serializeEmployee),
        nextCursor: rows.length > q.limit && last ? encodeNameCursor(last.name, last.id) : null,
        total,
      };
    },

    async create(companyId: string, input: CreateEmployeeBody): Promise<EmployeeRow> {
      assertWalletAddress(input.walletAddress);
      const amount = amountOf(input.defaultAmount);
      const created = await prisma.$transaction(async (tx) => {
        await lockCompanyPeople(tx, companyId);
        await assertGroup(tx, companyId, input.groupId);
        await assertWalletFree(tx, companyId, input.walletAddress);
        return tx.employee.create({
          data: {
            companyId,
            name: input.name,
            email: input.email ?? null,
            role: input.role ?? null,
            walletAddress: input.walletAddress,
            defaultAmountStroops: amount,
            groupId: input.groupId ?? null,
          },
        });
      });
      // Best effort: the person is added even when Stellar can't be reached right now.
      await runChecks(companyId, [created]).catch(() => undefined);
      return getOwned(companyId, created.id);
    },

    async update(companyId: string, id: string, input: UpdateEmployeeBody): Promise<EmployeeRow> {
      if (input.walletAddress !== undefined) assertWalletAddress(input.walletAddress);
      const amount = input.defaultAmount !== undefined ? amountOf(input.defaultAmount) : undefined;
      const outside = await getOwned(companyId, id);
      const walletChanged = input.walletAddress !== undefined && input.walletAddress !== outside.walletAddress;
      await prisma.$transaction(async (tx) => {
        await lockCompanyPeople(tx, companyId);
        // Re-read under the lock: a restore or another edit may have changed it meanwhile.
        const before = await tx.employee.findFirst({ where: { id, companyId } });
        if (!before) throw notFound("Person");
        await assertGroup(tx, companyId, input.groupId);
        if (input.walletAddress && input.walletAddress !== before.walletAddress && before.archivedAt === null) {
          await assertWalletFree(tx, companyId, input.walletAddress, id);
        }
        await tx.employee.updateMany({
          where: { id, companyId },
          data: {
            name: input.name,
            email: input.email,
            role: input.role,
            walletAddress: input.walletAddress,
            defaultAmountStroops: amount,
            groupId: input.groupId,
            // A new wallet (or amount, which changes trustline headroom) needs a new check.
            ...(walletChanged || amount !== undefined ? { checkReason: null, checkedAt: null } : {}),
          },
        });
      });
      const after = await getOwned(companyId, id);
      if (walletChanged || amount !== undefined) await runChecks(companyId, [after]).catch(() => undefined);
      return getOwned(companyId, id);
    },

    /** Archived people are left out of new runs and keep their history on old ones (E4). */
    async archive(companyId: string, id: string): Promise<EmployeeRow> {
      await getOwned(companyId, id);
      await prisma.employee.updateMany({ where: { id, companyId, archivedAt: null }, data: { archivedAt: new Date() } });
      return getOwned(companyId, id);
    },

    async restore(companyId: string, id: string): Promise<EmployeeRow> {
      await getOwned(companyId, id);
      await prisma.$transaction(async (tx) => {
        await lockCompanyPeople(tx, companyId);
        const e = await tx.employee.findFirst({ where: { id, companyId } });
        if (!e) throw notFound("Person");
        await assertWalletFree(tx, companyId, e.walletAddress, id);
        await tx.employee.updateMany({ where: { id, companyId }, data: { archivedAt: null } });
      });
      return getOwned(companyId, id);
    },

    /** Re-checks the given people (or the 200 checked longest ago) against Stellar, fresh. */
    async check(companyId: string, ids?: string[]): Promise<EmployeeRow[]> {
      const rows = await prisma.employee.findMany({
        where: { companyId, archivedAt: null, ...(ids ? { id: { in: ids } } : {}) },
        orderBy: [{ checkedAt: { sort: "asc", nulls: "first" } }, { id: "asc" }],
        take: 200,
      });
      await runChecks(companyId, rows);
      return prisma.employee.findMany({ where: { companyId, id: { in: rows.map((r) => r.id) } }, include, orderBy: { name: "asc" } });
    },

    /** All or nothing: one bad row and nobody is added. Groups are matched by name, or created. */
    async import(companyId: string, input: ImportEmployeesBody): Promise<number> {
      const errors: { path: string; message: string }[] = [];
      const seen = new Map<string, number>();
      input.employees.forEach((row, i) => {
        try {
          assertWalletAddress(row.walletAddress);
        } catch (err) {
          errors.push({ path: `employees.${i}.walletAddress`, message: err instanceof AppError ? err.message : "Invalid address" });
        }
        const first = seen.get(row.walletAddress);
        if (first !== undefined) errors.push({ path: `employees.${i}.walletAddress`, message: `Same wallet as row ${first + 1}` });
        else seen.set(row.walletAddress, i);
      });
      if (errors.length > 0) {
        throw new AppError("VALIDATION_FAILED", `${errors.length} row(s) need fixing; nobody was added`, { details: errors });
      }
      return prisma.$transaction(
        async (tx) => {
          await lockCompanyPeople(tx, companyId);
          const taken = await tx.employee.findMany({
            where: { companyId, archivedAt: null, walletAddress: { in: input.employees.map((e) => e.walletAddress) } },
            select: { walletAddress: true },
          });
          const takenSet = new Set(taken.map((t) => t.walletAddress));
          const clashes = input.employees.flatMap((e, i) =>
            takenSet.has(e.walletAddress) ? [{ path: `employees.${i}.walletAddress`, message: "Already used by someone on your team" }] : [],
          );
          if (clashes.length > 0) {
            throw new AppError("WALLET_IN_USE", `${clashes.length} wallet(s) are already used on your team; nobody was added`, { details: clashes });
          }
          const groupIds = new Map<string, string>();
          for (const name of new Set(input.employees.map((e) => e.group).filter((g): g is string => Boolean(g)))) {
            const g = await tx.group.upsert({ where: { companyId_name: { companyId, name } }, update: {}, create: { companyId, name } });
            groupIds.set(name, g.id);
          }
          const created = await tx.employee.createMany({
            data: input.employees.map((e) => ({
              companyId,
              name: e.name,
              email: e.email ?? null,
              role: e.role ?? null,
              walletAddress: e.walletAddress,
              defaultAmountStroops: amountOf(e.defaultAmount),
              groupId: e.group ? (groupIds.get(e.group) ?? null) : null,
            })),
          });
          return created.count;
        },
        { timeout: 30_000 },
      );
    },
  };
}

export type EmployeeService = ReturnType<typeof createEmployeeService>;
