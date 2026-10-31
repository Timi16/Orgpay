"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useSWRConfig } from "swr";
import { AuthHero } from "@/components/AuthHero";
import { PasswordInput, StrengthMeter } from "@/components/PasswordInput";
import { api, ApiError, errorMessage } from "@/lib/api";
import type { Company } from "@/lib/types";
import { useShake } from "../_ui/useShake";
import styles from "../auth.module.css";

export default function SignupPage() {
  const router = useRouter();
  const { mutate } = useSWRConfig();
  const { shake, shakeClass } = useShake();
  const [biz, setBiz] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [agree, setAgree] = useState(false);
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [emailTaken, setEmailTaken] = useState(false);

  const invalid = {
    biz: biz.trim().length < 2,
    email: !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()),
    password: password.length < 10,
    agree: !agree,
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setTried(true);
    if (busy) return;
    if (invalid.biz || invalid.email || invalid.password || invalid.agree) {
      shake();
      return;
    }
    setBusy(true);
    setError(null);
    setEmailTaken(false);
    try {
      const res = await api.post<{ company: Company }>("/auth/signup", { businessName: biz.trim(), email: email.trim(), password });
      await mutate("/auth/me", res, { revalidate: false });
      router.replace(res.company.emailVerified ? "/onboarding" : "/verify-email");
    } catch (err) {
      if (err instanceof ApiError && err.code === "EMAIL_TAKEN") setEmailTaken(true);
      else setError(errorMessage(err));
      shake();
      setBusy(false);
    }
  };

  const bizBad = tried && invalid.biz;
  const emailBad = (tried && invalid.email) || emailTaken;
  const pwBad = tried && invalid.password;
  const agreeBad = tried && invalid.agree;

  return (
    <div className={styles.split}>
      <AuthHero />
      <main className={styles.panel}>
        <div className={styles.column}>
          <div className={styles.head}>
            <h1 className={styles.title}>Create your account</h1>
            <span className="sub">Takes a minute. You add your receiving wallet next.</span>
          </div>
          <form onSubmit={submit} noValidate className={styles.form}>
            <div className="field">
              <label htmlFor="biz" className="label">
                Company name
              </label>
              <div className={shakeClass(bizBad)}>
                <input
                  id="biz"
                  type="text"
                  className={`input${bizBad ? " invalid" : ""}`}
                  value={biz}
                  onChange={(e) => setBiz(e.target.value)}
                  placeholder="e.g. Lumi Store"
                  maxLength={100}
                  autoComplete="organization"
                  aria-invalid={bizBad || undefined}
                  aria-describedby={bizBad ? "biz-error" : undefined}
                  autoFocus
                />
              </div>
              {bizBad ? (
                <span id="biz-error" role="alert" className="field-error">
                  Tell us your companyTell us the business name customers will see on checkout.apos;s name.
                </span>
              ) : null}
            </div>
            <div className="field">
              <label htmlFor="email" className="label">
                Work email
              </label>
              <div className={shakeClass(emailBad)}>
                <input
                  id="email"
                  type="email"
                  className={`input${emailBad ? " invalid" : ""}`}
                  value={email}
                  onChange={(e) => {
                    setEmail(e.target.value);
                    setEmailTaken(false);
                  }}
                  placeholder="you@company.com"
                  autoComplete="email"
                  aria-invalid={emailBad || undefined}
                  aria-describedby={emailBad ? "email-error" : undefined}
                />
              </div>
              {tried && invalid.email ? (
                <span id="email-error" role="alert" className="field-error">
                  That email does not look right.
                </span>
              ) : emailTaken ? (
                <span id="email-error" role="alert" className="field-error">
                  An account with this email already exists. <Link href="/login">Sign in instead</Link>
                </span>
              ) : null}
            </div>
            <div className="field">
              <label htmlFor="pw" className="label">
                Password
              </label>
              <div className={shakeClass(pwBad)}>
                <PasswordInput id="pw" value={password} onChange={setPassword} invalid={pwBad} autoComplete="new-password" describedBy="pw-hint" />
              </div>
              <StrengthMeter password={password} id="pw-hint" />
            </div>
            <div className="field">
              <label className={`${styles.check} ${shakeClass(agreeBad) ?? ""}`}>
                <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} aria-invalid={agreeBad || undefined} />
                I understand this is a Testnet beta and I keep custody of my own wallet keys.
              </label>
              {agreeBad ? (
                <span role="alert" className="field-error">
                  Please confirm the Testnet note.
                </span>
              ) : null}
            </div>
            {error ? (
              <div role="alert" className="alert">
                {error}
              </div>
            ) : null}
            <button type="submit" className="btn btn-primary btn-block" disabled={busy} aria-busy={busy} style={{ fontSize: 15 }}>
              {busy ? "Creating account…" : "Create account"}
            </button>
          </form>
          <span className={styles.foot}>
            Already have an account?{" "}
            <Link href="/login" style={{ fontWeight: 700 }}>
              Sign in
            </Link>
          </span>
        </div>
      </main>
    </div>
  );
}
