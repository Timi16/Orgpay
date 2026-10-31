"use client";

import { useState } from "react";
import { useSWRConfig } from "swr";
import { Dialog } from "@/components/Dialog";
import { Icon } from "@/components/Icon";
import { useToast } from "@/components/Toast";
import { api, errorMessage } from "@/lib/api";
import { useGroups } from "@/lib/session";
import type { Group } from "@/lib/types";
import { invalidateEmployees } from "./EmployeeDialog";

function GroupRow({ group }: { group: Group }) {
  const { mutate } = useSWRConfig();
  const toast = useToast();
  const [name, setName] = useState(group.name);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const rename = async () => {
    if (!name.trim() || name.trim() === group.name) return;
    setBusy(true);
    setError(null);
    try {
      await api.patch(`/v1/groups/${group.id}`, { name: name.trim() });
      await invalidateEmployees(mutate);
      toast(`Renamed to ${name.trim()}`);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    try {
      await api.delete(`/v1/groups/${group.id}`);
      await invalidateEmployees(mutate);
      toast(`${group.name} deleted · its people are now ungrouped`);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <li style={{ padding: "10px 0", borderTop: "1px solid var(--rule-soft)", display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <input className="input" value={name} maxLength={50} onChange={(e) => setName(e.target.value)} onBlur={() => void rename()} aria-label={`Name of group ${group.name}`} style={{ height: 40 }} />
        <span className="mono faint" style={{ fontSize: 12, whiteSpace: "nowrap" }}>
          {group.employeeCount} {group.employeeCount === 1 ? "person" : "people"}
        </span>
        {confirm ? (
          <>
            <button type="button" className="btn btn-danger btn-sm" onClick={remove} disabled={busy} aria-busy={busy}>
              Delete
            </button>
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => setConfirm(false)}>
              Keep
            </button>
          </>
        ) : (
          <button type="button" className="icon-btn" aria-label={`Delete group ${group.name}`} onClick={() => setConfirm(true)}>
            <Icon name="trash" size={16} />
          </button>
        )}
      </div>
      {confirm ? <span className="hint">Its people stay; they just won&apos;t be in a group.</span> : null}
      {error ? <span className="field-error">{error}</span> : null}
    </li>
  );
}

/** Create, rename and delete groups. Deleting a group never deletes anyone. */
export function GroupsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { mutate } = useSWRConfig();
  const { data } = useGroups();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.post("/v1/groups", { name: name.trim() });
      setName("");
      await invalidateEmployees(mutate);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} title="Groups" width={520}>
      <p className="muted">Group people the way you pay them: Engineering, Contractors, a country. A run can include whole groups at once.</p>
      <form onSubmit={add} noValidate style={{ display: "flex", gap: 8 }}>
        <input className="input" value={name} maxLength={50} onChange={(e) => setName(e.target.value)} placeholder="New group name" aria-label="New group name" />
        <button type="submit" className="btn btn-dark" disabled={!name.trim() || busy} aria-busy={busy}>
          Add
        </button>
      </form>
      {error ? (
        <div role="alert" className="alert">
          {error}
        </div>
      ) : null}
      <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
        {data?.data.map((g) => (
          <GroupRow key={`${g.id}:${g.name}`} group={g} />
        ))}
        {data && data.data.length === 0 ? <li className="faint" style={{ padding: "10px 0" }}>No groups yet.</li> : null}
      </ul>
    </Dialog>
  );
}
