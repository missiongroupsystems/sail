import { allocateByShares, sumCents, type Cents, type Share } from "./money.js";
import type { TaxAmount } from "./pricing/schemas.js";

/**
 * Bill allocation (scope doc 4.4). A line's priced components are split across
 * checks by equal shares with the largest-remainder allocator; each component
 * is allocated on its own (each tax component too) and a check's total is the
 * sum of its allocated components, so the checks always add up to the order to
 * the cent.
 */
export type LineComponents = {
  base: Cents;
  /** Signed (negative or zero). */
  discount: Cents;
  fee: Cents;
  /** The line's tax by component; the line's tax is their sum. */
  taxes: TaxAmount[];
  /** Per-adjustment amounts attached to this line: { [adjustment_id]: { amount, tax } } */
  adjustments: Record<string, { amount: Cents; tax: Cents }>;
};

export type AllocatedComponents = LineComponents & { tax: Cents; total: Cents; share: Share };

/**
 * Allocate one line across checks. `shares[i]` is check i's share of the line;
 * shares with num 0 receive nothing. Ties go to earlier checks (check order).
 * In exclusive tax mode `total = base + discount + fee + tax`; in inclusive mode
 * the caller passes `taxAddsToTotal: false` and `total = base + discount + fee`.
 */
export function allocateLine(components: LineComponents, shares: readonly Share[], opts: { taxAddsToTotal: boolean }): AllocatedComponents[] {
  const base = allocateByShares(components.base, shares);
  const discount = allocateByShares(components.discount, shares);
  const fee = allocateByShares(components.fee, shares);
  const taxes = components.taxes.map((t) => allocateByShares(t.amount, shares));
  const adj: Record<string, { amount: Cents[]; tax: Cents[] }> = {};
  for (const [id, a] of Object.entries(components.adjustments)) adj[id] = { amount: allocateByShares(a.amount, shares), tax: allocateByShares(a.tax, shares) };
  return shares.map((share, i) => {
    const adjustments: Record<string, { amount: Cents; tax: Cents }> = {};
    for (const [id, a] of Object.entries(adj)) adjustments[id] = { amount: a.amount[i]!, tax: a.tax[i]! };
    const b = base[i]!;
    const d = discount[i]!;
    const f = fee[i]!;
    const mine = components.taxes.map((t, k) => ({ name: t.name, bps: t.bps, amount: taxes[k]![i]! }));
    const t = sumCents(mine.map((x) => x.amount));
    return { base: b, discount: d, fee: f, tax: t, taxes: mine, adjustments, total: b + d + f + (opts.taxAddsToTotal ? t : 0), share };
  });
}

/** Add tax amounts up by component (name and rate), in first-seen order. */
export function sumTaxes(lists: readonly (readonly TaxAmount[])[]): TaxAmount[] {
  const byKey = new Map<string, TaxAmount>();
  for (const list of lists) {
    for (const t of list) {
      const key = `${t.bps}|${t.name}`;
      const cur = byKey.get(key) ?? { name: t.name, bps: t.bps, amount: 0 };
      cur.amount += t.amount;
      byKey.set(key, cur);
    }
  }
  return [...byKey.values()];
}

/** N equal shares (even split). */
export function evenShares(n: number): Share[] {
  if (!Number.isInteger(n) || n < 1) throw new RangeError("n must be a positive integer");
  return Array.from({ length: n }, () => ({ num: 1, den: n }));
}

/** Shares for `n` checks where only `indices` take part equally (a bottle shared by checks 1 and 3). */
export function sharedAmong(n: number, indices: readonly number[]): Share[] {
  const set = new Set(indices);
  if (set.size === 0) throw new RangeError("at least one check must take the line");
  for (const i of set) if (i < 0 || i >= n) throw new RangeError(`check index ${i} out of range`);
  return Array.from({ length: n }, (_, i) => (set.has(i) ? { num: 1, den: set.size } : { num: 0, den: 1 }));
}

/** Shares placing the whole line on one check. */
export function wholeTo(n: number, index: number): Share[] {
  return sharedAmong(n, [index]);
}

/** Sum of check totals equals the order total: a helper for tests and invariants. */
export function sumAllocations(parts: readonly AllocatedComponents[]): Cents {
  return sumCents(parts.map((p) => p.total));
}
