"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Icon } from "@/components/Icon";
import { useMe } from "@/lib/session";
import type { Company } from "@/lib/types";
import { CloseAccountCard } from "./_components/CloseAccountCard";
import { NetworkCard } from "./_components/NetworkCard";
import { NotificationsCard } from "./_components/NotificationsCard";
import { Section } from "./_components/Section";
import { SecurityCard } from "./_components/SecurityCard";
import { useSaveSetting } from "./_components/useSaveSetting";
import { WalletsCard } from "./_components/WalletsCard";

export default function SettingsPage() {
  // The app layout only renders pages once the company is loaded.
  const { company } = useMe();
  if (!company) return null;
  return <Settings company={company} />;
}

function CompanyCard({ company }: { company: Company }) {
  const { save, error } = useSaveSetting(company);
  const [name, setName] = useState(company.businessName);
  const [busy, setBusy] = useState(false);
  const trimmed = name.trim();
  const dirty = trimmed !== company.businessName;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!dirty || !trimmed || busy) return;
    setBusy(true);
    await save({ businessName: trimmed }, "Company name saved");
    setBusy(false);
  };

  return (
    <Section title="Company" sub="Shown to you in OrgPay and in the emails it sends you.">
      <form onSubmit={submit} noValidate style={{ display: "flex", gap: 10, alignItems: "flex-end", flexWrap: "wrap" }}>
        <div className="field" style={{ flex: "1 1 280px" }}>
          <label htmlFor="company-name" className="label">
            Company name
          </label>
          <input id="company-name" className={`input${!trimmed ? " invalid" : ""}`} value={name} maxLength={100} onChange={(e) => setName(e.target.value)} autoComplete="organization" />
        </div>
        <button type="submit" className="btn btn-dark" disabled={!dirty || !trimmed || busy} aria-busy={busy}>
          Save
        </button>
      </form>
      {!trimmed ? <span className="field-error">Enter your company&apos;s name.</span> : null}
      {error ? (
        <div role="alert" className="alert">
          {error}
        </div>
      ) : null}
    </Section>
  );
}

function Settings({ company }: { company: Company }) {
  // The Testnet badge links to /settings#network; sections only exist once this renders.
  useEffect(() => {
    if (window.location.hash) document.getElementById(window.location.hash.slice(1))?.scrollIntoView({ block: "start" });
  }, []);

  return (
    <>
      <header className="page-head">
        <div>
          <span className="eyebrow">Settings</span>
          <h1 className="h1">Your company</h1>
        </div>
      </header>
      <CompanyCard company={company} />
      <WalletsCard />
      <NotificationsCard company={company} />
      <SecurityCard email={company.email} />
      <NetworkCard />
      <Section title="API keys" sub="Run payroll from your own systems: add people, create runs and submit signed transactions over the API.">
        <Link href="/api-keys" className="btn btn-secondary btn-sm" style={{ alignSelf: "flex-start" }}>
          <Icon name="keys" size={15} /> Manage API keys
        </Link>
      </Section>
      <CloseAccountCard businessName={company.businessName} />
    </>
  );
}
