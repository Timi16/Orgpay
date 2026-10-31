import type { Mail } from "./mailer";
import { formatStroops } from "./amount";

/** Plain-text emails. Amounts are shown trimmed ("80.00"), never rounded. */
export function money(stroops: bigint, code: string): string {
  const [whole = "0", frac = ""] = formatStroops(stroops).split(".");
  const trimmed = frac.replace(/0+$/, "").padEnd(2, "0");
  return `${whole}.${trimmed} ${code}`;
}

export interface RunFacts {
  id: string;
  number: number;
  name: string;
  status: "PAID" | "PARTIAL" | "FAILED";
  assetCode: string;
  paidCount: number;
  paidStroops: bigint;
  failed: { name: string; reason: string }[];
}

const REASONS: Record<string, string> = {
  ACCOUNT_NOT_FOUND: "wallet does not exist on Stellar Testnet",
  NO_TRUSTLINE: "no USDC trustline",
  NOT_AUTHORIZED: "not authorised by the USDC issuer",
  TRUSTLINE_LIMIT_TOO_LOW: "USDC trustline limit too low",
  PAYMENT_FAILED: "Stellar refused the payment",
};

/** To the company: a payroll run finished. */
export function runFinishedEmail(to: string, businessName: string, r: RunFacts, webOrigin: string): Mail {
  const subject =
    r.status === "PAID"
      ? `Payroll #${r.number} paid: ${r.paidCount} people, ${money(r.paidStroops, r.assetCode)}`
      : r.status === "PARTIAL"
        ? `Payroll #${r.number}: ${r.failed.length} payment(s) not sent`
        : `Payroll #${r.number}: nobody was paid`;
  const failedLines = r.failed.slice(0, 20).map((f) => `  - ${f.name}: ${REASONS[f.reason] ?? f.reason}`);
  return {
    to,
    subject,
    text: [
      `Hi ${businessName},`,
      "",
      `${r.name} (payroll #${r.number}) has finished on Stellar Testnet.`,
      `Paid: ${r.paidCount} ${r.paidCount === 1 ? "person" : "people"}, ${money(r.paidStroops, r.assetCode)}.`,
      ...(r.failed.length > 0
        ? ["", `Not paid (${r.failed.length}). Nothing was sent to them:`, ...failedLines, ...(r.failed.length > 20 ? [`  …and ${r.failed.length - 20} more`] : []), "", "Fix their wallets, then use “Check again and retry” on the run."]
        : []),
      "",
      `Open the run, with every transaction hash: ${webOrigin}/payroll/${r.id}`,
      "",
      "Stellar Testnet · no real money moves.",
    ].join("\n"),
  };
}
