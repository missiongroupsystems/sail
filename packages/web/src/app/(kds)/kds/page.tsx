"use client";

import dynamic from "next/dynamic";

// The display reads localStorage on boot, so it renders only in the browser.
const KdsApp = dynamic(() => import("@/kds/KdsApp"), { ssr: false, loading: () => null });

export default function KdsPage() {
  return <KdsApp />;
}
