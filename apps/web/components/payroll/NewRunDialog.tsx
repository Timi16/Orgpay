"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import useSWR, { useSWRConfig } from "swr";
import { Dialog } from "@/components/Dialog";
import { walletName } from "@/components/wallets/useVerifyWallet";
import { api, ApiError, errorMessage, newIdempotencyKey } from "@/lib/api";
import { formatAmount, sumAmounts } from "@/lib/format";
import { useGroups, useWallets } from "@/lib/session";
import type { EmployeePage, Run } from "@/lib/types";

function defaultName(): string {
  return `${new Date().toLocaleDateString("en-GB", { month: "long" })} payroll`;
}

function lastDayOfMonth(): string {
  const now = new Date();
  const last = new Date(Date.UTC(now.getFullYear(), now.getMonth() + 1, 0));
  return last.toISOString().slice(0, 10);
}

/** Draft a run: name, pay date, funding wallet, and who is on it (whole groups and/or people). */
export function NewRunDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const router = useRouter();
  const { mutate } = useSWRConfig();
  const { data: wallets } = useWallets();
  const { data: groups } = useGroups();
  const { data: people } = useSWR<EmployeePage>(open ? "/v1/employees?limit=500" : null);

  const [name, setName] = useState(defaultName);
  const [payDate, setPayDate] = useState(lastDayOfMonth);
  const [walletId, setWalletId] = useState<string>("");
  const [groupIds, setGroupIds] = useState<Set<string>>(new Set());
  const [employeeIds, setEmployeeIds] = useState<Set<string>>(new Set());
  const [q, setQ] = useState("");
  const [batched, setBatched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // One key per opening of the dialog: a double submit, or a retry after a dropped answer, makes one run.
  const idempotencyKey = useMemo(() => (open ? newIdempotencyKey() : ""), [open]);

  const chosenWallet = walletId || wallets?.data[0]?.id || "";
  const everyone = useMemo(() => people?.data ?? [], [people]);
  // Who would be on the run: anyone picked directly or through a group, once.
  const picked = useMemo(
    () => everyone.filter((e) => employeeIds.has(e.id) || (e.group !== null && groupIds.has(e.group.id))),
    [everyone, employeeIds, groupIds],
  );
  const total = sumAmounts(picked.map((e) => e.salary));
  const shown = q.trim() ? everyone.filter((e) => `${e.name} ${e.email ?? ""} ${e.group?.name ?? ""}`.toLowerCase().includes(q.trim().toLowerCase())) : everyone;

  const toggle = (set: Set<string>, id: string, update: (s: Set<string>) => void) => {
    const next = new Set(set);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    update(next);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.post<{ run: Run }>("/v1/payroll-runs", {
        name: name.trim(),
        walletId: chosenWallet,
        payDate: payDate || null,
        groupIds: [...groupIds],
        employeeIds: [...employeeIds],
        paymentsPerTx: batched ? 100 : 1,
      }, { idempotencyKey });
      void mutate("/v1/summary");
      void mutate((key) => typeof key === "string" && key.startsWith("/v1/payroll-runs"));
      onClose();
      router.push(`/payroll/${res.run.id}`);
    } catch (err) {
      setError(err instanceof ApiError && err.field("name") ? (err.field("name") ?? null) : errorMessage(err));
      setBusy(false);
    }
  };

  const noWallet = wallets && wallets.data.length === 0;
  const noPeople = people && people.data.length === 0;

  return (
    <Dialog open={open} onClose={onClose} title="New payroll run" width={620}>
      {noWallet ? (
        <div className="notice">
          Add a funding wallet first: the Stellar account you&apos;ll pay from. <Link href="/settings#wallets">Add one in Settings</Link>.
        </div>
      ) : noPeople ? (
        <div className="notice">
          Add the people you pay first. <Link href="/people">Go to People</Link>.
        </div>
      ) : (
        <form onSubmit={submit} noValidate style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12 }}>
            <div className="field">
              <label htmlFor="run-name" className="label">
                Name
              </label>
              <input id="run-name" className="input" value={name} maxLength={100} onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="field">
              <label htmlFor="run-date" className="label">
                Pay date
              </label>
              <input id="run-date" type="date" className="input" value={payDate} onChange={(e) => setPayDate(e.target.value)} />
            </div>
          </div>
          <div className="field">
            <label htmlFor="run-wallet" className="label">
              Pay from
            </label>
            <select id="run-wallet" className="select" value={chosenWallet} onChange={(e) => setWalletId(e.target.value)}>
              {wallets?.data.map((w) => (
                <option key={w.id} value={w.id}>
                  {walletName(w)}
                  {w.usdcBalance !== null ? ` · ${formatAmount(w.usdcBalance)} USDC` : ""}
                </option>
              ))}
            </select>
          </div>

          <fieldset style={{ border: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 8 }}>
            <legend className="label" style={{ marginBottom: 8 }}>
              How payments are sent
            </legend>
            <label className={`choice${batched ? "" : " choice-on"}`}>
              <input type="radio" name="ppt" checked={!batched} onChange={() => setBatched(false)} />
              <span>
                <b>One transaction per employee</b> <span className="faint">· recommended</span>
                <br />
                <span className="muted" style={{ fontSize: 13 }}>Every payment gets its own hash. You sign once per employee.</span>
              </span>
            </label>
            <label className={`choice${batched ? " choice-on" : ""}`}>
              <input type="radio" name="ppt" checked={batched} onChange={() => setBatched(true)} />
              <span>
                <b>Batch up to 100 per transaction</b>
                <br />
                <span className="muted" style={{ fontSize: 13 }}>Fewer signatures; payments in a batch share one hash.</span>
              </span>
            </label>
          </fieldset>

          {groups && groups.data.length > 0 ? (
            <fieldset style={{ border: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 8 }}>
              <legend className="label" style={{ marginBottom: 8 }}>
                Whole groups
              </legend>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                {groups.data.map((g) => {
                  const on = groupIds.has(g.id);
                  return (
                    <button
                      type="button"
                      key={g.id}
                      aria-pressed={on}
                      className={`btn btn-sm ${on ? "btn-dark" : "btn-secondary"}`}
                      onClick={() => toggle(groupIds, g.id, setGroupIds)}
                    >
                      {g.name} <span className="mono" style={{ fontSize: 11, opacity: 0.75 }}>{g.employeeCount}</span>
                    </button>
                  );
                })}
              </div>
            </fieldset>
          ) : null}

          <fieldset style={{ border: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 8 }}>
            <legend className="label" style={{ marginBottom: 8 }}>
              People
            </legend>
            <div style={{ display: "flex", gap: 8 }}>
              <input className="input" placeholder="Search people" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search people" style={{ height: 40 }} />
              <button type="button" className="btn btn-secondary btn-sm" style={{ height: 40 }} onClick={() => setEmployeeIds(new Set(everyone.map((e) => e.id)))}>
                Everyone
              </button>
            </div>
            <ul style={{ listStyle: "none", margin: 0, padding: 0, maxHeight: 220, overflowY: "auto", border: "1px solid var(--rule)", borderRadius: 4, background: "var(--paper)" }}>
              {!people ? (
                <li className="skeleton" style={{ height: 120, margin: 8 }} />
              ) : (
                shown.map((e) => {
                  const viaGroup = e.group !== null && groupIds.has(e.group.id);
                  const checked = viaGroup || employeeIds.has(e.id);
                  return (
                    <li key={e.id} style={{ borderBottom: "1px solid var(--rule-soft)" }}>
                      <label className="check" style={{ padding: "10px 12px", alignItems: "center", cursor: viaGroup ? "default" : "pointer" }}>
                        <input type="checkbox" checked={checked} disabled={viaGroup} onChange={() => toggle(employeeIds, e.id, setEmployeeIds)} />
                        <span style={{ flex: 1, minWidth: 0 }}>
                          <b style={{ fontWeight: 600 }}>{e.name}</b>
                          <span className="faint" style={{ fontSize: 12 }}>
                            {e.group ? ` · ${e.group.name}` : ""}
                            {viaGroup ? " (via group)" : ""}
                          </span>
                        </span>
                        <span className="mono tnum" style={{ fontSize: 13 }}>
                          {formatAmount(e.salary)}
                        </span>
                      </label>
                    </li>
                  );
                })
              )}
            </ul>
          </fieldset>

          <div className="divider" style={{ paddingTop: 14, display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 16, flexWrap: "wrap" }}>
            <div className="muted" style={{ fontSize: 14 }}>
              {picked.length} {picked.length === 1 ? "person" : "people"} · you can change amounts next
            </div>
            <div className="money total-rule" style={{ fontSize: 30 }} aria-label={`Total ${formatAmount(total)} USDC`}>
              {formatAmount(total)}
              <span className="unit">USDC</span>
            </div>
          </div>
          {error ? (
            <div role="alert" className="alert">
              {error}
            </div>
          ) : null}
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, flexWrap: "wrap" }}>
            <button type="button" className="btn btn-secondary" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="btn btn-primary" disabled={busy || !name.trim() || !chosenWallet} aria-busy={busy}>
              Create draft
            </button>
          </div>
        </form>
      )}
    </Dialog>
  );
}
