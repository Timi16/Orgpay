"use client";

import { useMemo, useState } from "react";
import { useSWRConfig } from "swr";
import { Dialog } from "@/components/Dialog";
import { useToast } from "@/components/Toast";
import { api, ApiError, errorMessage } from "@/lib/api";
import { formatAmount, shortAddress, sumAmounts } from "@/lib/format";
import { invalidateEmployees } from "./EmployeeDialog";

interface Row {
  name: string;
  walletAddress: string;
  salary: string;
  group: string | null;
  email: string | null;
}

const SAMPLE = `name,wallet,amount,group,email
Ada Okafor,GBQ2…,3200,Contractors,ada@example.com
Marcus Silva,GDA1…,6800,Engineering,`;

/** The one delimiter a file uses, read from its header row: tab (a spreadsheet paste), then ; then ,. */
function delimiterOf(header: string): string {
  return header.includes("\t") ? "\t" : header.includes(";") ? ";" : ",";
}

/** Splits one line on `sep` only, honouring double quotes ("1,500.00" stays one cell). */
function cells(line: string, sep: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === sep) {
      out.push(cur.trim());
      cur = "";
    } else cur += c;
  }
  out.push(cur.trim());
  return out;
}

/** CSV with a header row: name, wallet, amount, and optionally group and email (any order). */
function parse(text: string): { rows: Row[]; problems: string[] } {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return { rows: [], problems: lines.length ? ["Add at least one person under the header row."] : [] };
  const sep = delimiterOf(lines[0] ?? "");
  const header = cells(lines[0] ?? "", sep).map((h) => h.toLowerCase().trim());
  // Exact column names first, then a looser match that never claims a column already taken.
  const taken = new Set<number>();
  const col = (exact: string[], loose: string[] = []) => {
    let i = header.findIndex((h, j) => !taken.has(j) && exact.includes(h));
    if (i < 0) i = header.findIndex((h, j) => !taken.has(j) && loose.some((n) => h.includes(n)));
    if (i >= 0) taken.add(i);
    return i;
  };
  const iEmail = col(["email", "e-mail", "email address"], ["email"]);
  const iWallet = col(["wallet", "address", "stellar address", "wallet address", "public key"], ["wallet", "stellar"]);
  const iName = col(["name", "full name", "employee"], ["name"]);
  const iAmount = col(["amount", "salary", "pay", "default amount"], ["amount", "salary"]);
  const iGroup = col(["group", "team", "department"], ["group", "team", "department"]);
  const problems: string[] = [];
  if (iName < 0 || iWallet < 0 || iAmount < 0) return { rows: [], problems: ["The first row must name the columns, including name, wallet and amount."] };
  const rows = lines.slice(1).map((line, n) => {
    const c = cells(line, sep);
    const row: Row = {
      name: c[iName] ?? "",
      walletAddress: (c[iWallet] ?? "").toUpperCase(),
      salary: (c[iAmount] ?? "").replace(/[,\s]/g, ""),
      group: iGroup >= 0 ? c[iGroup] || null : null,
      email: iEmail >= 0 ? c[iEmail] || null : null,
    };
    const at = `Row ${n + 2}`;
    if (/^S[A-Z2-7]{55}$/.test(row.walletAddress)) {
      problems.push(`${at}: that's a secret key (S…). Remove it from the file and ask for the public address (G…).`);
      row.walletAddress = "";
    } else if (!/^G[A-Z2-7]{55}$/.test(row.walletAddress)) problems.push(`${at}: the wallet isn't a Stellar public address (G…, 56 characters).`);
    if (!row.name) problems.push(`${at}: the name is empty.`);
    if (!/^\d{1,12}(\.\d{1,7})?$/.test(row.salary) || !/[1-9]/.test(row.salary)) problems.push(`${at}: the amount isn't a number above 0.`);
    return row;
  });
  return { rows, problems };
}

export function ImportDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { mutate } = useSWRConfig();
  const toast = useToast();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [serverProblems, setServerProblems] = useState<string[]>([]);
  const { rows, problems } = useMemo(() => parse(text), [text]);
  const [secretRemoved, setSecretRemoved] = useState(false);
  /** A secret key (S…) never stays on screen: its line is dropped from the box as soon as it appears. */
  const setSafeText = (value: string) => {
    const lines = value.split(/\r?\n/);
    const kept = lines.filter((l) => !/S[A-Z2-7]{55}/.test(l.toUpperCase()));
    setSecretRemoved(kept.length !== lines.length);
    setText(kept.join("\n"));
  };

  const load = async (file: File | undefined) => {
    if (!file) return;
    setSafeText(await file.text());
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    setServerProblems([]);
    try {
      const res = await api.post<{ created: number }>("/v1/employees/import", { employees: rows });
      await invalidateEmployees(mutate);
      // Check the new wallets in the background so People shows who can receive.
      void api.post("/v1/employees/check", {}).then(() => invalidateEmployees(mutate)).catch(() => undefined);
      toast(`${res.created} people added`);
      setText("");
      onClose();
    } catch (err) {
      if (err instanceof ApiError) {
        setServerProblems(err.details.map((d) => `${d.path?.replace(/^employees\.(\d+)\..*/, (_m, i: string) => `Row ${Number.parseInt(i, 10) + 2}`) ?? ""}: ${d.message ?? ""}`));
      }
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} title="Import people" width={640}>
      <p className="muted">
        Paste from a spreadsheet, or choose a CSV file. The first row names the columns: <span className="mono">name, wallet, amount</span>, and optionally{" "}
        <span className="mono">group, email</span>. Missing groups are created. It&apos;s all or nothing: one bad row and nobody is added.
      </p>
      <textarea className="textarea mono" rows={7} value={text} onChange={(e) => setSafeText(e.target.value)} placeholder={SAMPLE} aria-label="People as CSV" style={{ fontSize: 12 }} />
      {secretRemoved ? (
        <div role="alert" className="alert">
          <b>A secret key (S…) was removed.</b> Never share one, with OrgPay or anyone; ask for the public address (G…). Whoever&apos;s key it is should move their
          funds to a new wallet.
        </div>
      ) : null}
      <label className="btn btn-secondary btn-sm" style={{ alignSelf: "flex-start" }}>
        Choose a CSV file
        <input type="file" accept=".csv,text/csv,text/plain" className="sr-only" onChange={(e) => void load(e.target.files?.[0])} />
      </label>
      {rows.length > 0 ? (
        <div className="sheet" style={{ maxHeight: 200, overflowY: "auto" }}>
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Wallet</th>
                <th>Group</th>
                <th className="num">Amount</th>
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, 50).map((r, i) => (
                <tr key={i}>
                  <td>{r.name}</td>
                  <td className="mono faint" style={{ fontSize: 12 }}>
                    {r.walletAddress ? shortAddress(r.walletAddress) : "—"}
                  </td>
                  <td>{r.group ?? "—"}</td>
                  <td className="num">{/^\d/.test(r.salary) ? formatAmount(r.salary) : r.salary}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {[...problems, ...serverProblems].length > 0 ? (
        <div role="alert" className="alert" style={{ maxHeight: 140, overflowY: "auto" }}>
          <b>Fix these, then import:</b>
          <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
            {[...problems, ...serverProblems].slice(0, 20).map((p, i) => (
              <li key={i}>{p}</li>
            ))}
          </ul>
        </div>
      ) : error ? (
        <div role="alert" className="alert">
          {error}
        </div>
      ) : null}
      <div className="divider" style={{ paddingTop: 14, display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <span className="muted">
          {rows.length} {rows.length === 1 ? "person" : "people"}
          {rows.length ? <> · <span className="mono">{formatAmount(sumAmounts(rows.map((r) => (/^\d{1,12}(\.\d{1,7})?$/.test(r.salary) ? r.salary : "0"))))} USDC</span> a run</> : null}
        </span>
        <div style={{ display: "flex", gap: 10 }}>
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" onClick={submit} disabled={busy || rows.length === 0 || problems.length > 0 || rows.length > 500} aria-busy={busy}>
            Import {rows.length || ""}
          </button>
        </div>
      </div>
    </Dialog>
  );
}
