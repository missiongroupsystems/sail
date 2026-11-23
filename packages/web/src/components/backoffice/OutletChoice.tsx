"use client";

import { Button, Select, cx, outletOwnName } from "@sail/ui";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import type { Brand, Outlet } from "@/lib/api/types";
import type { Scope } from "@/lib/cookies";
import { useSession } from "@/lib/session-context";
import { useShowOutlet } from "@/components/ShownOutlet";

/** The outlet a page works on: the scope's outlet when one is chosen, otherwise the page's own choice (its first outlet). */
export function useOutletChoice(outlets: Outlet[], scope: Scope, initial: string | null) {
  const [outletId, setOutletId] = useState<string | null>(initial);
  useEffect(() => setOutletId(initial), [initial]);
  const scoped = outlets.find((o) => o.id === scope.outletId) ?? null;
  useShowOutlet(scoped?.id ?? outletId);
  return { outletId: scoped?.id ?? outletId, setOutletId, scoped };
}

/** The outlets a page's outlet row offers: the live ones, and the chosen one even when archived. */
export function choosableOutlets(outlets: Outlet[], outletId: string | null) {
  return outlets.filter((o) => !o.archived || o.id === outletId);
}

/**
 * The outlets of the brand in scope, as one row at the top of a page that works per outlet, with the chosen one
 * marked. It is the scope picker's outlet choice laid out flat: choosing here changes the page at once and is
 * remembered the same way, so the picker and every other page follow. Each outlet shows its own name, as the
 * brand is already in scope. A long row scrolls sideways. With one outlet
 * or none there is nothing to choose, and it renders nothing: the page's own empty state covers none.
 */
export function OutletChoice({ outlets, scope, outletId, onChange }: { outlets: Outlet[]; scope: Scope; outletId: string | null; onChange: (id: string | null) => void }) {
  const router = useRouter();
  const brandName = useSession().brands.find((b) => b.id === scope.brandId)?.name;
  const live = choosableOutlets(outlets, outletId);
  if (live.length < 2) return null;
  const choose = (id: string) => {
    onChange(id);
    if (id === scope.outletId) return;
    void fetch("/api/prefs", { method: "POST", keepalive: true, headers: { "content-type": "application/json" }, body: JSON.stringify({ scope: { brandId: scope.brandId, outletId: id } }) }).then(() => router.refresh());
  };
  return (
    <nav aria-label="Outlets" className="max-w-full overflow-x-auto">
      <span className="inline-flex h-9 max-sm:h-auto items-center gap-0.5 rounded-[10px] bg-surface-2 p-0.5">
        {live.map((o) => (
          <Button
            key={o.id}
            variant="quiet"
            aria-current={o.id === outletId ? "true" : undefined}
            onPress={() => choose(o.id)}
            className={cx("h-8! min-h-8! max-sm:h-11! max-sm:min-h-11! shrink-0 rounded-[8px]! px-3! text-[13px] whitespace-nowrap", o.id === outletId ? "bg-surface! text-ink shadow-segment" : "text-ink-2")}
          >
            {outletOwnName(o.name, brandName)}
          </Button>
        ))}
      </span>
    </nav>
  );
}

export function BrandChoice({ brands, scope, brandId, onChange, allowAll }: { brands: Brand[]; scope: Scope; brandId: string | null; onChange: (id: string | null) => void; allowAll?: boolean }) {
  const scoped = brands.find((b) => b.id === scope.brandId) ?? null;
  if (scoped) {
    return (
      <p className="min-h-11 py-2.5">
        <span className="text-ink-2">Brand </span>
        <span className="text-ink">{scoped.name}</span>
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
