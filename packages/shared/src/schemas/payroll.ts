import { z } from "zod";
import { AmountSchema, IdSchema, PaginationQuery, RECEIVE_PROBLEMS, SafeText } from "./common";

export const RUN_STATUSES = ["DRAFT", "PAYING", "PAID", "PARTIAL", "FAILED", "CANCELLED"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];
export const ITEM_STATUSES = ["PENDING", "SENDING", "PAID", "FAILED", "CANCELLED"] as const;
export type ItemStatus = (typeof ITEM_STATUSES)[number];
export const BATCH_STATUSES = ["AWAITING_SIGNATURE", "SUBMITTED", "CONFIRMED", "FAILED", "EXPIRED"] as const;
export type BatchStatus = (typeof BATCH_STATUSES)[number];
/** Why a line was not paid. PAYMENT_FAILED = any other recipient-side failure (failureDetail has the raw code). */
export const FAILURE_CODES = [...RECEIVE_PROBLEMS, "PAYMENT_FAILED"] as const;
export type FailureCode = (typeof FAILURE_CODES)[number];

/** Most payments in one Stellar transaction. */
export const MAX_BATCH_OPS = 100;

const RunName = SafeText(1, 100, "Give the run a name");
const PayDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");

export const CreateRunBody = z
  .object({
    name: RunName,
    walletId: IdSchema,
    payDate: PayDate.nullable().optional(),
    groupIds: z.array(IdSchema).max(50).optional(),
    employeeIds: z.array(IdSchema).max(1000).optional(),
  })
  .strict();
export type CreateRunBody = z.infer<typeof CreateRunBody>;

export const UpdateRunBody = z
  .object({ name: RunName, payDate: PayDate.nullable(), walletId: IdSchema })
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, "Send at least one field to change");
export type UpdateRunBody = z.infer<typeof UpdateRunBody>;

export const AddItemsBody = z
  .object({
    groupIds: z.array(IdSchema).max(50).optional(),
    employeeIds: z.array(IdSchema).max(1000).optional(),
  })
  .strict()
  .refine((v) => (v.groupIds?.length ?? 0) + (v.employeeIds?.length ?? 0) > 0, "Pick at least one person or group");
export type AddItemsBody = z.infer<typeof AddItemsBody>;

export const UpdateItemBody = z.object({ amount: AmountSchema }).strict();
export type UpdateItemBody = z.infer<typeof UpdateItemBody>;

export const SubmitBatchBody = z.object({ signedXdr: z.string().trim().min(1).max(200_000) }).strict();
export type SubmitBatchBody = z.infer<typeof SubmitBatchBody>;

export const RetryBody = z.object({ itemIds: z.array(IdSchema).min(1).max(1000).optional() }).strict();
export type RetryBody = z.infer<typeof RetryBody>;

export const RunListQuery = z.object({ status: z.enum(RUN_STATUSES).optional(), ...PaginationQuery }).strict();
export type RunListQuery = z.infer<typeof RunListQuery>;

export const RunItemParams = z.object({ id: IdSchema, itemId: IdSchema }).strict();
export const RunBatchParams = z.object({ id: IdSchema, batchId: IdSchema }).strict();

const Counts = z.object({
  lines: z.number().int(),
  pending: z.number().int(),
  sending: z.number().int(),
  paid: z.number().int(),
  failed: z.number().int(),
  cancelled: z.number().int(),
});

export const RunSummarySchema = z.object({
  id: z.string(),
  number: z.number().int(),
  name: z.string(),
  payDate: z.string().nullable(),
  status: z.enum(RUN_STATUSES),
  wallet: z.object({ id: z.string(), address: z.string(), label: z.string().nullable() }),
  asset: z.object({ code: z.string(), issuer: z.string() }),
  /** Sum of every line that is not cancelled. */
  total: z.string(),
  totalStroops: z.string(),
  paid: z.string(),
  paidStroops: z.string(),
  failedTotal: z.string(),
  counts: Counts,
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type RunSummary = z.infer<typeof RunSummarySchema>;

export const RunItemSchema = z.object({
  id: z.string(),
  position: z.number().int(),
  employeeId: z.string().nullable(),
  name: z.string(),
  walletAddress: z.string(),
  amount: z.string(),
  amountStroops: z.string(),
  status: z.enum(ITEM_STATUSES),
  failureCode: z.enum(FAILURE_CODES).nullable(),
  failureDetail: z.string().nullable(),
  txHash: z.string().nullable(),
  ledger: z.number().int().nullable(),
  paidAt: z.string().nullable(),
  batchNumber: z.number().int().nullable(),
  attempts: z.number().int(),
});
export type RunItem = z.infer<typeof RunItemSchema>;

export const BatchSchema = z.object({
  id: z.string(),
  number: z.number().int(),
  status: z.enum(BATCH_STATUSES),
  txHash: z.string(),
  opCount: z.number().int(),
  total: z.string(),
  maxTime: z.string(),
  ledger: z.number().int().nullable(),
  closedAt: z.string().nullable(),
  resultCode: z.string().nullable(),
  submittedAt: z.string().nullable(),
  settledAt: z.string().nullable(),
  createdAt: z.string(),
});
export type Batch = z.infer<typeof BatchSchema>;

export const RunEventSchema = z.object({
  id: z.string(),
  type: z.string(),
  message: z.string(),
  actor: z.string(),
  itemId: z.string().nullable(),
  batchId: z.string().nullable(),
  createdAt: z.string(),
});
export type RunEvent = z.infer<typeof RunEventSchema>;

export const RunSchema = RunSummarySchema.extend({
  items: z.array(RunItemSchema),
  batches: z.array(BatchSchema),
  events: z.array(RunEventSchema),
});
export type Run = z.infer<typeof RunSchema>;
export const RunResponse = z.object({ run: RunSchema });
export const RunListResponse = z.object({ data: z.array(RunSummarySchema), nextCursor: z.string().nullable() });

/** The batch to sign: the unsigned transaction envelope (base64 XDR). */
export const SignableBatchSchema = BatchSchema.extend({ xdr: z.string(), networkPassphrase: z.string() });
export type SignableBatch = z.infer<typeof SignableBatchSchema>;
export const NextBatchResponse = z.object({ batch: SignableBatchSchema.nullable(), run: RunSchema });
export const SubmitBatchResponse = z.object({ batch: BatchSchema, run: RunSchema });

export const FUNDING_PROBLEMS = ["ACCOUNT_NOT_FOUND", "NO_TRUSTLINE", "INSUFFICIENT_USDC", "INSUFFICIENT_XLM"] as const;
export type FundingProblem = (typeof FUNDING_PROBLEMS)[number];

export const RunCheckSchema = z.object({
  lines: z.array(z.object({ itemId: z.string(), ok: z.boolean(), reason: z.enum(RECEIVE_PROBLEMS).nullable() })),
  /** Lines that would be paid if the run started now. */
  payableCount: z.number().int(),
  payableTotal: z.string(),
  excludedCount: z.number().int(),
  funding: z.object({
    address: z.string(),
    usdcAvailable: z.string().nullable(),
    xlmAvailable: z.string().nullable(),
    /** XLM needed for network fees across every batch. */
    feeXlm: z.string(),
    enough: z.boolean(),
    problem: z.enum(FUNDING_PROBLEMS).nullable(),
    /** USDC still missing when problem is INSUFFICIENT_USDC. */
    shortBy: z.string().nullable(),
  }),
  checkedAt: z.string(),
});
export type RunCheck = z.infer<typeof RunCheckSchema>;
export const RunCheckResponse = z.object({ check: RunCheckSchema });

// ---------- overview ----------

export const SummarySchema = z.object({
  paidThisMonth: z.string(),
  peoplePaidThisMonth: z.number().int(),
  failedLines: z.number().int(),
  activeEmployees: z.number().int(),
  employeesWithProblems: z.number().int(),
  draftRuns: z.array(RunSummarySchema),
  activeRuns: z.array(RunSummarySchema),
  recentRuns: z.array(RunSummarySchema),
  /** Paid per calendar month (UTC), oldest first, last 6 months including this one. */
  monthly: z.array(z.object({ month: z.string(), paid: z.string() })),
});
export type Summary = z.infer<typeof SummarySchema>;

export const HealthSchema = z.object({
  status: z.enum(["ok", "degraded"]),
  db: z.enum(["up", "down"]),
  network: z.literal("testnet"),
  openBatches: z.number().int().nullable(),
});
export type Health = z.infer<typeof HealthSchema>;
