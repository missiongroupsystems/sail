import type { Metadata, Viewport } from "next";
import { IBM_Plex_Mono, IBM_Plex_Sans } from "next/font/google";
import type { ReactNode } from "react";
import { getTheme } from "@/lib/api.server";
import "./globals.css";

// Self-hosted through next/font (design 7.4). CJK falls back to the device's system faces, set in the token stack.
const plexSans = IBM_Plex_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-plex-sans",
  display: "swap",
  fallback: ["-apple-system", "PingFang SC", "PingFang TC", "Hiragino Sans", "Noto Sans CJK SC", "system-ui", "sans-serif"],
});
const plexMono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-plex-mono",
  display: "swap",
  fallback: ["ui-monospace", "SF Mono", "Menlo", "monospace"],
});

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
  const theme = await getTheme();
  return (
    <html lang="en-SG" data-theme={theme === "service" ? "service" : undefined} className={`${plexSans.variable} ${plexMono.variable}`} suppressHydrationWarning>
      <body className="bg-bg font-sans text-ink antialiased">{children}</body>
    </html>
  );
}
