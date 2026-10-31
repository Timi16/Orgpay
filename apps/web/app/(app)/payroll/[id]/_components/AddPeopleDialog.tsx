"use client";

import { useState } from "react";
import useSWR, { useSWRConfig } from "swr";
import { Dialog } from "@/components/Dialog";
import { api, errorMessage } from "@/lib/api";
import { formatAmount } from "@/lib/format";
import { useGroups } from "@/lib/session";
import type { EmployeePage, Run } from "@/lib/types";

/** Adds people (or whole groups) to a draft. People already on the run are left as they are. */
export function AddPeopleDialog({ run, open, onClose }: { run: Run; open: boolean; onClose: () => void }) {
  const { mutate } = useSWRConfig();
  const { data: groups } = useGroups();
  const { data: people } = useSWR<EmployeePage>(open ? "/v1/employees?limit=500" : null);
  const [groupIds, setGroupIds] = useState<Set<string>>(new Set());
  const [ids, setIds] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const onRun = new Set(run.payments.map((i) => i.employeeId));
  const available = (people?.data ?? []).filter((e) => !onRun.has(e.id));

  const flip = (set: Set<string>, id: string, update: (s: Set<string>) => void) => {
    const next = new Set(set);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    update(next);
  };

  const add = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await api.post<{ run: Run }>(`/v1/payroll-runs/${run.id}/payments`, { groupIds: [...groupIds], employeeIds: [...ids] });
      await mutate(`/v1/payroll-runs/${run.id}`, res, { revalidate: false });
      setGroupIds(new Set());
      setIds(new Set());
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} title="Add people" width={560}>
      {groups && groups.data.length > 0 ? (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }} role="group" aria-label="Whole groups">
          {groups.data.map((g) => (
            <button key={g.id} type="button" aria-pressed={groupIds.has(g.id)} className={`btn btn-sm ${groupIds.has(g.id) ? "btn-dark" : "btn-secondary"}`} onClick={() => flip(groupIds, g.id, setGroupIds)}>
              {g.name} <span className="mono" style={{ fontSize: 11, opacity: 0.75 }}>{g.employeeCount}</span>
            </button>
          ))}
        </div>
      ) : null}
      <ul style={{ listStyle: "none", margin: 0, padding: 0, maxHeight: 300, overflowY: "auto", border: "1px solid var(--rule)", borderRadius: 4, background: "var(--paper)" }}>
        {!people ? <li className="skeleton" style={{ height: 120, margin: 8 }} /> : null}
        {people && available.length === 0 ? <li className="faint" style={{ padding: 14 }}>Everyone is already on this run.</li> : null}
        {available.map((e) => (
          <li key={e.id} style={{ borderBottom: "1px solid var(--rule-soft)" }}>
            <label className="check" style={{ padding: "10px 12px", alignItems: "center" }}>
              <input type="checkbox" checked={ids.has(e.id) || (e.group !== null && groupIds.has(e.group.id))} disabled={e.group !== null && groupIds.has(e.group.id)} onChange={() => flip(ids, e.id, setIds)} />
              <span style={{ flex: 1 }}>
                {e.name}
                <span className="faint" style={{ fontSize: 12 }}>{e.group ? ` · ${e.group.name}` : ""}</span>
              </span>
              <span className="mono" style={{ fontSize: 13 }}>
                {formatAmount(e.salary)}
              </span>
            </label>
          </li>
        ))}
      </ul>
      {error ? (
        <div role="alert" className="alert">
          {error}
        </div>
      ) : null}
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 10 }}>
        <button type="button" className="btn btn-secondary" onClick={onClose}>
          Cancel
        </button>
        <button type="button" className="btn btn-primary" onClick={add} disabled={busy || (ids.size === 0 && groupIds.size === 0)} aria-busy={busy}>
          Add to run
        </button>
      </div>
    </Dialog>
  );
}
