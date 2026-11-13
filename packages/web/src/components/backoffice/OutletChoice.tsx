"use client";

import { Select } from "@sail/ui";
import { useEffect, useState } from "react";
import type { Brand, Outlet } from "@/lib/api/types";
import type { Scope } from "@/lib/cookies";

/** The outlet a page works on: the scope picker's outlet when set, otherwise a toolbar choice. */
export function useOutletChoice(outlets: Outlet[], scope: Scope, initial: string | null) {
  const [outletId, setOutletId] = useState<string | null>(initial);
  useEffect(() => setOutletId(initial), [initial]);
  const scoped = outlets.find((o) => o.id === scope.outletId) ?? null;
  return { outletId: scoped?.id ?? outletId, setOutletId, scoped };
}

export function OutletChoice({ outlets, scope, outletId, onChange }: { outlets: Outlet[]; scope: Scope; outletId: string | null; onChange: (id: string | null) => void }) {
  const scoped = outlets.find((o) => o.id === scope.outletId) ?? null;
  if (scoped) {
    return (
      <p className="min-h-11 py-2.5">
        <span className="text-ink-2">Outlet </span>
        <span className="text-ink">{scoped.name}</span>
        <span className="text-caption text-ink-2"> · from the scope picker</span>
      </p>
    );
  }
  return (
    <Select
      aria-label="Outlet"
      variant="toolbar" size="sm"
      items={outlets.filter((o) => !o.archived || o.id === outletId).map((o) => ({ id: o.id, label: o.name }))}
      selectedKey={outletId}
      onSelectionChange={onChange}
      placeholder="Choose an outlet"
    />
  );
}

export function BrandChoice({ brands, scope, brandId, onChange, allowAll }: { brands: Brand[]; scope: Scope; brandId: string | null; onChange: (id: string | null) => void; allowAll?: boolean }) {
  const scoped = brands.find((b) => b.id === scope.brandId) ?? null;
  if (scoped) {
    return (
      <p className="min-h-11 py-2.5">
        <span className="text-ink-2">Brand </span>
        <span className="text-ink">{scoped.name}</span>
        <span className="text-caption text-ink-2"> · from the scope picker</span>
      </p>
    );
  }
  const ALL = "__all__";
  return (
    <Select
      aria-label="Brand"
      variant="toolbar" size="sm"
      items={[...(allowAll ? [{ id: ALL, label: "All brands" }] : []), ...brands.filter((b) => !b.archived || b.id === brandId).map((b) => ({ id: b.id, label: b.name }))]}
      selectedKey={brandId ?? (allowAll ? ALL : null)}
      onSelectionChange={(k) => onChange(k === ALL ? null : k)}
      placeholder="Choose a brand"
    />
  );
}
