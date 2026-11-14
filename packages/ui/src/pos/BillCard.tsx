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
  /** Overrides the status word on a paid bill: "Tip still to give back: $2.00". */
  statusLabel?: string | null;
  /** An open bill with a payment on it already: its chip says "Part paid", not "Unpaid". */
  partPaid?: boolean;
  /** [Pre-bill] [Pay] on unpaid bills; [Get invoice] [Refund] on paid ones. */
  actions?: ReactNode;
  className?: string;
};

const STATUS_LABEL: Record<BillCardStatus, string> = { open: "", paid: "Paid", partially_refunded: "Partly refunded", refunded: "Refunded" };

/** One bill as a column card: lines with their share, totals, a lock when paid, and the bill's own actions. */
export function BillCard({ label, status, lines, rows, tenders, isTarget, onPress, isDisabled, actions, statusLabel, partPaid, className }: BillCardProps) {
  const paid = status !== "open";
  const body = (
    <>
      <header className="flex min-h-12 items-center justify-between gap-2 border-b border-rule-subtle px-4 py-2.5">
        <h3 className="truncate font-heading text-[17px] font-semibold text-ink">{label}</h3>
        {paid ? (
          <span className="inline-flex h-[22px] shrink-0 items-center gap-1 rounded-chip bg-status-paid-tint px-2 text-[11.5px] font-medium text-status-paid">
            <Icon icon={Lock} size={13} /> {statusLabel ?? STATUS_LABEL[status]}
          </span>
        ) : isTarget ? (
          <span className="shrink-0 text-caption font-medium text-status-seated">Tap to move here</span>
        ) : (
          <span className="inline-flex h-[22px] shrink-0 items-center gap-1 rounded-chip bg-surface-2 px-2 text-[11.5px] font-medium text-ink-2">
            <span aria-hidden className="inline-block size-2.5 rounded-full border border-current" /> {partPaid ? "Part paid" : "Unpaid"}
          </span>
        )}
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-1">
        {lines.length === 0 ? <p className="px-2 py-3 text-[14.5px] text-ink-3">Nothing on this bill yet.</p> : null}
        {lines.map((l) => {
          const inner = (
            <>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[15px] text-ink">{l.name}</span>
                {l.detail ? <span className="block truncate text-[13px] text-ink-2">{l.detail}</span> : null}
                {/* A shared line says so in words under its name, not as a chip. */}
                {l.share && l.share !== "1" ? <span className="block text-[12.5px] text-ink-2 tabular">Shared · <span className="font-medium text-ink">{l.share} share</span></span> : null}
              </span>
              <Money cents={l.amountCents} size="body" className="shrink-0 text-ink" />
            </>
          );
          const cls = cx(
            "flex w-full items-start gap-2 rounded-field px-2 py-1.5 text-left outline-none",
            l.isSelected && "bg-surface-3 shadow-[inset_0_0_0_1.5px_var(--ink)]",
            l.onPress && "press pos-touch min-h-11 transition-colors duration-[120ms] data-[pressed]:bg-surface-3 data-[hovered]:bg-surface-2 data-[disabled]:text-ink-disabled data-[focus-visible]:outline-2 data-[focus-visible]:outline-offset-[-2px] data-[focus-visible]:outline-focus",
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
      <dl className="border-t border-rule-subtle px-4 pt-2.5 pb-1">
        {rows.map((r) => (
          <div key={r.key} className={cx("flex items-center justify-between gap-2", r.kind === "total" ? "mt-1.5 min-h-9 pt-1.5 hairline-t" : "min-h-6")}>
            <dt className={cx("truncate", r.kind === "total" ? "font-heading text-line font-semibold text-ink" : "text-[13px] text-ink-2")}>{r.label}</dt>
            <dd className="shrink-0">
              <Money cents={r.cents} size={r.kind === "total" ? "heading" : "caption"} className={r.kind === "total" ? "font-heading text-ink" : "text-ink"} />
            </dd>
          </div>
        ))}
      </dl>
      {tenders?.length ? (
        <ul className="px-4 pb-2 text-[13px] text-ink-2">
          {tenders.map((t) => (
            <li key={t.id} className="flex items-center justify-between gap-2">
              <span className="truncate">{t.label}</span>
              <Money cents={t.cents} size="caption" />
            </li>
          ))}
        </ul>
      ) : null}
      {actions ? <footer className="flex flex-wrap items-center justify-end gap-2 border-t border-rule-subtle px-2.5 py-2.5">{actions}</footer> : null}
    </>
  );
  const classes = cx(
    "flex max-h-full w-[400px] shrink-0 flex-col self-start max-[1150px]:w-[340px] overflow-hidden rounded-panel border border-rule text-left max-[960px]:max-h-none max-[960px]:w-full",
    isTarget ? "border-transparent shadow-[inset_0_0_0_2px_var(--status-seated)] bg-status-seated-tint" : paid ? "bg-[color-mix(in_oklab,var(--status-paid-tint)_60%,var(--surface))]" : "bg-surface",
    className,
  );
  if (onPress) {
    return (
      <AriaButton onPress={onPress} isDisabled={isDisabled} aria-label={`${label}, move the selected line here`} className={cx(classes, "press pos-touch outline-none data-[pressed]:scale-[0.99] data-[disabled]:opacity-60 data-[focus-visible]:outline-2 data-[focus-visible]:outline-offset-2 data-[focus-visible]:outline-focus")}>
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
