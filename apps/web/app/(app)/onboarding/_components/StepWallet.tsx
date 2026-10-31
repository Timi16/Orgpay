"use client";

import { WalletReadiness } from "@/app/(app)/settings/_components/WalletsCard";
import { AddWalletForm } from "@/components/wallets/AddWalletForm";
import { walletName } from "@/components/wallets/useVerifyWallet";
import { formatAmount } from "@/lib/format";
import type { Company, Wallet } from "@/lib/types";
import styles from "../onboarding.module.css";

interface Props {
  company: Company;
  wallets: Wallet[];
  className: string;
  onBack: () => void;
  onDone: () => void;
}

/** The account payroll is paid from. Only its public address: the company signs every batch in Freighter. */
export function StepWallet({ wallets, className, onBack, onDone }: Props) {
  const wallet = wallets[0];
  return (
    <div className={className}>
      <div className={styles.head}>
        <span className="eyebrow">Step 2 of 3</span>
        <h1 className="h1" style={{ fontSize: 40 }}>
          Where does pay <em>come from</em>?
        </h1>
        <p className="sub">
          Paste the public address (G…) of the Stellar Testnet account you&apos;ll pay salaries from. It needs a USDC trustline and some USDC, plus a little XLM for fees.
          You&apos;ll approve each payroll in Freighter with this account.
        </p>
      </div>
      {wallet ? (
        <div className="sheet sheet-pad" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <strong style={{ fontSize: 16 }}>{walletName(wallet)}</strong>
            <WalletReadiness wallet={wallet} />
          </div>
          <span className="mono faint" style={{ fontSize: 12, wordBreak: "break-all" }}>
            {wallet.address}
          </span>
          <dl className="ledger" style={{ maxWidth: 320 }}>
            <dt>USDC</dt>
            <dd>{wallet.usdcBalance !== null ? formatAmount(wallet.usdcBalance) : "—"}</dd>
            <dt>XLM for fees</dt>
            <dd>{wallet.xlmBalance !== null ? formatAmount(wallet.xlmBalance) : "—"}</dd>
          </dl>
          {!wallet.hasUsdcTrustline ? (
            <div className="notice">You can carry on now. Before your first run, add a USDC trustline to this account and fund it with test USDC.</div>
          ) : null}
        </div>
      ) : (
        <div className="sheet sheet-pad">
          <AddWalletForm existing={wallets} labelPlaceholder="e.g. Payroll treasury" />
        </div>
      )}
      <div className={styles.actions}>
        <button type="button" className="btn btn-secondary" onClick={onBack}>
          Back
        </button>
        <button type="button" className="btn btn-primary btn-lg" onClick={onDone} disabled={!wallet}>
          Continue
        </button>
      </div>
    </div>
  );
}
