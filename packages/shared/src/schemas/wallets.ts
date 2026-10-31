import { z } from "zod";
import { IdSchema, SafeText } from "./common";

export const AddWalletBody = z
  .object({
    address: z.string().trim().min(1).max(100),
    label: SafeText(1, 64).optional(),
  })
  .strict();
export type AddWalletBody = z.infer<typeof AddWalletBody>;

const SignatureBytes = z.array(z.number().int().min(0).max(255)).length(64);

/**
 * Freighter's signMessage returns `signedMessage` as a base64 string (API v4+) or as a
 * Buffer (v3), which JSON turns into { type: "Buffer", data: [...] }. All are accepted, plus hex.
 */
export const SignatureSchema = z.union([
  z.string().trim().min(1).max(256),
  SignatureBytes,
  z.object({ type: z.literal("Buffer"), data: SignatureBytes }).strict(),
]);

export const VerifyWalletBody = z
  .object({ challengeId: IdSchema, signature: SignatureSchema })
  .strict();
export type VerifyWalletBody = z.infer<typeof VerifyWalletBody>;

export const TrustlineSchema = z.object({
  code: z.string(),
  issuer: z.string(),
  limit: z.string(),
  balance: z.string(),
  buyingLiabilities: z.string(),
  sellingLiabilities: z.string().default("0"),
  authorized: z.boolean(),
});
export type Trustline = z.infer<typeof TrustlineSchema>;

/** A funding wallet: the Stellar account payroll is paid from. */
export const WalletSchema = z.object({
  id: z.string(),
  address: z.string(),
  label: z.string().nullable(),
  verified: z.boolean(),
  verifiedAt: z.string().nullable(),
  accountExists: z.boolean(),
  /** USDC (configured issuer) balance as last checked; null when there is no trustline. */
  usdcBalance: z.string().nullable(),
  /** XLM balance as last checked; null when the account does not exist. */
  xlmBalance: z.string().nullable(),
  hasUsdcTrustline: z.boolean(),
  checkedAt: z.string().nullable(),
  createdAt: z.string(),
});
export type Wallet = z.infer<typeof WalletSchema>;
export const WalletResponse = z.object({ wallet: WalletSchema });
export const WalletListResponse = z.object({ data: z.array(WalletSchema) });
export const ChallengeResponse = z.object({
  challengeId: z.string(),
  message: z.string(),
  expiresAt: z.string(),
});
export type ChallengeResponse = z.infer<typeof ChallengeResponse>;
