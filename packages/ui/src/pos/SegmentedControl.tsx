"use client";

import { Button as AriaButton } from "react-aria-components";
import { cx } from "../lib/cx";

export type SegmentOption = {
  id: string;
  label: string;
  isDisabled?: boolean;
  /** The register's reason the option is off ("Bill 1 is paid. Refund it to change the split."); surfaced by the parent on press. */
  reason?: string | null;
};

export type SegmentedControlProps = {
  options: SegmentOption[];
  selectedId: string;
  onSelect: (id: string) => void;
  /** Pressing a disabled option: the parent shows its reason in one line (design 4.4). */
  onDisabledPress?: (option: SegmentOption) => void;
  "aria-label": string;
  className?: string;
};

/** A segmented control (design 4.4 split modes): one row of equal pills, the selected one filled. Disabled options stay visible with their reason. */
export function SegmentedControl({ options, selectedId, onSelect, onDisabledPress, className, ...rest }: SegmentedControlProps) {
  return (
    <div role="group" aria-label={rest["aria-label"]} className={cx("inline-flex items-center gap-1 rounded-tile bg-surface-2 p-1", className)}>
      {options.map((o) => {
        const selected = o.id === selectedId;
        return (
          <AriaButton
            key={o.id}
            aria-pressed={selected}
            aria-disabled={o.isDisabled || undefined}
            aria-description={o.isDisabled && o.reason ? o.reason : undefined}
            onPress={() => (o.isDisabled ? onDisabledPress?.(o) : onSelect(o.id))}
            className={cx(
              "press pos-touch flex min-h-11 min-w-[72px] items-center justify-center rounded-[8px] px-4 text-line outline-none",
              selected ? "bg-surface text-ink shadow-[0_1px_2px_rgba(0,0,0,0.08)]" : "text-ink-2 data-[hovered]:text-ink",
              o.isDisabled && !selected && "opacity-45",
              "data-[pressed]:scale-[0.97] data-[focus-visible]:outline-2 data-[focus-visible]:outline-offset-2 data-[focus-visible]:outline-status-seated",
            )}
          >
            {o.label}
          </AriaButton>
        );
      })}
    </div>
  );
}
