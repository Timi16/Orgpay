"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import useSWR, { useSWRConfig } from "swr";
import { CopyButton } from "@/components/CopyButton";
import { Dialog } from "@/components/Dialog";
import { Icon } from "@/components/Icon";
import { countsText, Ticks } from "@/components/payroll/Ticks";
import { BatchStatusPill, RunStatusPill } from "@/components/StatusPill";
import { useToast } from "@/components/Toast";
import { api, errorMessage } from "@/lib/api";
import { API_URL, explorerAccount, explorerTx } from "@/lib/config";
import { Seal } from "@/components/payroll/Seal";
import { countdown, formatAmount, formatDateTime, formatDay, shortAddress, shortHash, sumAmounts } from "@/lib/format";
import { useNow } from "@/lib/hooks";
import { IN_FLIGHT, REASON_FIX } from "@/lib/payroll";
import { usePayRun, type PayPhase } from "@/lib/usePayRun";
import type { Run } from "@/lib/types";
import { AddPeopleDialog } from "./_components/AddPeopleDialog";
import { Lines } from "./_components/Lines";
import { ReviewDialog } from "./_components/ReviewDialog";

/** The run as CSV, built by the API: every payment with its status, hash, explorer link and verification time. */
const exportUrl = (run: Run) => `${API_URL}/v1/payroll-runs/${run.id}/export.csv`;

const PHASE_TEXT: Partial<Record<PayPhase["kind"], string>> = {
  starting: "Checking everyone on Stellar and starting the run…",
  preparing: "Preparing the next transaction…",
  submitting: "Sending the signed transaction to Stellar…",
};

/** What's happening with the money right now, and the one thing to do next. */
function PayPanel({ run, phase, saving, onPay, onReview }: { run: Run; phase: PayPhase; saving: boolean; onPay: () => void; onReview: () => void }) {
  const now = useNow(1000);
  const open = run.transactions.find((b) => b.status === "AWAITING_SIGNATURE" || b.status === "SUBMITTED");
  // An unsigned batch past its window: Stellar has to confirm it can't land before a new one is built.
  const lapsed = open?.status === "AWAITING_SIGNATURE" && new Date(open.maxTime).getTime() <= now ? open : null;
  const working = PHASE_TEXT[phase.kind];

  let body: React.ReactNode = null;
  if (phase.kind === "signing") {
    body = (
      <div className="info-note" style={{ display: "flex", gap: 10, alignItems: "center" }}>
        <span className="spinner" aria-hidden="true" />
        <span>
          <span role="status">
            <b>Approve transaction {phase.batch.number} in Freighter:</b> {phase.batch.opCount === 1 ? `${run.payments.find((p) => p.id === phase.batch.paymentIds[0])?.name ?? "1 payment"}` : `${phase.batch.opCount} payments`}, {formatAmount(phase.batch.total)} USDC.
          </span>{" "}
          It expires in <span className="mono" aria-hidden="true">{countdown(phase.batch.maxTime, now)}</span>
          <span className="sr-only">5 minutes from when it was prepared</span>.
        </span>
      </div>
    );
  } else if (working) {
    body = (
      <div className="info-note" role="status" style={{ display: "flex", gap: 10, alignItems: "center" }}>
        <span className="spinner" aria-hidden="true" />
        {working}
      </div>
    );
  } else if (phase.kind === "error") {
    body = (
      <div role="alert" className="alert">
        <b>Payment paused.</b> {phase.message}
      </div>
    );
  }

  if (lapsed && !working && phase.kind !== "signing") {
    body = (
      <div className="notice" role="status" style={{ display: "flex", gap: 10, alignItems: "center" }}>
        <span className="spinner" aria-hidden="true" />
        <span>
          <b>Transaction {lapsed.number} wasn&apos;t signed in time.</b> Stellar is confirming it can no longer go through (up to a couple of minutes). Nothing was sent; you
          can sign a fresh batch as soon as it&apos;s confirmed.
        </span>
      </div>
    );
  }

  if (open?.status === "SUBMITTED" && !working && phase.kind !== "signing") {
    body = (
      <>
        {body}
        <div className="notice" role="status" style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <span className="spinner" aria-hidden="true" />
          <span>
            <b>Transaction {open.number} is confirming on Stellar.</b> This page updates by itself. If Stellar doesn&apos;t take it before{" "}
            {formatDateTime(open.maxTime)}, nothing is sent and you can sign again.
            {open.resultCode ? <span className="mono" style={{ fontSize: 12 }}> (Stellar said {open.resultCode})</span> : null}
          </span>
        </div>
      </>
    );
  }

  const busy = phase.kind === "starting" || phase.kind === "preparing" || phase.kind === "signing" || phase.kind === "submitting";
  const action =
    run.status === "DRAFT" ? (
      <button type="button" className="btn btn-primary btn-lg" onClick={onReview} disabled={run.payments.length === 0 || busy || saving} aria-busy={saving}>
        {saving ? "Saving amounts…" : `Review and pay ${formatAmount(run.total)} USDC`}
      </button>
    ) : run.status === "PROCESSING" && open?.status !== "SUBMITTED" && !lapsed ? (
      <button type="button" className="btn btn-primary btn-lg" onClick={onPay} disabled={busy} aria-busy={busy}>
        <Icon name="freighter" size={18} /> {open ? `Sign transaction ${open.number} in Freighter` : run.counts.pending > 0 ? `Sign and pay the remaining ${run.counts.pending}` : "Continue"}
      </button>
    ) : null;

  if (!body && !action) return null;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, padding: "0 28px 22px" }}>
      {body}
      {action ? <div style={{ display: "flex", justifyContent: "flex-end" }}>{action}</div> : null}
    </div>
  );
}

function FailuresCallout({ run, onRetry, retrying }: { run: Run; onRetry: () => void; retrying: boolean }) {
  const failed = run.payments.filter((i) => i.status === "FAILED");
  if (failed.length === 0) return null;
  const reasons = [...new Set(failed.map((f) => f.failureCode).filter((c): c is NonNullable<typeof c> => c !== null))];
  return (
    <div className="alert" style={{ margin: "0 28px 22px", display: "flex", gap: 16, alignItems: "flex-start", flexWrap: "wrap" }}>
      <div style={{ flex: "1 1 320px" }}>
        <b>
          {failed.length} {failed.length === 1 ? "payment wasn't" : "payments weren't"} sent: {formatAmount(sumAmounts(failed.map((f) => f.amount)))} USDC.
        </b>{" "}
        Nothing was sent to {failed.length === 1 ? failed[0]?.name : "them"}.{" "}
        {reasons.map((r) => REASON_FIX[r]).join(" ")} Then check again and retry; nobody who was paid is paid twice.
      </div>
      {run.status !== "PROCESSING" || run.counts.pending === 0 ? (
        <button type="button" className="btn btn-dark btn-sm" onClick={onRetry} disabled={retrying} aria-busy={retrying}>
          <Icon name="refresh" size={15} /> Check again and retry
        </button>
      ) : null}
    </div>
  );
}

function Totals({ run }: { run: Run }) {
  const pick = (match: (s: Run["payments"][number]["status"]) => boolean) => sumAmounts(run.payments.filter((i) => match(i.status)).map((i) => i.amount));
  const rows: [string, string, number][] = [
    ["Successful", pick((s) => s === "SUCCESSFUL"), run.counts.successful],
    ["Signing or confirming", pick((s) => IN_FLIGHT.includes(s)), run.counts.awaitingSignature + run.counts.submitted],
    ["Pending", pick((s) => s === "PENDING"), run.counts.pending],
    ["Failed", pick((s) => s === "FAILED"), run.counts.failed],
  ];
  const draft = run.status === "DRAFT";
  return (
    <div className="run-totals">
      <div style={{ display: "flex", flexDirection: "column", gap: 10, minWidth: 0 }}>
        <span className="eyebrow">{draft ? "Total for this run" : "Where the money is"}</span>
        {draft ? (
          <span className="muted" style={{ fontSize: 13 }}>
            {run.counts.payments} {run.counts.payments === 1 ? "person" : "people"} · network fees about 0.00001 XLM per payment, paid in XLM
          </span>
        ) : (
          <dl className="ledger" style={{ maxWidth: 360 }}>
            {rows
              .filter(([, , n]) => n > 0)
              .map(([label, amount, n]) => (
                <div key={label} style={{ display: "contents" }}>
                  <dt>
                    {label} <span className="faint">({n})</span>
                  </dt>
                  <dd>{formatAmount(amount)}</dd>
                </div>
              ))}
          </dl>
        )}
      </div>
      <div className="money total-rule" style={{ fontSize: "clamp(36px, 6vw, 56px)", textAlign: "right" }} aria-label={`Total ${formatAmount(run.total)} USDC`}>
        {/* The binding total never animates: what you see is always the exact amount. */}
        {formatAmount(run.total)}
        <span className="unit">USDC</span>
      </div>
    </div>
  );
}

function RunView({ run }: { run: Run }) {
  const router = useRouter();
  const toast = useToast();
  const { mutate } = useSWRConfig();
  const { phase, pay, reset } = usePayRun(run);
  const [saving, setSaving] = useState(0);
  const openBatch = run.transactions.some((b) => b.status === "AWAITING_SIGNATURE" || b.status === "SUBMITTED");
  // A paused-payment message is about a moment that has passed once the run moves on.
  const seen = useRef(`${run.status}:${run.counts.successful}:${run.transactions.length}`);
  useEffect(() => {
    const now = `${run.status}:${run.counts.successful}:${run.transactions.length}`;
    if (now !== seen.current) {
      seen.current = now;
      if (phase.kind === "error" || phase.kind === "expiring") reset();
    }
  }, [run.status, run.counts.successful, run.transactions.length, phase.kind, reset]);
  const [review, setReview] = useState(false);
  const [adding, setAdding] = useState(false);
  const [confirm, setConfirm] = useState<"cancel" | "delete" | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const key = `/v1/payroll-runs/${run.id}`;

  const statuses = run.payments.map((i) => i.status);
  // When the company first signed: the first submission, or the ledger time of a batch landed elsewhere.
  const firstLanded = run.transactions.find((b) => b.submittedAt ?? b.closedAt);
  const signedAt = firstLanded ? (firstLanded.submittedAt ?? firstLanded.closedAt) : null;

  const act = async (what: "retry" | "cancel" | "delete") => {
    setBusy(what);
    try {
      if (what === "delete") {
        await api.delete(key);
        void mutate("/v1/summary");
        router.replace("/payroll");
        toast("Draft deleted");
        return;
      }
      const res = await api.post<{ run: Run }>(`${key}/${what}`);
      await mutate(key, res, { revalidate: false });
      void mutate("/v1/summary");
      if (what === "retry") {
        const ready = res.run.counts.pending;
        toast(ready ? `${ready} ready to pay again · sign to send` : "They still can't receive USDC. Nothing changed.");
      } else toast("Cancelled. Nothing more will be sent.");
    } catch (err) {
      toast(errorMessage(err));
    } finally {
      setBusy(null);
      setConfirm(null);
    }
  };

  return (
    <>
      <nav aria-label="Breadcrumb" style={{ fontSize: 13 }}>
        <Link href="/payroll" className="muted">
          <Icon name="back" size={14} style={{ verticalAlign: "-2px" }} /> Payroll
        </Link>
      </nav>

      <article className="sheet stub" aria-labelledby="run-title">
        <div className="run-head">
          <div style={{ display: "flex", flexDirection: "column", gap: 14, minWidth: 0 }}>
            <span className="eyebrow">Payroll · Run #{String(run.number).padStart(4, "0")}</span>
            <h1 id="run-title" className="h1" style={{ fontSize: "clamp(30px, 4vw, 40px)" }}>
              {run.name}
            </h1>
            <dl className="facts">
              {[
                [
                  "Pay from",
                  <span key="w" style={{ display: "inline-flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                    <a href={explorerAccount(run.wallet.address)} target="_blank" rel="noreferrer" className="hash" title={run.wallet.address}>
                      {run.wallet.label ? `${run.wallet.label} · ` : ""}
                      {shortAddress(run.wallet.address)}
                    </a>
                    <CopyButton value={run.wallet.address} className="btn-link" label="Copy" ariaLabel="Copy the funding wallet address" style={{ fontSize: 12 }} />
                  </span>,
                ],
                ["Pay date", run.payDate ? formatDay(run.payDate) : "—"],
                ["Signed", signedAt ? formatDateTime(signedAt) : "Not yet"],
                ["People", String(run.counts.payments - run.counts.cancelled)],
              ].map(([label, value], i) => (
                <div key={i}>
                  <dt>{label}</dt>
                  <dd>{value}</dd>
                </div>
              ))}
            </dl>
          </div>
          <div className="run-head-status">
            <RunStatusPill status={run.status} />
            <Seal key={run.status} status={run.status} date={run.finishedAt} />
          </div>
        </div>
        {run.status !== "DRAFT" ? (
          <div style={{ padding: "0 28px 22px", display: "flex", flexDirection: "column", gap: 8 }}>
            <Ticks statuses={statuses} label={countsText(run.counts)} />
            <span className="muted" style={{ fontSize: 13 }} aria-live="polite">
              {countsText(run.counts)}
            </span>
          </div>
        ) : (
          <div className="info-note" style={{ margin: "0 28px 22px" }}>
            This is a draft. Change amounts, add or remove people, then review: OrgPay checks every wallet on Stellar, and nothing is sent until you sign in Freighter.
          </div>
        )}

        <PayPanel run={run} phase={phase} saving={saving > 0} onPay={() => void pay()} onReview={() => setReview(true)} />
        <FailuresCallout run={run} onRetry={() => void act("retry")} retrying={busy === "retry"} />

        <div className="tear" style={{ paddingTop: 18 }}>
          {run.status === "DRAFT" ? (
            <div style={{ padding: "0 28px 14px", display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => setAdding(true)}>
                <Icon name="plus" size={15} /> Add people
              </button>
            </div>
          ) : null}
          <Lines run={run} onSaving={(d) => setSaving((n) => Math.max(0, n + d))} />
        </div>
        <Totals run={run} />
      </article>

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", justifyContent: "flex-end" }}>
        {run.status !== "DRAFT" ? (
          <a className="btn btn-secondary" href={exportUrl(run)} download>
            <Icon name="download" size={16} /> Export CSV
          </a>
        ) : null}
        {run.status === "DRAFT" ? (
          <button type="button" className="btn btn-danger" onClick={() => setConfirm("delete")}>
            Delete draft
          </button>
        ) : run.status === "PROCESSING" || run.counts.failed > 0 ? (
          <button
            type="button"
            className="btn btn-danger"
            onClick={() => setConfirm("cancel")}
            disabled={openBatch}
            title={openBatch ? "A transaction is waiting for a signature or for Stellar. Wait for it to finish or expire." : undefined}
          >
            {run.status === "PROCESSING" ? "Cancel unsent payments" : "Give up on failed payments"}
          </button>
        ) : null}
      </div>

      {run.transactions.length > 0 ? (
        <section className="sheet" aria-labelledby="batches-h">
          <h2 id="batches-h" className="h2 sheet-pad" style={{ paddingBottom: 6 }}>
            Transactions
          </h2>
          <div className="table-wrap">
            <table className="table stack">
              <thead>
                <tr>
                  <th>Transaction</th>
                  <th>Status</th>
                  <th className="num">Payments</th>
                  <th className="num">Total (USDC)</th>
                  <th className="hide-sm">Ledger</th>
                </tr>
              </thead>
              <tbody>
                {run.transactions
                  .slice()
                  .reverse()
                  .map((b) => (
                    <tr key={b.id}>
                      <td className="full">
                        <b>Transaction {b.number}</b>
                        <div>
                          {b.status === "CONFIRMED" || (b.status === "FAILED" && b.ledger) ? (
                            <a href={explorerTx(b.txHash)} target="_blank" rel="noreferrer" className="hash" title={b.txHash}>
                              {shortHash(b.txHash)} <Icon name="external" size={12} />
                            </a>
                          ) : (
                            <span className="mono faint" style={{ fontSize: 12 }} title={b.txHash}>
                              {shortHash(b.txHash)}
                            </span>
                          )}
                        </div>
                      </td>
                      <td>
                        <BatchStatusPill status={b.status} />
                        {b.resultCode ? <div className="mono faint" style={{ fontSize: 11, marginTop: 4 }}>{b.resultCode}</div> : null}
                      </td>
                      <td className="num">{b.opCount}</td>
                      <td className="num">{formatAmount(b.total)}</td>
                      <td className="hide-sm muted" style={{ fontSize: 13 }}>
                        {b.ledger ? `${b.ledger}${b.closedAt ? ` · ${formatDateTime(b.closedAt)}` : ""}` : "—"}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      <details className="sheet sheet-pad">
        <summary style={{ cursor: "pointer", fontWeight: 600 }}>History ({run.events.length})</summary>
        <ol style={{ listStyle: "none", margin: "14px 0 0", padding: 0, display: "flex", flexDirection: "column", gap: 10 }}>
          {run.events
            .slice()
            .reverse()
            .map((e) => (
              <li key={e.id} style={{ display: "grid", gridTemplateColumns: "150px 1fr", gap: 12, fontSize: 13 }}>
                <span className="faint mono" style={{ fontSize: 12 }}>
                  {formatDateTime(e.createdAt)}
                </span>
                <span>
                  {e.message} <span className="faint">· {e.actor === "system" ? "OrgPay" : e.actor === "api" ? "API" : "you"}</span>
                </span>
              </li>
            ))}
        </ol>
      </details>

      <ReviewDialog run={run} open={review} onClose={() => setReview(false)} onPay={() => void pay()} />
      <AddPeopleDialog run={run} open={adding} onClose={() => setAdding(false)} />
      <Dialog
        open={confirm !== null}
        onClose={() => setConfirm(null)}
        title={confirm === "delete" ? "Delete this draft?" : run.status === "PROCESSING" ? "Cancel the unsent payments?" : "Give up on the failed payments?"}
        footer={
          <>
            <button type="button" className="btn btn-secondary" onClick={() => setConfirm(null)}>
              Keep
            </button>
            <button type="button" className="btn btn-danger" disabled={busy !== null} aria-busy={busy !== null} onClick={() => void act(confirm === "delete" ? "delete" : "cancel")}>
              {confirm === "delete" ? "Delete draft" : "Yes, cancel them"}
            </button>
          </>
        }
      >
        <p className="muted">
          {confirm === "delete"
            ? "Nothing has been sent from it. The people stay in OrgPay."
            : "Everyone already paid stays paid. Nobody else on this run will be sent anything, and it can't be undone."}
        </p>
      </Dialog>
    </>
  );
}

export default function RunPage() {
  const { id } = useParams<{ id: string }>();
  const key = `/v1/payroll-runs/${id}`;
  // While money is moving, follow it every 2 seconds; otherwise only on focus.
  const { data, error, mutate } = useSWR<{ run: Run }>(key, {
    refreshInterval: (latest) => {
      const run = latest?.run;
      if (!run) return 0;
      if (run.counts.submitted > 0 || run.transactions.some((b) => b.status === "SUBMITTED")) return 2000;
      // An unsigned transaction past its window: the worker expires it within about 30 s, then a new one can be signed.
      return run.transactions.some((b) => b.status === "AWAITING_SIGNATURE" && new Date(b.maxTime).getTime() <= Date.now()) ? 5000 : 0;
    },
  });
  if (error && !data) {
    return (
      <div className="sheet empty" role="alert">
        <strong>{error instanceof Error && "status" in error && (error as { status: number }).status === 404 ? "This run doesn't exist" : "The run didn't load"}</strong>
        <span>{errorMessage(error)}</span>
        <div style={{ display: "flex", gap: 8 }}>
          <button type="button" className="btn btn-primary" onClick={() => void mutate()}>
            Try again
          </button>
          <Link href="/payroll" className="btn btn-secondary">
            All payroll
          </Link>
        </div>
      </div>
    );
  }
  if (!data) {
    return (
      <div aria-busy="true" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <div className="skeleton" style={{ height: 48, width: "min(420px, 80%)" }} />
        <div className="skeleton" style={{ height: 420 }} />
      </div>
    );
  }
  return <RunView run={data.run} />;
}
