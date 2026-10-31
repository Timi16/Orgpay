"use client";

import { useEffect, useState } from "react";

/** The current time, refreshed every `ms` (for "3 min ago" labels and countdowns). */
export function useNow(ms = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}
