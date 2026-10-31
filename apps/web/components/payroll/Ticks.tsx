import type { ItemStatus, RunSummary } from "@/lib/types";

const CLASS: Record<ItemStatus, string> = {
  PENDING: "",
  AWAITING_SIGNATURE: "signing",
  SUBMITTED: "sending",
  SUCCESSFUL: "paid",
  FAILED: "failed",
  CANCELLED: "cancelled",
};

/**
 * One tick per payment, in run order: successful, in flight (striped), failed, cancelled, still
 * pending. Above 120 payments the ticks would be hairlines, so the same story is told as a joined
 * bar. The counts are always written out next to it; this is the picture, not the only record.
 */
export function Ticks({ statuses, label }: { statuses: ItemStatus[]; label: string }) {
  if (statuses.length === 0) return null;
  if (statuses.length > 120) {
    const order: ItemStatus[] = ["SUCCESSFUL", "SUBMITTED", "AWAITING_SIGNATURE", "FAILED", "CANCELLED", "PENDING"];
    return (
      <div className="ticks bar" role="img" aria-label={label}>
        {order.map((s) => {
          const n = statuses.filter((x) => x === s).length;
          return n ? <i key={s} className={CLASS[s]} style={{ flex: n }} /> : null;
        })}
      </div>
    );
  }
  return (
    <div className="ticks" role="img" aria-label={label}>
      {statuses.map((s, i) => (
        <i key={i} className={CLASS[s]} style={{ animationDelay: `${Math.min(i, 40) * 30}ms` }} />
      ))}
    </div>
  );
}

/** Payment statuses in tick order, from a summary's counts (a summary has counts, not payments). */
export function tickStatuses(c: RunSummary["counts"]): ItemStatus[] {
  return [
    ...Array<ItemStatus>(c.successful).fill("SUCCESSFUL"),
    ...Array<ItemStatus>(c.submitted).fill("SUBMITTED"),
    ...Array<ItemStatus>(c.awaitingSignature).fill("AWAITING_SIGNATURE"),
    ...Array<ItemStatus>(c.failed).fill("FAILED"),
    ...Array<ItemStatus>(c.pending).fill("PENDING"),
    ...Array<ItemStatus>(c.cancelled).fill("CANCELLED"),
  ];
}

/** "5 successful · 1 confirming · 1 failed · 2 pending", skipping zeros. */
export function countsText(c: RunSummary["counts"]): string {
  const parts = [
    c.successful ? `${c.successful} successful` : "",
    c.awaitingSignature ? `${c.awaitingSignature} waiting for signature` : "",
    c.submitted ? `${c.submitted} confirming` : "",
    c.failed ? `${c.failed} failed` : "",
    c.pending ? `${c.pending} pending` : "",
    c.cancelled ? `${c.cancelled} cancelled` : "",
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : "No payments yet";
}
