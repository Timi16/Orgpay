import { Account, Asset, FeeBumpTransaction, Keypair, Memo, Operation, TransactionBuilder, type Transaction } from "@stellar/stellar-sdk";
import { env } from "../../config/env";
import type { AssetRef } from "../../lib/asset";
import { formatStroops } from "../../lib/amount";
import { AppError } from "../../lib/errors";
import { FEE_PER_OP_STROOPS } from "../../stellar/checks";

export interface PaymentLine {
  destination: string;
  amountStroops: bigint;
}

export interface BuiltBatch {
  xdr: string;
  /** Hex hash of the transaction; signatures do not change it. */
  hash: string;
  /** The sequence number the transaction uses (account sequence + 1). */
  sequence: string;
}

/**
 * One transaction: a USDC payment per line from the funding wallet, valid until maxTime.
 * `accountSequence` is the funding account's current sequence; the transaction uses the next.
 */
export function buildBatchTransaction(input: {
  source: string;
  accountSequence: string;
  asset: AssetRef;
  lines: PaymentLine[];
  memo: string;
  maxTime: Date;
}): BuiltBatch {
  const account = new Account(input.source, input.accountSequence);
  const asset = new Asset(input.asset.code, input.asset.issuer);
  const builder = new TransactionBuilder(account, {
    fee: FEE_PER_OP_STROOPS.toString(),
    networkPassphrase: env.NETWORK_PASSPHRASE,
    timebounds: { minTime: 0, maxTime: Math.floor(input.maxTime.getTime() / 1000) },
    memo: Memo.text(input.memo),
  });
  for (const line of input.lines) {
    builder.addOperation(
      Operation.payment({ destination: line.destination, asset, amount: formatStroops(line.amountStroops) }),
    );
  }
  const tx = builder.build();
  return { xdr: tx.toXDR(), hash: Buffer.from(tx.hash()).toString("hex"), sequence: tx.sequence };
}

/** Memo text is at most 28 bytes. */
export function batchMemo(runNumber: number): string {
  return `OrgPay payroll #${runNumber}`.slice(0, 28);
}

/**
 * Parses what the browser sent back and proves it is the transaction OrgPay built, signed
 * by the funding wallet. Returns the transaction for submission.
 */
export function checkSignedBatch(signedXdr: string, expected: { hash: string; source: string }): Transaction {
  let parsed: Transaction | FeeBumpTransaction;
  try {
    parsed = TransactionBuilder.fromXDR(signedXdr, env.NETWORK_PASSPHRASE);
  } catch {
    throw new AppError("VALIDATION_FAILED", "That is not a Stellar transaction", {
      details: [{ path: "signedXdr", message: "Not a valid transaction envelope" }],
    });
  }
  if (parsed instanceof FeeBumpTransaction || Buffer.from(parsed.hash()).toString("hex") !== expected.hash) {
    throw new AppError("TX_MISMATCH", "This is not the transaction OrgPay built for this batch");
  }
  const signer = Keypair.fromPublicKey(expected.source);
  const signed = parsed.signatures.some((sig) => {
    try {
      return signer.verify(parsed.hash(), sig.signature);
    } catch {
      return false;
    }
  });
  if (!signed) {
    throw new AppError("INVALID_SIGNATURE", "The transaction is not signed by the funding wallet. Sign it with that account in Freighter.");
  }
  return parsed;
}
