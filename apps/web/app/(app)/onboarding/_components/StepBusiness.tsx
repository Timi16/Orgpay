"use client";

import { useState } from "react";
import { api, errorMessage } from "@/lib/api";
import { useMe } from "@/lib/session";
import type { Company } from "@/lib/types";
import styles from "../onboarding.module.css";
import { markBusinessStepSeen, useShake } from "./shared";

export function StepBusiness({ company, className, onDone }: { company: Company; className: string; onDone: () => void }) {
  const { mutate } = useMe();
  const { shake, shakeClass } = useShake();
  const [name, setName] = useState(company.businessName);
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bad = tried && name.trim().length < 2;

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setTried(true);
    if (busy) return;
    if (name.trim().length < 2) {
      shake();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (name.trim() !== company.businessName) {
        await mutate(await api.post<{ company: Company }>("/auth/settings", { businessName: name.trim() }), { revalidate: false });
      }
      markBusinessStepSeen(company.id);
      onDone();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <form className={className} onSubmit={save} noValidate>
      <div className={styles.head}>
        <span className="eyebrow">Step 1 of 3</span>
        <h1 className="h1" style={{ fontSize: 40 }}>
          Who&apos;s running <em>payroll</em>?
        </h1>
        <p className="sub">Your company name appears across OrgPay and in the emails we send you when a run is paid.</p>
      </div>
      <div className="field">
        <label htmlFor="ob-name" className="label">
          Company name
        </label>
        <input
          id="ob-name"
          className={`input${bad ? " invalid" : ""} ${shakeClass(bad) ?? ""}`}
          value={name}
          maxLength={100}
          autoComplete="organization"
          onChange={(e) => setName(e.target.value)}
          aria-invalid={bad}
          aria-describedby={bad ? "ob-name-err" : undefined}
        />
        {bad ? (
          <span id="ob-name-err" className="field-error">
            Enter your company&apos;s name (at least 2 characters).
          </span>
        ) : null}
      </div>
      {error ? (
        <div role="alert" className="alert">
          {error}
        </div>
      ) : null}
      <div className={styles.actions}>
        <button type="submit" className="btn btn-primary btn-lg" disabled={busy} aria-busy={busy}>
          Continue
        </button>
      </div>
    </form>
  );
}
