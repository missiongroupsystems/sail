import type { TaxAmount } from "@sail/shared";

/**
 * A period's tax due by component: the tax charged less the tax given back by refunds, matched on name and rate.
 * A component that appears only in the refunds (charged in an earlier period) is listed with a negative amount.
 * The register computes this so the back office shows it as returned and never subtracts on its own.
 */
export function taxDue(charged: readonly TaxAmount[], refunded: readonly TaxAmount[]): TaxAmount[] {
  const key = (t: TaxAmount) => `${t.bps}\u0000${t.name}`;
  const due = new Map<string, TaxAmount>();
  for (const t of charged) {
    const k = key(t);
    const prev = due.get(k);
    due.set(k, { name: t.name, bps: t.bps, amount: (prev?.amount ?? 0) + t.amount });
  }
  for (const t of refunded) {
    const k = key(t);
    const prev = due.get(k);
    due.set(k, { name: t.name, bps: t.bps, amount: (prev?.amount ?? 0) - t.amount });
  }
  return [...due.values()].sort((a, b) => b.bps - a.bps || a.name.localeCompare(b.name));
}
