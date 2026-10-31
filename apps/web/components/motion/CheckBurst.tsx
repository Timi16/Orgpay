/** The "it's paid" moment: a ring that expands, a disc that pops, and a tick that draws itself. */
export function CheckBurst({ size = 72, color = "var(--good)" }: { size?: number; color?: string }) {
  return (
    <span aria-hidden="true" style={{ position: "relative", width: size, height: size, display: "inline-flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
      <span style={{ position: "absolute", inset: 0, borderRadius: "50%", border: `2px solid ${color}`, animation: "ripple 1s ease-out 0.15s both" }} />
      <span style={{ position: "absolute", inset: 0, borderRadius: "50%", border: `2px solid ${color}`, animation: "ripple 1s ease-out 0.45s both" }} />
      <span style={{ position: "absolute", inset: 0, borderRadius: "50%", background: color, animation: "scale-in 0.45s cubic-bezier(0.34,1.56,0.64,1) both" }} />
      <svg width={size * 0.5} height={size * 0.5} viewBox="0 0 24 24" fill="none" stroke="#FFFFFF" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" style={{ position: "relative" }}>
        <path d="M5 12l5 5L20 7" style={{ "--len": 24, strokeDasharray: 24, animation: "logo-draw 0.45s ease-out 0.35s both" } as React.CSSProperties} />
      </svg>
    </span>
  );
}
