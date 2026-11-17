"use client";

import { Icon, Money, useLocale } from "@sail/ui";
import { ArrowRight } from "lucide-react";
import { Button as AriaButton } from "react-aria-components";
import { countItems } from "@/lib/format";
import { Dock } from "./Shell";
import type { Quote } from "./useQuote";

/**
 * The floating basket bar: the count in a grey filled circle, "View your order", the basket's total and an arrow.
 * The total is the register's quote for the basket (final review C-6); the phone never adds cents. While the
 * basket changes, the last total stays, dimmed, until the new one arrives.
 */
export function BasketBar({ count, quote, onPress }: { count: number; quote?: Quote; onPress: () => void }) {
  const { money } = useLocale();
  const total = quote?.quote?.total ?? null;
  return (
    <Dock>
      <AriaButton
        onPress={onPress}
        aria-label={`View your order, ${countItems(count)}${total != null && !quote?.updating ? `, ${money(total)}` : ""}`}
        className="press flex h-14 w-full items-center gap-3 rounded-full bg-brand-accent pr-5 pl-2 text-[16.5px] font-semibold text-on-brand-accent outline-none select-none touch-manipulation transition-transform duration-[120ms] data-[pressed]:scale-[0.98] data-[focus-visible]:outline-2 data-[focus-visible]:outline-offset-2 data-[focus-visible]:outline-focus"
      >
        <span aria-hidden className="flex h-10 min-w-10 items-center justify-center rounded-full bg-[color-mix(in_srgb,var(--on-brand-accent)_22%,transparent)] px-2 tabular">
          {count}
        </span>
        <span className="flex-1 text-left">View your order</span>
        {total != null ? <Money cents={total} pending={quote?.updating} className="text-[16.5px] font-semibold text-on-brand-accent" /> : null}
        <Icon icon={ArrowRight} size={20} />
      </AriaButton>
    </Dock>
  );
}
