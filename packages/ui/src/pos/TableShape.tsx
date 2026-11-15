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

/** The tint behind an occupied table and the pill in the legend: each status ink clears 4.5:1 on its own tint. */
const TINT: Record<TableStatus, { fill: string; pill: string }> = {
  free: { fill: "var(--surface)", pill: "bg-surface-2 text-ink-2" },
  seated: { fill: "var(--status-seated-tint)", pill: "bg-status-seated-tint text-status-seated" },
  sent: { fill: "var(--status-sent-tint)", pill: "bg-status-sent-tint text-status-sent" },
  bill_requested: { fill: "var(--status-bill-tint)", pill: "bg-status-bill-tint text-status-bill" },
  paid: { fill: "var(--status-paid-tint)", pill: "bg-status-paid-tint text-status-paid" },
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
  /** `card`: name top-left, guests top-right, the status pill and time at the foot. `compact`: all centred,
   * for a round table or one too small for the card. Default: `card` unless round. */
  layout?: "card" | "compact";
  style?: CSSProperties;
  className?: string;
};

/** A table on the floor plan: number at 20pt, pax, elapsed time, status colour + icon. */
export function TableShape({ name, shape, status, pax, elapsed, needsYou, highlight, isDisabled, onPress, layout, style, className }: TableShapeProps) {
  const meta = TABLE_STATUS[status];
  const free = status === "free";
  const card = (layout ?? (shape === "round" ? "compact" : "card")) === "card";
  return (
    <AriaButton
      onPress={onPress}
      isDisabled={isDisabled}
      style={{ ...style, "--table-colour": meta.colour, "--table-tint": TINT[status].fill } as CSSProperties}
      aria-label={`Table ${name}, ${meta.label}${pax ? `, ${pax} guests` : ""}${elapsed ? `, seated ${elapsed}` : ""}${needsYou ? ", needs you" : ""}`}
      className={cx(
        "press pos-touch absolute flex flex-col outline-none transition-[transform,box-shadow] duration-[120ms]",
        card ? "@container items-stretch justify-between px-3 py-2.5 text-left" : "items-center justify-center gap-0.5",
        shape === "round" ? "rounded-full" : "rounded-sheet",
        highlight
          ? cx("shadow-[inset_0_0_0_3px_var(--status-seated)] bg-status-seated-tint", free && "border border-dashed border-rule-dashed")
          : free
            ? "border border-dashed border-rule-dashed bg-surface"
            : "bg-(--table-tint) shadow-[inset_0_0_0_1.5px_color-mix(in_oklab,var(--table-colour)_60%,transparent)]",
        "data-[pressed]:scale-[0.97] data-[disabled]:opacity-40 data-[focus-visible]:outline-2 data-[focus-visible]:outline-offset-2 data-[focus-visible]:outline-focus",
        className,
      )}
    >
      {card ? (
        <>
          <span className="flex items-start justify-between gap-2">
            <span className={cx("min-w-0 truncate font-heading text-heading leading-tight", free ? "text-ink-2" : "text-ink")}>{name}</span>
            {pax ? (
              <span className="inline-flex shrink-0 items-center gap-1 pt-0.5 text-caption font-medium text-ink-2 tabular">
                <Icon icon={Users} size={13} />
                {pax}
              </span>
            ) : null}
          </span>
          {free ? (
            <span className="text-caption text-ink-3">Free</span>
          ) : (
            <span className="flex items-center justify-between gap-2">
              <span className="inline-flex h-6 min-w-0 items-center gap-1 rounded-chip bg-surface px-2 text-[12px] font-medium" style={{ color: meta.colour }}>
                <Icon icon={meta.icon} size={12} className="shrink-0" />
                {/* A narrow card keeps the icon and the time; the word is still in the button's name. */}
                <span className="truncate @max-[150px]:sr-only">{meta.label}</span>
              </span>
              {elapsed ? <span className="shrink-0 text-caption text-ink tabular">{elapsed}</span> : null}
            </span>
          )}
        </>
      ) : (
        <>
          <span className={cx("font-heading text-heading leading-none", free ? "text-ink-2" : "text-ink")}>{name}</span>
          {!free ? (
            <span className="flex items-center gap-1 text-caption font-medium text-ink-2">
              <Icon icon={meta.icon} size={14} style={{ color: meta.colour }} />
              {pax ? <span className="tabular">{pax}</span> : null}
              {elapsed ? <span className="tabular">· {elapsed}</span> : null}
            </span>
          ) : (
            <span className="text-caption text-ink-3">Free</span>
          )}
        </>
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
    <ul className={cx("flex flex-wrap items-center gap-2 text-[11.5px] font-medium", className)} aria-label="Table status legend">
      {(Object.keys(TABLE_STATUS) as TableStatus[]).map((s) => {
        const m = TABLE_STATUS[s];
        return (
          <li key={s} className={cx("inline-flex h-[22px] items-center gap-1.5 rounded-chip px-2", TINT[s].pill)}>
            <Icon icon={m.icon} size={12} />
            {m.label}
          </li>
        );
      })}
      <li className="inline-flex h-[22px] items-center gap-1.5 rounded-chip bg-status-alert-tint px-2 text-status-alert">
        <Icon icon={Bell} size={12} />
        Needs you
      </li>
    </ul>
  );
}
