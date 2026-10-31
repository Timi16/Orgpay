"use client";

import Link from "next/link";
import { useState } from "react";
import { Icon } from "@/components/Icon";
import { api, errorMessage } from "@/lib/api";
import { AuthCentred } from "../_ui/AuthCentred";
import { useShake } from "../_ui/useShake";
import styles from "../auth.module.css";

export default function ForgotPasswordPage() {
  const { shake, shakeClass } = useShake();
  const [email, setEmail] = useState("");
  const [tried, setTried] = useState(false);
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [resent, setResent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());

  const send = async (again = false) => {
    setTried(true);
    if (!emailOk) shake();
    if (!emailOk || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.post("/auth/password/forgot", { email: email.trim() });
      setSent(true);
      setResent(again);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const emailBad = tried && !emailOk;

  return (
    <AuthCentred footer={<Link href="/login">Back to sign in</Link>}>
      {!sent ? (
        <form
          key="ask"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
          className={styles.cardBody}
        >
          <span className={styles.badge}>
            <Icon name="keys" size={24} strokeWidth={2.2} />
          </span>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <h1 className={styles.cardTitle}>Reset your password</h1>
            <span className={styles.cardText}>Enter the email you signed up with. We&apos;ll send a link that works for one hour.</span>
          </div>
          {error ? (
            <div role="alert" className="alert">
              {error}
            </div>
          ) : null}
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
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@company.com"
                autoComplete="email"
                aria-invalid={emailBad || undefined}
                autoFocus
              />
            </div>
            {emailBad ? (
              <span role="alert" className="field-error">
                Enter a valid email address.
              </span>
            ) : null}
          </div>
          <button type="submit" className="btn btn-primary btn-lg" disabled={busy} aria-busy={busy}>
            {busy ? "Sending…" : "Send reset link"}
          </button>
        </form>
      ) : (
        <div key="sent" className={styles.cardBody} style={{ alignItems: "flex-start" }}>
          <span className={styles.badge}>
            <Icon name="mail" size={24} strokeWidth={2.2} />
          </span>
          <h1 className={styles.cardTitle}>Check your email</h1>
          <span className={styles.cardText}>
            If an account exists for <span style={{ fontWeight: 700, color: "var(--ink)", overflowWrap: "anywhere" }}>{email.trim()}</span>, a reset link is on its way. It works once, for one hour.
          </span>
          {error ? (
            <div role="alert" className="alert" style={{ alignSelf: "stretch" }}>
              {error}
            </div>
          ) : null}
          <div className={styles.linkRow} style={{ justifyContent: "flex-start" }}>
            <button type="button" className="btn-link" onClick={() => void send(true)} disabled={busy} aria-busy={busy}>
              {busy ? "Sending…" : resent ? "Sent again" : "Resend email"}
            </button>
            <button
              type="button"
              className={styles.quiet}
              onClick={() => {
                setSent(false);
                setTried(false);
                setResent(false);
              }}
            >
              Use a different email
            </button>
          </div>
        </div>
      )}
    </AuthCentred>
  );
}
