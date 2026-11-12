import { allocateByShares, sumCents, type Cents, type Share } from "./money.js";
import type { TaxAmount } from "./pricing/schemas.js";

/**
 * Bill allocation. A line's priced components are split across
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
  // A receipt prints a bill's adjustment rows under its discount and fee, so on each bill the rows must add up to them.
  splitRows(adj, components.adjustments, discount, shares, -1);
  splitRows(adj, components.adjustments, fee, shares, 1);
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

/**
 * Re-split the adjustments of one sign (discounts −1, fees +1) so that on every bill they add up to the bill's own
 * discount (or fee) and across bills each adds up to its own amount. Each bill takes the floor of its exact share of each
 * adjustment, then the leftover cents are filled bill by bill, adjustment by adjustment, so no row changes sign. Only when
 * the adjustments account for the whole amount, as they always do for a line the engine priced.
 */
function splitRows(adj: Record<string, { amount: Cents[]; tax: Cents[] }>, source: LineComponents["adjustments"], perBill: Cents[], shares: readonly Share[], sign: 1 | -1) {
  const ids = Object.keys(source).filter((id) => Math.sign(source[id]!.amount) === sign);
  if (ids.length === 0 || sumCents(ids.map((id) => source[id]!.amount)) !== sumCents(perBill)) return;
  const den = sumCents(shares.map((x) => x.num * (shares.reduce((l, y) => lcm(l, y.den), 1) / x.den)));
  const lcmDen = shares.reduce((l, y) => lcm(l, y.den), 1);
  const weight = shares.map((x) => x.num * (lcmDen / x.den));
  const cells = ids.map((id) => weight.map((w) => (den === 0 ? 0 : Math.floor((Math.abs(source[id]!.amount) * w) / den))));
  const rowNeed = perBill.map((d, i) => Math.abs(d) - sumCents(cells.map((c) => c[i]!)));
  const colNeed = ids.map((id, k) => Math.abs(source[id]!.amount) - sumCents(cells[k]!));
  for (let i = 0, k = 0; i < perBill.length && k < ids.length; ) {
    const give = Math.min(rowNeed[i]!, colNeed[k]!);
    cells[k]![i]! += give;
    rowNeed[i]! -= give;
    colNeed[k]! -= give;
    if (rowNeed[i] === 0) i++;
    else k++;
  }
  ids.forEach((id, k) => (adj[id]!.amount = cells[k]!.map((v) => sign * v || 0)));
}

function lcm(a: number, b: number): number {
  let x = a;
  let y = b;
  while (y) [x, y] = [y, x % y];
  return (a / x) * b;
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
