"use client";

import type { ReactNode } from "react";
import { cx } from "../lib/cx";
import { Button, type ButtonVariant } from "../components/Button";

export type NowItem = {
  id: string;
  /** "T7 · QR order · 3", "P-031 · Ready · Lim". */
  title: string;
  detail?: string | null;
  /** Lines of a QR order, shown under the detail (design 4.2). */
  lines?: string[];
  actions?: { id: string; label: string; onPress: () => void; variant?: ButtonVariant; isDisabled?: boolean; isPending?: boolean }[];
};

export type NowRailProps = {
  items: NowItem[];
  /** The [+ Takeaway order] button and similar, pinned at the bottom. */
  footer?: ReactNode;
  className?: string;
};

/** The "Now" rail (design 4.2): everything waiting for a person, oldest first; "Nothing waiting" when empty. */
export function NowRail({ items, footer, className }: NowRailProps) {
  return (
    <aside className={cx("flex h-full w-[300px] shrink-0 flex-col hairline-l bg-surface", className)} aria-label="Now">
      <h2 className="px-4 pt-4 pb-2 text-caption text-ink-2 uppercase tracking-[0.04em]">Now</h2>
      <div className="min-h-0 flex-1 overflow-y-auto px-3">
        {items.length === 0 ? (
          <p className="px-1 py-3 text-body text-ink-2">Nothing waiting</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {items.map((it) => (
              <li key={it.id} className="rounded-tile bg-surface-2 px-3 py-3">
                <p className="text-line text-ink">{it.title}</p>
                {it.detail ? <p className="text-caption text-ink-2">{it.detail}</p> : null}
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
      {footer ? <div className="flex flex-col gap-2 p-3 hairline-t">{footer}</div> : null}
    </aside>
  );
}
