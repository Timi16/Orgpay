"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { useSWRConfig } from "swr";
import { AuthHero } from "@/components/AuthHero";
import { PasswordInput } from "@/components/PasswordInput";
import { api, ApiError, errorMessage } from "@/lib/api";
import type { Company } from "@/lib/types";
import { useShake } from "../_ui/useShake";
import styles from "../auth.module.css";

/** Only same-site paths are followed after sign-in. */
function safeNext(next: string | null): string {
  return next && next.startsWith("/") && !next.startsWith("//") ? next : "/dashboard";
}

type Problem = { text: string; field: "email" | "password" | "both" | "none" };

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const { mutate } = useSWRConfig();
  const { shake, shakeClass } = useShake();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(true);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [busy, setBusy] = useState(false);

  const fail = (next: Problem) => {
    setProblem(next);
    shake();
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      fail({ text: email.trim() ? "That email does not look right." : "Enter your email to continue.", field: "email" });
      return;
    }
    if (password.length === 0) {
      fail({ text: "Enter your password.", field: "password" });
      return;
    }
    setBusy(true);
    setProblem(null);
    try {
      const res = await api.post<{ company: Company }>("/auth/login", { email: email.trim(), password, remember });
      await mutate("/auth/me", res, { revalidate: false });
      router.replace(res.company.emailVerified ? safeNext(params.get("next")) : "/verify-email");
    } catch (err) {
      if (err instanceof ApiError && err.code === "INVALID_CREDENTIALS") {
        fail({ text: "That email and password don't match. Try again or reset your password.", field: "both" });
      } else {
        fail({ text: errorMessage(err), field: "none" });
      }
      setBusy(false);
    }
  };

  const emailBad = problem?.field === "email" || problem?.field === "both";
  const pwBad = problem?.field === "password" || problem?.field === "both";

  return (
    <div className={styles.column}>
      <div className={styles.head}>
        <h1 className={styles.title}>Sign in</h1>
        <span className="sub">Welcome back. Use the email you signed up with.</span>
      </div>
      <form onSubmit={submit} noValidate className={styles.form}>
        {params.get("reset") === "1" && !problem ? <div className="success">Password updated. Sign in with your new password.</div> : null}
        <div className="field">
          <label htmlFor="email" className="label">
            Email
          </label>
          <div className={shakeClass(emailBad)}>
            <input
              id="email"
              type="email"
              className={`input${emailBad ? " invalid" : ""}`}
              value={email}
              onChange={(e) => {
                setEmail(e.target.value);
                setProblem(null);
              }}
              placeholder="you@company.com"
              autoComplete="email"
              aria-invalid={emailBad || undefined}
              aria-describedby={problem ? "login-error" : undefined}
              autoFocus
            />
          </div>
        </div>
        <div className="field">
          <div className={styles.labelRow}>
            <label htmlFor="pw" className="label">
              Password
            </label>
            <Link href="/forgot-password" style={{ fontSize: 13, fontWeight: 700 }}>
              Forgot?
            </Link>
          </div>
          <div className={shakeClass(pwBad)}>
            <PasswordInput
              id="pw"
              value={password}
              onChange={(value) => {
                setPassword(value);
                setProblem(null);
              }}
              invalid={pwBad}
              autoComplete="current-password"
              describedBy={problem ? "login-error" : undefined}
            />
          </div>
        </div>
        {problem ? (
          <span id="login-error" role="alert" className="field-error" style={{ fontWeight: 600 }}>
            {problem.text}
          </span>
        ) : null}
        <label className={styles.check} style={{ alignItems: "center" }}>
          <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
          Keep me logged in for 14 days
        </label>
        <button type="submit" className="btn btn-primary btn-block" disabled={busy} aria-busy={busy} style={{ fontSize: 15 }}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>
      <span className={styles.foot}>
        New here?{" "}
        <Link href="/signup" style={{ fontWeight: 700 }}>
          Create an account
        </Link>
      </span>
    </div>
  );
}

export default function LoginPage() {
  return (
    <div className={styles.split}>
      <AuthHero />
      <main className={styles.panel}>
        <Suspense fallback={<div className={styles.column} aria-busy="true" style={{ minHeight: 420 }} />}>
          <LoginForm />
        </Suspense>
      </main>
    </div>
  );
}
