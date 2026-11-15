"use client";

import { ScopePicker, type ScopeValue } from "@sail/ui";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import type { Brand, Outlet } from "@/lib/api/types";
import type { Scope } from "@/lib/cookies";

export function ScopeControl({ merchantName, brands, outlets, scope }: { merchantName: string; brands: Brand[]; outlets: Outlet[]; scope: Scope }) {
  const router = useRouter();
  const [value, setValue] = useState<ScopeValue>(scope);
  useEffect(() => setValue(scope), [scope]);

  const change = async (next: ScopeValue) => {
    setValue(next);
    await fetch("/api/prefs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ scope: next }) });
    router.refresh();
  };

  return (
    <>
      <div className="max-[1099px]:hidden">
        <ScopePicker merchantName={merchantName} brands={brands} outlets={outlets} value={value} onChange={change} />
      </div>
      <div className="min-[1100px]:hidden">
        <ScopePicker merchantName={merchantName} brands={brands} outlets={outlets} value={value} onChange={change} collapsed />
      </div>
    </>
  );
}
