// The API's shapes, straight from the shared package, plus list envelopes.
export type {
  ApiKey,
  ChallengeResponse,
  Company,
  Employee,
  FailureCode,
  FundingProblem,
  Group,
  Payment,
  PaymentDetail,
  PaymentStatus,
  PaymentVerification,
  ReceiveProblem,
  RecipientCheck,
  Run,
  RunCheck,
  RunEvent,
  RunStatus,
  RunSummary,
  Session,
  SignableTransaction,
  StellarTransaction,
  Summary,
  Trustline,
  TxStatus,
  Wallet,
} from "@orgpay/shared";

// Names the screens grew up with: a run's lines are its payments, a batch is a Stellar transaction.
export type { Payment as RunItem, PaymentStatus as ItemStatus, StellarTransaction as Batch, SignableTransaction as SignableBatch, TxStatus as BatchStatus } from "@orgpay/shared";

export interface Page<T> {
  data: T[];
  nextCursor: string | null;
}

export interface EmployeePage extends Page<import("@orgpay/shared").Employee> {
  total: number;
}
