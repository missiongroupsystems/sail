"use client";

import { cx } from "../lib/cx";
import { useLocale } from "../lib/locale";

export type MoneyProps = {
  /** Show "+" on positive amounts (deltas). */
  signed?: boolean;
  /** Integer minor units from the API, in the merchant's currency. This component never adds, subtracts or rounds. */
  cents: number;
  className?: string;
  /** Type style: `body` (default), `line`, `title`, or `amount-xl` for balances. */
  size?: "caption" | "body" | "line" | "heading" | "title" | "amount-xl" | "display";
  /** Dim the figure while the register is repricing (7.8 pricing state). */
  pending?: boolean;
};

const sizeClass: Record<NonNullable<MoneyProps["size"]>, string> = {
  caption: "text-caption",
  body: "text-body",
  line: "text-line",
  heading: "text-heading",
  title: "text-title",
  "amount-xl": "text-amount-xl",
  display: "text-display",
};

export function Money({ cents, className, size = "body", pending, signed }: MoneyProps) {
  const text = useLocale().money(cents, { signed });
  return (
    <span
      className={cx("tabular whitespace-nowrap", sizeClass[size], pending && "opacity-60", className)}
      aria-busy={pending || undefined}
    >
      {text}
    </span>
  );
}
