import type { VerificationChecks } from "@orgpay/shared";
import { FeeBumpTransaction, TransactionBuilder, type Transaction } from "@stellar/stellar-sdk";
import { env } from "../config/env";
import { parseAmount } from "../lib/amount";
import type { AssetRef } from "../lib/asset";
import type { FoundTransaction } from "./gateway";
import { decodeResultXdr } from "./results";

export interface ExpectedTransaction {
  /** The hash OrgPay built and stored. */
  txHash: string;
  /** The run's funding wallet. */
  source: string;
  asset: AssetRef;
}

export interface ExpectedPayment {
  opIndex: number;
  walletAddress: string;
  amountStroops: bigint;
}

const NONE: VerificationChecks = {
  found: false,
  successful: false,
  hashMatches: false,
  source: false,
  destination: false,
  asset: false,
  amount: false,
  opResult: false,
};

function parseEnvelope(envelopeXdr: string): Transaction | null {
  try {
    const parsed = TransactionBuilder.fromXDR(envelopeXdr, env.NETWORK_PASSPHRASE);
    // Anyone may wrap a signed transaction in a fee bump; the payments are in the inner one.
    return parsed instanceof FeeBumpTransaction ? parsed.innerTransaction : parsed;
  } catch {
    return null;
  }
}

/**
 * Checks a ledger record against one payment: the transaction succeeded, it is the one OrgPay
 * built, it is from the funding wallet, and the operation at the payment's index paid exactly
 * this amount of this asset to this wallet, with op_success. A payment is SUCCESSFUL only when
 * every check passes.
 */
export function verifyPayment(found: FoundTransaction | null, expected: ExpectedTransaction, payment: ExpectedPayment): VerificationChecks {
  if (!found) return { ...NONE };
  const checks: VerificationChecks = { ...NONE, found: true, successful: found.successful };
  const tx = parseEnvelope(found.envelopeXdr);
  if (!tx) return checks;
  checks.hashMatches = Buffer.from(tx.hash()).toString("hex") === expected.txHash;
  checks.source = tx.source === expected.source;
  const op = tx.operations[payment.opIndex];
  if (op?.type === "payment") {
    checks.destination = op.destination === payment.walletAddress;
    checks.asset = !op.asset.isNative() && op.asset.getCode() === expected.asset.code && op.asset.getIssuer() === expected.asset.issuer;
    checks.amount = parseAmount(op.amount) === payment.amountStroops;
  }
  try {
    checks.opResult = decodeResultXdr(found.resultXdr).opCodes[payment.opIndex] === "op_success";
  } catch {
    checks.opResult = false;
  }
  return checks;
}

export function allPassed(checks: VerificationChecks): boolean {
  return Object.values(checks).every(Boolean);
}
