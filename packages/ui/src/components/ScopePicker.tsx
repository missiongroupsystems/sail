"use client";

import { ChevronDown, Store } from "lucide-react";
import { Dialog as AriaDialog, DialogTrigger, Popover, Button as AriaButton } from "react-aria-components";
import { cx } from "../lib/cx";
import { Icon } from "./Icon";
import { Select } from "./Select";

export type ScopeOption = { id: string; name: string; archived?: boolean };
export type ScopeValue = { brandId: string | null; outletId: string | null };

export type ScopePickerProps = {
  merchantName: string;
  brands: ScopeOption[];
  outlets: ScopeOption[];
  value: ScopeValue;
  onChange: (next: ScopeValue) => void;
  /** Icon-only trigger for the collapsed navigation rail. */
  collapsed?: boolean;
  className?: string;
};

export const ALL = "__all__";

/**
 * Merchant ▸ Brand ▸ Outlet. Every back-office page respects the
 * selection. The merchant is fixed by the sign-in; brand and outlet narrow it.
 */
export function ScopePicker({ merchantName, brands, outlets, value, onChange, collapsed, className }: ScopePickerProps) {
  const brand = brands.find((b) => b.id === value.brandId) ?? null;
  const outlet = outlets.find((o) => o.id === value.outletId) ?? null;
  const brandLabel = brand?.name ?? "All brands";
  const outletLabel = outlet?.name ?? "All outlets";
  const summary = `${merchantName} ▸ ${brandLabel} ▸ ${outletLabel}`;

  return (
    <DialogTrigger>
      <AriaButton
        aria-label={`Scope: ${summary}`}
        className={cx(
          "press flex w-full min-h-11 items-center gap-2 rounded-[10px] bg-surface px-3 py-2 text-left shadow-[inset_0_0_0_1px_var(--line)] outline-none transition-shadow duration-[120ms]",
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
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[11.5px] leading-4 text-ink-3">{merchantName}</span>
              <span className="block truncate text-[14px] leading-5 font-medium text-ink">
                {brandLabel} · {outletLabel}
              </span>
            </span>
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
            items={[{ id: ALL, label: "All brands" }, ...brands.filter((b) => !b.archived || b.id === value.brandId).map((b) => ({ id: b.id, label: b.name }))]}
            selectedKey={value.brandId ?? ALL}
            onSelectionChange={(key) => onChange({ ...value, brandId: key === ALL || key === null ? null : key })}
          />
          <Select
            label="Outlet"
            items={[{ id: ALL, label: "All outlets" }, ...outlets.filter((o) => !o.archived || o.id === value.outletId).map((o) => ({ id: o.id, label: o.name }))]}
            selectedKey={value.outletId ?? ALL}
            onSelectionChange={(key) => onChange({ ...value, outletId: key === ALL || key === null ? null : key })}
          />
        </AriaDialog>
      </Popover>
    </DialogTrigger>
  );
}
