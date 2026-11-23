"use client";

import { ScopePicker, type ScopeValue } from "@sail/ui";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import type { Brand, Outlet } from "@/lib/api/types";
import type { Scope } from "@/lib/cookies";
import { useShownOutlet } from "./ShownOutlet";

export function ScopeControl({ merchantName, brands, outlets, scope }: { merchantName: string; brands: Brand[]; outlets: Outlet[]; scope: Scope }) {
  const router = useRouter();
  const [value, setValue] = useState<ScopeValue>(scope);
  const shownOutletId = useShownOutlet();
  useEffect(() => setValue(scope), [scope]);

  const change = async (next: ScopeValue) => {
    setValue(next);
    // keepalive: the choice is still remembered when the next click leaves the page before the reply.
    await fetch("/api/prefs", { method: "POST", keepalive: true, headers: { "content-type": "application/json" }, body: JSON.stringify({ scope: next }) });
    router.refresh();
  };

  // The picker offers the chosen brand's outlets only: each outlet says which brand it belongs to.
  const options = outlets.map((o) => ({ id: o.id, name: o.name, archived: o.archived, brandId: o.brand_id }));
  return (
    <>
      <div className="max-[1099px]:hidden">
        <ScopePicker merchantName={merchantName} brands={brands} outlets={options} value={value} shownOutletId={shownOutletId} onChange={change} />
      </div>
      <div className="min-[1100px]:hidden">
        <ScopePicker merchantName={merchantName} brands={brands} outlets={options} value={value} shownOutletId={shownOutletId} onChange={change} collapsed />
      </div>
    </>
  );
}
