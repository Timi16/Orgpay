"use client";

import { useEffect, useId, useRef } from "react";

interface Props {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  /** Buttons, right-aligned. */
  footer?: React.ReactNode;
  width?: number;
}

/** Modal dialog on the native <dialog>: focus is trapped and Escape closes it. */
export function Dialog({ open, onClose, title, children, footer, width = 460 }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onClose={onClose}
      onClick={(e) => {
        if (e.target === ref.current) onClose(); // click on the backdrop
      }}
      style={{ width: "calc(100% - 32px)", maxWidth: width }}
    >
      {open ? (
        <div style={{ position: "relative", padding: "26px 28px 24px", display: "flex", flexDirection: "column", gap: 16 }}>
          <button type="button" className="dialog-x" aria-label="Close" onClick={onClose}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
          <h2 id={titleId} className="h2" style={{ fontSize: 26, paddingRight: 36 }}>
            {title}
          </h2>
          {children}
          {footer ? <div style={{ display: "flex", justifyContent: "flex-end", flexWrap: "wrap", gap: 10, marginTop: 4 }}>{footer}</div> : null}
        </div>
      ) : null}
    </dialog>
  );
}
