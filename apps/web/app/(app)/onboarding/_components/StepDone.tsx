"use client";

import Link from "next/link";
import { Icon } from "@/components/Icon";
import type { Company, Wallet } from "@/lib/types";
import styles from "../onboarding.module.css";

/** Two next steps: add people, then draft the first run. */
export function StepDone({ company, className }: { company: Company; wallets: Wallet[]; className: string }) {
  return (
    <div className={className}>
      <div className={styles.head}>
        <span className="eyebrow">Step 3 of 3</span>
        <h1 className="h1" style={{ fontSize: 40 }}>
          {company.businessName} is <em>ready</em>.
        </h1>
        <p className="sub">Add the people you pay, then draft your first run. Nothing moves until you sign it in Freighter.</p>
      </div>
      <ol className="stagger" style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 12 }}>
        <li className="sheet sheet-pad" style={{ display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap" }}>
          <span className="date-tile" aria-hidden="true">
            <b>STEP</b>
            <span>1</span>
          </span>
          <div style={{ flex: "1 1 220px" }}>
            <strong style={{ fontSize: 16 }}>Add your people</strong>
            <p className="muted" style={{ fontSize: 14 }}>Name, Stellar wallet and default amount. Group them (Engineering, Contractors…) or import a spreadsheet.</p>
          </div>
          <Link href="/people" className="btn btn-dark">
            <Icon name="people" size={16} /> Add people
          </Link>
        </li>
        <li className="sheet sheet-pad" style={{ display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap" }}>
          <span className="date-tile" aria-hidden="true">
            <b>STEP</b>
            <span>2</span>
          </span>
          <div style={{ flex: "1 1 220px" }}>
            <strong style={{ fontSize: 16 }}>Draft your first payroll</strong>
            <p className="muted" style={{ fontSize: 14 }}>Pick employees, check the total, then execute: each payment is signed in Freighter and verified on Stellar.</p>
          </div>
          <Link href="/payroll?new=1" className="btn btn-primary">
            <Icon name="payroll" size={16} /> New payroll
          </Link>
        </li>
      </ol>
      <Link href="/dashboard" className="btn-link" style={{ alignSelf: "flex-start" }}>
        Go to the overview
      </Link>
    </div>
  );
}
