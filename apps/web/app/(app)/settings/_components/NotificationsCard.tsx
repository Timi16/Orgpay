"use client";

import type { Company } from "@/lib/types";
import { Section, SwitchRow } from "./Section";
import { useSaveSetting } from "./useSaveSetting";

/** Two email switches. Each saves the moment it is flipped. */
export function NotificationsCard({ company }: { company: Company }) {
  const { save, error } = useSaveSetting(company);
  return (
    <Section title="Notifications" sub={<>Email to {company.email}.</>}>
      {error ? (
        <div role="alert" className="alert">
          {error}
        </div>
      ) : null}
      <div style={{ display: "flex", flexDirection: "column" }}>
        <SwitchRow
          label="Run paid"
          description="One email when a payroll run finishes with everyone paid, with the link to every transaction."
          checked={company.notifyPaid}
          onChange={(on) => void save({ notifyPaid: on }, on ? "You'll get an email when a run is paid" : "Run-paid emails are off")}
        />
        <SwitchRow
          label="Payments not sent"
          description="One email when a run finishes with people who couldn't be paid, and why (for example, no USDC trustline)."
          checked={company.notifyProblems}
          onChange={(on) => void save({ notifyProblems: on }, on ? "You'll get an email when payments aren't sent" : "Those emails are off")}
        />
      </div>
    </Section>
  );
}
