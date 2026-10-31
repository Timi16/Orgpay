import { z } from "zod";
import { AmountSchema, IdSchema, PaginationQuery, RECEIVE_PROBLEMS, SafeText } from "./common";

const Name = SafeText(1, 100, "Enter a name");
const Email = z.string().trim().toLowerCase().email("Enter a valid email").max(254);
const Role = SafeText(1, 64);
const WalletAddress = z.string().trim().min(1, "Enter a Stellar address").max(100);

// ---------- groups ----------

export const GroupNameBody = z.object({ name: SafeText(1, 50, "Enter a name") }).strict();
export type GroupNameBody = z.infer<typeof GroupNameBody>;

export const GroupSchema = z.object({
  id: z.string(),
  name: z.string(),
  employeeCount: z.number().int(),
  createdAt: z.string(),
});
export type Group = z.infer<typeof GroupSchema>;
export const GroupResponse = z.object({ group: GroupSchema });
export const GroupListResponse = z.object({ data: z.array(GroupSchema) });

// ---------- employees ----------

export const CreateEmployeeBody = z
  .object({
    name: Name,
    email: Email.nullable().optional(),
    role: Role.nullable().optional(),
    walletAddress: WalletAddress,
    defaultAmount: AmountSchema,
    groupId: IdSchema.nullable().optional(),
  })
  .strict();
export type CreateEmployeeBody = z.infer<typeof CreateEmployeeBody>;

export const UpdateEmployeeBody = z
  .object({
    name: Name,
    email: Email.nullable(),
    role: Role.nullable(),
    walletAddress: WalletAddress,
    defaultAmount: AmountSchema,
    groupId: IdSchema.nullable(),
  })
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, "Send at least one field to change");
export type UpdateEmployeeBody = z.infer<typeof UpdateEmployeeBody>;

/** Bulk import (e.g. from a CSV). Groups are named; missing ones are created. All or nothing. */
export const ImportEmployeesBody = z
  .object({
    employees: z
      .array(
        z
          .object({
            name: Name,
            email: Email.nullable().optional(),
            role: Role.nullable().optional(),
            walletAddress: WalletAddress,
            defaultAmount: AmountSchema,
            group: SafeText(1, 50).nullable().optional(),
          })
          .strict(),
      )
      .min(1, "Add at least one person")
      .max(500, "Import at most 500 people at a time"),
  })
  .strict();
export type ImportEmployeesBody = z.infer<typeof ImportEmployeesBody>;

export const CheckEmployeesBody = z.object({ ids: z.array(IdSchema).min(1).max(200).optional() }).strict();

export const EmployeeListQuery = z
  .object({
    q: z.string().trim().max(100).optional(),
    /** A group id, or "none" for people in no group. */
    groupId: z.union([IdSchema, z.literal("none")]).optional(),
    status: z.enum(["active", "archived"]).default("active"),
    // Larger pages than other lists: the run builder shows everyone at once.
    limit: z.coerce.number().int().min(1).max(500).default(100),
    cursor: PaginationQuery.cursor,
  })
  .strict();
export type EmployeeListQuery = z.infer<typeof EmployeeListQuery>;

export const RecipientCheckSchema = z.object({
  /** ready = can receive USDC; problem = see reason; unchecked = not checked yet (or Stellar was unreachable). */
  status: z.enum(["ready", "problem", "unchecked"]),
  reason: z.enum(RECEIVE_PROBLEMS).nullable(),
  checkedAt: z.string().nullable(),
});
export type RecipientCheck = z.infer<typeof RecipientCheckSchema>;

export const EmployeeSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string().nullable(),
  role: z.string().nullable(),
  walletAddress: z.string(),
  defaultAmount: z.string(),
  defaultAmountStroops: z.string(),
  group: z.object({ id: z.string(), name: z.string() }).nullable(),
  archived: z.boolean(),
  check: RecipientCheckSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Employee = z.infer<typeof EmployeeSchema>;
export const EmployeeResponse = z.object({ employee: EmployeeSchema });
export const EmployeeListResponse = z.object({
  data: z.array(EmployeeSchema),
  nextCursor: z.string().nullable(),
  /** Matching people across all pages. */
  total: z.number().int(),
});
export const ImportEmployeesResponse = z.object({ created: z.number().int() });
