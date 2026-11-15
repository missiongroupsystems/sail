"use client";

import type { ReactNode } from "react";
import { Button as AriaButton } from "react-aria-components";
import { cx } from "../lib/cx";

export type FilterTabOption<K extends string = string> = { id: K; label: ReactNode; count?: number | string; isDisabled?: boolean };

export type FilterTabsProps<K extends string = string> = {
  options: FilterTabOption<K>[];
  selectedId: K;
  onSelect: (id: K) => void;
  /** Names the group for screen readers: "Range", "Orders shown". */
  "aria-label": string;
  className?: string;
};

/**
 * A back-office filter as a segmented strip: a grey track, the chosen option raised on a white
 * segment, an optional count in tertiary ink after each label. Each option is a toggle button
 * (`aria-pressed`) in a named group.
 */
export function FilterTabs<K extends string = string>({ options, selectedId, onSelect, className, ...rest }: FilterTabsProps<K>) {
  return (
    <div role="group" aria-label={rest["aria-label"]} className={cx("inline-flex h-9 max-sm:h-12 max-w-full items-center gap-0.5 overflow-x-auto rounded-[10px] bg-surface-2 p-0.5", className)}>
      {options.map((o) => {
        const active = o.id === selectedId;
        return (
          <AriaButton
            key={o.id}
            aria-pressed={active}
            isDisabled={o.isDisabled}
            onPress={() => onSelect(o.id)}
            className={cx(
              "press inline-flex h-8 max-sm:h-11 shrink-0 cursor-default items-center gap-1.5 whitespace-nowrap rounded-[8px] px-3 text-[13px] font-medium outline-none transition-colors duration-[120ms]",
              "data-[focus-visible]:outline-2 data-[focus-visible]:outline-offset-[-2px] data-[focus-visible]:outline-focus data-[disabled]:text-ink-disabled",
              active ? "bg-surface text-ink shadow-segment" : "text-ink-2 data-[hovered]:text-ink",
            )}
          >
            {o.label}
            {o.count !== undefined ? <span className="text-[12px] font-normal text-ink-3 tabular">{o.count}</span> : null}
          </AriaButton>
        );
      })}
    </div>
  );
}
