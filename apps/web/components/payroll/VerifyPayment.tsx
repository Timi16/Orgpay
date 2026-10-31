"use client";

import { useState } from "react";
import { Dialog } from "@/components/Dialog";
import { Icon } from "@/components/Icon";
import { api, errorMessage } from "@/lib/api";
import { formatAmount, formatDateTime, shortAddress } from "@/lib/format";
import type { PaymentVerification, RunItem } from "@/lib/types";

const CHECKS: { key: keyof PaymentVerification["checks"]; label: string }[] = [
  { key: "found", label: "Found on the ledger" },
  { key: "successful", label: "Transaction succeeded" },
  { key: "hashMatches", label: "The transaction OrgPay built" },
  { key: "source", label: "From the funding wallet" },
  { key: "destination", label: "To the employee’s wallet" },
  { key: "asset", label: "USDC from the configured issuer" },
  { key: "amount", label: "Exactly the amount on the run" },
  { key: "opResult", label: "Payment operation succeeded" },
];

/**
 * Re-checks one payment straight from Stellar (GET /v1/payments/:id/verify): nothing here comes
 * from OrgPay's own records, so anyone can confirm a payment without trusting them.
 */
export function VerifyPayment({ item }: { item: RunItem }) {
  const [open, setOpen] = useState(false);
  const [result, setResult] = useState<PaymentVerification | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function check() {
    setBusy(true);
    setError(null);
    try {
      setResult((await api.get<{ verification: PaymentVerification }>(`/v1/payments/${item.id}/verify`)).verification);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button
        type="button"
        className="btn btn-secondary btn-sm"
        onClick={() => {
          setOpen(true);
          setResult(null);
          void check();
        }}
      >
        <Icon name="shield" size={14} />
        Verify
      </button>
      <Dialog open={open} onClose={() => setOpen(false)} title={`${item.name} · ${formatAmount(item.amount)} USDC`} width={560}>
        {busy ? (
          <p className="muted" style={{ margin: 0, display: "flex", gap: 10, alignItems: "center" }}>
            <span className="spinner" aria-hidden="true" /> Reading the transaction from Stellar…
          </p>
        ) : error ? (
          <div className="alert" role="alert">{error}</div>
        ) : result ? (
          <>
            <div className={result.verified ? "success" : "alert"} role="status" style={{ display: "flex", gap: 10, alignItems: "center" }}>
              <Icon name={result.verified ? "shield" : "alert"} size={20} />
              <span>
                {result.verified ? (
                  <><b>Verified on Stellar just now.</b> Read from Horizon, not from OrgPay’s records. All 8 checks pass.</>
                ) : (
                  <><b>Not verified.</b> {result.txHash ? "The ledger record doesn’t match this payment on every check below." : "This payment hasn’t been in a transaction on the ledger."}</>
                )}
              </span>
            </div>
            <ul className="verify-list" aria-label="Checks">
              {CHECKS.map((c, i) => (
                <li key={c.key} style={{ animationDelay: `${120 + i * 90}ms` }}>
                  <span className={`verify-mark ${result.checks[c.key] ? "ok" : "no"}`} aria-hidden="true">
                    <Icon name={result.checks[c.key] ? "check" : "x"} size={12} strokeWidth={3} />
                  </span>
                  <span style={{ flex: 1 }}>{c.label}</span>
                  <span className="sr-only">{result.checks[c.key] ? "passes" : "fails"}</span>
                  <span className="mono faint" style={{ fontSize: 12 }}>
                    {c.key === "found" && result.ledger ? `ledger ${result.ledger}` : c.key === "destination" ? shortAddress(item.walletAddress) : c.key === "amount" ? formatAmount(item.amount) : ""}
                  </span>
                </li>
              ))}
            </ul>
            {result.txHash ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 4, padding: "12px 14px", background: "var(--sunken)", borderRadius: 6 }}>
                <span className="eyebrow">Transaction hash{result.closedAt ? ` · ${formatDateTime(result.closedAt)}` : ""}</span>
                <span className="mono" style={{ fontSize: 12.5, wordBreak: "break-all" }}>{result.txHash}</span>
              </div>
            ) : null}
            {result.explorerUrl ? (
              <a className="btn btn-primary" href={result.explorerUrl} target="_blank" rel="noreferrer" style={{ alignSelf: "flex-end" }}>
                Open on Stellar Expert <Icon name="external" size={14} />
              </a>
            ) : null}
          </>
        ) : null}
      </Dialog>
    </>
  );
}
