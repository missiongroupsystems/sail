"use client";

import { useEffect, useRef } from "react";
import { Button as AriaButton } from "react-aria-components";
import { cx } from "../lib/cx";

export type ScrollTab = { id: string; label: string };

export type ScrollTabsProps = {
  tabs: ScrollTab[];
  /** The section currently in view. */
  selectedId: string | null;
  onSelect: (id: string) => void;
  /** "Menu sections" */
  label?: string;
  className?: string;
};

/**
 * Sticky section chips for the guest menu: one horizontal row
 * that scrolls, the section being read filled in ink, the others grey.
 * They jump to sections on the same page, so they are navigation, not a tablist.
 */
export function ScrollTabs({ tabs, selectedId, onSelect, label = "Menu sections", className }: ScrollTabsProps) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!selectedId || !ref.current) return;
    const el = ref.current.querySelector<HTMLElement>(`[data-tab-id="${selectedId}"]`);
    el?.scrollIntoView({ block: "nearest", inline: "center", behavior: "smooth" });
  }, [selectedId]);
  return (
    <nav ref={ref} aria-label={label} className={cx("no-scrollbar flex gap-2 overflow-x-auto py-1.5", className ?? "px-4")}>
      {tabs.map((t) => {
        const on = t.id === selectedId;
        return (
          <AriaButton
            key={t.id}
            data-tab-id={t.id}
            onPress={() => onSelect(t.id)}
            aria-current={on ? "location" : undefined}
            className={cx(
              "press relative flex min-h-12 shrink-0 items-center rounded-chip px-4 text-[14.5px] whitespace-nowrap outline-none touch-manipulation select-none transition-colors duration-[120ms]",
              "data-[focus-visible]:outline-2 data-[focus-visible]:-outline-offset-2 data-[focus-visible]:outline-focus",
              on ? "bg-primary font-semibold text-on-primary" : "bg-surface-2 font-medium text-ink-2 data-[hovered]:text-ink data-[pressed]:bg-surface-3",
            )}
          >
            {t.label}
          </AriaButton>
        );
      })}
    </nav>
  );
}
