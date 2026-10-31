"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { Icon } from "@/components/Icon";
import { PasswordInput, StrengthMeter } from "@/components/PasswordInput";
import { api, ApiError, errorMessage } from "@/lib/api";
import { AuthCentred, Burst } from "../_ui/AuthCentred";
import { useShake } from "../_ui/useShake";
import styles from "../auth.module.css";

function ResetForm() {
  const token = useSearchParams().get("token") ?? "";
  const { shake, shakeClass } = useShake();
  const [p1, setP1] = useState("");
  const [p2, setP2] = useState("");
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expired, setExpired] = useState(false);

  const problem = p1.length < 10 ? "Use at least 10 characters." : p1 !== p2 ? "The two passwords don't match." : "";

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setTried(true);
    if (problem) shake();
    if (problem || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.post("/auth/password/reset", { token, newPassword: p1 });
      setDone(true);
    } catch (err) {
      if (err instanceof ApiError && (err.code === "CHALLENGE_EXPIRED" || err.code === "VALIDATION_FAILED") && !err.field("newPassword")) setExpired(true);
      else setError(errorMessage(err));
      setBusy(false);
    }
  };

  if (!token || expired) {
    return (
      <div key="expired" className={styles.cardBody}>
        <span className={styles.badge} style={{ background: "var(--warn-bg)", color: "var(--warn)" }}>
          <Icon name="clock" size={24} strokeWidth={2.2} />
        </span>
        <h1 className={styles.cardTitle}>This reset link no longer works</h1>
        <span className={styles.cardText}>Reset links work once and expire after an hour. Ask for a new one and use it straight away.</span>
        <Link href="/forgot-password" className="btn btn-primary btn-lg">
          Send a new link
        </Link>
      </div>
    );
  }
  if (done) {
    return (
      <div key="done" className={styles.cardBody} style={{ alignItems: "flex-start" }}>
        <Burst size={56} />
        <h1 className={styles.cardTitle}>Password updated</h1>
        <span className={styles.cardText}>For your safety, we logged you out on every device.</span>
        <Link href="/login" className="btn btn-primary btn-lg btn-block">
          Sign in
        </Link>
      </div>
    );
  }

  const p1Bad = tried && p1.length < 10;
  const p2Bad = tried && p1.length >= 10 && p1 !== p2;

  return (
    <form key="form" noValidate onSubmit={save} className={styles.cardBody} style={{ gap: 16 }}>
      <span className={styles.badge}>
        <Icon name="shield" size={24} strokeWidth={2.2} />
      </span>
      <h1 className={styles.cardTitle}>Choose a new password</h1>
      <div className="field">
        <label htmlFor="p1" className="label">
          New password
        </label>
        <div className={shakeClass(p1Bad)}>
          <PasswordInput id="p1" value={p1} onChange={setP1} autoComplete="new-password" invalid={p1Bad} describedBy="p1-hint" />
        </div>
        <StrengthMeter password={p1} id="p1-hint" />
      </div>
      <div className="field">
        <label htmlFor="p2" className="label">
          Confirm new password
        </label>
        <div className={shakeClass(p2Bad)}>
          <PasswordInput id="p2" value={p2} onChange={setP2} autoComplete="new-password" invalid={p2Bad} />
        </div>
      </div>
      {tried && problem ? (
        <span role="alert" className="field-error">
          {problem}
        </span>
      ) : null}
      {error ? (
        <div role="alert" className="alert">
          {error}
        </div>
      ) : null}
      <button type="submit" className="btn btn-primary btn-lg" disabled={busy} aria-busy={busy}>
        {busy ? "Updating…" : "Update password"}
      </button>
    </form>
  );
}

export default function ResetPasswordPage() {
  return (
    <AuthCentred footer={<Link href="/login">Back to sign in</Link>}>
      <Suspense fallback={<div style={{ minHeight: 240 }} aria-busy="true" />}>
        <ResetForm />
      </Suspense>
    </AuthCentred>
  );
}
