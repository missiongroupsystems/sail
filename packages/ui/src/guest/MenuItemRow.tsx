"use client";

import { Plus } from "lucide-react";
import { Button as AriaButton } from "react-aria-components";
import { cx } from "../lib/cx";
import { Icon } from "../components/Icon";
import { Money } from "../components/Money";
import { useLocale } from "../lib/locale";

export type MenuItemState =
  /** Tapping opens the item sheet. */
  | "orderable"
  /** The table cannot order yet: the row is read-only. */
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

const shell = "flex min-h-[68px] w-full items-center gap-3 px-4 py-3 text-left";

/**
 * A typography-led menu item: name, one-line description and price, and a 44px
 * add control when the table can order (it carries the count once the item is in
 * the order). Sold-out items stay listed, greyed, with "Sold out" in place of the
 * price. The parent draws the hairline between rows.
 */
export function MenuItemRow({ name, description, price, state, reason, note, inBasket, onPress, className }: MenuItemRowProps) {
  const { money } = useLocale();
  const dim = state === "sold_out" || state === "unavailable";
  const body = (
    <>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className={cx("font-display text-[16px] leading-snug font-medium break-words", dim ? "text-ink-3" : "text-ink")}>{name}</span>
        {description ? <span className="line-clamp-2 text-[13.5px] leading-snug text-ink-3">{description}</span> : null}
        {state === "unavailable" && reason ? <span className="text-caption text-ink-3">{reason}</span> : null}
        {note && !dim ? <span className="text-caption font-medium text-status-sent">{note}</span> : null}
        {state === "sold_out" ? null : <Money cents={price} size="body" className={cx("mt-0.5 text-[15px]", dim ? "text-ink-3" : "text-ink-2")} />}
      </span>
      {state === "sold_out" ? <span className="shrink-0 rounded-chip bg-surface-2 px-3 py-1.5 text-[12.5px] font-medium text-ink-2">Sold out</span> : null}
      {state === "orderable" ? (
        inBasket ? (
          <span aria-hidden className="flex size-11 shrink-0 items-center justify-center rounded-full bg-brand-accent text-[16px] font-semibold tabular text-on-brand-accent">
            {inBasket}
          </span>
        ) : (
          <span aria-hidden className="flex size-11 shrink-0 items-center justify-center rounded-full bg-surface-2 text-ink transition-colors duration-[120ms] group-data-[pressed]:bg-surface-3">
            <Icon icon={Plus} size={20} strokeWidth={2} />
          </span>
        )
      ) : null}
    </>
  );

  if (state === "orderable" && onPress) {
    // The name replaces the row's content for screen readers, so it carries the price (the badge is a bare number).
    return (
      <AriaButton
        onPress={onPress}
        aria-label={`${name}, ${money(price)}${inBasket ? `, ${inBasket} in your order` : ""}`}
        aria-description={description ?? undefined}
        className={cx("group cursor-default rounded-none outline-none touch-manipulation transition-colors duration-[120ms] data-[pressed]:bg-surface-2 data-[focus-visible]:outline-2 data-[focus-visible]:-outline-offset-2 data-[focus-visible]:outline-focus", shell, className)}
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
