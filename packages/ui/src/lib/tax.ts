/** One tax component as the register reports it: `name` is the whole label ("VAT 20%", "State sales tax"). */
export type TaxAmountLike = { name: string; bps: number; amount: number };

export type TaxRow = { key: string; label: string; amount: number };

/**
 * Tax rows in the register's order (pricing semantics §8): with exclusive prices each component is a row before the
 * total; with inclusive prices each is a row after it, labelled "<name> (included)". The rate is never added to the name.
 */
export function taxRows(taxes: readonly TaxAmountLike[], taxMode: string): { before: TaxRow[]; after: TaxRow[] } {
  const inclusive = taxMode === "inclusive";
  const rows = sortTaxes(taxes).map((t, i) => ({ key: `tax:${i}:${t.name}`, label: inclusive ? `${t.name} (included)` : t.name, amount: t.amount }));
  return inclusive ? { before: [], after: rows } : { before: rows, after: [] };
}

/**
 * One order for tax components on every screen and receipt: the lowest rate first, then by name. A bill and its
 * order list the same rates in whatever order the register met them, so the pay sheet and the order panel differed
 * (live-test C-8). The printed receipt sorts the same way (shared/escpos templates).
 */
export function sortTaxes<T extends TaxAmountLike>(taxes: readonly T[]): T[] {
  return [...taxes].sort((a, b) => a.bps - b.bps || a.name.localeCompare(b.name));
}
