import type { Metadata, Viewport } from "next";
import { Bricolage_Grotesque, Inter, JetBrains_Mono } from "next/font/google";
import "./globals.css";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter" });
const bricolage = Bricolage_Grotesque({ subsets: ["latin"], weight: ["500", "600", "700"], variable: "--font-bricolage" });
const jetbrains = JetBrains_Mono({ subsets: ["latin"], variable: "--font-jetbrains" });

const SITE_URL = (process.env.NEXT_PUBLIC_SITE_URL ?? "https://www.useorgpay.xyz").replace(/\/$/, "");
const DESCRIPTION = "Pay your whole team in USDC on Stellar Testnet. One run, one transaction per employee, every payment verified on the ledger.";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: { default: "OrgPay", template: "%s · OrgPay" },
  description: DESCRIPTION,
  applicationName: "OrgPay",
  icons: { icon: [{ url: "/icon.svg", type: "image/svg+xml" }] },
  openGraph: {
    type: "website",
    siteName: "OrgPay",
    title: "OrgPay · Pay the whole team. Prove every payment.",
    description: DESCRIPTION,
    url: SITE_URL,
  },
  twitter: { card: "summary_large_image", title: "OrgPay · Pay the whole team. Prove every payment.", description: DESCRIPTION },
};

export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#2F4BD8" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} ${bricolage.variable} ${jetbrains.variable}`}>
      <body>{children}</body>
    </html>
  );
}
