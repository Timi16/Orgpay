import Link from "next/link";

interface MarkProps {
  size?: number;
  /** Lines flow and the dots pulse: payments going out. Off under reduced motion. */
  animated?: boolean;
  /** "light" = on paper; "dark" = on the night panel. Same mark either way. */
  on?: "light" | "dark";
}

/**
 * The OrgPay mark, a fan-out: the organization's coin sends three lines that land as three
 * payments. Below 24 px the lines drop and the coin and dots stay.
 */
export function LogoMark({ size = 30, animated = false }: MarkProps) {
  if (size < 24) {
    return (
      <svg width={size} height={size} viewBox="0 0 36 36" aria-hidden="true" style={{ flexShrink: 0 }}>
        <rect width="36" height="36" rx="9" fill="#2F4BD8" />
        <circle cx="12" cy="18" r="6.5" fill="#FFFFFF" />
        <circle cx="26.5" cy="9.5" r="3.8" fill="#FFFFFF" />
        <circle cx="26.5" cy="18" r="3.8" fill="#FFFFFF" />
        <circle cx="26.5" cy="26.5" r="3.8" fill="#FFFFFF" />
      </svg>
    );
  }
  return (
    <svg width={size} height={size} viewBox="0 0 36 36" aria-hidden="true" className={animated ? "lg-live" : undefined} style={{ flexShrink: 0 }}>
      <rect width="36" height="36" rx="10" fill="#2F4BD8" />
      <path className="lg-flow" d="M13 18C19 18 19.5 9.5 25 9.5M13 18H25M13 18C19 18 19.5 26.5 25 26.5" stroke="#C9D3FF" strokeWidth="1.8" fill="none" strokeLinecap="round" />
      <circle cx="11.5" cy="18" r="5.2" fill="#FFFFFF" />
      <circle cx="11.5" cy="18" r="2.1" fill="#14213D" />
      <circle className="lg-leaf" cx="26.5" cy="9.5" r="2.9" fill="#FFFFFF" />
      <circle className="lg-leaf lg-l2" cx="26.5" cy="18" r="2.9" fill="#FFFFFF" />
      <circle className="lg-leaf lg-l3" cx="26.5" cy="26.5" r="2.9" fill="#FFFFFF" />
    </svg>
  );
}

interface LogoProps {
  href?: string;
  size?: number;
  fontSize?: number;
  on?: "light" | "dark";
  animated?: boolean;
  style?: React.CSSProperties;
}

export function Logo({ href = "/", size = 30, fontSize = 24, on = "light", animated = true, style }: LogoProps) {
  return (
    <Link
      href={href}
      aria-label="OrgPay home"
      style={{ display: "inline-flex", alignItems: "center", gap: 10, color: on === "dark" ? "#FFFFFF" : "var(--ink)", textDecoration: "none", ...style }}
    >
      <LogoMark size={size} animated={animated} on={on} />
      <span style={{ fontFamily: "var(--font-serif)", fontWeight: 700, fontSize, lineHeight: 1, letterSpacing: "-0.03em" }}>
        Org<span style={{ color: on === "dark" ? "#9FB0FF" : "var(--green)" }}>Pay</span>
      </span>
    </Link>
  );
}
