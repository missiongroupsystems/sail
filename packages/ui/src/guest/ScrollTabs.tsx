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
 * Sticky section tabs for the guest menu (design 4.11): one horizontal row
 * that scrolls, the selected tab underlined in the brand accent (section 9).
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
    <nav ref={ref} aria-label={label} className={cx("no-scrollbar flex gap-1 overflow-x-auto px-2", className)}>
      {tabs.map((t) => {
        const on = t.id === selectedId;
        return (
          <AriaButton
            key={t.id}
            data-tab-id={t.id}
            onPress={() => onSelect(t.id)}
            aria-current={on ? "location" : undefined}
            className={cx(
              "press relative flex min-h-12 shrink-0 items-center px-3 text-line whitespace-nowrap outline-none touch-manipulation select-none",
              "data-[pressed]:scale-[0.97] data-[focus-visible]:outline-2 data-[focus-visible]:-outline-offset-2 data-[focus-visible]:outline-status-seated",
              on ? "text-brand-accent" : "text-ink-2",
            )}
          >
            {t.label}
            <span aria-hidden className={cx("absolute inset-x-3 bottom-0 h-0.5 rounded-full", on ? "bg-brand-accent" : "bg-transparent")} />
          </AriaButton>
        );
      })}
    </nav>
  );
}
