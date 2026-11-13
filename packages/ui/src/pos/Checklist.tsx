"use client";

import { ArrowRight, Check, Circle } from "lucide-react";
import { cx } from "../lib/cx";
import { Button } from "../components/Button";
import { Icon } from "../components/Icon";

export type ChecklistItemStatus = "open" | "resolved" | "left";

export type ChecklistItem = {
  id: string;
  /** "3 open orders", "1 QR order waiting". */
  title: string;
  detail?: string | null;
  status: ChecklistItemStatus;
  /** Go to where the item is resolved (the Orders screen, the Now rail…). */
  onView?: () => void;
  viewLabel?: string;
  /** Leave it for the next shift where the register allows it. */
  onLeave?: () => void;
  leaveLabel?: string;
};

export type ChecklistProps = {
  items: ChecklistItem[];
  className?: string;
};

/** The close-shift checklist: one row per register read, each resolved or explicitly left open. */
export function Checklist({ items, className }: ChecklistProps) {
  return (
    <ul className={cx("flex flex-col gap-2", className)} aria-label="Before closing">
      {items.map((it) => (
        // Every row is one grey tile; an open item is told apart by its amber circle and its actions, not a different card.
        <li key={it.id} className="flex min-h-16 flex-wrap items-center gap-x-3 gap-y-2 rounded-panel bg-surface-2 px-4 py-2.5">
          <Icon
            icon={it.status === "resolved" ? Check : it.status === "left" ? ArrowRight : Circle}
            size={20}
            className={cx(it.status === "resolved" && "text-status-paid", it.status === "left" && "text-ink-2", it.status === "open" && "text-status-sent")}
          />
          <div className="min-w-[12rem] flex-1">
            <p className={cx("truncate text-line font-medium", it.status === "open" ? "text-ink" : "text-ink-2")}>{it.title}</p>
            {/* The sub-line wraps rather than cut off mid-word in a narrow column. */}
            {it.detail ? <p className="text-[13px] leading-snug text-ink-2">{it.detail}</p> : null}
          </div>
          <div className="ml-auto flex items-center gap-2">
          {it.status === "open" && it.onView ? (
            <Button size="lg" variant="secondary" onPress={it.onView} className="bg-surface!">
              {it.viewLabel ?? "View"}
            </Button>
          ) : null}
          {it.status === "open" && it.onLeave ? (
            <Button size="lg" variant="quiet" onPress={it.onLeave} className="text-ink-2">
              {it.leaveLabel ?? "Leave open"}
            </Button>
          ) : null}
          </div>
        </li>
      ))}
    </ul>
  );
}
