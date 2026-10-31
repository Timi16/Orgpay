import type { Metadata } from "next";
import Link from "next/link";
import { Icon } from "@/components/Icon";
import { Logo, LogoMark } from "@/components/Logo";
import { Reveal } from "@/components/motion/Reveal";
import { explorerTx } from "@/lib/config";
import { Calculator } from "./_landing/Calculator";
import { HeroRun } from "./_landing/HeroRun";
import { StickyHeader } from "./_landing/StickyHeader";
import "./_landing/landing.css";

export const metadata: Metadata = {
  title: { absolute: "OrgPay · USDC payroll on Stellar, every payment proven" },
  description:
    "Add employees and their Stellar wallets, review one payroll run with an exact total, and sign. Each employee gets their own transaction, verified on the ledger. Non-custodial, on Stellar Testnet.",
};

// The six payments of the Testnet proof (docs/TRANSACTIONS.md).
const PROOF: [string, string, string][] = [
  ["R1 P1", "b7f1599bd25b6bdd1b6670901cf23d1079f5370260c84e7f8f966793e9cdda6b", "1.0000000"],
  ["R1 P2", "e53d06a7bd5c30384cf5b1cd57c229adae7e47029ef5b7b69fbd47e0640e1c7c", "2.0000001"],
  ["R1 P3", "6efb22841ecc08145b107fa45ed63615daaf47bcf98bf8a68048486355477d94", "1.2500000"],
  ["R1 P4", "3c5eb203467f08b63dd802461aaddc22741875a0f8270837d787fb8fb39d5027", "1.7500000"],
  ["R1 P5", "1d8d0df3d581b63b36439190090a226f3632545e7232d70e6354b82e65df60b3", "1.5000000"],
  ["R1 P6", "9ab4ea450f4dd479386c2ecf0fee6e3f35040ba0ac87664107e4298216bc8a83", "2.5000000"],
];

const STEPS: [string, string][] = [
  ["Add employees", "Name, Stellar wallet and USDC salary. Each wallet is checked: does it exist, does it trust USDC?"],
  ["Review one run", "Every amount, the exact total, who can’t receive yet, and whether your wallet covers it."],
  ["Execute and sign", "One transaction per employee, signed in Freighter. OrgPay never sees your key."],
  ["Verified on the ledger", "Successful only when the ledger record matches: the wallet, the amount, the hash."],
];

const CHECKS: [string, string][] = [
  ["Found on the ledger", "ledger 5489491"],
  ["Transaction succeeded", "successful"],
  ["The transaction OrgPay built", "hash matches"],
  ["From the funding wallet", "GDTDY4…CRAB"],
  ["To Amara’s wallet", "GAUFYR…RRDR"],
  ["USDC from Circle’s issuer", "GBBD47…LA5"],
  ["Exactly the salary", "2.0000001"],
  ["Payment operation succeeded", "op_success"],
];

const SAFETY: [string, string, string][] = [
  ["M8 11V8a4 4 0 0 1 8 0v3M6 11h12v9H6z", "Non-custodial", "OrgPay builds each transaction unsigned. You sign in Freighter. It never sees, stores or logs a secret key."],
  ["M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7", "Repeats are harmless", "Double clicks, retries and slow answers get the same transaction back. A successful payment is never sent again."],
  ["M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6zM8.5 12l2.5 2.5 4.5-5", "Successful means verified", "Only the ledger’s record, checked against the payment, turns it green. Anyone can re-check it."],
  ["M12 4l9 16H3zM12 10v4M12 17v.01", "Failures are loud", "A wallet that can’t receive is caught before signing, with the reason and a one-click retry."],
];

const COMPARE: [string, string, string][] = [
  ["Total before paying", "A spreadsheet", "Exact, to 7 decimals, on a double rule"],
  ["Wallet that can’t receive", "You find out after", "Caught at review; never sent"],
  ["Clicked twice", "Paid twice", "Same transaction, sent once"],
  ["Proof for each person", "Dig through history", "A hash and memo per payment, verified"],
];

const FAQ: [string, string][] = [
  ["Does OrgPay hold our money or keys?", "No. Money stays in your funding wallet until you sign. OrgPay builds each transaction unsigned; you sign it in Freighter and your secret key never leaves it."],
  ["What happens if I click Execute twice?", "Nothing extra. A run can be executed once, and while a transaction is open you always get that same one back. A successful payment is never sent again."],
  ["What if an employee’s wallet can’t receive USDC?", "It’s caught at review, before anything is signed. That payment is marked failed with the reason, nothing is sent, and you can retry once their wallet is fixed."],
  ["When does a payment count as successful?", "Only after OrgPay reads the transaction back from Stellar and it matches: the hash, the funding wallet, the employee’s wallet, the asset and the exact amount."],
  ["Is this real money?", "Not yet. OrgPay runs on Stellar Testnet with Circle’s Testnet USDC, which has no value."],
];

const check = (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" aria-hidden="true">
    <path d="M5 12.5l4.5 4.5L19 7.5" />
  </svg>
);

export default function Landing() {
  return (
    <div style={{ overflowX: "hidden" }}>
      <a className="l-announce" href="#proof">
        <span className="live-dot" style={{ marginRight: 8, verticalAlign: "middle", background: "#2e9e6a" }} />
        Live on Stellar Testnet: 6 payroll payments, 6 verified hashes. <b>See the proof →</b>
      </a>

      <StickyHeader>
        <div className="l-wrap" style={{ paddingTop: 16, paddingBottom: 16, display: "flex", flexWrap: "wrap", alignItems: "center", gap: "14px 28px" }}>
          <Logo size={34} fontSize={25} />
          <nav aria-label="Main" style={{ display: "flex", flexWrap: "wrap", gap: 24, flex: "1 1 auto" }}>
            <a href="#how">How it works</a>
            <a href="#verify">Verification</a>
            <a href="#costs">Costs</a>
            <a href="#safety">Safety</a>
            <a href="#faq">FAQ</a>
          </nav>
          <div style={{ display: "flex", gap: 10 }}>
            <Link className="btn btn-secondary" href="/login">Sign in</Link>
            <Link className="btn btn-primary" href="/signup">Start on Testnet</Link>
          </div>
        </div>
      </StickyHeader>

      <section className="l-wrap" style={{ paddingTop: 64, paddingBottom: 72, display: "flex", flexWrap: "wrap", gap: 56, alignItems: "center" }}>
        <div style={{ flex: "1 1 480px", minWidth: 0, display: "flex", flexDirection: "column", gap: 24 }}>
          <span className="pill pill-warn l-rise" style={{ alignSelf: "flex-start" }}>
            <span className="live-dot" style={{ background: "var(--testnet)" }} /> USDC payroll on Stellar Testnet
          </span>
          <h1 className="l-h1 l-rise l-d1">
            Pay the whole team in one run. <span className="shine">Prove every payment.</span>
          </h1>
          <p className="l-lead l-rise l-d2">
            Add employees and their Stellar wallets, review one payroll with an exact total, and sign. Each employee gets their own transaction, and it only turns green once the ledger says so.
          </p>
          <div className="l-rise l-d3" style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
            <Link className="btn btn-primary btn-lg" href="/signup">
              Run your first payroll <Icon name="forward" size={18} />
            </Link>
            <a className="btn btn-secondary btn-lg" href="#proof">See six real payments</a>
          </div>
          <div className="l-rise l-d4" style={{ display: "flex", flexWrap: "wrap", gap: 22 }}>
            <span className="l-check">{check}Keys stay in Freighter</span>
            <span className="l-check">{check}Nobody paid twice</span>
            <span className="l-check">{check}Every hash on Stellar Expert</span>
          </div>
        </div>
        <div className="l-rise l-d2" style={{ flex: "1 1 480px", minWidth: 0 }}>
          <HeroRun />
        </div>
      </section>

      <section id="proof" className="l-band l-marquee" aria-label="Verified Testnet hashes">
        <div className="l-marquee-track">
          {[...PROOF, ...PROOF].map(([memo, hash, amount], i) => (
            <span key={i} aria-hidden={i >= PROOF.length ? true : undefined}>
              {memo} · {i < PROOF.length ? <a href={explorerTx(hash)} target="_blank" rel="noreferrer">{hash.slice(0, 12)}…</a> : `${hash.slice(0, 12)}…`} · {amount} USDC ✓
            </span>
          ))}
        </div>
      </section>

      <section className="l-wrap" style={{ paddingTop: 56 }}>
        <div className="l-grid">
          {[
            ["6/6", "payments verified on Testnet, each with its own hash"],
            ["51", "checks passed in the end-to-end proof, read from Horizon"],
            ["0", "double payments across every repeated-request test"],
            ["5 s", "to a verified payment, about one Stellar ledger"],
          ].map(([n, text], i) => (
            <Reveal key={n} delay={i * 80} className="card-lift">
              <div className="l-stat">{n}</div>
              <div className="muted" style={{ fontSize: 14, marginTop: 6 }}>{text}</div>
            </Reveal>
          ))}
        </div>
      </section>

      <section id="how" className="l-wrap l-section" style={{ display: "flex", flexDirection: "column", gap: 32 }}>
        <Reveal style={{ maxWidth: 720, display: "flex", flexDirection: "column", gap: 10 }}>
          <span className="eyebrow">How it works</span>
          <h2 className="l-h2">From a list of people to verified hashes in four steps.</h2>
        </Reveal>
        <div className="l-steps">
          <div className="l-steps-line" aria-hidden="true" />
          <div className="l-steps-fill" aria-hidden="true" />
          <ol className="l-grid" style={{ listStyle: "none", margin: 0, padding: 0, position: "relative" }}>
            {STEPS.map(([title, text], i) => (
              <Reveal as="li" key={title} delay={i * 100} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                <span className="l-step-num" style={i === 3 ? { background: "var(--paid)" } : undefined}>{i === 3 ? check : `0${i + 1}`}</span>
                <div className="card-lift" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  <b style={{ fontSize: 18 }}>{title}</b>
                  <span className="muted" style={{ fontSize: 14.5, lineHeight: 1.55 }}>{text}</span>
                </div>
              </Reveal>
            ))}
          </ol>
        </div>
      </section>

      <section id="verify" className="l-band">
        <div className="l-wrap l-section" style={{ display: "flex", flexWrap: "wrap", gap: 48, alignItems: "center" }}>
          <Reveal style={{ flex: "1 1 420px", minWidth: 0, display: "flex", flexDirection: "column", gap: 18 }}>
            <span className="eyebrow">Verification</span>
            <h2 className="l-h2">Green means the ledger agreed. Nothing else.</h2>
            <p className="l-lead" style={{ fontSize: 17 }}>
              A slow answer or a timeout is never treated as paid. Before a payment turns successful, OrgPay reads the transaction back from Stellar and checks it, line by line.
            </p>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              <span className="pill pill-muted">Pending</span>
              <span className="pill pill-warn">Waiting for signature</span>
              <span className="pill pill-info">Submitted, confirming</span>
              <span className="pill pill-good">Successful</span>
              <span className="pill pill-danger">Failed, with the reason</span>
            </div>
          </Reveal>
          <Reveal delay={120} className="card-lift l-checks" style={{ flex: "1 1 440px", minWidth: 0 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8, gap: 12 }}>
              <b className="serif" style={{ fontSize: 20 }}>Amara Nwosu · 2.0000001 USDC</b>
              <span className="pill pill-good">Verified</span>
            </div>
            <ul className="verify-list">
              {CHECKS.map(([label, value], i) => (
                <li key={label} style={{ animationDelay: `${300 + i * 110}ms` }}>
                  <span className="verify-mark ok" aria-hidden="true">{check}</span>
                  <span style={{ flex: 1 }}>{label}</span>
                  <span className="mono faint" style={{ fontSize: 12.5 }}>{value}</span>
                </li>
              ))}
            </ul>
          </Reveal>
        </div>
      </section>

      <section id="costs" className="l-wrap l-section" style={{ display: "flex", flexWrap: "wrap", gap: 40, alignItems: "center" }}>
        <Reveal style={{ flex: "1 1 380px", minWidth: 0, display: "flex", flexDirection: "column", gap: 16 }}>
          <span className="eyebrow">What a run costs</span>
          <h2 className="l-h2">Network fees you can count on one hand.</h2>
          <p className="l-lead" style={{ fontSize: 17 }}>Stellar charges a tiny fee in XLM per payment. Drag the slider to see a run your size.</p>
        </Reveal>
        <Reveal delay={120} style={{ flex: "1 1 520px", minWidth: 0 }}>
          <Calculator />
        </Reveal>
      </section>

      <section id="safety" className="l-night">
        <div className="l-wrap l-section" style={{ display: "flex", flexDirection: "column", gap: 36 }}>
          <Reveal style={{ maxWidth: 700, display: "flex", flexDirection: "column", gap: 10 }}>
            <span className="eyebrow">Safety</span>
            <h2 className="l-h2">Built so a payment can’t go out twice.</h2>
          </Reveal>
          <div className="l-grid">
            {SAFETY.map(([path, title, text], i) => (
              <Reveal key={title} delay={i * 90} className="l-night-card">
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#9fb0ff" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d={path} />
                </svg>
                <b style={{ fontSize: 17 }}>{title}</b>
                <p>{text}</p>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      <section className="l-wrap l-section" style={{ display: "flex", flexDirection: "column", gap: 24 }}>
        <Reveal style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <span className="eyebrow">Why not just send payments?</span>
          <h2 className="l-h2">One by one vs one OrgPay run</h2>
        </Reveal>
        <Reveal delay={100} className="card-lift" style={{ padding: 0, overflowX: "auto" }}>
          <table className="l-compare">
            <thead>
              <tr>
                <th><span className="sr-only">Situation</span></th>
                <th className="faint" style={{ fontSize: 13 }}>Sending one by one</th>
                <th className="ours" style={{ fontSize: 13, color: "var(--green-hover)" }}>OrgPay</th>
              </tr>
            </thead>
            <tbody>
              {COMPARE.map(([what, before, after]) => (
                <tr key={what}>
                  <td style={{ fontWeight: 600 }}>{what}</td>
                  <td className="muted">{before}</td>
                  <td className="ours">{after}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Reveal>
      </section>

      <section id="faq" className="l-wrap" style={{ paddingTop: 24, paddingBottom: 80, display: "flex", flexWrap: "wrap", gap: 40 }}>
        <div style={{ flex: "1 1 300px", display: "flex", flexDirection: "column", gap: 10 }}>
          <span className="eyebrow">Questions</span>
          <h2 className="l-h2">Before you run payroll</h2>
        </div>
        <div className="l-faq" style={{ flex: "2 1 560px", minWidth: 0 }}>
          {FAQ.map(([q, a], i) => (
            <details key={q} open={i === 0}>
              <summary>
                {q}
                <span className="plus" aria-hidden="true"><Icon name="plus" size={16} strokeWidth={2.4} /></span>
              </summary>
              <p>{a}</p>
            </details>
          ))}
        </div>
      </section>

      <section style={{ padding: "0 24px 80px" }}>
        <div className="l-cta">
          <div style={{ flex: "1 1 420px", display: "flex", flexDirection: "column", gap: 14 }}>
            <h2 className="l-h2" style={{ fontSize: 48 }}>Your next payroll, proven in minutes.</h2>
            <p style={{ margin: 0, fontSize: 17, color: "#dce2ff" }}>Free on Stellar Testnet. Bring a funding wallet and a few employees.</p>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 12, marginTop: 6 }}>
              <Link className="btn btn-lg btn-white" href="/signup">Start on Testnet</Link>
              <Link className="btn btn-lg btn-ghost" href="/login">Sign in</Link>
            </div>
          </div>
          <div className="l-float" aria-hidden="true">
            <LogoMark size={200} animated />
          </div>
        </div>
      </section>

      <footer style={{ borderTop: "1px solid var(--rule)", background: "var(--sheet)" }}>
        <div className="l-wrap" style={{ paddingTop: 40, paddingBottom: 32, display: "flex", flexWrap: "wrap", gap: 32, justifyContent: "space-between" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 10, maxWidth: 320 }}>
            <Logo size={28} fontSize={22} />
            <span className="muted" style={{ fontSize: 13.5, lineHeight: 1.55 }}>USDC payroll on Stellar Testnet. Testnet USDC has no value; no real money moves.</span>
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 48, fontSize: 14 }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <b>Product</b>
              <a href="#how">How it works</a>
              <a href="#verify">Verification</a>
              <a href="#costs">Costs</a>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <b>Developers</b>
              <a href={`${process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4400"}/docs`}>API reference</a>
              <a href="#proof">Testnet proof</a>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <b>Built on</b>
              <span className="muted">Stellar · Horizon</span>
              <span className="muted">Freighter</span>
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
}
