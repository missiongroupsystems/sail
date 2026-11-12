"use client";

import { Bell, Check, Circle, Flame, Receipt, Users, type LucideIcon } from "lucide-react";
import type { CSSProperties } from "react";
import { Button as AriaButton } from "react-aria-components";
import { cx } from "../lib/cx";
import { Icon } from "../components/Icon";

export type TableStatus = "free" | "seated" | "sent" | "bill_requested" | "paid";

/** Status is always colour + icon + word. */
export const TABLE_STATUS: Record<TableStatus, { label: string; icon: LucideIcon; colour: string }> = {
  free: { label: "Free", icon: Circle, colour: "var(--ink-2)" },
  seated: { label: "Seated", icon: Users, colour: "var(--status-seated)" },
  sent: { label: "Sent", icon: Flame, colour: "var(--status-sent)" },
  bill_requested: { label: "Bill asked", icon: Receipt, colour: "var(--status-bill)" },
  paid: { label: "Paid", icon: Check, colour: "var(--status-paid)" },
};

export type TableShapeProps = {
  name: string;
  shape: "round" | "square" | "rect" | string;
  status: TableStatus;
  pax?: number | null;
  /** "0:42" from the floor snapshot, updated by the caller. */
  elapsed?: string | null;
  /** Table requests or QR orders waiting: shows the "needs you" mark. */
  needsYou?: boolean;
  /** Target highlight while moving a table. */
  highlight?: boolean;
  isDisabled?: boolean;
  onPress: () => void;
  style?: CSSProperties;
  className?: string;
};

/** A table on the floor plan: number at 20pt, pax, elapsed time, status colour + icon. */
export function TableShape({ name, shape, status, pax, elapsed, needsYou, highlight, isDisabled, onPress, style, className }: TableShapeProps) {
  const meta = TABLE_STATUS[status];
  const free = status === "free";
  return (
    <AriaButton
      onPress={onPress}
      isDisabled={isDisabled}
      style={{ ...style, "--table-colour": meta.colour } as CSSProperties}
      aria-label={`Table ${name}, ${meta.label}${pax ? `, ${pax} guests` : ""}${elapsed ? `, seated ${elapsed}` : ""}${needsYou ? ", needs you" : ""}`}
      className={cx(
        "press pos-touch absolute flex flex-col items-center justify-center gap-0.5 outline-none",
        shape === "round" ? "rounded-full" : "rounded-tile",
        free ? "bg-surface hairline" : "bg-[color-mix(in_srgb,var(--table-colour)_var(--table-fill),var(--surface))]",
        !free && "shadow-[inset_0_0_0_2px_var(--table-colour)]",
        highlight && "shadow-[inset_0_0_0_3px_var(--status-seated)] bg-[color-mix(in_srgb,var(--status-seated)_10%,var(--surface))]",
        "data-[pressed]:scale-[0.97] data-[disabled]:opacity-40 data-[focus-visible]:outline-2 data-[focus-visible]:outline-offset-2 data-[focus-visible]:outline-status-seated",
        className,
      )}
    >
      <span className="text-heading text-ink">{name}</span>
      {!free ? (
        <span className="flex items-center gap-1 text-caption text-ink-2">
          <Icon icon={meta.icon} size={14} style={{ color: meta.colour }} />
          {pax ? <span className="tabular">{pax}</span> : null}
          {elapsed ? <span className="tabular">· {elapsed}</span> : null}
        </span>
      ) : (
        <span className="text-caption text-ink-2">Free</span>
      )}
      {needsYou ? (
        <span className="absolute -top-1.5 -right-1.5 flex size-6 items-center justify-center rounded-full bg-status-alert text-surface" aria-hidden>
          <Icon icon={Bell} size={13} />
        </span>
      ) : null}
    </AriaButton>
  );
}

/** The always-visible legend: every status as colour + icon + word. */
export function StatusLegend({ className }: { className?: string }) {
  return (
    <ul className={cx("flex flex-wrap items-center gap-x-5 gap-y-1 text-caption text-ink-2", className)} aria-label="Table status legend">
      {(Object.keys(TABLE_STATUS) as TableStatus[]).map((s) => {
        const m = TABLE_STATUS[s];
        return (
          <li key={s} className="flex items-center gap-1.5">
            <Icon icon={m.icon} size={14} style={{ color: m.colour }} />
            {m.label}
          </li>
        );
      })}
      <li className="flex items-center gap-1.5">
        <Icon icon={Bell} size={14} className="text-status-alert" />
        Needs you
      </li>
    </ul>
  );
}
