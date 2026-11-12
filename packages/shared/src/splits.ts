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
 * Odd cents per check so far, against each check's exact share: what `allocateLine` uses to hand out the next odd cent.
 * Pass one array (one entry per check, starting at 0) for every line of a split, so the odd cents of all the lines
 * are spread across the bills instead of all landing on the first one.
 */
export type SplitBalance = number[];

/** Largest remainder with ties going to the checks in `order` first. */
function allocateInOrder(total: Cents, shares: readonly Share[], order: readonly number[]): Cents[] {
  const parts = allocateByShares(total, order.map((i) => shares[i]!));
  const out: Cents[] = new Array<Cents>(shares.length);
  order.forEach((i, k) => (out[i] = parts[k]!));
  return out;
}

/** Who takes an odd cent first: of a positive amount the check that is furthest under its share, of a negative amount the one furthest over; then check order. */
function tieOrder(balance: SplitBalance, amount: Cents): number[] {
  // Balances are sums of fractions of a cent: a gap below a millionth is rounding noise, and check order decides.
  const gap = (x: number) => (Math.abs(x) < 1e-6 ? 0 : x);
  return balance.map((_, i) => i).sort((a, b) => gap(amount < 0 ? balance[b]! - balance[a]! : balance[a]! - balance[b]!) || a - b);
}

/**
 * Allocate one line across checks. `shares[i]` is check i's share of the line;
 * shares with num 0 receive nothing. An odd cent goes to the check that has had the
 * fewest so far (`opts.balance`, carried across the lines of one split; a fresh one per
 * line when omitted), then to the earlier check, so an even split's bills differ by at
 * most a cent rather than by a cent per line.
 * In exclusive tax mode `total = base + discount + fee + tax`; in inclusive mode
 * the caller passes `taxAddsToTotal: false` and `total = base + discount + fee`.
 */
export function allocateLine(components: LineComponents, shares: readonly Share[], opts: { taxAddsToTotal: boolean; balance?: SplitBalance }): AllocatedComponents[] {
  const balance = opts.balance ?? shares.map(() => 0);
  /** One component across the checks; `counts` when it is part of the bill's total, so the balance follows the totals. */
  const split = (amount: Cents, counts: boolean) => {
    const order = tieOrder(balance, amount);
    const parts = allocateInOrder(amount, shares, order);
    if (counts) shares.forEach((s, i) => (balance[i] = balance[i]! + parts[i]! - (amount * s.num) / s.den));
    return { parts, order };
  };
  const b0 = split(components.base, true);
  const d0 = split(components.discount, true);
  const f0 = split(components.fee, true);
  const t0 = components.taxes.map((t) => split(t.amount, opts.taxAddsToTotal));
  const base = b0.parts;
  const discount = d0.parts;
  const fee = f0.parts;
  const taxes = t0.map((t) => t.parts);
  // An adjustment's share follows the component it is part of (a fee or a discount, and its tax), so a bill's adjustments match its fee and discount.
  const taxOrder = t0[0]?.order ?? f0.order;
  const adj: Record<string, { amount: Cents[]; tax: Cents[] }> = {};
  for (const [id, a] of Object.entries(components.adjustments)) adj[id] = { amount: allocateInOrder(a.amount, shares, a.amount < 0 ? d0.order : f0.order), tax: allocateInOrder(a.tax, shares, taxOrder) };
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
