import { TrustlineSchema, type Trustline } from "@orgpay/shared";
import { z } from "zod";

/** Trustlines cached as JSON on a wallet row. Anything unreadable counts as none. */
export function parseTrustlines(json: unknown): Trustline[] {
  const parsed = z.array(TrustlineSchema).safeParse(json);
  return parsed.success ? parsed.data : [];
}
