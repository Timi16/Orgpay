// Words, tones and icons for every payroll status. Status is never colour alone.
import type { AnyIcon } from "@/components/Icon";
import type { BatchStatus, FailureCode, FundingProblem, ItemStatus, ReceiveProblem, RunStatus } from "./types";

export type Tone = "good" | "warn" | "danger" | "info" | "muted" | "brand";
export interface StatusSpec {
  label: string;
  tone: Tone;
  icon: AnyIcon;
}

export const RUN_STATUS: Record<RunStatus, StatusSpec> = {
  DRAFT: { label: "Draft", tone: "muted", icon: "draft" },
  PROCESSING: { label: "Processing", tone: "info", icon: "clock" },
  COMPLETED: { label: "Completed", tone: "good", icon: "check" },
  PARTIALLY_PAID: { label: "Partially paid", tone: "warn", icon: "alert" },
  FAILED: { label: "Failed", tone: "danger", icon: "x" },
  CANCELLED: { label: "Cancelled", tone: "muted", icon: "ban" },
};

/** A payment is SUCCESSFUL only once its ledger record was checked against it. */
export const ITEM_STATUS: Record<ItemStatus, StatusSpec> = {
  PENDING: { label: "Pending", tone: "muted", icon: "clock" },
  AWAITING_SIGNATURE: { label: "Waiting for signature", tone: "warn", icon: "pen" },
  SUBMITTED: { label: "Submitted, confirming", tone: "info", icon: "send" },
  SUCCESSFUL: { label: "Successful", tone: "good", icon: "check" },
  FAILED: { label: "Failed", tone: "danger", icon: "x" },
  CANCELLED: { label: "Cancelled", tone: "muted", icon: "ban" },
};

/** In a transaction that may still land: never offer to send these again. */
export const IN_FLIGHT: ItemStatus[] = ["AWAITING_SIGNATURE", "SUBMITTED"];

export const BATCH_STATUS: Record<BatchStatus, StatusSpec> = {
  AWAITING_SIGNATURE: { label: "Waiting for your signature", tone: "info", icon: "pen" },
  SUBMITTED: { label: "Confirming on Stellar", tone: "warn", icon: "clock" },
  CONFIRMED: { label: "Confirmed", tone: "good", icon: "check" },
  FAILED: { label: "Not accepted", tone: "danger", icon: "x" },
  EXPIRED: { label: "Expired unsigned", tone: "muted", icon: "ban" },
};

/** Short reason under a line or a person. */
export const REASON_SHORT: Record<FailureCode | ReceiveProblem, string> = {
  ACCOUNT_NOT_FOUND: "Wallet not on Testnet",
  NO_TRUSTLINE: "No USDC trustline",
  NOT_AUTHORIZED: "Not authorised for USDC",
  TRUSTLINE_LIMIT_TOO_LOW: "USDC limit too low",
  PAYMENT_FAILED: "Stellar refused it",
};

/** What the company can tell the person to do. */
export const REASON_FIX: Record<FailureCode | ReceiveProblem, string> = {
  ACCOUNT_NOT_FOUND: "Their wallet address doesn't exist on Stellar Testnet yet. They need to fund it with XLM first (Friendbot works on Testnet).",
  NO_TRUSTLINE: "Their wallet can't hold USDC yet. They need to add a USDC trustline in their wallet app.",
  NOT_AUTHORIZED: "The USDC issuer hasn't authorised their wallet to hold USDC.",
  TRUSTLINE_LIMIT_TOO_LOW: "Their USDC trustline limit is lower than this payment. They need to raise it.",
  PAYMENT_FAILED: "Stellar refused this payment. Check their wallet, then retry.",
};

export const FUNDING_PROBLEM: Record<FundingProblem, string> = {
  ACCOUNT_NOT_FOUND: "The funding wallet doesn't exist on Stellar Testnet yet. Fund it with XLM first.",
  NO_TRUSTLINE: "The funding wallet has no USDC trustline, so it can't send USDC.",
  INSUFFICIENT_USDC: "The funding wallet doesn't hold enough USDC for this run.",
  INSUFFICIENT_XLM: "The funding wallet needs a little more XLM to cover network fees.",
};
