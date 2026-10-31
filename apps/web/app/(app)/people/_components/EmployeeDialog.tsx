"use client";

import { cloneElement, useState } from "react";
import { useSWRConfig } from "swr";
import { Dialog } from "@/components/Dialog";
import { useToast } from "@/components/Toast";
import { api, ApiError, errorMessage } from "@/lib/api";
import { formatAmount } from "@/lib/format";
import { useGroups } from "@/lib/session";
import type { Employee } from "@/lib/types";

/** A 56-character value starting with S is a Stellar secret key. It must never leave this page. */
const looksLikeSecret = (v: string) => /^S[A-Z2-7]{55}$/.test(v.trim());

function addressProblem(a: string): string | null {
  if (!a) return "Paste their Stellar public address.";
  if (a[0] !== "G") return "A Stellar public address starts with G.";
  if (a.length !== 56) return `That has ${a.length} characters. A public address has exactly 56.`;
  if (!/^G[A-Z2-7]{55}$/.test(a)) return "Only capital letters A–Z and digits 2–7 are allowed.";
  return null;
}

function amountProblem(v: string): string | null {
  if (!v.trim()) return "Enter the amount they're usually paid.";
  if (!/^\d{1,12}(\.\d{1,7})?$/.test(v.trim())) return "Use a number like 1500 or 1500.50 (up to 7 decimals).";
  if (!/[1-9]/.test(v)) return "The amount must be more than 0.";
  return null;
}

export const invalidateEmployees = (mutate: ReturnType<typeof useSWRConfig>["mutate"]) =>
  mutate((key) => typeof key === "string" && (key.startsWith("/v1/employees") || key === "/v1/groups" || key === "/v1/summary"));

/** Add or edit a person. Their wallet is checked on Stellar as soon as it is saved. */
export function EmployeeDialog({ open, onClose, employee }: { open: boolean; onClose: () => void; employee: Employee | null }) {
  const { mutate } = useSWRConfig();
  const toast = useToast();
  const { data: groups } = useGroups();
  const [name, setName] = useState(employee?.name ?? "");
  const [email, setEmail] = useState(employee?.email ?? "");
  const [role, setRole] = useState(employee?.role ?? "");
  const [wallet, setWallet] = useState(employee?.walletAddress ?? "");
  const [amount, setAmount] = useState(employee ? formatAmount(employee.salary, 0).replace(/,/g, "") : "");
  const [groupId, setGroupId] = useState(employee?.group?.id ?? "");
  const [newGroup, setNewGroup] = useState("");
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [apiErr, setApiErr] = useState<ApiError | null>(null);

  const secret = looksLikeSecret(wallet);
  const errs = {
    name: !name.trim() ? "Enter their name." : null,
    wallet: secret ? null : addressProblem(wallet.trim()),
    amount: amountProblem(amount),
  };
  const show = (k: keyof typeof errs) => (tried ? errs[k] : null) ?? apiErr?.field(k === "wallet" ? "walletAddress" : k === "amount" ? "salary" : k) ?? null;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setTried(true);
    setApiErr(null);
    setError(null);
    if (secret || errs.name || errs.wallet || errs.amount || busy) return;
    setBusy(true);
    try {
      let gid: string | null = groupId || null;
      if (groupId === "__new") {
        const created = await api.post<{ group: { id: string } }>("/v1/groups", { name: newGroup.trim() });
        gid = created.group.id;
        setGroupId(gid); // a retry after a failed save must not create the group again
      }
      const body = {
        name: name.trim(),
        email: email.trim() || null,
        role: role.trim() || null,
        walletAddress: wallet.trim(),
        salary: amount.trim(),
        groupId: gid,
      };
      const res = employee
        ? await api.patch<{ employee: Employee }>(`/v1/employees/${employee.id}`, body)
        : await api.post<{ employee: Employee }>("/v1/employees", body);
      await invalidateEmployees(mutate);
      const check = res.employee.check;
      toast(
        check.status === "ready"
          ? `${res.employee.name} saved · can receive USDC`
          : check.status === "problem"
            ? `${res.employee.name} saved · can't receive USDC yet`
            : `${res.employee.name} saved · wallet not checked yet`,
      );
      onClose();
    } catch (err) {
      if (err instanceof ApiError && err.details.length) setApiErr(err);
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  const field = (id: string, label: string, input: React.ReactElement<{ "aria-describedby"?: string; "aria-invalid"?: boolean }>, err: string | null, hint?: string) => (
    <div className="field">
      <label htmlFor={id} className="label">
        {label}
      </label>
      {cloneElement(input, { "aria-describedby": err ? `${id}-err` : hint ? `${id}-hint` : undefined, "aria-invalid": err ? true : undefined })}
      {err ? (
        <span id={`${id}-err`} className="field-error">
          {err}
        </span>
      ) : hint ? (
        <span id={`${id}-hint`} className="hint">
          {hint}
        </span>
      ) : null}
    </div>
  );

  return (
    <Dialog open={open} onClose={onClose} title={employee ? `Edit ${employee.name}` : "Add a person"} width={560}>
      <form onSubmit={submit} noValidate style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 12 }}>
          {field("emp-name", "Name", <input id="emp-name" className={`input${show("name") ? " invalid" : ""}`} value={name} maxLength={100} onChange={(e) => setName(e.target.value)} autoComplete="off" />, show("name"))}
          {field("emp-role", "Role (optional)", <input id="emp-role" className="input" value={role} maxLength={64} onChange={(e) => setRole(e.target.value)} placeholder="e.g. Backend engineer" />, null)}
        </div>
        {field("emp-email", "Email (optional)", <input id="emp-email" type="email" className="input" value={email} maxLength={254} onChange={(e) => setEmail(e.target.value)} autoComplete="off" />, apiErr?.field("email") ?? null)}
        {field(
          "emp-wallet",
          "Stellar wallet (public address)",
          <input
            id="emp-wallet"
            className={`input mono${secret || show("wallet") ? " invalid" : ""}`}
            value={secret ? "" : wallet}
            maxLength={100}
            onChange={(e) => setWallet(e.target.value)}
            placeholder="G…"
            autoComplete="off"
            spellCheck={false}
          />,
          show("wallet"),
          "Starts with G. They need a USDC trustline on Stellar Testnet to be paid.",
        )}
        {secret ? (
          <div role="alert" className="alert">
            <b>That was a secret key (S…), so we cleared it.</b> Never share it, with OrgPay or anyone. Ask for the public address that starts with G. If this key was sent
            to you, the person should move their funds to a new wallet.
          </div>
        ) : null}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 12 }}>
          {field(
            "emp-amount",
            "Default amount (USDC)",
            <input id="emp-amount" inputMode="decimal" className={`input amount${show("amount") ? " invalid" : ""}`} value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="1500.00" />,
            show("amount"),
            "Pre-filled on each run; you can change it per run.",
          )}
          {field(
            "emp-group",
            "Group",
            <select id="emp-group" className="select" value={groupId} onChange={(e) => setGroupId(e.target.value)}>
              <option value="">No group</option>
              {groups?.data.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
              <option value="__new">New group…</option>
            </select>,
            null,
          )}
        </div>
        {groupId === "__new" ? field("emp-newgroup", "New group name", <input id="emp-newgroup" className="input" value={newGroup} maxLength={50} onChange={(e) => setNewGroup(e.target.value)} placeholder="e.g. Contractors" />, null) : null}
        {error ? (
          <div role="alert" className="alert">
            {error}
          </div>
        ) : null}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, flexWrap: "wrap" }}>
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy || secret || (groupId === "__new" && !newGroup.trim())} aria-busy={busy}>
            {employee ? "Save changes" : "Add person"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
