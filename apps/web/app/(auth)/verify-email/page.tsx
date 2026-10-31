"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Icon } from "@/components/Icon";
import { api, ApiError, errorMessage } from "@/lib/api";
import { useLogout, useMe } from "@/lib/session";
import type { Company } from "@/lib/types";
import { AuthCentred, Burst } from "../_ui/AuthCentred";
import { useReducedMotion } from "../_ui/useReducedMotion";
import { useShake } from "../_ui/useShake";
import styles from "../auth.module.css";

const RESEND_WAIT = 60;
const BOXES = [0, 1, 2, 3, 4, 5] as const;

export default function VerifyEmailPage() {
  const router = useRouter();
  const { company, mutate } = useMe();
  const logout = useLogout();
  const reduced = useReducedMotion();
  const { shake, shakeClass } = useShake();
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expired, setExpired] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [resending, setResending] = useState(false);
  // A code was sent at sign-up, so the first resend waits a minute too.
  const [wait, setWait] = useState(RESEND_WAIT);
  const submitted = useRef("");
  const input = useRef<HTMLInputElement>(null);

  // The field is disabled while a code is checked; give the cursor back when a code is refused.
  useEffect(() => {
    if (!busy && error) input.current?.focus();
  }, [busy, error]);

  useEffect(() => {
    if (company === null) router.replace("/login");
    // Arriving already confirmed goes straight on; a code confirmed here shows the tick first.
    else if (company?.emailVerified && !done) router.replace("/onboarding");
  }, [company, router, done]);

  useEffect(() => {
    if (!done) return;
    const id = setTimeout(() => router.replace("/onboarding"), reduced ? 700 : 1500);
    return () => clearTimeout(id);
  }, [done, reduced, router]);

  useEffect(() => {
    if (wait <= 0) return;
    const id = setTimeout(() => setWait((w) => w - 1), 1000);
    return () => clearTimeout(id);
  }, [wait]);

  const verify = async (value: string) => {
    if (busy || value.length !== 6) return;
    submitted.current = value;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await api.post<{ company: Company }>("/auth/email/verify", { code: value });
      setDone(true);
      await mutate(res, { revalidate: false });
    } catch (err) {
      const isExpired = err instanceof ApiError && err.code === "CHALLENGE_EXPIRED";
      setExpired(isExpired);
      setError(isExpired ? "This code has expired or was tried too many times. Send a new one." : errorMessage(err));
      setCode("");
      setBusy(false);
      shake();
    }
  };

  const onCode = (raw: string) => {
    const digits = raw.replace(/\D/g, "").slice(0, 6);
    setCode(digits);
    setError(null);
    // Entering the sixth digit submits; the same wrong code is not sent twice by itself.
    if (digits.length === 6 && digits !== submitted.current) void verify(digits);
  };

  const resend = async () => {
    if (resending || wait > 0) return;
    setResending(true);
    setError(null);
    setNotice(null);
    try {
      await api.post("/auth/email/resend");
      setNotice("A new code is on its way. The old one no longer works.");
      setExpired(false);
      submitted.current = "";
      setWait(RESEND_WAIT);
    } catch (err) {
      if (err instanceof ApiError && err.code === "RATE_LIMITED" && err.retryAfter) setWait(err.retryAfter);
      else setError(errorMessage(err));
    } finally {
      setResending(false);
    }
  };

  if (!company || (company.emailVerified && !done)) return <div style={{ minHeight: "100vh" }} aria-busy="true" />;

  if (done) {
    return (
      <AuthCentred>
        <div className={styles.done} role="status">
          <Burst size={72} />
          <h1 className={styles.cardTitle}>Email confirmed</h1>
          <span className={styles.cardText}>Taking you to set up your account…</span>
        </div>
      </AuthCentred>
    );
  }

  const bad = !!error && !expired;
  const active = Math.min(code.length, 5);

  return (
    <AuthCentred>
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void verify(code);
        }}
        className={styles.cardBody}
      >
        <span className={styles.badge}>
          <Icon name="mail" size={24} strokeWidth={2.2} />
        </span>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <h1 className={styles.cardTitle}>Check your email</h1>
          <span className={styles.cardText}>
            We sent a 6-digit code to <span style={{ fontWeight: 700, color: "var(--ink)", overflowWrap: "anywhere" }}>{company.email}</span>. Enter it to open your dashboard.
          </span>
        </div>
        {error ? (
          <div role="alert" className="alert">
            {error}
          </div>
        ) : notice ? (
          <div role="status" className="success">
            {notice}
          </div>
        ) : null}
        <div className="field">
          <label htmlFor="code" className="label">
            Confirmation code
          </label>
          <div className={shakeClass(bad)}>
            <div className={`${styles.code}${busy ? ` ${styles.codeBusy}` : ""}`}>
              {BOXES.map((i) => {
                const digit = code[i];
                const cls = [styles.box, digit ? styles.boxFilled : "", bad ? styles.boxBad : "", !busy && i === active ? styles.boxActive : ""].filter(Boolean).join(" ");
                return (
                  <span key={i} aria-hidden="true" className={cls} style={{ "--i": i } as React.CSSProperties}>
                    {digit ? (
                      <span key={digit} className={styles.digit}>
                        {digit}
                      </span>
                    ) : null}
                  </span>
                );
              })}
              {/* The one real field: invisible, laid over the boxes. */}
              <input
                id="code"
                ref={input}
                className={styles.codeInput}
                value={code}
                onChange={(e) => onCode(e.target.value)}
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9]*"
                maxLength={7}
                autoFocus
                disabled={busy}
                aria-invalid={bad || undefined}
                aria-describedby="code-hint"
              />
            </div>
          </div>
          <span id="code-hint" className="hint">
            The code works for 15 minutes. Check spam if you don&apos;t see it.
          </span>
        </div>
        <button type="submit" className="btn btn-primary btn-lg" disabled={busy || code.length !== 6} aria-busy={busy}>
          {busy ? "Checking…" : "Confirm email"}
        </button>
        <div className={styles.linkRow}>
          <button type="button" className="btn-link" onClick={resend} disabled={resending || wait > 0}>
            {resending ? "Sending…" : wait > 0 ? `Send a new code in ${wait}s` : "Send a new code"}
          </button>
          <button type="button" className={styles.quiet} onClick={logout}>
            Wrong email? Log out
          </button>
        </div>
      </form>
    </AuthCentred>
  );
}
