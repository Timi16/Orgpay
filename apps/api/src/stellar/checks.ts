import type { FundingProblem, ReceiveProblem, Trustline } from "@orgpay/shared";
import { formatStroops } from "../lib/amount";
import type { AssetRef } from "../lib/asset";
import { parseAmount } from "../lib/amount";
import { AppError } from "../lib/errors";
import type { AccountState } from "./gateway";

/** Per-operation fee bid, in stroops. Testnet's base fee is 100; this leaves room for surges. */
export const FEE_PER_OP_STROOPS = 1000n;
/** Base reserve: each entry an account holds locks 0.5 XLM. */
const BASE_RESERVE_STROOPS = 5_000_000n;

/** Horizon amounts are decimal strings; one we can't read must never pass as "enough". */
export function horizonStroops(value: string): bigint {
  const s = parseAmount(value);
  if (s === null) throw new AppError("HORIZON_UNAVAILABLE", "Stellar returned a balance OrgPay could not read");
  return s;
}

export function findTrustline(trustlines: Trustline[], asset: AssetRef): Trustline | undefined {
  return trustlines.find((t) => t.code === asset.code && t.issuer === asset.issuer);
}

/**
 * Can `account` receive `amountStroops` of the asset right now? Needs an existing account and
 * an authorised trustline with headroom: limit − balance − buying liabilities ≥ amount.
 */
export function receiveProblem(account: AccountState, asset: AssetRef, amountStroops: bigint): ReceiveProblem | null {
  if (!account.exists) return "ACCOUNT_NOT_FOUND";
  const line = findTrustline(account.trustlines, asset);
  if (!line) return "NO_TRUSTLINE";
  if (!line.authorized) return "NOT_AUTHORIZED";
  const headroom = horizonStroops(line.limit) - horizonStroops(line.balance) - horizonStroops(line.buyingLiabilities);
  return headroom < amountStroops ? "TRUSTLINE_LIMIT_TOO_LOW" : null;
}

export interface FundingCheck {
  usdcAvailable: bigint | null;
  xlmAvailable: bigint | null;
  feeStroops: bigint;
  problem: FundingProblem | null;
  /** How much USDC is missing, when problem is INSUFFICIENT_USDC. */
  shortBy: bigint | null;
}

/**
 * Can the funding wallet send `totalStroops` of the asset in `opCount` payments? USDC available
 * is balance − selling liabilities; XLM must cover the fees on top of the minimum reserve.
 */
export function fundingCheck(account: AccountState, asset: AssetRef, totalStroops: bigint, opCount: number): FundingCheck {
  const feeStroops = FEE_PER_OP_STROOPS * BigInt(opCount);
  if (!account.exists) return { usdcAvailable: null, xlmAvailable: null, feeStroops, problem: "ACCOUNT_NOT_FOUND", shortBy: null };
  const reserve =
    (2n + BigInt(account.subentries) + BigInt(account.sponsoring) - BigInt(account.sponsored)) * BASE_RESERVE_STROOPS;
  const xlmAvailable =
    horizonStroops(account.nativeBalance) - horizonStroops(account.nativeSellingLiabilities) - reserve;
  const line = findTrustline(account.trustlines, asset);
  if (!line || !line.authorized) {
    return { usdcAvailable: null, xlmAvailable, feeStroops, problem: "NO_TRUSTLINE", shortBy: null };
  }
  const usdcAvailable = horizonStroops(line.balance) - horizonStroops(line.sellingLiabilities);
  if (usdcAvailable < totalStroops) {
    return { usdcAvailable, xlmAvailable, feeStroops, problem: "INSUFFICIENT_USDC", shortBy: totalStroops - usdcAvailable };
  }
  if (xlmAvailable < feeStroops) {
    return { usdcAvailable, xlmAvailable, feeStroops, problem: "INSUFFICIENT_XLM", shortBy: null };
  }
  return { usdcAvailable, xlmAvailable, feeStroops, problem: null, shortBy: null };
}

export const RECEIVE_PROBLEM_TEXT: Record<ReceiveProblem, string> = {
  ACCOUNT_NOT_FOUND: "This wallet does not exist on Stellar Testnet yet",
  NO_TRUSTLINE: "This wallet has no USDC trustline",
  NOT_AUTHORIZED: "The USDC issuer has not authorised this wallet",
  TRUSTLINE_LIMIT_TOO_LOW: "This wallet's USDC trustline limit is too low for the amount",
};

/** The error a refused start or batch carries, in words the company can act on. */
export function fundingError(check: FundingCheck, assetCode: string): AppError {
  const message =
    check.problem === "ACCOUNT_NOT_FOUND"
      ? "The funding wallet does not exist on Stellar Testnet. Fund it with XLM first."
      : check.problem === "NO_TRUSTLINE"
        ? `The funding wallet has no ${assetCode} trustline.`
        : check.problem === "INSUFFICIENT_USDC"
          ? `The funding wallet is ${formatStroops(check.shortBy ?? 0n)} ${assetCode} short.`
          : "The funding wallet needs more XLM to cover network fees.";
  return new AppError("INSUFFICIENT_FUNDS", message, {
    details: [
      {
        problem: check.problem,
        usdcAvailable: check.usdcAvailable === null ? null : formatStroops(check.usdcAvailable),
        xlmAvailable: check.xlmAvailable === null ? null : formatStroops(check.xlmAvailable),
        shortBy: check.shortBy === null ? null : formatStroops(check.shortBy),
      },
    ],
  });
}
