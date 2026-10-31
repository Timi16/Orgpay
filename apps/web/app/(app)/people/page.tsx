"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import useSWR, { useSWRConfig } from "swr";
import { CopyButton } from "@/components/CopyButton";
import { Icon } from "@/components/Icon";
import { Pill } from "@/components/StatusPill";
import { useToast } from "@/components/Toast";
import { api, errorMessage, qs } from "@/lib/api";
import { explorerAccount } from "@/lib/config";
import { formatAmount, initials, shortAddress, sumAmounts } from "@/lib/format";
import { REASON_FIX, REASON_SHORT } from "@/lib/payroll";
import { useGroups } from "@/lib/session";
import type { Employee, EmployeePage } from "@/lib/types";
import { EmployeeDialog, invalidateEmployees } from "./_components/EmployeeDialog";
import { GroupsDialog } from "./_components/GroupsDialog";
import { ImportDialog } from "./_components/ImportDialog";

function Readiness({ employee }: { employee: Employee }) {
  const c = employee.check;
  if (c.status === "ready") return <Pill tone="good" icon="check">Can receive</Pill>;
  if (c.status === "unchecked") return <Pill tone="muted" icon="clock">Not checked</Pill>;
  return (
    <span title={c.reason ? REASON_FIX[c.reason] : undefined}>
      <Pill tone="danger" icon="x">
        {c.reason ? REASON_SHORT[c.reason] : "Can't receive"}
      </Pill>
    </span>
  );
}

function PeopleView() {
  const params = useSearchParams();
  const router = useRouter();
  const toast = useToast();
  const { mutate } = useSWRConfig();
  const { data: groups } = useGroups();
  const [q, setQ] = useState("");
  const group = params.get("group") ?? "";
  const archived = params.get("archived") === "1";
  const onlyProblems = params.get("ready") === "problem";
  const key = `/v1/employees${qs({ limit: 500, q: q.trim() || undefined, groupId: group || undefined, status: archived ? "inactive" : undefined })}`;
  const { data, error, isLoading, mutate: reload } = useSWR<EmployeePage>(key, { keepPreviousData: true });
  const [editing, setEditing] = useState<Employee | null | "new">(null);
  const [groupsOpen, setGroupsOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [checking, setChecking] = useState(false);
  const [archiving, setArchiving] = useState<string | null>(null);

  const setParam = (k: string, v: string | null) => {
    const next = new URLSearchParams(params.toString());
    if (v) next.set(k, v);
    else next.delete(k);
    router.replace(`/people${next.toString() ? `?${next.toString()}` : ""}`);
  };

  const rows = (data?.data ?? []).filter((e) => !onlyProblems || e.check.status === "problem");
  const totalGroups = groups?.data.length ?? 0;

  const checkAll = async () => {
    setChecking(true);
    try {
      const res = await api.post<{ data: Employee[] }>("/v1/employees/check", {});
      await invalidateEmployees(mutate);
      const bad = res.data.filter((e) => e.check.status === "problem").length;
      toast(bad ? `Checked ${res.data.length} wallets · ${bad} can't receive USDC` : `Checked ${res.data.length} wallets · all can receive USDC`);
    } catch (err) {
      toast(errorMessage(err));
    } finally {
      setChecking(false);
    }
  };

  const archive = async (e: Employee) => {
    if (archiving) return;
    setArchiving(e.id);
    try {
      await api.post(`/v1/employees/${e.id}/${e.active ? "deactivate" : "reactivate"}`);
      await invalidateEmployees(mutate);
      toast(e.active ? `${e.name} deactivated · left out of new runs` : `${e.name} reactivated`);
    } catch (err) {
      toast(errorMessage(err));
    } finally {
      setArchiving(null);
    }
  };

  return (
    <>
      <header className="page-head">
        <div>
          <span className="eyebrow">People</span>
          <h1 className="h1">
            {data && !q && !group && !archived ? (
              <>
                {data.total} {data.total === 1 ? "person" : "people"}, {totalGroups} {totalGroups === 1 ? "group" : "groups"}
              </>
            ) : archived ? (
              "Archived people"
            ) : (
              "Your people"
            )}
          </h1>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button type="button" className="btn btn-secondary" onClick={checkAll} disabled={checking} aria-busy={checking}>
            <Icon name="refresh" size={16} /> Check wallets
          </button>
          <button type="button" className="btn btn-secondary" onClick={() => setImportOpen(true)}>
            <Icon name="upload" size={16} /> Import
          </button>
          <button type="button" className="btn btn-dark" onClick={() => setEditing("new")}>
            <Icon name="plus" size={16} /> Add person
          </button>
        </div>
      </header>

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
        <div style={{ position: "relative", flex: "1 1 240px", maxWidth: 340 }}>
          <span style={{ position: "absolute", left: 12, top: 13, color: "var(--ink-3)" }}>
            <Icon name="search" size={16} />
          </span>
          <input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, email, role or wallet" aria-label="Search people" style={{ paddingLeft: 36, borderRadius: 999 }} />
        </div>
        <div className="seg" role="group" aria-label="Filter by group">
          <button type="button" aria-pressed={!group} onClick={() => setParam("group", null)}>
            All
          </button>
          {groups?.data.map((g) => (
            <button type="button" key={g.id} aria-pressed={group === g.id} onClick={() => setParam("group", g.id)}>
              {g.name}
              <span className="count">{g.employeeCount}</span>
            </button>
          ))}
          <button type="button" aria-pressed={group === "none"} onClick={() => setParam("group", "none")}>
            No group
          </button>
        </div>
        <button type="button" className="btn-link" onClick={() => setGroupsOpen(true)}>
          Manage groups
        </button>
      </div>
      <div style={{ display: "flex", gap: 16, flexWrap: "wrap", marginTop: -16 }}>
        <label className="check" style={{ fontSize: 13 }}>
          <input type="checkbox" checked={onlyProblems} onChange={(e) => setParam("ready", e.target.checked ? "problem" : null)} />
          Only people who can&apos;t receive USDC
        </label>
        <label className="check" style={{ fontSize: 13 }}>
          <input type="checkbox" checked={archived} onChange={(e) => setParam("archived", e.target.checked ? "1" : null)} />
          Show deactivated
        </label>
      </div>

      <section className="sheet" aria-label="People">
        {error && !data ? (
          <div className="empty" role="alert">
            <strong>People didn&apos;t load</strong>
            <span>{errorMessage(error)}</span>
            <button type="button" className="btn btn-primary" onClick={() => void reload()}>
              Try again
            </button>
          </div>
        ) : isLoading && !data ? (
          <div style={{ padding: 28, display: "flex", flexDirection: "column", gap: 10 }} aria-busy="true">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="skeleton" style={{ height: 44 }} />
            ))}
          </div>
        ) : rows.length === 0 ? (
          <div className="empty">
            <strong>{q || group || onlyProblems || archived ? "Nobody matches" : "No people yet"}</strong>
            <span>{q || group || onlyProblems || archived ? "Try another search or filter." : "Add the people you pay, one by one or from a spreadsheet."}</span>
            {!(q || group || onlyProblems || archived) ? (
              <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                <button type="button" className="btn btn-dark" onClick={() => setEditing("new")}>
                  Add person
                </button>
                <button type="button" className="btn btn-secondary" onClick={() => setImportOpen(true)}>
                  Import
                </button>
              </div>
            ) : null}
          </div>
        ) : (
          <div className="table-wrap">
            <table className="table stack">
              <thead>
                <tr>
                  <th className="hide-sm">#</th>
                  <th>Name</th>
                  <th>Wallet</th>
                  <th className="hide-sm">Group</th>
                  <th className="num">Default (USDC)</th>
                  <th>Can receive USDC</th>
                  <th>
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((e, i) => (
                  <tr key={e.id}>
                    <td className="idx hide-sm">{String(i + 1).padStart(2, "0")}</td>
                    <td>
                      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                        <span aria-hidden="true" style={{ width: 32, height: 32, flexShrink: 0, borderRadius: "50%", background: "var(--green-tint)", color: "var(--green-hover)", display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 12, fontWeight: 700 }}>
                          {initials(e.name)}
                        </span>
                        <span className="who">
                          <b>{e.name}</b>
                          <span style={{ fontFamily: "var(--font-sans)" }}>{[e.role, e.email].filter(Boolean).join(" · ") || "—"}</span>
                        </span>
                      </div>
                    </td>
                    <td className="full">
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                        <a href={explorerAccount(e.walletAddress)} target="_blank" rel="noreferrer" className="hash" title={e.walletAddress}>
                          {shortAddress(e.walletAddress, 5, 5)}
                        </a>
                        <CopyButton value={e.walletAddress} className="btn-link" label="Copy" ariaLabel={`Copy ${e.name}'s wallet address`} style={{ fontSize: 12 }} />
                      </span>
                    </td>
                    <td className="hide-sm">{e.group ? <span className="chip-tag">{e.group.name}</span> : <span className="faint">—</span>}</td>
                    <td className="num">{formatAmount(e.salary)}</td>
                    <td>
                      <Readiness employee={e} />
                    </td>
                    <td style={{ whiteSpace: "nowrap", textAlign: "right" }}>
                      <button type="button" className="btn-link" onClick={() => setEditing(e)} aria-label={`Edit ${e.name}`}>
                        Edit
                      </button>
                      <span className="faint"> · </span>
                      <button type="button" className="btn-link" style={{ color: "var(--ink-2)" }} disabled={archiving === e.id} onClick={() => void archive(e)} aria-label={`${e.active ? "Deactivate" : "Reactivate"} ${e.name}`}>

                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="divider" style={{ padding: "16px 28px", display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
              <span className="muted">
                {rows.length} shown{data && data.nextCursor ? " (first 500)" : ""}
              </span>
              <span className="muted">
                Default total <span className="mono tnum" style={{ color: "var(--ink)" }}>{formatAmount(sumAmounts(rows.map((r) => r.salary)))} USDC</span>
              </span>
            </div>
          </div>
        )}
      </section>

      {editing ? <EmployeeDialog open onClose={() => setEditing(null)} employee={editing === "new" ? null : editing} /> : null}
      <GroupsDialog open={groupsOpen} onClose={() => setGroupsOpen(false)} />
      <ImportDialog open={importOpen} onClose={() => setImportOpen(false)} />
    </>
  );
}

export default function PeoplePage() {
  return (
    <Suspense fallback={null}>
      <PeopleView />
    </Suspense>
  );
}
