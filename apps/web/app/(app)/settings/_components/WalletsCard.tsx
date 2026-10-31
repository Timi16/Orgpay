"use client";

import { useState } from "react";
import useSWR, { useSWRConfig } from "swr";
import { CopyButton } from "@/components/CopyButton";
import { Dialog } from "@/components/Dialog";
import { Icon } from "@/components/Icon";
import { Pill } from "@/components/StatusPill";
import { useToast } from "@/components/Toast";
import { AddWalletForm } from "@/components/wallets/AddWalletForm";
import { useVerifyWallet, VerifyProgress, walletName } from "@/components/wallets/useVerifyWallet";
import { api, errorMessage } from "@/lib/api";
import { explorerAccount } from "@/lib/config";
import { formatAmount, timeAgo } from "@/lib/format";
import { useNow } from "@/lib/hooks";
import type { Wallet } from "@/lib/types";
import { Section } from "./Section";

const WALLETS = "/v1/wallets";

/** What a funding wallet can do right now, in one pill. */
export function WalletReadiness({ wallet }: { wallet: Wallet }) {
  if (!wallet.checkedAt) return <Pill tone="muted" icon="clock">Not checked yet</Pill>;
  if (!wallet.accountExists) return <Pill tone="danger" icon="x">Not on Testnet</Pill>;
  if (!wallet.hasUsdcTrustline) return <Pill tone="danger" icon="x">No USDC trustline</Pill>;
  return <Pill tone="good" icon="check">Can pay in USDC</Pill>;
}

function WalletRow({ wallet, now }: { wallet: Wallet; now: number }) {
  const toast = useToast();
  const { mutate } = useSWRConfig();
  const { state, verify, busy: verifying } = useVerifyWallet();
  const [busy, setBusy] = useState<"refresh" | "remove" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);

  const refresh = async () => {
    setBusy("refresh");
    setError(null);
    try {
      await api.post(`/v1/wallets/${wallet.id}/refresh`);
      await mutate(WALLETS);
      toast(`${walletName(wallet)} re-checked on Stellar`);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    setBusy("remove");
    setError(null);
    try {
      await api.delete(`/v1/wallets/${wallet.id}`);
      setConfirmRemove(false);
      await mutate(WALLETS);
      toast(`${walletName(wallet)} removed`);
    } catch (err) {
      setConfirmRemove(false);
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <li style={{ padding: "18px 0", borderTop: "1px solid var(--rule-soft)", display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", gap: 16, flexWrap: "wrap", alignItems: "flex-start", justifyContent: "space-between" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 0, flex: "1 1 260px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <strong style={{ fontSize: 15 }}>{walletName(wallet)}</strong>
            <WalletReadiness wallet={wallet} />
            {wallet.verified ? <Pill tone="brand" icon="shield">Ownership verified</Pill> : null}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
            <a href={explorerAccount(wallet.address)} target="_blank" rel="noreferrer" className="hash" style={{ wordBreak: "break-all" }}>
              {wallet.address}
            </a>
            <CopyButton value={wallet.address} className="btn-link" label="Copy" ariaLabel="Copy wallet address" />
          </div>
        </div>
        <dl className="ledger" style={{ minWidth: 220 }}>
          <dt>USDC</dt>
          <dd>{wallet.usdcBalance !== null ? formatAmount(wallet.usdcBalance) : "—"}</dd>
          <dt>XLM (fees)</dt>
          <dd>{wallet.xlmBalance !== null ? formatAmount(wallet.xlmBalance) : "—"}</dd>
          <dt className="faint" style={{ fontSize: 12 }}>Checked</dt>
          <dd className="faint" style={{ fontSize: 12, fontFamily: "var(--font-sans)" }}>{wallet.checkedAt ? timeAgo(wallet.checkedAt, now) : "never"}</dd>
        </dl>
      </div>
      {state.phase && state.walletId === wallet.id ? <VerifyProgress phase={state.phase} /> : null}
      {state.error && state.walletId === wallet.id ? (
        <div role="alert" className="alert">
          {state.error}
        </div>
      ) : null}
      {error ? (
        <div role="alert" className="alert">
          {error}
        </div>
      ) : null}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button type="button" className="btn btn-secondary btn-sm" onClick={refresh} disabled={busy !== null} aria-busy={busy === "refresh"}>
          <Icon name="refresh" size={15} /> Re-check balances
        </button>
        {!wallet.verified ? (
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => void verify(wallet)} disabled={verifying} aria-busy={verifying}>
            <Icon name="freighter" size={15} /> Verify with Freighter
          </button>
        ) : null}
        <button type="button" className="btn btn-danger btn-sm" onClick={() => setConfirmRemove(true)} disabled={busy !== null}>
          Remove
        </button>
      </div>
      <Dialog
        open={confirmRemove}
        onClose={() => setConfirmRemove(false)}
        title={`Remove ${walletName(wallet)}?`}
        footer={
          <>
            <button type="button" className="btn btn-secondary" onClick={() => setConfirmRemove(false)}>
              Keep it
            </button>
            <button type="button" className="btn btn-danger" onClick={remove} disabled={busy === "remove"} aria-busy={busy === "remove"}>
              Remove wallet
            </button>
          </>
        }
      >
        <p className="muted">New runs won&apos;t be able to pay from it. Past runs keep their record. The wallet and its funds are untouched: OrgPay never held them.</p>
      </Dialog>
    </li>
  );
}

/** The wallets payroll is paid from. OrgPay never holds their keys: every batch is signed in Freighter. */
export function WalletsCard() {
  const now = useNow();
  const { data, error } = useSWR<{ data: Wallet[] }>(WALLETS);
  const [adding, setAdding] = useState(false);
  const wallets = data?.data ?? [];
  return (
    <Section
      id="wallets"
      title="Funding wallets"
      sub="The Stellar accounts payroll is paid from. You sign every payment in Freighter; OrgPay never sees a secret key."
    >
      {error ? (
        <div role="alert" className="alert">
          {errorMessage(error)}
        </div>
      ) : !data ? (
        <div className="skeleton" style={{ height: 80 }} />
      ) : wallets.length === 0 ? (
        <div className="info-note">No funding wallet yet. Add the public address (G…) of the account you&apos;ll pay from.</div>
      ) : (
        <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
          {wallets.map((w) => (
            <WalletRow key={w.id} wallet={w} now={now} />
          ))}
        </ul>
      )}
      {adding || (data && wallets.length === 0) ? (
        <div style={{ borderTop: "1px dashed var(--rule)", paddingTop: 18 }}>
          <AddWalletForm existing={wallets} labelPlaceholder="e.g. Payroll treasury" onAdded={() => setAdding(false)} />
        </div>
      ) : (
        <button type="button" className="btn btn-secondary btn-sm" style={{ alignSelf: "flex-start" }} onClick={() => setAdding(true)}>
          <Icon name="plus" size={15} /> Add a funding wallet
        </button>
      )}
    </Section>
  );
}
