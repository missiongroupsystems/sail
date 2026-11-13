import type { Metadata, Viewport } from "next";
import { localeFromAcceptLanguage } from "@sail/ui";
import { headers } from "next/headers";
import type { ReactNode } from "react";
import { getTheme } from "@/lib/api.server";
import { fontClassNames } from "@/lib/fonts";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Sail", template: "%s · Sail" },
  description: "Sail back office",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  const [theme, requestHeaders] = await Promise.all([getTheme(), headers()]);
  // The browser's language until a signed-in surface knows the merchant's (LocaleProvider then sets it).
  const lang = localeFromAcceptLanguage(requestHeaders.get("accept-language")) ?? "en";
  return (
    <html lang={lang} data-theme={theme === "service" ? "service" : undefined} className={fontClassNames} suppressHydrationWarning>
      <body className="bg-bg font-sans text-ink antialiased">{children}</body>
    </html>
  );
}
