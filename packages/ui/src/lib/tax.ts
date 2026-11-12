/** One tax component as the register reports it: `name` is the whole label ("VAT 20%", "State sales tax"). */
export type TaxAmountLike = { name: string; bps: number; amount: number };

export type TaxRow = { key: string; label: string; amount: number };

/**
 * Tax rows in the register's order (pricing semantics §8): with exclusive prices each component is a row before the
 * total; with inclusive prices each is a row after it, labelled "<name> (included)". The rate is never added to the name.
 */
export function taxRows(taxes: readonly TaxAmountLike[], taxMode: string): { before: TaxRow[]; after: TaxRow[] } {
  const inclusive = taxMode === "inclusive";
  const rows = taxes.map((t, i) => ({ key: `tax:${i}:${t.name}`, label: inclusive ? `${t.name} (included)` : t.name, amount: t.amount }));
  return inclusive ? { before: [], after: rows } : { before: rows, after: [] };
}
