"use client";

import { formatStroops } from "@orgpay/shared";
import { useEffect, useState } from "react";
import { explorerTx } from "@/lib/config";

// Run #1 from the Testnet proof: real employees, amounts and hashes (docs/TRANSACTIONS.md).
const PAYMENTS: { name: string; stroops: bigint; hash: string }[] = [
  { name: "Ada Okafor", stroops: 10_000_000n, hash: "b7f1599bd25b6bdd1b6670901cf23d1079f5370260c84e7f8f966793e9cdda6b" },
  { name: "Amara Nwosu", stroops: 20_000_001n, hash: "e53d06a7bd5c30384cf5b1cd57c229adae7e47029ef5b7b69fbd47e0640e1c7c" },
  { name: "Kenji Watanabe", stroops: 12_500_000n, hash: "6efb22841ecc08145b107fa45ed63615daaf47bcf98bf8a68048486355477d94" },
  { name: "Marcus Silva", stroops: 17_500_000n, hash: "3c5eb203467f08b63dd802461aaddc22741875a0f8270837d787fb8fb39d5027" },
  { name: "Priya Raman", stroops: 15_000_000n, hash: "1d8d0df3d581b63b36439190090a226f3632545e7232d70e6354b82e65df60b3" },
];

const LOOK = [
  { pill: "pill-muted", label: "Pending", tick: "" },
  { pill: "pill-warn", label: "Signing", tick: "signing" },
  { pill: "pill-info", label: "Confirming", tick: "sending" },
  { pill: "pill-good", label: "Successful", tick: "paid" },
] as const;

/** The landing's run document, playing a payroll through: pending → signing → confirming → successful. */
export function HeroRun() {
  const [step, setStep] = useState(99);
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    setStep(0);
    const timer = setInterval(() => setStep((s) => (s >= 22 ? 0 : s + 1)), 750);
    return () => clearInterval(timer);
  }, []);

  let paid = 0n;
  let ok = 0;
  let moving = 0;
  const rows = PAYMENTS.map((p, i) => {
    const phase = Math.max(0, Math.min(3, step - i * 3));
    if (phase === 3) {
      paid += p.stroops;
      ok++;
    } else if (phase > 0) moving++;
    return { ...p, phase, look: LOOK[phase] ?? LOOK[0] };
  });
  const done = ok === PAYMENTS.length;
  const counts = `${ok} successful · ${moving} in flight · ${PAYMENTS.length - ok - moving} pending · 1 failed`;

  return (
    <div className="hero-run">
      <div className="hero-badge" aria-hidden="true">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6z" />
          <path d="M8.5 12l2.5 2.5 4.5-5" />
        </svg>
        Verified on the ledger
      </div>
      <div className="tear-top" aria-hidden="true" />
      <div className="hero-doc">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
          <div>
            <div className="eyebrow">Payroll run #1 · live</div>
            <div className="serif" style={{ fontSize: 23, marginTop: 4 }}>October payroll</div>
          </div>
          <span className={`pill ${done ? "pill-warn" : "pill-info"}`}>
            <span className="live-dot" style={{ background: "currentColor", width: 7, height: 7 }} />
            {done ? "Partially paid · retry Tomás" : "Processing"}
          </span>
        </div>
        <div className="ticks" role="img" aria-label={counts} style={{ margin: "18px 0 6px" }}>
          {rows.map((r) => (
            <i key={r.name} className={r.look.tick} />
          ))}
          <i className="failed" />
        </div>
        <div aria-live="polite" className="muted" style={{ fontSize: 12.5, marginBottom: 8 }}>
          {counts}
        </div>
        {rows.map((r, i) => (
          <div key={r.name} className="hero-row">
            <span className="mono faint" style={{ fontSize: 12, width: 22 }}>{String(i + 1).padStart(2, "0")}</span>
            <span style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 2 }}>
              <span style={{ fontWeight: 500 }}>{r.name}</span>
              {r.phase === 3 ? (
                <a className="mono" href={explorerTx(r.hash)} target="_blank" rel="noreferrer" style={{ fontSize: 11.5 }}>
                  {r.hash.slice(0, 16)}… · R1 P{i + 1}
                </a>
              ) : (
                <span className="mono faint" style={{ fontSize: 11.5 }}>{r.phase === 2 ? "waiting for the ledger…" : "not sent yet"}</span>
              )}
            </span>
            <span className="mono" style={{ fontSize: 13 }}>{formatStroops(r.stroops)}</span>
            <span className={`pill ${r.look.pill}`} style={{ minWidth: 112, justifyContent: "center" }}>{r.look.label}</span>
          </div>
        ))}
        <div className="hero-row">
          <span className="mono faint" style={{ fontSize: 12, width: 22 }}>06</span>
          <span style={{ flex: 1, display: "flex", flexDirection: "column", gap: 2 }}>
            <span style={{ fontWeight: 500 }}>Tomás Reyes</span>
            <span className="mono" style={{ fontSize: 11.5, color: "var(--failed)" }}>left out before signing</span>
          </span>
          <span className="mono" style={{ fontSize: 13 }}>2.5000000</span>
          <span className="pill pill-danger" style={{ minWidth: 112, justifyContent: "center" }}>No trustline</span>
        </div>
        <div className="total-rule" />
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", paddingTop: 12 }}>
          <span style={{ fontWeight: 600 }}>Paid so far</span>
          <span className="serif" style={{ fontSize: 32 }}>
            {formatStroops(paid)} <span className="muted" style={{ fontSize: 14, fontFamily: "var(--font-sans)", fontWeight: 400 }}>/ 10.0000001 USDC</span>
          </span>
        </div>
      </div>
    </div>
  );
}
