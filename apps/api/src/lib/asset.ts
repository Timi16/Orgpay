import { env } from "../config/env";

export interface AssetRef {
  code: string;
  issuer: string;
}

/** Payroll is paid in USDC from the issuer OrgPay is configured to trust. */
export function usdc(): AssetRef {
  return { code: "USDC", issuer: env.USDC_ISSUER };
}
