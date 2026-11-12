"use client";

import dynamic from "next/dynamic";

// The station app reads localStorage and sessionStorage on boot, so it renders only in the browser.
const PosApp = dynamic(() => import("@/pos/PosApp"), { ssr: false, loading: () => null });

export default function PosPage() {
  return <PosApp />;
}
