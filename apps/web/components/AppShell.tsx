"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { initials } from "@/lib/format";
import { useLogout, useSummary } from "@/lib/session";
import type { Company } from "@/lib/types";
import { Icon, type AnyIcon } from "./Icon";
import { Logo } from "./Logo";

const NAV: { href: string; label: string; icon: AnyIcon; also?: string[] }[] = [
  { href: "/dashboard", label: "Overview", icon: "overview" },
  { href: "/payroll", label: "Payroll", icon: "payroll" },
  { href: "/people", label: "People", icon: "people" },
  { href: "/settings", label: "Settings", icon: "settings", also: ["/api-keys"] },
];

export function AppShell({ company, children }: { company: Company; children: React.ReactNode }) {
  const pathname = usePathname();
  const logout = useLogout();
  const { data: summary } = useSummary();
  const under = (base: string) => pathname === base || pathname.startsWith(`${base}/`);
  const counts: Record<string, React.ReactNode> = {
    "/people": summary ? summary.activeEmployees : null,
    "/payroll": summary && summary.draftRuns.length + summary.activeRuns.length > 0 ? summary.draftRuns.length + summary.activeRuns.length : null,
  };

  return (
    <div className="shell">
      <nav aria-label="Main" className="shell-nav">
        <Logo href="/dashboard" animated style={{ padding: "0 10px 22px" }} />
        <div className="nav-company" style={{ margin: "0 2px 16px", padding: "10px 12px", border: "1px solid var(--rule)", borderRadius: 4, background: "var(--sheet)", display: "flex", alignItems: "center", gap: 10 }}>
          <div aria-hidden="true" style={{ width: 32, height: 32, flexShrink: 0, borderRadius: "50%", background: "var(--green-tint)", color: "var(--green-hover)", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 700, fontSize: 12 }}>
            {initials(company.businessName)}
          </div>
          <div style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
            <span style={{ fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{company.businessName}</span>
            <span className="faint" style={{ fontSize: 12 }}>Payroll in USDC</span>
          </div>
        </div>
        {NAV.map((item) => {
          const current = under(item.href) || (item.also ?? []).some(under);
          const count = counts[item.href];
          return (
            <Link key={item.href} href={item.href} className="nav-link" aria-current={current ? "page" : undefined}>
              <Icon name={item.icon} />
              {item.label}
              {item.href === "/dashboard" && summary && summary.failedPayments > 0 ? (
                <span className="nav-badge" aria-label={`${summary.failedPayments} payments not sent`}>
                  {summary.failedPayments > 99 ? "99+" : summary.failedPayments}
                </span>
              ) : count !== null && count !== undefined ? (
                <span className="count">{count}</span>
              ) : null}
            </Link>
          );
        })}
        <div className="nav-foot" style={{ marginTop: "auto", padding: "16px 10px 0", borderTop: "1px dashed var(--rule)", display: "flex", alignItems: "center", gap: 10 }}>
          <span className="faint" style={{ fontSize: 12, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{company.email}</span>
          <button type="button" onClick={logout} aria-label="Log out" title="Log out" className="icon-btn" style={{ marginLeft: "auto" }}>
            <Icon name="logout" />
          </button>
        </div>
      </nav>
      <div className="shell-body">
        <div className="shell-top">
          <Link href="/settings#network" className="tag-testnet" aria-label="Network: Stellar Testnet, no real money">
            Stellar Testnet · no real money
          </Link>
          <button type="button" onClick={logout} aria-label="Log out" title="Log out" className="icon-btn nav-mobile-only">
            <Icon name="logout" />
          </button>
        </div>
        {/* Keyed by route so each page plays its arrival once. */}
        <main key={pathname} className="shell-main">
          {children}
        </main>
      </div>
    </div>
  );
}
