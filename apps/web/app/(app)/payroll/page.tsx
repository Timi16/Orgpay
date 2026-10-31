"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import useSWRInfinite from "swr/infinite";
import { Icon } from "@/components/Icon";
import { NewRunDialog } from "@/components/payroll/NewRunDialog";
import { countsText } from "@/components/payroll/Ticks";
import { RunStatusPill } from "@/components/StatusPill";
import { errorMessage, qs } from "@/lib/api";
import { formatAmount, formatDay, timeAgo } from "@/lib/format";
import { RUN_STATUS } from "@/lib/payroll";
import type { Page, RunStatus, RunSummary } from "@/lib/types";

const FILTERS: (RunStatus | "")[] = ["", "DRAFT", "PROCESSING", "COMPLETED", "PARTIALLY_PAID", "FAILED", "CANCELLED"];

function PayrollView() {
  const params = useSearchParams();
  const router = useRouter();
  const status = (params.get("status") ?? "") as RunStatus | "";
  const [newOpen, setNewOpen] = useState(false);

  // /payroll?new=1 (from onboarding and the overview) opens the dialog once.
  useEffect(() => {
    if (params.get("new") === "1") {
      setNewOpen(true);
      router.replace(status ? `/payroll?status=${status}` : "/payroll");
    }
  }, [params, router, status]);

  const { data, error, size, setSize, isLoading, mutate } = useSWRInfinite<Page<RunSummary>>(
    (i, prev) => (i > 0 && !prev?.nextCursor ? null : `/v1/payroll-runs${qs({ limit: 25, status: status || undefined, cursor: i > 0 ? prev?.nextCursor : undefined })}`),
    { revalidateFirstPage: true },
  );
  const runs = data?.flatMap((p) => p.data) ?? [];
  const more = Boolean(data?.[data.length - 1]?.nextCursor);

  return (
    <>
      <header className="page-head">
        <div>
          <span className="eyebrow">Payroll</span>
          <h1 className="h1">Runs</h1>
        </div>
        <button type="button" className="btn btn-dark" onClick={() => setNewOpen(true)}>
          <Icon name="plus" size={16} /> New payroll
        </button>
      </header>

      <div className="seg" role="group" aria-label="Filter runs by status" style={{ alignSelf: "flex-start" }}>
        {FILTERS.map((f) => (
          <button key={f || "all"} type="button" aria-pressed={status === f} onClick={() => router.replace(f ? `/payroll?status=${f}` : "/payroll")}>
            {f ? RUN_STATUS[f].label : "All"}
          </button>
        ))}
      </div>

      <section className="sheet" aria-label="Payroll runs">
        {error && !data ? (
          <div className="empty" role="alert">
            <strong>Runs didn&apos;t load</strong>
            <span>{errorMessage(error)}</span>
            <button type="button" className="btn btn-primary" onClick={() => void mutate()}>
              Try again
            </button>
          </div>
        ) : isLoading && !data ? (
          <div style={{ padding: 28, display: "flex", flexDirection: "column", gap: 10 }} aria-busy="true">
            {[0, 1, 2].map((i) => (
              <div key={i} className="skeleton" style={{ height: 52 }} />
            ))}
          </div>
        ) : runs.length === 0 ? (
          <div className="empty">
            <strong>{status ? `No ${RUN_STATUS[status].label.toLowerCase()} runs` : "No payroll yet"}</strong>
            <span>{status ? "Try another filter." : "Draft a run: pick employees, check the total, execute and sign."}</span>
            {!status ? (
              <button type="button" className="btn btn-primary" style={{ marginTop: 8 }} onClick={() => setNewOpen(true)}>
                New payroll
              </button>
            ) : null}
          </div>
        ) : (
          <div className="table-wrap">
            <table className="table stack">
              <thead>
                <tr>
                  <th className="hide-sm">#</th>
                  <th>Run</th>
                  <th className="hide-sm">Pay date</th>
                  <th>Status</th>
                  <th className="num">Total (USDC)</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((r) => (
                  <tr key={r.id}>
                    <td className="idx hide-sm">{String(r.number).padStart(4, "0")}</td>
                    <td>
                      <Link href={`/payroll/${r.id}`} className="rowlink">
                        {r.name}
                      </Link>
                      <div className="faint" style={{ fontSize: 12 }}>
                        {r.status === "DRAFT" ? `${r.counts.payments} people · edited ${timeAgo(r.updatedAt)}` : countsText(r.counts)}
                      </div>
                    </td>
                    <td className="hide-sm muted">{r.payDate ? formatDay(r.payDate) : "—"}</td>
                    <td>
                      <RunStatusPill status={r.status} />
                    </td>
                    <td className="num">
                      {formatAmount(r.total)}
                      {r.status !== "DRAFT" && r.paidTotal !== r.total ? (
                        <div className="faint" style={{ fontSize: 12 }}>
                          {formatAmount(r.paidTotal)} paid
                        </div>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {more ? (
              <div style={{ padding: 18, display: "flex", justifyContent: "center" }}>
                <button type="button" className="btn btn-secondary btn-sm" onClick={() => void setSize(size + 1)}>
                  Show more
                </button>
              </div>
            ) : null}
          </div>
        )}
      </section>
      <NewRunDialog open={newOpen} onClose={() => setNewOpen(false)} />
    </>
  );
}

export default function PayrollPage() {
  return (
    <Suspense fallback={null}>
      <PayrollView />
    </Suspense>
  );
}
