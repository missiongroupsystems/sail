"use client";

import { Icon } from "@sail/ui";
import { ArrowRight } from "lucide-react";
import { Button as AriaButton } from "react-aria-components";
import { countItems } from "@/lib/format";
import { Dock } from "./Shell";

/**
 * The floating basket bar: the count in a grey filled circle, "View your order" and an arrow. It carries
 * no total, because the client never adds cents (principle 8); the review page
 * shows each item's menu price and the bill at the POS has the real total.
 */
export function BasketBar({ count, onPress }: { count: number; onPress: () => void }) {
  return (
    <Dock>
      <AriaButton
        onPress={onPress}
        aria-label={`View your order, ${countItems(count)}`}
        className="press flex h-14 w-full items-center gap-3 rounded-full bg-brand-accent pr-5 pl-2 text-[16.5px] font-semibold text-on-brand-accent outline-none select-none touch-manipulation transition-transform duration-[120ms] data-[pressed]:scale-[0.98] data-[focus-visible]:outline-2 data-[focus-visible]:outline-offset-2 data-[focus-visible]:outline-focus"
      >
        <span aria-hidden className="flex h-10 min-w-10 items-center justify-center rounded-full bg-[color-mix(in_srgb,var(--on-brand-accent)_22%,transparent)] px-2 tabular">
          {count}
        </span>
        <span className="flex-1 text-left">View your order</span>
        <Icon icon={ArrowRight} size={20} />
      </AriaButton>
    </Dock>
  );
}
