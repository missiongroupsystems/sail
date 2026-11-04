"use client";

import { ChevronLeft } from "lucide-react";
import type { ReactNode } from "react";
import { Button as AriaButton } from "react-aria-components";
import { cx } from "../lib/cx";
import { Icon } from "../components/Icon";

export type RailItem = { id: string; label: string };

export type SectionRailProps = {
  items: RailItem[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  /** When inside a folder: the folder's name and a way back ("◂ Drinks"). */
  folder?: { label: string; onBack: () => void } | null;
  /** The search field, rendered at the bottom. */
  footer?: ReactNode;
  className?: string;
};

const item =
  "press pos-touch flex min-h-14 w-full items-center rounded-tile px-3 text-left text-line outline-none " +
  "data-[pressed]:scale-[0.98] data-[hovered]:bg-surface-2 data-[focus-visible]:outline-2 data-[focus-visible]:outline-offset-2 data-[focus-visible]:outline-status-seated";

/** The section rail (design 4.3): 140pt, the layout's pages as items, the brand accent on the selected one. */
export function SectionRail({ items, selectedId, onSelect, folder, footer, className }: SectionRailProps) {
  return (
    <nav aria-label="Menu sections" className={cx("flex h-full w-[140px] shrink-0 flex-col gap-1 py-2 pr-2", className)}>
      {folder ? (
        <AriaButton onPress={folder.onBack} className={cx(item, "gap-1 text-ink-2")} aria-label={`Back from ${folder.label}`}>
          <Icon icon={ChevronLeft} size={18} />
          <span className="truncate">{folder.label}</span>
        </AriaButton>
      ) : null}
      <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto">
        {items.map((it) => {
          const selected = it.id === selectedId;
          return (
            <AriaButton
              key={it.id}
              onPress={() => onSelect(it.id)}
              aria-current={selected ? "page" : undefined}
              className={cx(item, selected ? "bg-surface text-ink shadow-[inset_4px_0_0_var(--brand-accent)]" : "text-ink-2")}
            >
              <span className="truncate">{it.label}</span>
            </AriaButton>
          );
        })}
      </div>
      {footer ? <div className="pt-2">{footer}</div> : null}
    </nav>
  );
}
