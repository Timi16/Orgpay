import { BATCH_STATUS, ITEM_STATUS, RUN_STATUS, type StatusSpec, type Tone } from "@/lib/payroll";
import type { BatchStatus, ItemStatus, RunStatus } from "@/lib/types";
import { Icon, type AnyIcon } from "./Icon";

export function Pill({ tone, icon, children }: { tone: Tone; icon?: AnyIcon; children: React.ReactNode }) {
  return (
    <span className={`pill pill-${tone}`}>
      {icon ? <Icon name={icon} size={13} strokeWidth={2.4} /> : null}
      {children}
    </span>
  );
}

function SpecPill({ spec, label }: { spec: StatusSpec; label?: string }) {
  // Keyed by label so the pill animates in when the status changes live.
  return (
    <Pill key={label ?? spec.label} tone={spec.tone} icon={spec.icon}>
      {label ?? spec.label}
    </Pill>
  );
}

export const RunStatusPill = ({ status, label }: { status: RunStatus; label?: string }) => <SpecPill spec={RUN_STATUS[status]} label={label} />;
export const ItemStatusPill = ({ status }: { status: ItemStatus }) => <SpecPill spec={ITEM_STATUS[status]} />;
export const BatchStatusPill = ({ status }: { status: BatchStatus }) => <SpecPill spec={BATCH_STATUS[status]} />;
