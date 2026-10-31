"use client";

import { formatStroops } from "@orgpay/shared";
import { useState } from "react";
import { formatAmount } from "@/lib/format";

/** Fee per payment operation, in stroops (OrgPay bids 1000; Testnet usually charges 100). */
const FEE_PER_OP = 1000n;

/** "What a run costs": drag the team size, pick one transaction per employee or batches. */
export function Calculator() {
  const [people, setPeople] = useState(12);
  const [batched, setBatched] = useState(false);
  const txs = batched ? Math.ceil(people / 100) : people;
  const fees = formatAmount(formatStroops(BigInt(people) * FEE_PER_OP), 4);
  return (
    <div className="card-lift calc">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <label htmlFor="calc-n" style={{ fontWeight: 600 }}>People on the run</label>
        <span className="serif" style={{ fontSize: 40, color: "var(--green)" }}>{people}</span>
      </div>
      <input id="calc-n" type="range" min={1} max={200} value={people} onChange={(e) => setPeople(Number.parseInt(e.target.value, 10))} style={{ width: "100%", accentColor: "var(--green)" }} />
      <div className="seg" role="group" aria-label="Payments per transaction">
        <button type="button" aria-pressed={!batched} onClick={() => setBatched(false)}>One per employee</button>
        <button type="button" aria-pressed={batched} onClick={() => setBatched(true)}>Batch up to 100</button>
      </div>
      <div className="calc-grid">
        <div><span className="eyebrow">Signatures</span><div className="serif calc-num">{txs}</div></div>
        <div><span className="eyebrow">Network fees</span><div className="serif calc-num">{fees} <span className="muted" style={{ fontSize: 13, fontFamily: "var(--font-sans)", fontWeight: 400 }}>XLM</span></div></div>
        <div><span className="eyebrow">Hashes</span><div className="serif calc-num">{txs}</div></div>
      </div>
      <span className="muted" style={{ fontSize: 13 }}>
        {batched ? "Fewer signatures; payments in the same transaction share a hash." : `Every employee gets their own hash and memo, e.g. OrgPay R1 P${people}.`}
      </span>
    </div>
  );
}
