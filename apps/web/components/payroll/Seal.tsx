import type { RunStatus } from "@/lib/types";

/** The stamp on a finished run: COMPLETED in green, PARTIALLY PAID in amber. Decorative; the status pill says it too. */
export function Seal({ status, date }: { status: RunStatus; date: string | null }) {
  if (status !== "COMPLETED" && status !== "PARTIALLY_PAID") return null;
  const day = date ? new Date(date).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }).toUpperCase() : "";
  return (
    <span aria-hidden="true" className={`seal ${status === "COMPLETED" ? "seal-paid" : "seal-partial"}`}>
      {status === "COMPLETED" ? "Completed" : "Partially paid"}
      {day ? <small>{day}</small> : null}
    </span>
  );
}
