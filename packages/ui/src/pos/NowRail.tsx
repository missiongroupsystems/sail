"use client";

import type { ReactNode } from "react";
import { Check } from "lucide-react";
import { cx } from "../lib/cx";
import { Icon } from "../components/Icon";
import { Button, type ButtonVariant } from "../components/Button";

export type NowItem = {
  id: string;
  /** "T7 · QR order · 3", "P-031 · Ready · Lim". */
  title: string;
  detail?: string | null;
  /** Lines of a QR order, shown under the detail. */
  lines?: string[];
  actions?: { id: string; label: string; onPress: () => void; variant?: ButtonVariant; isDisabled?: boolean; isPending?: boolean }[];
};

export type NowRailProps = {
  items: NowItem[];
  /** The [+ Takeaway order] button and similar, pinned at the bottom. */
  footer?: ReactNode;
  className?: string;
};

/** The "Now" rail: everything waiting for a person, oldest first; "Nothing waiting" when empty. */
export function NowRail({ items, footer, className }: NowRailProps) {
  return (
    <aside className={cx("flex h-full w-[300px] shrink-0 flex-col overflow-hidden rounded-panel border border-rule bg-surface max-[1100px]:w-[260px]", className)} aria-label="Now">
      <header className="flex h-12 shrink-0 items-center justify-between border-b border-rule px-4">
        <h2 className="font-heading text-[16px] font-semibold text-ink">Now</h2>
        {items.length ? <span className="text-[13px] text-ink-3 tabular">{items.length} waiting</span> : null}
      </header>
      <div className={cx("min-h-0 flex-1 overflow-y-auto p-2", items.length === 0 && "flex flex-col items-center justify-center")}>
        {items.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-6 text-center">
            <Icon icon={Check} size={20} className="text-ink-2" />
            <p className="text-[15px] text-ink-2">Nothing waiting</p>
            <p className="text-[13.5px] text-ink-3">QR orders, table requests and pickups appear here.</p>
          </div>
        ) : (
          <ul className="flex flex-col gap-2">
            {items.map((it) => (
              <li key={it.id} className="rounded-tile border border-rule bg-surface p-3">
                <p className="text-line font-medium text-ink">{it.title}</p>
                {it.detail ? <p className="text-[13px] text-ink-2">{it.detail}</p> : null}
                {it.lines?.length ? (
                  <ul className="mt-1 text-caption text-ink-2">
                    {it.lines.map((l, i) => (
                      <li key={i} className="truncate">
                        {l}
                      </li>
                    ))}
                  </ul>
                ) : null}
                {it.actions?.length ? (
                  <div className="mt-2 flex flex-wrap gap-2">
                    {it.actions.map((a) => (
                      <Button key={a.id} size="md" variant={a.variant ?? "secondary"} onPress={a.onPress} isDisabled={a.isDisabled} isPending={a.isPending}>
                        {a.label}
                      </Button>
                    ))}
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>
      {footer ? <div className="flex flex-col gap-2 border-t border-rule-subtle p-3">{footer}</div> : null}
    </aside>
  );
}
