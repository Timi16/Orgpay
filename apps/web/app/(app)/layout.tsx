"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect } from "react";
import { AppShell } from "@/components/AppShell";
import { Providers, useMe } from "@/lib/session";

function Guard({ children }: { children: React.ReactNode }) {
  const { company, error, mutate } = useMe();
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (company === null) router.replace(`/login?next=${encodeURIComponent(pathname)}`);
    // The dashboard stays locked until the email is confirmed.
    else if (company && !company.emailVerified) router.replace("/verify-email");
  }, [company, pathname, router]);

  if (error) {
    return (
      <div className="empty" style={{ minHeight: "100vh", justifyContent: "center" }}>
        <strong>We can&apos;t reach OrgPay right now</strong>
        <span>Nothing was sent or changed. Check your connection and try again.</span>
        <button type="button" className="btn btn-primary" onClick={() => mutate()} style={{ marginTop: 8 }}>
          Try again
        </button>
      </div>
    );
  }
  if (!company || !company.emailVerified) return <div style={{ minHeight: "100vh" }} aria-busy="true" />;
  return <AppShell company={company}>{children}</AppShell>;
}

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <Providers>
      <Guard>{children}</Guard>
    </Providers>
  );
}
