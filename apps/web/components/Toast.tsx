"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";

type Show = (message: string) => void;
const ToastContext = createContext<Show>(() => undefined);

/** One short confirmation at the bottom right of the screen, gone after a few seconds. */
export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [message, setMessage] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const show = useCallback<Show>((text) => {
    if (timer.current) clearTimeout(timer.current);
    setMessage(text);
    setTick((n) => n + 1);
    timer.current = setTimeout(() => setMessage(null), 3200);
  }, []);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  return (
    <ToastContext.Provider value={show}>
      {children}
      <div aria-live="polite" role="status" style={{ position: "fixed", right: 24, bottom: 24, left: 24, display: "flex", justifyContent: "flex-end", pointerEvents: "none", zIndex: 60 }}>
        {message ? (
          <div key={tick} className="toast" style={{ background: "var(--sheet)", color: "var(--ink)", border: "1px solid var(--rule)", borderLeft: "3px solid var(--green)", padding: "12px 16px", borderRadius: "0 4px 4px 0", fontSize: 14, fontWeight: 600, display: "flex", alignItems: "center", gap: 10, maxWidth: "100%", boxShadow: "var(--shadow-sheet)" }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--green)" strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0 }}>
              <path d="M5 12l5 5L20 7" style={{ "--len": 24, strokeDasharray: 24, animation: "logo-draw 0.35s ease-out 0.15s both" } as React.CSSProperties} />
            </svg>
            {message}
          </div>
        ) : null}
      </div>
    </ToastContext.Provider>
  );
}

export const useToast = () => useContext(ToastContext);
