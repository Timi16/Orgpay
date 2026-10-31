import { Section } from "./Section";
import styles from "./settings.module.css";

/** Testnet is the only network. Mainnet is shown so companies know it is planned; it does nothing. */
export function NetworkCard() {
  return (
    <Section id="network" title="Network" sub="Which Stellar network payroll is paid on.">
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <div className={styles.netOn} aria-current="true">
          <span className={styles.netDot} aria-hidden="true" />
          <div style={{ display: "flex", flexDirection: "column", gap: 1, flex: 1, minWidth: 0 }}>
            <span style={{ fontWeight: 800 }}>Testnet</span>
            <span style={{ fontSize: 13, color: "var(--slate)" }}>Free test money from Friendbot. Nothing here is real.</span>
          </div>
          <span style={{ fontSize: 12, fontWeight: 700, color: "var(--brand-dark)" }}>Selected</span>
        </div>
        <div className={styles.netOff} aria-disabled="true">
          <span aria-hidden="true" style={{ width: 10, height: 10, borderRadius: "50%", background: "var(--good)", opacity: 0.5, flexShrink: 0 }} />
          <div style={{ display: "flex", flexDirection: "column", gap: 1, flex: 1, minWidth: 0 }}>
            <span style={{ fontWeight: 800, color: "var(--slate)" }}>Mainnet</span>
            <span style={{ fontSize: 13, color: "var(--slate)" }}>Real USDC. Same people, same runs.</span>
          </div>
          <span style={{ padding: "3px 9px", borderRadius: 6, background: "var(--border)", color: "var(--slate)", fontSize: 12, fontWeight: 700, whiteSpace: "nowrap" }}>Coming soon</span>
        </div>
      </div>
    </Section>
  );
}
