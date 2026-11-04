"use client";

import { Plus } from "lucide-react";
import { Button as AriaButton } from "react-aria-components";
import { cx } from "../lib/cx";
import { Icon } from "../components/Icon";
import { Money } from "../components/Money";

export type MenuItemState =
  /** Tapping opens the item sheet. */
  | "orderable"
  /** The table cannot order yet: the row is read-only (design 4.11). */
  | "browse"
  | "sold_out"
  | "unavailable";

export type MenuItemRowProps = {
  name: string;
  /** One line; longer text is clamped to two lines. */
  description?: string | null;
  /** Menu price in cents from the register. */
  price: number;
  state: MenuItemState;
  /** The register's reason when unavailable ("Lunch only, 11:30 am to 2:30 pm"). */
  reason?: string | null;
  /** "2 left today" when a daily cap is nearly reached. */
  note?: string | null;
  /** How many of this item are already in the basket. */
  inBasket?: number;
  onPress?: () => void;
  className?: string;
};

const shell = "flex w-full items-start gap-4 py-4 text-left hairline-b";

/**
 * A typography-led menu item (design 4.11): name, price, one-line description
 * and a 48px "+" when the table can order. Sold-out items stay listed, greyed,
 * with the word "Sold out" where the price was.
 */
export function MenuItemRow({ name, description, price, state, reason, note, inBasket, onPress, className }: MenuItemRowProps) {
  const dim = state === "sold_out" || state === "unavailable";
  const body = (
    <>
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="flex items-baseline justify-between gap-3">
          <span className={cx("font-display text-line text-ink", dim && "text-ink-2")}>{name}</span>
          {state === "sold_out" ? <span className="shrink-0 text-body text-ink-2">Sold out</span> : <Money cents={price} size="body" className={dim ? "text-ink-2" : "text-ink"} />}
        </span>
        {description ? <span className={cx("line-clamp-2 text-body text-ink-2", dim && "opacity-70")}>{description}</span> : null}
        {state === "unavailable" && reason ? <span className="text-caption text-ink-2">{reason}</span> : null}
        {note && !dim ? <span className="text-caption text-status-sent">{note}</span> : null}
      </span>
      {state === "orderable" ? (
        <span aria-hidden className={cx("relative mt-0.5 inline-flex size-12 shrink-0 items-center justify-center rounded-full hairline text-brand-accent group-data-[pressed]:bg-surface-2", inBasket && "border-brand-accent bg-brand-accent text-on-brand-accent")}>
          <Icon icon={Plus} size={22} strokeWidth={2.25} />
          {inBasket ? <span className="absolute -right-1 -top-1 min-w-5 rounded-full bg-ink px-1 text-center text-caption tabular text-surface">{inBasket}</span> : null}
        </span>
      ) : null}
    </>
  );

  if (state === "orderable" && onPress) {
    return (
      <AriaButton
        onPress={onPress}
        aria-label={`${name}${inBasket ? `, ${inBasket} in your order` : ""}`}
        className={cx("group press cursor-default rounded-none outline-none touch-manipulation data-[pressed]:bg-surface-2 data-[focus-visible]:outline-2 data-[focus-visible]:-outline-offset-2 data-[focus-visible]:outline-status-seated", shell, className)}
      >
        {body}
      </AriaButton>
    );
  }
  return (
    <div className={cx(shell, className)} aria-disabled={dim || undefined}>
      {body}
    </div>
  );
}
