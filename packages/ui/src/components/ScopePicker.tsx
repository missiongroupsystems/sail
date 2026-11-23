"use client";

import { ChevronDown, Store } from "lucide-react";
import { Dialog as AriaDialog, DialogTrigger, Popover, Button as AriaButton } from "react-aria-components";
import { cx } from "../lib/cx";
import { outletOwnName } from "../lib/outlet-name";
import { useHydrated } from "../lib/use-hydrated";
import { Icon } from "./Icon";
import { Select } from "./Select";

export type ScopeOption = { id: string; name: string; archived?: boolean; /** On an outlet: the one brand it belongs to. */ brandId?: string };
export type ScopeValue = { brandId: string | null; outletId: string | null };

export type ScopePickerProps = {
  merchantName: string;
  brands: ScopeOption[];
  outlets: ScopeOption[];
  value: ScopeValue;
  onChange: (next: ScopeValue) => void;
  /** The outlet the page shows, on a page that works on one outlet while the scope covers all of them. */
  shownOutletId?: string | null;
  /** Icon-only trigger for the collapsed navigation rail. */
  collapsed?: boolean;
  className?: string;
};

export const ALL = "__all__";

/**
 * Merchant ▸ Brand ▸ Outlet. Every back-office page respects the selection. The merchant is fixed by the sign-in.
 * One brand is always chosen (there is no "All brands"), and the outlets offered are that brand's: one of them, or
 * all of them. Choosing another brand goes back to all of its outlets.
 */
export function ScopePicker({ merchantName, brands, outlets, value, shownOutletId, onChange, collapsed, className }: ScopePickerProps) {
  const brand = brands.find((b) => b.id === value.brandId) ?? null;
  const ofBrand = outlets.filter((o) => !brand || o.brandId === undefined || o.brandId === brand.id);
  // With all outlets in scope, a page that works on one outlet is named by the outlet it shows.
  const outlet = ofBrand.find((o) => o.id === value.outletId) ?? (value.outletId === null ? ofBrand.find((o) => o.id === shownOutletId) : undefined) ?? null;
  const brandLabel = brand?.name ?? "No brand yet";
  const outletLabel = outlet?.name ?? "All outlets";
  const allOutlets = brand ? `All outlets of ${brand.name}` : "All outlets";
  const summary = `${merchantName} ▸ ${brandLabel} ▸ ${outletLabel}`;
  // The trigger names only what narrows the view, so it fits: one brand with one outlet is just the brand; one brand
  // with several is the outlet part; several brands are the brand, and the outlet's own name once one is chosen.
  const liveBrands = brands.filter((b) => !b.archived);
  const liveOutlets = ofBrand.filter((o) => !o.archived);
  const ownOutlet = outlet ? outletOwnName(outlet.name, brand?.name) : "All outlets";
  const trigger = liveBrands.length > 1 ? (outlet ? `${brandLabel} · ${ownOutlet}` : brandLabel) : liveOutlets.length > 1 ? ownOutlet : brandLabel;
  const hydrated = useHydrated();

  return (
    <DialogTrigger>
      <AriaButton
        aria-label={`Scope: ${summary}`}
        // Server-rendered, the button has no handler yet: it says so until then, so an early press is not taken and lost.
        aria-disabled={hydrated ? undefined : true}
        className={cx(
          "press aria-disabled:pointer-events-none flex w-full min-h-11 items-center gap-2 rounded-[10px] bg-surface px-3 py-2 text-left shadow-[inset_0_0_0_1px_var(--line)] outline-none transition-shadow duration-[120ms]",
          "data-[hovered]:shadow-[inset_0_0_0_1px_var(--line-strong)] data-[pressed]:bg-surface-2",
          "data-[focus-visible]:outline-2 data-[focus-visible]:outline-offset-2 data-[focus-visible]:outline-focus",
          collapsed && "justify-center px-0",
          className,
        )}
      >
        {collapsed ? (
          <Icon icon={Store} size={18} className="text-ink" />
        ) : (
          <>
            {/* The merchant is fixed by the sign-in; the popover and the accessible name carry the full scope. */}
            <span className="min-w-0 flex-1 truncate text-[14px] leading-5 font-medium text-ink">{trigger}</span>
            <Icon icon={ChevronDown} size={16} className="shrink-0 text-ink-3" />
          </>
        )}
      </AriaButton>
      <Popover
        placement="bottom start"
        offset={4}
        className="w-[320px] rounded-[14px] bg-surface shadow-popover outline-none data-[entering]:animate-rise-in data-[exiting]:animate-rise-out"
      >
        <AriaDialog aria-label="Change scope" className="flex flex-col gap-4 p-4 outline-none">
          <div>
            <p className="text-caption text-ink-3">Merchant</p>
            <p className="text-line text-ink">{merchantName}</p>
          </div>
          <Select
            label="Brand"
            items={brands.filter((b) => !b.archived || b.id === value.brandId).map((b) => ({ id: b.id, label: b.name }))}
            selectedKey={value.brandId}
            placeholder="No brand yet"
            // Another brand has other outlets: the outlet goes back to all of the new brand's.
            onSelectionChange={(key) => key !== null && key !== value.brandId && onChange({ brandId: key, outletId: null })}
          />
          <Select
            label="Outlet"
            items={[{ id: ALL, label: allOutlets }, ...ofBrand.filter((o) => !o.archived || o.id === value.outletId).map((o) => ({ id: o.id, label: o.name }))]}
            selectedKey={outlet?.id ?? ALL}
            onSelectionChange={(key) => onChange({ ...value, outletId: key === ALL || key === null ? null : key })}
          />
        </AriaDialog>
      </Popover>
    </DialogTrigger>
  );
}
