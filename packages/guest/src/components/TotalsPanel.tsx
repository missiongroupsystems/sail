"use client";

import { Money, taxRows } from "@sail/ui";
import type { GuestTotals } from "@/lib/types";

/**
 * The table's totals on a grey panel, as the register priced the order: subtotal, each fee and discount, tax and the
 * table total. With inclusive prices the tax rows follow the total, marked "included". Nothing here is added up.
 */
export function TotalsPanel({ totals }: { totals: GuestTotals }) {
  const tax = taxRows(totals.taxes, totals.tax_mode);
  const row = (key: string, label: string, cents: number, signed = false) => (
    <div key={key} className="flex items-baseline justify-between gap-4 py-1 text-[15px]">
      <dt className="min-w-0 text-ink-2 wrap-anywhere">{label}</dt>
      <dd className="shrink-0 text-ink">
        <Money cents={cents} signed={signed} size="body" className="text-[15px] text-ink" />
      </dd>
    </div>
  );
  return (
    <section aria-label="Table total" className="rounded-sheet bg-surface-2 px-4 pt-3 pb-4">
      <dl className="flex flex-col">
        {row("subtotal", "Subtotal", totals.subtotal)}
        {totals.adjustments.map((a, i) => row(`adj:${i}`, a.name, a.total, a.total < 0))}
        {tax.before.map((t) => row(t.key, t.label, t.amount))}
        <div className="mt-2 flex items-baseline justify-between gap-4 border-t border-rule pt-3">
          <dt className="font-display text-[18px] font-semibold text-ink">Table total</dt>
          <dd className="shrink-0">
            <Money cents={totals.total} size="heading" className="font-display text-[18px] font-semibold text-ink" />
          </dd>
        </div>
        {tax.after.map((t) => row(t.key, t.label, t.amount))}
      </dl>
    </section>
  );
}
