"use client";

import { Lock } from "lucide-react";
import type { ReactNode } from "react";
import { Button as AriaButton } from "react-aria-components";
import { cx } from "../lib/cx";
import { Icon } from "../components/Icon";
import { Money } from "../components/Money";

export type BillCardStatus = "open" | "paid" | "partially_refunded" | "refunded";

export type BillCardLine = {
  id: string;
  name: string;
  /** "⅓" or "1/3" share of a line split between bills. */
  share?: string | null;
  detail?: string | null;
  amountCents: number;
  /** Tap a line on a bill to pick it as the one to move (By item). */
  onPress?: () => void;
  isSelected?: boolean;
  isDisabled?: boolean;
};

export type BillCardRow = { key: string; label: string; cents: number; kind?: "row" | "total" | "paid" | "balance" };

export type BillCardProps = {
  /** "Bill 2 · Seat 2". */
  label: string;
  status: BillCardStatus;
  lines: BillCardLine[];
  /** Adjustments, tax, total, paid and balance as the register returned them. */
  rows: BillCardRow[];
  /** Tenders on a paid bill: "Card · $41.56". */
  tenders?: { id: string; label: string; cents: number }[];
  /** Highlight as the target while a line is selected (tap a line, then a bill). */
  isTarget?: boolean;
  onPress?: () => void;
  isDisabled?: boolean;
  /** [Pre-bill] [Pay ▸] on unpaid bills; [Get invoice] [Refund] on paid ones. */
  actions?: ReactNode;
  className?: string;
};

const STATUS_LABEL: Record<BillCardStatus, string> = { open: "", paid: "Paid", partially_refunded: "Partly refunded", refunded: "Refunded" };

/** One bill as a column card: lines with their share, totals, a lock when paid, and the bill's own actions. */
export function BillCard({ label, status, lines, rows, tenders, isTarget, onPress, isDisabled, actions, className }: BillCardProps) {
  const paid = status !== "open";
  const body = (
    <>
      <header className="flex items-center justify-between gap-2 px-4 pt-3 pb-2 hairline-b">
        <h3 className="truncate text-line text-ink">{label}</h3>
        {paid ? (
          <span className="inline-flex shrink-0 items-center gap-1 rounded-chip bg-[color-mix(in_srgb,var(--status-paid)_12%,transparent)] px-2 text-caption text-status-paid">
            <Icon icon={Lock} size={13} /> {STATUS_LABEL[status]}
          </span>
        ) : isTarget ? (
          <span className="shrink-0 text-caption text-status-seated">Tap to move here</span>
        ) : null}
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-1">
        {lines.length === 0 ? <p className="px-2 py-3 text-body text-ink-2">Nothing on this bill yet.</p> : null}
        {lines.map((l) => {
          const inner = (
            <>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2 text-body text-ink">
                  <span className="truncate">{l.name}</span>
                  {l.share && l.share !== "1" ? <span className="shrink-0 rounded-chip bg-surface-2 px-1.5 text-caption text-ink-2 tabular">{l.share}</span> : null}
                </span>
                {l.detail ? <span className="block truncate text-caption text-ink-2">{l.detail}</span> : null}
              </span>
              <Money cents={l.amountCents} size="body" className="shrink-0 text-ink" />
            </>
          );
          const cls = cx(
            "flex w-full items-start gap-2 rounded-[8px] px-2 py-1.5 text-left outline-none",
            l.isSelected && "bg-[color-mix(in_srgb,var(--status-seated)_14%,transparent)] shadow-[inset_0_0_0_1.5px_var(--status-seated)]",
            l.onPress && "press pos-touch data-[pressed]:bg-surface-2 data-[hovered]:bg-surface-2 data-[disabled]:opacity-45 data-[focus-visible]:outline-2 data-[focus-visible]:outline-offset-[-2px] data-[focus-visible]:outline-status-seated",
          );
          return l.onPress ? (
            <AriaButton key={l.id} onPress={l.onPress} isDisabled={l.isDisabled} aria-pressed={l.isSelected} className={cls}>
              {inner}
            </AriaButton>
          ) : (
            <div key={l.id} className={cls}>
              {inner}
            </div>
          );
        })}
      </div>
      <dl className="px-4 pt-2 pb-1 hairline-t">
        {rows.map((r) => (
          <div key={r.key} className={cx("flex items-center justify-between gap-2", r.kind === "total" ? "mt-1 min-h-8 pt-1 hairline-t" : "min-h-6")}>
            <dt className={cx("truncate", r.kind === "total" ? "text-line text-ink" : "text-caption text-ink-2")}>{r.label}</dt>
            <dd className="shrink-0">
              <Money cents={r.cents} size={r.kind === "total" ? "heading" : "caption"} className={r.kind === "total" ? "text-ink" : "text-ink-2"} />
            </dd>
          </div>
        ))}
      </dl>
      {tenders?.length ? (
        <ul className="px-4 pb-2 text-caption text-ink-2">
          {tenders.map((t) => (
            <li key={t.id} className="flex items-center justify-between gap-2">
              <span className="truncate">{t.label}</span>
              <Money cents={t.cents} size="caption" />
            </li>
          ))}
        </ul>
      ) : null}
      {actions ? <footer className="flex flex-wrap items-center justify-end gap-2 px-3 pt-1 pb-3">{actions}</footer> : null}
    </>
  );
  const classes = cx(
    "flex h-full w-[264px] shrink-0 flex-col rounded-tile bg-surface hairline text-left",
    isTarget && "shadow-[inset_0_0_0_2px_var(--status-seated)] bg-[color-mix(in_srgb,var(--status-seated)_6%,var(--surface))]",
    paid && "bg-[color-mix(in_srgb,var(--status-paid)_6%,var(--surface))]",
    className,
  );
  if (onPress) {
    return (
      <AriaButton onPress={onPress} isDisabled={isDisabled} aria-label={`${label}, move the selected line here`} className={cx(classes, "press pos-touch outline-none data-[pressed]:scale-[0.99] data-[disabled]:opacity-60 data-[focus-visible]:outline-2 data-[focus-visible]:outline-offset-2 data-[focus-visible]:outline-status-seated")}>
        {body}
      </AriaButton>
    );
  }
  return (
    <section aria-label={label} className={classes}>
      {body}
    </section>
  );
}
