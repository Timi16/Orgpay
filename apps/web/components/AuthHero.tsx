"use client";

import styles from "@/app/(auth)/auth.module.css";
import { useReducedMotion } from "@/app/(auth)/_ui/useReducedMotion";
import { Logo } from "./Logo";

const POINTS = ["Non-custodial · you sign every payroll in Freighter", "Checked before you sign, so nobody is paid twice", "Paid or Not sent, with the transaction hash"];

const at = (i: number) => ({ "--i": i }) as React.CSSProperties;

/** The ink left panel of the sign-up and sign-in screens. */
export function AuthHero() {
  const reduced = useReducedMotion();
  return (
    <section className={styles.hero}>
      {/* Decoration only: two slow blurred shapes and a faint bridge that redraws, kept to the far side. */}
      <div className={styles.decor} aria-hidden="true">
        <span className={`${styles.blob} ${styles.blobA}`} />
        <span className={`${styles.blob} ${styles.blobB}`} />
        <svg className={styles.arch} viewBox="0 0 500 200" fill="none" stroke="currentColor" strokeLinecap="round">
          <path className={styles.archLine} pathLength={1} d="M20 120H480" strokeWidth="6" />
          <path className={styles.archLine} pathLength={1} d="M20 150H480" strokeWidth="6" />
        </svg>
      </div>
      <div className={styles.in} style={at(0)}>
        <Logo on="dark" size={30} fontSize={28} animated={!reduced} style={{ display: "inline-flex" }} />
      </div>
      <div className={styles.heroBody}>
        <h2 className={`${styles.heroTitle} ${styles.in}`} style={at(1)}>
          Pay the whole team. Prove every payment.
        </h2>
        <p className={`${styles.heroText} ${styles.in}`} style={at(2)}>
          Payroll in USDC on Stellar. You keep the keys and the money; OrgPay checks every wallet, builds the transaction and tracks each payment to its hash.
        </p>
        <ul className={styles.heroList}>
          {POINTS.map((line, i) => (
            <li key={line} className={styles.in} style={at(3 + i)}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path className={styles.tick} style={at(3 + i)} d="M5 12l5 5L20 7" />
              </svg>
              {line}
            </li>
          ))}
        </ul>
      </div>
      <span className={`${styles.heroFoot} ${styles.in}`} style={at(6)}>
        Currently in beta on Stellar Testnet. No real money moves.
      </span>
    </section>
  );
}
