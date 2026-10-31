import styles from "./settings.module.css";

interface Props {
  title: string;
  sub?: React.ReactNode;
  children: React.ReactNode;
  id?: string;
  danger?: boolean;
  gap?: number;
}

/** One settings card: title, optional line under it, then the content. */
export function Section({ title, sub, children, id, danger, gap = 16 }: Props) {
  return (
    <section
      id={id}
      aria-label={title}
      className="card"
      style={{ padding: "24px 28px", display: "flex", flexDirection: "column", gap, scrollMarginTop: 16, ...(danger ? { borderColor: "var(--alert-border)" } : {}) }}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        <h2 className="h2" style={{ fontSize: 26, ...(danger ? { color: "var(--failed)" } : {}) }}>{title}</h2>
        {sub ? <span style={{ fontSize: 14, color: "var(--ink-2)", maxWidth: 640 }}>{sub}</span> : null}
      </div>
      {children}
    </section>
  );
}

interface SwitchRowProps {
  label: string;
  description: React.ReactNode;
  checked: boolean;
  onChange: (next: boolean) => void;
}

/** A labelled on/off switch with a line of explanation. */
export function SwitchRow({ label, description, checked, onChange }: SwitchRowProps) {
  return (
    <div className={styles.switchRow}>
      <div style={{ display: "flex", flexDirection: "column", gap: 2, flex: 1, minWidth: 0 }}>
        <span style={{ fontWeight: 700, fontSize: 14 }}>{label}</span>
        <span style={{ fontSize: 13, color: "var(--slate)" }}>{description}</span>
      </div>
      <button type="button" role="switch" aria-checked={checked} aria-label={label} className={styles.switch} onClick={() => onChange(!checked)}>
        <span className={styles.knob} />
      </button>
    </div>
  );
}
