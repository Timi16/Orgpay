import { formatStroops, parseAmount } from "@orgpay/shared";

// Amounts stay decimal strings end to end: nothing here goes through a float.

/** "50.0000000" -> "50.00", "1840.5" -> "1,840.50", "0.0000001" -> "0.0000001". */
export function formatAmount(amount: string, minDecimals = 2): string {
  const negative = amount.startsWith("-");
  const [whole = "0", fracRaw = ""] = amount.replace("-", "").split(".");
  let frac = fracRaw.replace(/0+$/, "");
  if (frac.length < minDecimals) frac = frac.padEnd(minDecimals, "0");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${negative ? "-" : ""}${grouped}${frac ? `.${frac}` : ""}`;
}

/** True when a decimal string is greater than zero. */
export function isPositive(amount: string): boolean {
  return /[1-9]/.test(amount) && !amount.startsWith("-");
}

export function shortAddress(address: string, lead = 4, tail = 4): string {
  return address.length <= lead + tail + 1 ? address : `${address.slice(0, lead)}…${address.slice(-tail)}`;
}

export const shortHash = (hash: string) => shortAddress(hash, 4, 4);

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "just now", "9 min ago", "3 h ago", "2 days ago", then a date. */
export function timeAgo(iso: string, now: number = Date.now()): string {
  const diff = now - new Date(iso).getTime();
  if (diff < MINUTE) return "just now";
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)} min ago`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)} h ago`;
  if (diff < 7 * DAY) {
    const days = Math.floor(diff / DAY);
    return `${days} day${days === 1 ? "" : "s"} ago`;
  }
  return formatDate(iso);
}

/** Time left until `iso`: "24 min", "3 h 10 min", "2 days". Empty string when already past. */
export function timeLeft(iso: string, now: number = Date.now()): string {
  const diff = new Date(iso).getTime() - now;
  if (diff <= 0) return "";
  if (diff < MINUTE) return "under a minute";
  if (diff < HOUR) return `${Math.ceil(diff / MINUTE)} min`;
  if (diff < DAY) {
    const minutes = Math.floor((diff % HOUR) / MINUTE);
    return `${Math.floor(diff / HOUR)} h${minutes ? ` ${minutes} min` : ""}`;
  }
  const days = Math.floor(diff / DAY);
  return `${days} day${days === 1 ? "" : "s"}`;
}

/** Countdown clock: "29:41", or "2:05:09" past an hour, or "3 days" for long expiries. */
export function countdown(iso: string, now: number = Date.now()): string {
  const diff = Math.max(0, new Date(iso).getTime() - now);
  if (diff >= 2 * DAY) return `${Math.floor(diff / DAY)} days`;
  const total = Math.floor(diff / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => n.toString().padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

export function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

/** Two-letter initials for avatars: "Lagoon Coffee" -> "LC", "tolu@example.com" -> "TO". */
export function initials(name: string): string {
  const words = name.replace(/@.*/, "").split(/[\s._-]+/).filter(Boolean);
  const letters = words.length >= 2 ? `${words[0]?.[0] ?? ""}${words[1]?.[0] ?? ""}` : (words[0] ?? "?").slice(0, 2);
  return letters.toUpperCase();
}

/** Sum of decimal strings, exactly (through bigint stroops). Unreadable values count as 0. */
export function sumAmounts(amounts: string[]): string {
  return formatStroops(amounts.reduce((sum, a) => sum + (parseAmount(a) ?? 0n), 0n));
}

/** "October payroll" → a stable month label "Oct 2026" for "YYYY-MM". */
export function monthLabel(yyyyMm: string, style: "short" | "long" = "short"): string {
  const [y = "2000", m = "1"] = yyyyMm.split("-");
  return new Date(Date.UTC(Number.parseInt(y, 10), Number.parseInt(m, 10) - 1, 1)).toLocaleDateString("en-GB", { month: style, timeZone: "UTC" });
}

/** A plain date (YYYY-MM-DD) shown as "31 Oct 2026", without timezone drift. */
export function formatDay(day: string): string {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}
