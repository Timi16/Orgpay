"use client";

import { useEffect, useRef, useState } from "react";
import { useSWRConfig } from "swr";
import { CopyButton } from "@/components/CopyButton";
import { Icon } from "@/components/Icon";
import { ItemStatusPill } from "@/components/StatusPill";
import { useToast } from "@/components/Toast";
import { api, errorMessage } from "@/lib/api";
import { explorerTx } from "@/lib/config";
import { formatAmount, formatDateTime, shortAddress, shortHash } from "@/lib/format";
import { IN_FLIGHT, REASON_FIX, REASON_SHORT } from "@/lib/payroll";
import { VerifyPayment } from "@/components/payroll/VerifyPayment";
import type { ItemStatus, Run, RunItem } from "@/lib/types";

type Filter = "all" | ItemStatus;
const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "SUCCESSFUL", label: "Successful" },
  { id: "FAILED", label: "Failed" },
  { id: "SUBMITTED", label: "Confirming" },
  { id: "AWAITING_SIGNATURE", label: "Waiting for signature" },
  { id: "PENDING", label: "Pending" },
  { id: "CANCELLED", label: "Cancelled" },
];

const AMOUNT = /^\d{1,12}(\.\d{1,7})?$/;

/** A draft line's amount, saved when the field loses focus (or on Enter). */
function AmountCell({ run, item, onSaving }: { run: Run; item: RunItem; onSaving: (delta: 1 | -1) => void }) {
  const { mutate } = useSWRConfig();
  const toast = useToast();
  const initial = formatAmount(item.amount, 2).replace(/,/g, "");
  const [value, setValue] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    const v = value.trim().replace(/,/g, "");
    if (v === initial) return setError(null);
    if (!AMOUNT.test(v) || !/[1-9]/.test(v)) return setError("Enter an amount above 0, up to 7 decimals.");
    setBusy(true);
    onSaving(1);
    setError(null);
    try {
      const res = await api.patch<{ run: Run }>(`/v1/payroll-runs/${run.id}/payments/${item.id}`, { amount: v });
      await mutate(`/v1/payroll-runs/${run.id}`, res, { revalidate: false });
      toast(`${item.name}: ${formatAmount(v)} USDC`);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
      onSaving(-1);
    }
  };

  const errId = `amount-err-${item.id}`;
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 4 }}>
      <input
        className={`input amount${error ? " invalid" : ""}`}
        style={{ width: 150, height: 38 }}
        value={value}
        inputMode="decimal"
        aria-label={`Amount for ${item.name}, USDC`}
        aria-invalid={Boolean(error)}
        aria-describedby={error ? errId : undefined}
        disabled={busy}
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => void save()}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        }}
      />
      {error ? <span id={errId} className="field-error" style={{ fontSize: 12, maxWidth: 180, textAlign: "right" }}>{error}</span> : null}
    </div>
  );
}

function Outcome({ item }: { item: RunItem }) {
  if (item.status === "SUCCESSFUL" && item.txHash) {
    return (
      <span style={{ display: "inline-flex", alignItems: "center", gap: 6, marginTop: 4, flexWrap: "wrap" }}>
        <a href={explorerTx(item.txHash)} target="_blank" rel="noreferrer" className="hash" title={item.txHash}>
          {shortHash(item.txHash)} <Icon name="external" size={12} />
        </a>
        <CopyButton value={item.txHash} className="btn-link" label="Copy" ariaLabel={`Copy the transaction hash for ${item.name}`} style={{ fontSize: 12 }} />
        <span className="verified-mark"><Icon name="shield" size={12} /> Verified{item.ledger ? ` · ledger ${item.ledger}` : ""}</span>
        <VerifyPayment item={item} />
      </span>
    );
  }
  if (item.status === "FAILED" && item.failureCode) {
    return (
      <span className="why" title={REASON_FIX[item.failureCode]}>
        {REASON_SHORT[item.failureCode]} · nothing sent
      </span>
    );
  }
  return null;
}

export function Lines({ run, onSaving }: { run: Run; onSaving: (delta: 1 | -1) => void }) {
  const { mutate } = useSWRConfig();
  const toast = useToast();
  const [filter, setFilter] = useState<Filter>("all");
  const [removing, setRemoving] = useState<Set<string>>(new Set());
  // Lines whose status just changed to Paid or Not sent glow once, so a live update is noticed.
  const previous = useRef<Map<string, ItemStatus> | null>(null);
  const glowTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [fresh, setFresh] = useState<Map<string, "just-paid" | "just-failed">>(new Map());
  useEffect(() => {
    const before = previous.current;
    previous.current = new Map(run.payments.map((i) => [i.id, i.status]));
    if (!before) return; // first render: nothing "just" changed
    const changed = new Map<string, "just-paid" | "just-failed">();
    for (const i of run.payments) {
      const was = before.get(i.id);
      if (was && was !== i.status && (i.status === "SUCCESSFUL" || i.status === "FAILED")) changed.set(i.id, i.status === "SUCCESSFUL" ? "just-paid" : "just-failed");
    }
    if (changed.size === 0) return;
    setFresh(changed);
    // Not cancelled by the next poll: the glow always ends, once.
    if (glowTimer.current) clearTimeout(glowTimer.current);
    glowTimer.current = setTimeout(() => setFresh(new Map()), 2400);
  }, [run.payments]);
  useEffect(() => () => {
    if (glowTimer.current) clearTimeout(glowTimer.current);
  }, []);
  const draft = run.status === "DRAFT";
  const count = (f: Filter) => (f === "all" ? run.payments.length : run.payments.filter((i) => i.status === f).length);
  // A filter whose lines have all moved on (e.g. "Sending" after they settle) falls back to All.
  const active: Filter = filter !== "all" && count(filter) === 0 ? "all" : filter;
  const shown = active === "all" ? run.payments : run.payments.filter((i) => i.status === active);

  const remove = async (item: RunItem) => {
    if (removing.has(item.id)) return;
    setRemoving((s) => new Set(s).add(item.id));
    try {
      const res = await api.delete<{ run: Run }>(`/v1/payroll-runs/${run.id}/payments/${item.id}`);
      await mutate(`/v1/payroll-runs/${run.id}`, res, { revalidate: false });
      toast(`${item.name} removed from this run`);
    } catch (err) {
      toast(errorMessage(err));
    } finally {
      setRemoving((s) => {
        const next = new Set(s);
        next.delete(item.id);
        return next;
      });
    }
  };

  return (
    <>
      {!draft && run.payments.length > 0 ? (
        <div style={{ padding: "0 28px 14px" }}>
          <div className="seg" role="group" aria-label="Filter payments by status">
            {FILTERS.filter((f) => f.id === "all" || count(f.id) > 0).map((f) => (
              <button key={f.id} type="button" aria-pressed={active === f.id} onClick={() => setFilter(f.id)}>
                {f.label}
                <span className="count">{count(f.id)}</span>
              </button>
            ))}
          </div>
        </div>
      ) : null}
      {run.payments.length === 0 ? (
        <div className="empty">
          <strong>Nobody on this run yet</strong>
          <span>Add people or whole groups.</span>
        </div>
      ) : (
        <div className="table-wrap">
          <table className="table stack">
            <thead>
              <tr>
                <th className="hide-sm">#</th>
                <th>Person</th>
                <th className="num">Amount (USDC)</th>
                <th>{draft ? "" : "Status"}</th>
                {!draft ? <th className="hide-sm">Paid at</th> : null}
                {draft ? (
                  <th>
                    <span className="sr-only">Remove</span>
                  </th>
                ) : null}
              </tr>
            </thead>
            <tbody>
              {shown.map((item) => (
                <tr key={item.id} className={fresh.get(item.id)}>
                  <td className="idx hide-sm">{String(item.position).padStart(2, "0")}</td>
                  <td>
                    <span className="who">
                      <b>{item.name}</b>
                      <span title={item.walletAddress}>{shortAddress(item.walletAddress, 5, 5)}</span>
                    </span>
                  </td>
                  <td className="num">{draft ? <AmountCell run={run} item={item} onSaving={onSaving} /> : formatAmount(item.amount)}</td>
                  <td className="full">
                    {draft ? null : (
                      <>
                        <ItemStatusPill status={item.status} />
                        {item.transactionNumber && IN_FLIGHT.includes(item.status) ? <span className="faint" style={{ fontSize: 12, marginLeft: 8 }}>transaction {item.transactionNumber}</span> : null}
                        <div>
                          <Outcome item={item} />
                        </div>
                      </>
                    )}
                  </td>
                  {!draft ? (
                    <td className="hide-sm muted" style={{ fontSize: 13 }}>
                      {item.paidAt ? (
                        <>
                          {formatDateTime(item.paidAt)}
                          <div className="faint mono" style={{ fontSize: 11 }}>
                            ledger {item.ledger}
                            {item.transactionNumber ? ` · transaction ${item.transactionNumber}` : ""}
                          </div>
                        </>
                      ) : (
                        "—"
                      )}
                    </td>
                  ) : null}
                  {draft ? (
                    <td style={{ textAlign: "right" }}>
                      <button type="button" className="icon-btn" aria-label={`Remove ${item.name} from this run`} disabled={removing.has(item.id)} onClick={() => void remove(item)}>
                        <Icon name="x" size={16} />
                      </button>
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
