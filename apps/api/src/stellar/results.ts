import { xdr } from "@stellar/stellar-sdk";

/** XDR variant names → the snake_case codes Horizon reports ("paymentNoTrust" → "op_no_trust"). */
function horizonStyle(name: string, prefix: "tx" | "op", strip: string): string {
  const rest = name.startsWith(strip) ? name.slice(strip.length) : name;
  return `${prefix}_${rest.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`).replace(/^_/, "")}`;
}

/**
 * Decodes a TransactionResult XDR (from a Horizon transaction record) into the same shape
 * a failed submission returns: the transaction code and one code per operation.
 */
export function decodeResultXdr(resultXdr: string): { txCode: string; opCodes: string[] } {
  const result = xdr.TransactionResult.fromXdr(resultXdr, "base64").result;
  const txCode = horizonStyle(result.type, "tx", "tx");
  const ops = result.type === "txSuccess" || result.type === "txFailed" ? result.results : [];
  const opCodes = ops.map((op) => {
    if (op.type !== "opInner") return horizonStyle(op.type, "op", "op");
    if (op.tr.type !== "payment") return "op_unexpected";
    return horizonStyle(op.tr.paymentResult.type, "op", "payment");
  });
  return { txCode, opCodes };
}
