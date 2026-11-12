"use client";

import { BrandButton } from "@sail/ui";
import { countItems } from "@/lib/format";

/**
 * The sticky basket bar: "Review 3 items". It carries no total,
 * because the client never adds cents (principle 8); the review page shows
 * each item's menu price and the bill at the POS has the real total.
 */
export function BasketBar({ count, onPress }: { count: number; onPress: () => void }) {
  return (
    <div className="fixed inset-x-0 bottom-0 z-30 flex justify-center px-4 pb-[max(12px,env(safe-area-inset-bottom))] pt-2 pointer-events-none">
      <BrandButton variant="accent" block onPress={onPress} className="pointer-events-auto min-h-14 max-w-[528px] shadow-sheet">
        Review {countItems(count)}
      </BrandButton>
    </div>
  );
}
