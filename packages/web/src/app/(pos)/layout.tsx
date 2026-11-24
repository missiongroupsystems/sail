import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { PRODUCT_NAME } from "@/lib/brand";

/**
 * The `(pos)` route group: a home-screen web app with no
 * back-office navigation. The page inside is client-rendered and long-lived.
 */
export const metadata: Metadata = {
  title: `${PRODUCT_NAME} POS`,
  description: `${PRODUCT_NAME} point of sale`,
  manifest: "/pos/manifest.webmanifest",
  appleWebApp: { capable: true, title: `${PRODUCT_NAME} POS`, statusBarStyle: "black-translucent" },
  formatDetection: { telephone: false, address: false, email: false },
  icons: { icon: "/pos/icon.svg", apple: "/pos/icon.svg" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f9f9f9" },
    { media: "(prefers-color-scheme: dark)", color: "#0f1311" },
  ],
};

export default function PosLayout({ children }: { children: ReactNode }) {
  return <div className="pos-touch h-dvh w-full overflow-hidden bg-bg text-ink">{children}</div>;
}
