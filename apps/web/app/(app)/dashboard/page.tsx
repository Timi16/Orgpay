"use client";

import { parseAmount } from "@orgpay/shared";
import Link from "next/link";
import { useState } from "react";
import { Icon } from "@/components/Icon";
import { wordCount, Words } from "@/components/motion/Words";
import { CountUpInt } from "@/components/motion/CountUp";
import { Money } from "@/components/payroll/Money";
import { NewRunDialog } from "@/components/payroll/NewRunDialog";
import { countsText, tickStatuses, Ticks } from "@/components/payroll/Ticks";
import { RunStatusPill } from "@/components/StatusPill";
import { walletName } from "@/components/wallets/useVerifyWallet";
import { errorMessage } from "@/lib/api";
import { formatAmount, formatDay, monthLabel, shortAddress, timeAgo } from "@/lib/format";
import { useMe, useSummary, useWallets } from "@/lib/session";
import type { RunSummary, Summary } from "@/lib/types";

function greeting(): string {
  const h = new Date().getHours();
  return h < 12 ? "Good morning." : h < 18 ? "Good afternoon." : "Good evening.";
}

function NextRun({ run }: { run: RunSummary }) {
  const day = run.payDate ? new Date(`${run.payDate}T00:00:00Z`) : null;
  const paying = run.status === "PROCESSING";
  return (
    <div className="lift" style={{ display: "flex", gap: 20, alignItems: "center", padding: "20px 28px", borderTop: "1px solid var(--rule)", flexWrap: "wrap", background: "var(--sheet)" }}>
      <span className="date-tile anim-scale-in" aria-hidden="true" style={{ animationDelay: "0.4s" }}>
        <b>{day ? day.toLocaleDateString("en-GB", { month: "short", timeZone: "UTC" }).toUpperCase() : "DRAFT"}</b>
        <span>{day ? day.getUTCDate() : "—"}</span>
      </span>
      <div style={{ flex: "1 1 260px", minWidth: 0 }}>
        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <b style={{ fontSize: 16 }}>{run.name}</b>
          <RunStatusPill status={run.status} />
        </div>
        <div className="muted" style={{ fontSize: 13, marginTop: 4 }}>
          {run.counts.payments - run.counts.cancelled} people · <span className="mono">{formatAmount(run.total)} USDC</span>
          {run.payDate ? ` · pay date ${formatDay(run.payDate)}` : ""} · edited {timeAgo(run.updatedAt)}
        </div>
        {paying ? (
          <div style={{ marginTop: 10, maxWidth: 420 }}>
            <Ticks statuses={tickStatuses(run.counts)} label={countsText(run.counts)} />
          </div>
        ) : null}
      </div>
      <Link href={`/payroll/${run.id}`} className="btn btn-primary">
        {paying ? "Continue paying" : "Review and pay"} <Icon name="forward" size={16} />
      </Link>
    </div>
  );
}

/** Paid per month, last six months. One series: one hue, values on hover and in the list for screen readers. */
function MonthlyChart({ monthly }: { monthly: Summary["monthly"] }) {
  const values = monthly.map((m) => parseAmount(m.paid) ?? 0n);
  const max = values.reduce((a, b) => (b > a ? b : a), 0n);
  const [hover, setHover] = useState<number | null>(null);
  if (max === 0n) {
    return <p className="muted" style={{ padding: "8px 0 4px" }}>Nothing paid in the last six months yet. Your first run will show up here.</p>;
  }
  // Heights as whole per-mille of the tallest month: bigint all the way, no float amounts.
  const height = (v: bigint) => Number.parseInt(((v * 1000n) / max).toString(), 10) / 10;
  return (
    <figure style={{ margin: 0 }}>
      <div style={{ display: "grid", gridTemplateColumns: `repeat(${monthly.length}, 1fr)`, gap: 10, alignItems: "end", height: 170, borderBottom: "1px solid var(--rule)", position: "relative" }} aria-hidden="true">
        {monthly.map((m, i) => {
          const v = values[i] ?? 0n;
          const current = i === monthly.length - 1;
          return (
            <div
              key={m.month}
              onMouseEnter={() => setHover(i)}
              onMouseLeave={() => setHover(null)}
              style={{ height: "100%", display: "flex", flexDirection: "column", justifyContent: "flex-end", alignItems: "center", gap: 6, position: "relative", cursor: "default" }}
            >
              {hover === i || (current && hover === null) ? (
                <span className="mono tnum" style={{ fontSize: 12, color: "var(--ink)", whiteSpace: "nowrap" }}>
                  {formatAmount(m.paid)}
                </span>
              ) : null}
              <div
                className="bar"
                style={{ ["--i" as string]: i, width: "min(56px, 70%)", height: `${Math.max(v > 0n ? 2 : 0, height(v))}%`, background: "var(--green)", opacity: hover === null || hover === i ? 1 : 0.55, borderRadius: "4px 4px 0 0" }}
              />
            </div>
          );
        })}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: `repeat(${monthly.length}, 1fr)`, gap: 10, marginTop: 8 }} aria-hidden="true">
        {monthly.map((m, i) => (
          <span key={m.month} className="faint" style={{ textAlign: "center", fontSize: 12, fontWeight: i === monthly.length - 1 ? 700 : 400, color: i === monthly.length - 1 ? "var(--ink)" : undefined }}>
            {monthLabel(m.month)}
          </span>
        ))}
      </div>
      <figcaption className="sr-only">
        USDC paid per month:{" "}
        {monthly.map((m) => `${monthLabel(m.month, "long")} ${formatAmount(m.paid)}`).join("; ")}
      </figcaption>
    </figure>
  );
}

function RecentRuns({ runs }: { runs: RunSummary[] }) {
  if (runs.length === 0) return null;
  return (
    <section className="sheet" aria-labelledby="recent-h">
      <div className="sheet-pad" style={{ paddingBottom: 8, display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12 }}>
        <h2 id="recent-h" className="h2">
          Recent runs
        </h2>
        <Link href="/payroll">All payroll</Link>
      </div>
      <div className="table-wrap">
        <table className="table stack">
          <thead>
            <tr>
              <th>Run</th>
              <th className="hide-sm">Finished</th>
              <th>Status</th>
              <th className="num">Paid (USDC)</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((r) => (
              <tr key={r.id} className="lift">
                <td>
                  <Link href={`/payroll/${r.id}`} className="rowlink">
                    {r.name}
                  </Link>
                  <div className="faint mono" style={{ fontSize: 12 }}>
                    #{r.number} · {countsText(r.counts)}
                  </div>
                </td>
                <td className="hide-sm muted">{r.finishedAt ? timeAgo(r.finishedAt) : "—"}</td>
                <td>
                  <RunStatusPill status={r.status} />
                </td>
                <td className="num">
                  {formatAmount(r.paidTotal)}
                  {r.paidTotal !== r.total ? <div className="faint" style={{ fontSize: 12 }}>of {formatAmount(r.total)}</div> : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export default function OverviewPage() {
  const { company } = useMe();
  const { data, error, mutate } = useSummary();
  const { data: wallets } = useWallets();
  const [newOpen, setNewOpen] = useState(false);
  const today = new Date().toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" });

  if (error && !data) {
    return (
      <div className="sheet empty" role="alert">
        <strong>The overview didn&apos;t load</strong>
        <span>{errorMessage(error)}</span>
        <button type="button" className="btn btn-primary" onClick={() => void mutate()}>
          Try again
        </button>
      </div>
    );
  }

  const next = data ? (data.activeRuns[0] ?? data.draftRuns[0] ?? null) : null;
  // The wallet the next run pays from (or the first one), compared with what that run still has to send.
  const wallet = wallets?.data.find((w) => w.id === next?.wallet.id) ?? wallets?.data[0];
  const remaining = next ? (parseAmount(next.total) ?? 0n) - (parseAmount(next.paidTotal) ?? 0n) : 0n;
  // Where the failed payments are: the most recent run that has any (or the payroll list).
  const failedRun = data ? [...data.activeRuns, ...data.recentRuns].find((r) => r.counts.failed > 0) : undefined;
  const nothingYet = data && wallets && data.activeEmployees === 0 && data.recentRuns.length === 0 && data.draftRuns.length === 0;
  const walletShort = wallet && next && wallet.id === next.wallet.id && wallet.usdcBalance !== null ? (parseAmount(wallet.usdcBalance) ?? 0n) < remaining : false;

  const headline = !data ? (
    <span className="skeleton" style={{ display: "inline-block", width: "min(520px, 90%)" }}>
      Loading
    </span>
  ) : (
    (() => {
      const hello = greeting();
      const [lead, em, tail] = next?.status === "PROCESSING" ? [hello, next.name, "is being paid."] : next ? [hello, next.name, "is ready to review."] : [`${hello} Payroll,`, "proven on Stellar.", ""];
      return (
        <>
          <Words text={lead} /> <em><Words text={em} start={wordCount(lead)} /></em>
          {tail ? (
            <>
              {" "}
              <Words text={tail} start={wordCount(lead) + wordCount(em)} />
            </>
          ) : null}
        </>
      );
    })()
  );

  return (
    <>
      <header className="page-head">
        <div>
          <span className="eyebrow">Overview · {today}</span>
          <h1 className="h1">{headline}</h1>
        </div>
        <button type="button" className="btn btn-dark" onClick={() => setNewOpen(true)}>
          <Icon name="plus" size={16} /> New payroll
        </button>
      </header>

      {nothingYet ? (
        <div className="info-note" style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
          <span style={{ flex: "1 1 280px" }}>
            {company ? `Welcome, ${company.businessName}. ` : ""}Add a funding wallet and the people you pay, then draft your first run.
          </span>
          <Link href="/onboarding" className="btn btn-secondary btn-sm">
            Finish setting up
          </Link>
        </div>
      ) : null}

      <section className="sheet" aria-label="This month">
        <div className="stagger" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(230px, 1fr))" }}>
          <div className="sheet-pad kpi-cell" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <span className="eyebrow">Paid this month</span>
            {data ? <Money amount={data.paidThisMonth} /> : <span className="skeleton" style={{ height: 40, width: 200 }} />}
            <span className="muted" style={{ fontSize: 13 }}>
              {data ? `${data.peoplePaidThisMonth} ${data.peoplePaidThisMonth === 1 ? "person" : "people"} paid on Stellar Testnet` : " "}
            </span>
          </div>
          <div className="sheet-pad kpi-cell" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <span className="eyebrow">Funding wallet</span>
            {wallet ? (
              <>
                {wallet.usdcBalance !== null ? <Money amount={wallet.usdcBalance} /> : <span className="money" style={{ fontSize: 40 }}>—</span>}
                <span className="muted" style={{ fontSize: 13 }}>
                  <span className="mono" style={{ fontSize: 12 }}>
                    {walletName(wallet) === wallet.label ? `${wallet.label} · ` : ""}
                    {shortAddress(wallet.address)}
                  </span>
                  {wallet.usdcBalance === null ? " · no USDC trustline yet" : walletShort ? <span style={{ color: "var(--failed)" }}> · short of the next run</span> : next && wallet.id === next.wallet.id ? " · enough for the next run" : ""}
                </span>
              </>
            ) : wallets ? (
              <Link href="/settings#wallets" className="btn btn-secondary btn-sm" style={{ alignSelf: "flex-start" }}>
                Add a funding wallet
              </Link>
            ) : (
              <span className="skeleton" style={{ height: 40, width: 200 }} />
            )}
          </div>
          <div className="sheet-pad kpi-cell" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <span className="eyebrow">Needs a look</span>
            {data ? (
              <span className="money" style={{ fontSize: 40, color: data.failedPayments + data.employeesWithProblems > 0 ? "var(--failed)" : undefined }}>
                <CountUpInt value={data.failedPayments + data.employeesWithProblems} />
              </span>
            ) : (
              <span className="skeleton" style={{ height: 40, width: 60 }} />
            )}
            <span className="muted" style={{ fontSize: 13, display: "flex", flexDirection: "column", gap: 2 }}>
              {data && data.failedPayments > 0 ? (
                <Link href={failedRun ? `/payroll/${failedRun.id}` : "/payroll"}>
                  {data.failedPayments} payment{data.failedPayments === 1 ? "" : "s"} not sent
                </Link>
              ) : null}
              {data && data.employeesWithProblems > 0 ? (
                <Link href="/people?ready=problem">
                  {data.employeesWithProblems} {data.employeesWithProblems === 1 ? "person" : "people"} can&apos;t receive USDC
                </Link>
              ) : null}
              {data && data.failedPayments + data.employeesWithProblems === 0 ? "Nothing. Every wallet checked can receive USDC." : null}
            </span>
          </div>
        </div>
        {next ? <NextRun run={next} /> : null}
      </section>

      <section className="sheet sheet-pad" aria-labelledby="monthly-h" style={{ display: "flex", flexDirection: "column", gap: 18 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
          <h2 id="monthly-h" className="h2">
            Paid per month
          </h2>
          <span className="faint" style={{ fontSize: 13 }}>
            USDC, by the ledger time each payment landed
          </span>
        </div>
        {data ? <MonthlyChart monthly={data.monthly} /> : <div className="skeleton" style={{ height: 170 }} />}
      </section>

      {data ? <RecentRuns runs={data.recentRuns} /> : null}
      <NewRunDialog open={newOpen} onClose={() => setNewOpen(false)} />
    </>
  );
}
