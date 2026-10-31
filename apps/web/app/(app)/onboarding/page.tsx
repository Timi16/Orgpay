"use client";

import { useState } from "react";
import { errorMessage } from "@/lib/api";
import { useMe, useWallets } from "@/lib/session";
import type { Company, Wallet } from "@/lib/types";
import { businessStepSeen, CheckIcon, type StepNumber } from "./_components/shared";
import { StepBusiness } from "./_components/StepBusiness";
import { StepDone } from "./_components/StepDone";
import { StepWallet } from "./_components/StepWallet";
import styles from "./onboarding.module.css";

const STEPS: { n: StepNumber; title: string; sub: string }[] = [
  { n: 1, title: "Company", sub: "Who is paying" },
  { n: 2, title: "Funding wallet", sub: "Where pay comes from" },
  { n: 3, title: "Done", sub: "Your first payroll" },
];

function Flow({ company, wallets }: { company: Company; wallets: Wallet[] }) {
  // Where to land comes from what is already saved: a wallet means both steps are done.
  const [step, setStep] = useState<StepNumber>(() => (wallets.length > 0 ? 3 : company.businessName.trim() && businessStepSeen(company.id) ? 2 : 1));
  const [dir, setDir] = useState<"next" | "back">("next");

  const go = (to: StepNumber) => {
    setDir(to > step ? "next" : "back");
    setStep(to);
  };

  const hasWallet = wallets.length > 0;
  const done = (n: StepNumber) => n !== step && (n === 1 ? step > 1 : n === 2 ? hasWallet : false);
  const panel = `${styles.panel} ${dir === "next" ? styles.next : styles.back}`;

  return (
    <div className={styles.wrap}>
      <div className={styles.left}>
        <nav className={styles.aside} aria-label="Set up steps">
          <span className={styles.eyebrow}>Set up</span>
          <div className={styles.bar} aria-hidden="true">
            <span className={styles.barFill} style={{ transform: `scaleX(${step / 3})` }} />
          </div>
          <ol className={styles.steps}>
            {STEPS.map((s) => {
              const isDone = done(s.n);
              const current = s.n === step;
              return (
                <li key={s.n} className={styles.step}>
                  <button type="button" className={styles.stepBtn} aria-current={current ? "step" : undefined} disabled={s.n >= step} onClick={() => go(s.n)}>
                    <span className={`${styles.dot} ${isDone ? styles.dotDone : current ? styles.dotNow : ""}`}>{isDone ? <CheckIcon size={14} className={styles.draw} /> : s.n}</span>
                    <span className={styles.stepText}>
                      <span className={styles.stepTitle}>
                        {s.title}
                        {isDone ? <span className="sr-only"> (done)</span> : null}
                      </span>
                      <span className={styles.stepSub}>{s.sub}</span>
                    </span>
                  </button>
                  {s.n < 3 ? (
                    <span className={`${styles.rail}${step > s.n ? ` ${styles.railOn}` : ""}`} aria-hidden="true">
                      <span className={styles.railFill} />
                    </span>
                  ) : null}
                </li>
              );
            })}
          </ol>
        </nav>
        <div className={styles.note}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6l7-3zM9 12l2 2 4-4" />
          </svg>
          OrgPay never asks for a secret key. You sign every payroll yourself, in Freighter.
        </div>
      </div>
      {step === 1 ? (
        <StepBusiness key="1" company={company} className={panel} onDone={() => go(2)} />
      ) : step === 2 ? (
        <StepWallet key="2" company={company} wallets={wallets} className={panel} onBack={() => go(1)} onDone={() => go(3)} />
      ) : (
        <StepDone key="3" company={company} wallets={wallets} className={panel} />
      )}
    </div>
  );
}

export default function OnboardingPage() {
  const { company } = useMe();
  const { data, error, isLoading, mutate } = useWallets();

  if (!company) return null;
  if (!data) {
    if (error && !isLoading) {
      return (
        <div className="card empty" role="alert">
          <strong>We couldn&apos;t load your setup</strong>
          <span>{errorMessage(error)}</span>
          <button type="button" className="btn btn-primary" onClick={() => void mutate()} style={{ marginTop: 8 }}>
            Try again
          </button>
        </div>
      );
    }
    return (
      <div className={styles.wrap} aria-busy="true" aria-label="Loading your setup">
        <div className={styles.left}>
          <div className={`${styles.aside} skeleton`} style={{ height: 240 }} />
        </div>
        <div className={styles.panel}>
          <div className="skeleton" style={{ height: 34, width: "min(320px, 80%)" }} />
          <div className="skeleton" style={{ height: 300, borderRadius: 14 }} />
          <div className="skeleton" style={{ height: 46, width: 130, borderRadius: 10 }} />
        </div>
      </div>
    );
  }
  return <Flow company={company} wallets={data.data} />;
}
