"use client";

import { Button as AriaButton } from "react-aria-components";
import { cx } from "../lib/cx";

export type SegmentOption = {
  id: string;
  label: string;
  /** A count after the label, in grey ("Open 3"). */
  count?: number;
  isDisabled?: boolean;
  /** The register's reason the option is off ("Bill 1 is paid. Refund it to change the split."); surfaced by the parent on press. */
  reason?: string | null;
};

export type SegmentedControlProps = {
  options: SegmentOption[];
  selectedId: string;
  onSelect: (id: string) => void;
  /** Pressing a disabled option: the parent shows its reason in one line. */
  onDisabledPress?: (option: SegmentOption) => void;
  "aria-label": string;
  className?: string;
};

/** A segmented control (split modes): one row of equal pills, the selected one filled. Disabled options stay visible with their reason. */
export function SegmentedControl({ options, selectedId, onSelect, onDisabledPress, className, ...rest }: SegmentedControlProps) {
  return (
    <div role="group" aria-label={rest["aria-label"]} className={cx("inline-flex items-center gap-0.5 rounded-chip bg-surface-2 p-1", className)}>
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
              "press pos-touch flex min-h-11 min-w-[72px] items-center justify-center rounded-chip px-4 text-[14.5px] font-medium whitespace-nowrap outline-none transition-colors duration-[120ms]",
              selected ? "bg-surface text-ink shadow-segment" : "text-ink-2 data-[hovered]:text-ink",
              o.isDisabled && !selected && "text-ink-disabled",
              "data-[pressed]:scale-[0.97] data-[focus-visible]:outline-2 data-[focus-visible]:outline-offset-2 data-[focus-visible]:outline-focus",
            )}
          >
            {o.label}
            {o.count != null ? <span className="ml-1.5 text-[12.5px] font-normal text-ink-3 tabular">{o.count}</span> : null}
          </AriaButton>
        );
      })}
    </div>
  );
}
