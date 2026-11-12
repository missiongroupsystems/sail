import { localeFromAcceptLanguage } from "@sail/ui";
import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import type { ReactNode } from "react";
import { fontClassNames } from "@/lib/fonts";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Scan to order", template: "%s" },
  description: "Order from your table",
  formatDetection: { telephone: false, address: false, email: false },
};

// No maximum-scale and no user-scalable=no: pinch zoom is never disabled in the guest app (design 10).
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#f6f3ee",
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  const lang = localeFromAcceptLanguage((await headers()).get("accept-language")) ?? "en";
  return (
    <html lang={lang} data-surface="guest" className={fontClassNames}>
      <body className="bg-bg font-sans text-ink antialiased">{children}</body>
    </html>
  );
}
