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
  /** Leave it for the next shift where the register allows it (design 4.9). */
  onLeave?: () => void;
  leaveLabel?: string;
};

export type ChecklistProps = {
  items: ChecklistItem[];
  className?: string;
};

/** The close-shift checklist (design 4.9): one row per register read, each resolved or explicitly left open. */
export function Checklist({ items, className }: ChecklistProps) {
  return (
    <ul className={cx("flex flex-col gap-2", className)} aria-label="Before closing">
      {items.map((it) => (
        <li key={it.id} className={cx("flex min-h-16 items-center gap-3 rounded-tile px-4 py-2", it.status === "open" ? "bg-surface hairline" : "bg-surface-2")}>
          <Icon
            icon={it.status === "resolved" ? Check : it.status === "left" ? ArrowRight : Circle}
            size={20}
            className={cx(it.status === "resolved" && "text-status-paid", it.status === "left" && "text-ink-2", it.status === "open" && "text-status-sent")}
          />
          <div className="min-w-0 flex-1">
            <p className={cx("truncate text-line", it.status === "open" ? "text-ink" : "text-ink-2")}>{it.title}</p>
            {it.detail ? <p className="truncate text-caption text-ink-2">{it.detail}</p> : null}
          </div>
          {it.status === "open" && it.onView ? (
            <Button size="lg" variant="secondary" onPress={it.onView}>
              {it.viewLabel ?? "View"}
            </Button>
          ) : null}
          {it.status === "open" && it.onLeave ? (
            <Button size="lg" variant="quiet" onPress={it.onLeave} className="text-ink-2">
              {it.leaveLabel ?? "Leave open"}
            </Button>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
