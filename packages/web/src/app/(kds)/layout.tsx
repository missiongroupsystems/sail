import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";

/** The `(kds)` route group: the kitchen display, a full-screen page for a wall monitor or a landscape tablet. */
export const metadata: Metadata = {
  title: "Sail kitchen display",
  description: "Sail kitchen display",
  formatDetection: { telephone: false, address: false, email: false },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: "cover",
};

export default function KdsLayout({ children }: { children: ReactNode }) {
  return <div className="pos-touch h-dvh w-full overflow-hidden bg-bg text-ink">{children}</div>;
}
