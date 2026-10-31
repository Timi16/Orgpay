import type { ErrorCode } from "@orgpay/shared";

export const HTTP_STATUS: Record<ErrorCode, number> = {
  VALIDATION_FAILED: 400,
  SECRET_KEY_REJECTED: 400,
  ACCOUNT_NOT_FOUND: 400,
  INSUFFICIENT_FUNDS: 400,
  TX_MISMATCH: 400,
  INVALID_SIGNATURE: 400,
  CHALLENGE_EXPIRED: 400,
  INVALID_CODE: 400,
  UNAUTHENTICATED: 401,
  INVALID_CREDENTIALS: 401,
  EMAIL_NOT_VERIFIED: 403,
  FORBIDDEN_ORIGIN: 403,
  NOT_FOUND: 404,
  INVALID_TRANSITION: 409,
  RUN_LOCKED: 409,
  NOTHING_TO_PAY: 409,
  WALLET_IN_USE: 409,
  WALLET_TAKEN: 409,
  NAME_TAKEN: 409,
  EMAIL_TAKEN: 409,
  LIMIT_REACHED: 409,
  PAYLOAD_TOO_LARGE: 413,
  RATE_LIMITED: 429,
  INTERNAL: 500,
  HORIZON_UNAVAILABLE: 503,
  SERVICE_UNAVAILABLE: 503,
};

export interface AppErrorOptions {
  details?: unknown[];
  /** Seconds; sent as Retry-After. */
  retryAfter?: number;
}

export class AppError extends Error {
  readonly status: number;
  readonly details: unknown[];
  readonly retryAfter?: number;

  constructor(
    readonly code: ErrorCode,
    message: string,
    opts: AppErrorOptions = {},
  ) {
    super(message);
    this.name = "AppError";
    this.status = HTTP_STATUS[code];
    this.details = opts.details ?? [];
    this.retryAfter = opts.retryAfter;
  }
}

export const notFound = (what = "Resource") => new AppError("NOT_FOUND", `${what} not found`);
