import { z } from "zod";
import { AmountSchema, IdSchema, PaginationQuery, RECEIVE_PROBLEMS, SafeText } from "./common";

/** A run's overall status, which follows from its payments. */
export const RUN_STATUSES = ["DRAFT", "PROCESSING", "COMPLETED", "PARTIALLY_PAID", "FAILED", "CANCELLED"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];
/** One employee payment. SUCCESSFUL only ever comes from a verified ledger record. */
export const PAYMENT_STATUSES = ["PENDING", "AWAITING_SIGNATURE", "SUBMITTED", "SUCCESSFUL", "FAILED", "CANCELLED"] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];
/** One Stellar transaction OrgPay built for a run. */
export const TX_STATUSES = ["AWAITING_SIGNATURE", "SUBMITTED", "CONFIRMED", "FAILED", "EXPIRED"] as const;
export type TxStatus = (typeof TX_STATUSES)[number];
/** Why a payment was not made. PAYMENT_FAILED = any other recipient-side failure (failureDetail has the raw code). */
export const FAILURE_CODES = [...RECEIVE_PROBLEMS, "PAYMENT_FAILED"] as const;
export type FailureCode = (typeof FAILURE_CODES)[number];

/** Most payments in one Stellar transaction. */
export const MAX_PAYMENTS_PER_TX = 100;
/** Testnet only, so the explorer is fixed. */
export const EXPLORER_TX_URL = "https://stellar.expert/explorer/testnet/tx/";
export const explorerTxUrl = (hash: string) => `${EXPLORER_TX_URL}${hash}`;

const RunName = SafeText(1, 100, "Give the run a name");
const PayDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");
const PaymentsPerTx = z.number().int().min(1).max(MAX_PAYMENTS_PER_TX);

export const CreateRunBody = z
  .object({
    name: RunName,
    walletId: IdSchema,
    payDate: PayDate.nullable().optional(),
    /** 1 (the default) = every payment is its own transaction, with its own hash. */
    paymentsPerTx: PaymentsPerTx.optional(),
    groupIds: z.array(IdSchema).max(50).optional(),
    employeeIds: z.array(IdSchema).max(1000).optional(),
  })
  .strict();
export type CreateRunBody = z.infer<typeof CreateRunBody>;

export const UpdateRunBody = z
  .object({ name: RunName, payDate: PayDate.nullable(), walletId: IdSchema, paymentsPerTx: PaymentsPerTx })
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, "Send at least one field to change");
export type UpdateRunBody = z.infer<typeof UpdateRunBody>;

export const AddPaymentsBody = z
  .object({
    groupIds: z.array(IdSchema).max(50).optional(),
    employeeIds: z.array(IdSchema).max(1000).optional(),
  })
  .strict()
  .refine((v) => (v.groupIds?.length ?? 0) + (v.employeeIds?.length ?? 0) > 0, "Pick at least one employee or group");
export type AddPaymentsBody = z.infer<typeof AddPaymentsBody>;

export const UpdatePaymentBody = z.object({ amount: AmountSchema }).strict();
export type UpdatePaymentBody = z.infer<typeof UpdatePaymentBody>;

export const SubmitTransactionBody = z.object({ signedXdr: z.string().trim().min(1).max(200_000) }).strict();
export type SubmitTransactionBody = z.infer<typeof SubmitTransactionBody>;

export const RetryBody = z.object({ paymentIds: z.array(IdSchema).min(1).max(1000).optional() }).strict();
export type RetryBody = z.infer<typeof RetryBody>;

export const RunListQuery = z.object({ status: z.enum(RUN_STATUSES).optional(), ...PaginationQuery }).strict();
export type RunListQuery = z.infer<typeof RunListQuery>;

export const RunPaymentParams = z.object({ id: IdSchema, paymentId: IdSchema }).strict();
export const RunTransactionParams = z.object({ id: IdSchema, txId: IdSchema }).strict();

const Counts = z.object({
  /** Every payment on the run: one per employee. */
  payments: z.number().int(),
  pending: z.number().int(),
  awaitingSignature: z.number().int(),
  submitted: z.number().int(),
  successful: z.number().int(),
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
  paymentsPerTx: z.number().int(),
  /** Employees on the run (cancelled payments not counted). */
  employeeCount: z.number().int(),
  /** Exact sum of every payment that is not cancelled. */
  total: z.string(),
  totalStroops: z.string(),
  /** Sum of SUCCESSFUL payments. */
  paidTotal: z.string(),
  paidTotalStroops: z.string(),
  failedTotal: z.string(),
  counts: Counts,
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type RunSummary = z.infer<typeof RunSummarySchema>;

export const PaymentSchema = z.object({
  id: z.string(),
  runId: z.string(),
  position: z.number().int(),
  employeeId: z.string().nullable(),
  /** Name and wallet as they were when the payment was added to the run. */
  name: z.string(),
  walletAddress: z.string(),
  amount: z.string(),
  amountStroops: z.string(),
  status: z.enum(PAYMENT_STATUSES),
  failureCode: z.enum(FAILURE_CODES).nullable(),
  failureDetail: z.string().nullable(),
  txHash: z.string().nullable(),
  ledger: z.number().int().nullable(),
  /** Ledger close time of the transaction that paid it. */
  paidAt: z.string().nullable(),
  /** When OrgPay checked the ledger record against this payment. */
  verifiedAt: z.string().nullable(),
  transactionNumber: z.number().int().nullable(),
  attempts: z.number().int(),
  explorerUrl: z.string().nullable(),
});
export type Payment = z.infer<typeof PaymentSchema>;

export const StellarTransactionSchema = z.object({
  id: z.string(),
  number: z.number().int(),
  status: z.enum(TX_STATUSES),
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
  /** Only once the transaction is on the ledger. */
  explorerUrl: z.string().nullable(),
});
export type StellarTransaction = z.infer<typeof StellarTransactionSchema>;

export const RunEventSchema = z.object({
  id: z.string(),
  type: z.string(),
  message: z.string(),
  actor: z.string(),
  paymentId: z.string().nullable(),
  transactionId: z.string().nullable(),
  createdAt: z.string(),
});
export type RunEvent = z.infer<typeof RunEventSchema>;

export const RunSchema = RunSummarySchema.extend({
  payments: z.array(PaymentSchema),
  transactions: z.array(StellarTransactionSchema),
  events: z.array(RunEventSchema),
});
export type Run = z.infer<typeof RunSchema>;
export const RunResponse = z.object({ run: RunSchema });
export const RunListResponse = z.object({ data: z.array(RunSummarySchema), nextCursor: z.string().nullable() });

/** The transaction to sign: the unsigned envelope (base64 XDR). */
export const SignableTransactionSchema = StellarTransactionSchema.extend({
  xdr: z.string(),
  networkPassphrase: z.string(),
  paymentIds: z.array(z.string()),
});
export type SignableTransaction = z.infer<typeof SignableTransactionSchema>;
export const NextTransactionResponse = z.object({ transaction: SignableTransactionSchema.nullable(), run: RunSchema });
export const SubmitTransactionResponse = z.object({ transaction: StellarTransactionSchema, run: RunSchema });

export const FUNDING_PROBLEMS = ["ACCOUNT_NOT_FOUND", "NO_TRUSTLINE", "INSUFFICIENT_USDC", "INSUFFICIENT_XLM"] as const;
export type FundingProblem = (typeof FUNDING_PROBLEMS)[number];

export const RunCheckSchema = z.object({
  payments: z.array(z.object({ paymentId: z.string(), ok: z.boolean(), reason: z.enum(RECEIVE_PROBLEMS).nullable() })),
  /** Payments that would be made if the run were executed now. */
  payableCount: z.number().int(),
  payableTotal: z.string(),
  excludedCount: z.number().int(),
  funding: z.object({
    address: z.string(),
    usdcAvailable: z.string().nullable(),
    xlmAvailable: z.string().nullable(),
    /** XLM needed for network fees across every transaction. */
    feeXlm: z.string(),
    enough: z.boolean(),
    problem: z.enum(FUNDING_PROBLEMS).nullable(),
    /** USDC still missing when problem is INSUFFICIENT_USDC. */
    shortBy: z.string().nullable(),
  }),
  /** Employees on this run already paid (or being paid) by another run with the same pay date. */
  alsoPaidElsewhere: z.array(
    z.object({ paymentId: z.string(), employeeId: z.string(), name: z.string(), runId: z.string(), runNumber: z.number().int() }),
  ),
  checkedAt: z.string(),
});
export type RunCheck = z.infer<typeof RunCheckSchema>;
export const RunCheckResponse = z.object({ check: RunCheckSchema });

// ---------- payments ----------

export const PaymentDetailSchema = PaymentSchema.extend({
  run: z.object({ id: z.string(), number: z.number().int(), name: z.string(), status: z.enum(RUN_STATUSES) }),
});
export type PaymentDetail = z.infer<typeof PaymentDetailSchema>;
export const PaymentResponse = z.object({ payment: PaymentDetailSchema });

/** Each check OrgPay makes on the ledger record before a payment counts as successful. */
export const VerificationChecksSchema = z.object({
  found: z.boolean(),
  successful: z.boolean(),
  hashMatches: z.boolean(),
  source: z.boolean(),
  destination: z.boolean(),
  asset: z.boolean(),
  amount: z.boolean(),
  opResult: z.boolean(),
});
export type VerificationChecks = z.infer<typeof VerificationChecksSchema>;

export const PaymentVerificationSchema = z.object({
  paymentId: z.string(),
  status: z.enum(PAYMENT_STATUSES),
  txHash: z.string().nullable(),
  /** Every check passed. */
  verified: z.boolean(),
  checks: VerificationChecksSchema,
  ledger: z.number().int().nullable(),
  closedAt: z.string().nullable(),
  explorerUrl: z.string().nullable(),
  checkedAt: z.string(),
});
export type PaymentVerification = z.infer<typeof PaymentVerificationSchema>;
export const PaymentVerificationResponse = z.object({ verification: PaymentVerificationSchema });

// ---------- overview ----------

export const SummarySchema = z.object({
  paidThisMonth: z.string(),
  peoplePaidThisMonth: z.number().int(),
  failedPayments: z.number().int(),
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
  openTransactions: z.number().int().nullable(),
});
export type Health = z.infer<typeof HealthSchema>;
