"use client";

import { useEffect, useRef, useState } from "react";
import { parseAmount } from "@orgpay/shared";
import { formatAmount } from "@/lib/format";

const DURATION = 900;
const easeOut = (t: number) => 1 - (1 - t) ** 3;

function stroopsToDecimal(stroops: bigint): string {
  const whole = stroops / 10_000_000n;
  const frac = (stroops % 10_000_000n).toString().padStart(7, "0");
  return `${whole}.${frac}`;
}

const reduced = () => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function useProgress(key: string): number {
  // Starts complete under reduced motion, so there is never a "0" frame.
  const [progress, setProgress] = useState(() => (reduced() ? 1 : 0));
  const frame = useRef(0);
  useEffect(() => {
    if (reduced()) {
      setProgress(1);
      return;
    }
    setProgress(0);
    const start = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / DURATION);
      setProgress(easeOut(t));
      if (t < 1) frame.current = requestAnimationFrame(tick);
    };
    frame.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame.current);
  }, [key]);
  return progress;
}

/**
 * A headline amount that counts from what it showed before (zero the first time) to its new
 * value. Interpolated in whole stroops with bigint, never a float; the final frame is exact, and
 * screen readers only ever get the exact value. Not for binding totals: those never animate.
 */
export function CountUpAmount({ value, minDecimals = 2 }: { value: string; minDecimals?: number }) {
  const from = useRef<bigint>(0n);
  const target = parseAmount(value) ?? 0n;
  const progress = useProgress(value);
  useEffect(() => {
    if (progress >= 1) from.current = target;
  }, [progress, target]);
  const start = from.current;
  const shown = progress >= 1 ? target : start + ((target - start) * BigInt(Math.round(progress * 1000))) / 1000n;
  const text = progress >= 1 ? formatAmount(value, minDecimals) : formatAmount(stroopsToDecimal(shown - (shown % 100_000n)), minDecimals);
  return (
    <>
      <span className="sr-only">{formatAmount(value, minDecimals)}</span>
      <span className="tnum" aria-hidden="true">
        {text}
      </span>
    </>
  );
}

/** A whole number (a count) that counts up. */
export function CountUpInt({ value, suffix = "" }: { value: number; suffix?: string }) {
  const progress = useProgress(String(value));
  return (
    <>
      <span className="sr-only">
        {value}
        {suffix}
      </span>
      <span className="tnum" aria-hidden="true">
        {Math.round(value * progress)}
        {suffix}
      </span>
    </>
  );
}
