"use client";

import { Logo } from "@/components/Logo";
import { CheckBurst } from "@/components/motion/CheckBurst";
import styles from "../auth.module.css";
import { useReducedMotion } from "./useReducedMotion";

/** Frame of the single-card auth screens: the logo draws, the card pops, a faint bridge spans the page. */
export function AuthCentred({ children, footer }: { children: React.ReactNode; footer?: React.ReactNode }) {
  const reduced = useReducedMotion();
  return (
    <div className={styles.centre}>
      <svg className={styles.backdrop} viewBox="0 0 500 200" fill="none" stroke="currentColor" strokeLinecap="round" aria-hidden="true">
        <path className={styles.backdropLine} pathLength={1} d="M20 180V150C120 20 380 20 480 150V180" strokeWidth="5" />
        <path className={styles.backdropLine} pathLength={1} d="M8 180H492" strokeWidth="5" />
        <path className={styles.backdropLine} pathLength={1} d="M130 180V96M250 180V54M370 180V96" strokeWidth="3.5" />
      </svg>
      <Logo size={36} fontSize={22} animated={!reduced} />
      <main className={styles.card}>{children}</main>
      {footer ? <div className={styles.after}>{footer}</div> : null}
    </div>
  );
}

/** The success tick. With reduced motion it is drawn already, since CheckBurst relies on its animation to appear. */
export function Burst({ size = 64, color = "var(--good)" }: { size?: number; color?: string }) {
  const reduced = useReducedMotion();
  if (!reduced) return <CheckBurst size={size} color={color} />;
  return (
    <span aria-hidden="true" style={{ width: size, height: size, borderRadius: "50%", background: color, display: "inline-flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
      <svg width={size * 0.5} height={size * 0.5} viewBox="0 0 24 24" fill="none" stroke="#FFFFFF" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
        <path d="M5 12l5 5L20 7" />
      </svg>
    </span>
  );
}
