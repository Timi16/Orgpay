"use client";

import Link from "next/link";
import { useState } from "react";
import useSWR, { useSWRConfig } from "swr";
import { Dialog } from "@/components/Dialog";
import { Icon } from "@/components/Icon";
import { Reveal } from "@/components/motion/Reveal";
import { useToast } from "@/components/Toast";
import { api, ApiError, errorMessage } from "@/lib/api";
import { API_URL } from "@/lib/config";
import { formatDate, timeAgo } from "@/lib/format";
import { useNow } from "@/lib/hooks";
import { useWallets } from "@/lib/session";
import type { ApiKey } from "@/lib/types";

const KEYS_PATH = "/v1/api-keys";
const WALLET_PLACEHOLDER = "YOUR_WALLET_ID";

type Tab = "curl" | "node" | "resp";
const TABS: { id: Tab; label: string }[] = [
  { id: "curl", label: "cURL" },
  { id: "node", label: "Node.js" },
  { id: "resp", label: "Response" },
];

/** Real, runnable samples for this API. Only the key and (with no wallet added yet) the wallet id are placeholders. */
function codeSamples(walletId: string): Record<Tab, string> {
  const base = `${API_URL}/v1/payroll-runs`;
  return {
    curl: [
      `# 1. A draft run for everyone in a group (or pass employeeIds). A new Idempotency-Key per run:`,
      `#    sending the same request again with it returns the same run instead of a second one.`,
      `curl -X POST ${base} \\`,
      `  -H "Authorization: Bearer op_test_…" \\`,
      `  -H "Idempotency-Key: $(uuidgen)" \\`,
      `  -H "Content-Type: application/json" \\`,
      `  -d '{"name":"October payroll","walletId":"${walletId}","groupIds":["<group id>"]}'`,
      ``,
      `# 2. Execute it: everyone is checked on Stellar and the funding wallet must cover the total`,
      `curl -X POST ${base}/<run id>/start -H "Authorization: Bearer op_test_…"`,
      ``,
      `# 3. Get the next transaction to sign (one payment by default)`,
      `curl -X POST ${base}/<run id>/transactions/next -H "Authorization: Bearer op_test_…"`,
    ].join("\n"),
    node: [
      `import { randomUUID } from "node:crypto";`,
      `import { Keypair, TransactionBuilder } from "@stellar/stellar-sdk";`,
      ``,
      `const api = (path, body) => fetch("${base}" + path, {`,
      `  method: "POST",`,
      "  headers: { Authorization: `Bearer ${process.env.ORGPAY_KEY}`, \"Content-Type\": \"application/json\", \"Idempotency-Key\": randomUUID() },",
      `  body: JSON.stringify(body ?? {}),`,
      `}).then(async (r) => { const j = await r.json(); if (!r.ok) throw new Error(j.error.message); return j; });`,
      ``,
      `const { run } = await api("", { name: "October payroll", walletId: "${walletId}", groupIds: ["<group id>"] });`,
      "await api(`/${run.id}/start`);",
      `// Sign each transaction with the funding wallet's key, kept on YOUR side. OrgPay never sees it.`,
      `const signer = Keypair.fromSecret(process.env.FUNDING_SECRET);`,
      `for (;;) {`,
      "  const { transaction, run: now } = await api(`/${run.id}/transactions/next`);",
      `  if (!transaction) {`,
      `    if (now.status !== "PROCESSING") break; // finished: COMPLETED, PARTIALLY_PAID or FAILED`,
      `    await new Promise((r) => setTimeout(r, 3000)); // one is confirming on Stellar; ask again`,
      `    continue;`,
      `  }`,
      `  const tx = TransactionBuilder.fromXDR(transaction.xdr, transaction.networkPassphrase);`,
      `  tx.sign(signer);`,
      "  await api(`/${run.id}/transactions/${transaction.id}/submit`, { signedXdr: tx.toXDR() });",
      `}`,
    ].join("\n"),
    resp: [
      `// GET ${base}/<run id> once it has finished. Shape only; values are placeholders.`,
      `{`,
      `  "run": {`,
      `    "number": 7, "name": "October payroll", "status": "PARTIALLY_PAID", "paymentsPerTx": 1,`,
      `    "employeeCount": 8, "total": "19850.0000000", "paidTotal": "18100.0000000", "failedTotal": "1750.0000000",`,
      `    "counts": { "payments": 8, "successful": 7, "failed": 1, "pending": 0, "awaitingSignature": 0, "submitted": 0, "cancelled": 0 },`,
      `    "payments": [`,
      `      { "name": "Ada Okafor", "amount": "3200.0000000", "status": "SUCCESSFUL", "txHash": "<64 hex chars>",`,
      `        "ledger": 1234567, "paidAt": "<ISO time>", "verifiedAt": "<ISO time>", "explorerUrl": "https://stellar.expert/…" },`,
      `      { "name": "Tomás Reyes", "amount": "1750.0000000", "status": "FAILED",`,
      `        "failureCode": "NO_TRUSTLINE", "txHash": null }`,
      `    ]`,
      `  }`,
      `}`,
    ].join("\n"),
  };
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

const COPY_FAILED = "Couldn't copy. Select the text and copy it yourself.";

export default function ApiKeysPage() {
  const toast = useToast();
  const { mutate } = useSWRConfig();
  const now = useNow();
  const { data, error, isLoading, mutate: reload } = useSWR<{ data: ApiKey[] }>(KEYS_PATH);
  const { data: wallets } = useWallets();
  const keys = data?.data;

  const [tab, setTab] = useState<Tab>("curl");

  // Create dialog
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState("");
  const [tried, setTried] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [nameServerError, setNameServerError] = useState<string | null>(null);

  // Reveal dialog. The full key lives only here, in memory, until the dialog closes.
  const [reveal, setReveal] = useState<{ name: string; key: string } | null>(null);
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);
  const [revealNonce, setRevealNonce] = useState(0);

  // Revoke dialog
  const [target, setTarget] = useState<ApiKey | null>(null);
  const [revoking, setRevoking] = useState(false);
  const [revokeError, setRevokeError] = useState<string | null>(null);

  // The first funding wallet is the natural example.
  const sampleWallet = wallets?.data[0];
  const samples = codeSamples(sampleWallet?.id ?? WALLET_PLACEHOLDER);

  const trimmed = name.trim();
  let nameError: string | null = null;
  if (!trimmed) nameError = "Give the key a name.";
  else if (trimmed.length > 64) nameError = "Keep the name to 64 characters or fewer.";
  else if (keys?.some((k) => !k.revokedAt && k.name.toLowerCase() === trimmed.toLowerCase())) nameError = "You already have an active key with that name.";
  const shownNameError = nameServerError ?? (tried ? nameError : null);

  const openCreate = () => {
    setName("");
    setTried(false);
    setCreateError(null);
    setNameServerError(null);
    setCreateOpen(true);
  };

  // Closing is always allowed (Escape closes a native dialog regardless); a create already sent still shows its key.
  const closeCreate = () => setCreateOpen(false);

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    setTried(true);
    if (creating || nameError) return;
    setCreating(true);
    setCreateError(null);
    setNameServerError(null);
    try {
      const res = await api.post<{ apiKey: ApiKey; key: string }>(KEYS_PATH, { name: trimmed });
      setSaved(false);
      setCopied(false);
      setReveal({ name: res.apiKey.name, key: res.key });
      setCreateOpen(false);
      void mutate(KEYS_PATH);
    } catch (err) {
      const fieldError = err instanceof ApiError ? err.field("name") : undefined;
      if (fieldError) setNameServerError(fieldError);
      else setCreateError(errorMessage(err));
    } finally {
      setCreating(false);
    }
  };

  const copyKey = async () => {
    if (!reveal) return;
    if (await copyText(reveal.key)) {
      setCopied(true);
      toast("Key copied to clipboard");
    } else {
      toast(COPY_FAILED);
    }
  };

  const finish = () => {
    if (!reveal) return;
    if (!saved) {
      // Escape closes a native dialog before we can stop it: mount it again so the key is not lost.
      toast("Tick the box once the key is saved");
      setRevealNonce((n) => n + 1);
      return;
    }
    toast(`${reveal.name} key is live`);
    setReveal(null);
    setSaved(false);
    setCopied(false);
  };

  const closeRevoke = () => {
    setTarget(null);
    setRevokeError(null);
  };

  const revoke = async () => {
    if (!target || revoking) return;
    setRevoking(true);
    setRevokeError(null);
    try {
      await api.delete(`${KEYS_PATH}/${target.id}`);
      await mutate(KEYS_PATH);
      toast(`${target.name} revoked`);
      setTarget(null);
    } catch (err) {
      setRevokeError(errorMessage(err));
    } finally {
      setRevoking(false);
    }
  };

  const copyCode = async () => {
    toast((await copyText(samples[tab])) ? "Code copied" : COPY_FAILED);
  };

  return (
    <>
      <div className="page-head">
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <Link href="/settings" style={{ display: "inline-flex", alignItems: "center", gap: 4, alignSelf: "flex-start", fontSize: 13, fontWeight: 700, marginBottom: 4 }}>
            <Icon name="back" size={15} strokeWidth={2.4} />
            Back to settings
          </Link>
          <h1 className="h1">API keys</h1>
          <span className="sub">
            Run payroll from your own systems: add people, create runs, submit signed batches. Keys start with <code className="mono">op_test_</code> and only work on Testnet.
          </span>
        </div>
        <button type="button" className="btn btn-primary" onClick={openCreate} style={{ fontSize: 15 }}>
          <Icon name="plus" strokeWidth={2.5} />
          Create key
        </button>
      </div>

      <div className="card" style={{ overflow: "hidden" }}>
        {error && !keys ? (
          <div className="empty" role="alert">
            <strong>We couldn&apos;t load your API keys</strong>
            <span>{errorMessage(error)}</span>
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => reload()} style={{ marginTop: 8 }}>
              Try again
            </button>
          </div>
        ) : !isLoading && keys && keys.length === 0 ? (
          <div className="empty">
            <strong>No API keys yet</strong>
            <span>Create a key to run payroll from your own systems.</span>
            <button type="button" className="btn btn-primary btn-sm" onClick={openCreate} style={{ marginTop: 8 }}>
              Create key
            </button>
          </div>
        ) : (
          <div className="table-wrap">
            <table className={keys ? "table cascade" : "table"} style={{ minWidth: 760 }} aria-busy={!keys}>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Key</th>
                  <th>Created</th>
                  <th>Last used</th>
                  <th style={{ textAlign: "right" }}>Status</th>
                </tr>
              </thead>
              <tbody>
                {keys
                  ? keys.map((k) => (
                      <tr key={k.id}>
                        <td style={{ fontWeight: 700, color: k.revokedAt ? "var(--slate-soft)" : "var(--ink)" }}>{k.name}</td>
                        <td className="mono" style={{ fontSize: 13, color: "var(--slate-strong)" }}>
                          <span aria-hidden="true">{k.prefix}••••••••</span>
                          <span className="sr-only">Starts with {k.prefix}; the rest is hidden</span>
                        </td>
                        <td className="muted">{formatDate(k.createdAt)}</td>
                        <td className="muted">{k.lastUsedAt ? timeAgo(k.lastUsedAt, now) : "Never"}</td>
                        <td style={{ textAlign: "right" }}>
                          {k.revokedAt ? (
                            <span className="pill pill-muted" title={`Revoked ${formatDate(k.revokedAt)}`}>
                              Revoked
                            </span>
                          ) : (
                            <button
                              type="button"
                              className="btn btn-sm"
                              onClick={() => {
                                setRevokeError(null);
                                setTarget(k);
                              }}
                              aria-label={`Revoke ${k.name}`}
                              style={{ height: 40, padding: "0 14px", background: "var(--surface)", borderColor: "var(--border)", color: "var(--error)" }}
                            >
                              Revoke
                            </button>
                          )}
                        </td>
                      </tr>
                    ))
                  : [0, 1, 2].map((i) => (
                      <tr key={i}>
                        {[140, 170, 90, 80].map((w) => (
                          <td key={w}>
                            <span className="skeleton" style={{ display: "inline-block", width: w, height: 16 }}>
                              &nbsp;
                            </span>
                          </td>
                        ))}
                        <td style={{ textAlign: "right" }}>
                          <span className="skeleton" style={{ display: "inline-block", width: 72, height: 16 }}>
                            &nbsp;
                          </span>
                        </td>
                      </tr>
                    ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <Reveal>
      <section aria-label="Code sample" style={{ background: "var(--night)", borderRadius: 14, overflow: "hidden", color: "#E2E8F0" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 12, padding: "12px 16px", borderBottom: "1px solid #1E293B" }}>
          <div role="tablist" aria-label="Code sample" style={{ display: "flex", gap: 4 }}>
            {TABS.map((t) => {
              const on = tab === t.id;
              return (
                <button
                  key={t.id}
                  type="button"
                  role="tab"
                  id={`code-tab-${t.id}`}
                  aria-selected={on}
                  aria-controls="code-panel"
                  onClick={() => setTab(t.id)}
                  style={{ height: 36, padding: "0 12px", border: "none", borderRadius: 8, background: on ? "#1E293B" : "transparent", color: on ? "#FFFFFF" : "#94A3B8", fontWeight: on ? 700 : 600, fontSize: 13, transition: "background-color 0.2s var(--ease-out), color 0.2s var(--ease-out)" }}
                >
                  {t.label}
                </button>
              );
            })}
          </div>
          <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
            <button
              type="button"
              onClick={copyCode}
              style={{ height: 36, padding: "0 12px", border: "1px solid #334155", background: "transparent", color: "#E2E8F0", borderRadius: 8, fontWeight: 700, fontSize: 13, display: "inline-flex", gap: 6, alignItems: "center" }}
            >
              <Icon name="copy" size={16} />
              Copy
            </button>
            <a href={`${API_URL}/docs`} target="_blank" rel="noreferrer" style={{ color: "var(--teal-on-dark)", fontWeight: 700, fontSize: 13 }}>
              API reference<span className="sr-only"> (opens in a new tab)</span>
            </a>
          </div>
        </div>
        <pre
          key={tab}
          id="code-panel"
          role="tabpanel"
          aria-labelledby={`code-tab-${tab}`}
          tabIndex={0}
          className="mono"
          style={{ margin: 0, padding: 20, fontSize: 13, lineHeight: 1.7, overflowX: "auto", whiteSpace: "pre", color: "#E2E8F0", animation: "slide-in-left 0.3s var(--ease-out) both" }}
        >
          {samples[tab]}
        </pre>
        <p style={{ padding: "12px 20px 16px", borderTop: "1px solid #1E293B", fontSize: 13, color: "#94A3B8", lineHeight: 1.6 }}>
          Each batch is an unsigned Stellar transaction. Sign it with the funding wallet wherever its key lives (it never comes to OrgPay) and submit it back; while a
          transaction is open, <code className="mono" style={{ color: "#E2E8F0" }}>transactions/next</code> returns that same transaction, so nobody is ever paid twice.
          {sampleWallet ? null : (
            <>
              {" "}
              Replace <code className="mono" style={{ color: "#E2E8F0" }}>{WALLET_PLACEHOLDER}</code> with the ID of a funding wallet; add one in{" "}
              <Link href="/settings" style={{ color: "var(--teal-on-dark)", fontWeight: 700 }}>
                Settings
              </Link>
              .
            </>
          )}
        </p>
      </section>
      </Reveal>

      <Dialog open={createOpen} onClose={closeCreate} title="Create an API key" width={480}>
        <form onSubmit={create} noValidate style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {createError ? (
            <div role="alert" className="alert">
              {createError}
            </div>
          ) : null}
          <div className="field">
            <label htmlFor="kname" className="label">
              Name
            </label>
            <input
              id="kname"
              className={`input${shownNameError ? " invalid" : ""}`}
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setNameServerError(null);
              }}
              placeholder="e.g. Mobile app"
              maxLength={64}
              autoComplete="off"
              aria-invalid={shownNameError ? true : undefined}
              aria-describedby="kname-hint"
            />
            {shownNameError ? (
              <span className="field-error" role="alert" style={{ fontWeight: 600 }}>
                {shownNameError}
              </span>
            ) : null}
            <span id="kname-hint" style={{ fontSize: 13, color: "var(--slate)" }}>
              Name it after where it&apos;ll live, so you know what breaks if you revoke it.
            </span>
          </div>
          <div style={{ background: "var(--row)", borderRadius: 10, padding: "12px 14px", fontSize: 14, color: "var(--slate-strong)", display: "flex", justifyContent: "space-between", gap: 12 }}>
            <span>Network</span>
            <span style={{ fontWeight: 700 }}>Stellar Testnet</span>
          </div>
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, flexWrap: "wrap" }}>
            <button type="button" className="btn btn-secondary" onClick={closeCreate} disabled={creating} aria-busy={creating} style={{ fontSize: 15 }}>
              Cancel
            </button>
            <button type="submit" className="btn btn-primary" disabled={creating} aria-busy={creating} style={{ fontSize: 15 }}>
              {creating ? "Creating…" : "Create key"}
            </button>
          </div>
        </form>
      </Dialog>

      <Dialog key={revealNonce} open={reveal !== null} onClose={finish} title="Copy your new key" width={520}>
        {reveal ? (
          <>
            <span className="sub" style={{ marginTop: -12 }}>
              {reveal.name} · created just now
            </span>
            <div style={{ display: "flex", gap: 8, alignItems: "stretch" }}>
              <span
                className="mono anim-scale-in"
                style={{ flex: 1, minWidth: 0, fontSize: 13, background: "var(--row)", border: "1px solid var(--border)", borderRadius: 10, padding: 12, wordBreak: "break-all", userSelect: "all" }}
              >
                {reveal.key}
              </span>
              <button type="button" className="btn btn-secondary" onClick={copyKey} style={{ height: "auto", minHeight: 46, padding: "0 18px", fontSize: 15 }}>
                <Icon name="copy" size={16} />
                <span aria-live="polite">{copied ? "Copied" : "Copy"}</span>
              </button>
            </div>
            <div style={{ background: "var(--attention-bg)", border: "1px solid var(--attention-border)", borderRadius: 12, padding: "12px 14px", fontSize: 14, color: "#713F12" }}>
              You won&apos;t see this key again. Store it in your server&apos;s environment variables. Never put it in a browser, a mobile app bundle or a public repo.
            </div>
            <label style={{ display: "flex", gap: 10, alignItems: "center", fontSize: 14, fontWeight: 600, minHeight: 44 }}>
              <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} style={{ width: 20, height: 20, accentColor: "var(--teal)", margin: 0, flexShrink: 0 }} />
              I&apos;ve saved this key somewhere safe
            </label>
            <div style={{ display: "flex", justifyContent: "flex-end" }}>
              <button
                type="button"
                className="btn"
                onClick={finish}
                disabled={!saved}
                style={{ padding: "0 24px", fontSize: 15, opacity: 1, background: saved ? "var(--teal)" : "var(--border)", color: saved ? "#FFFFFF" : "#64748B" }}
              >
                Done
              </button>
            </div>
          </>
        ) : null}
      </Dialog>

      <Dialog
        open={target !== null}
        onClose={closeRevoke}
        title={`Revoke “${target?.name ?? ""}”?`}
        width={480}
        footer={
          <>
            <button type="button" className="btn btn-secondary" onClick={closeRevoke} disabled={revoking} aria-busy={revoking} style={{ fontSize: 15 }}>
              Keep key
            </button>
            <button type="button" className="btn" onClick={revoke} disabled={revoking} aria-busy={revoking} style={{ fontSize: 15, background: "var(--error)", color: "#FFFFFF" }}>
              {revoking ? "Revoking…" : "Revoke key"}
            </button>
          </>
        }
      >
        <span style={{ fontSize: 15, color: "var(--slate)" }}>Anything using this key stops working right away. Runs it already created stay as they are. This can&apos;t be undone.</span>
        {revokeError ? (
          <div role="alert" className="alert">
            {revokeError}
          </div>
        ) : null}
      </Dialog>
    </>
  );
}
