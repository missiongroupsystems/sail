import { allocateByShares, allocateLargestRemainder, sumCents, type Cents, type Share } from "./money.js";
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

/** One bill's allocation of one line, as `rebalanceBillTax` reads and adjusts it. */
export type TaxRow = { check: number; lineId: string; shareNum: number; shareDen: number; taxes: TaxAmount[]; tax: Cents; total: Cents };

const taxKey = (t: { name: string; bps: number }) => `${t.bps}|${t.name}`;

/**
 * Split bills under per-rate rounding: each bill's tax for a rate component is made the order's tax for that component
 * spread across the bills by largest remainder, weighted by each bill's taxable amount, so a bill's tax row is its own
 * rate times its own subtotal to within the one cent the order's single rounding leaves (the order's tax always wins and
 * stays exact). Cents move between bills on a line the bills share, else between two whole lines of the same rate on
 * the two bills (each keeps its total across bills; only lines in `movable` when given). Mutates `rows`; returns the per-line tax change by component key.
 * `taxables[lineId][key]` is the line's taxable amount for that component.
 */
export function rebalanceBillTax(rows: TaxRow[], taxables: Record<string, Record<string, number>>, opts: { taxAddsToTotal: boolean; movable?: ReadonlySet<string> }): Map<string, Map<string, number>> {
  const lineDelta = new Map<string, Map<string, number>>();
  const checksSeen = [...new Set(rows.map((r) => r.check))].sort((a, b) => a - b);
  if (checksSeen.length < 2) return lineDelta;
  const keys = [...new Set(rows.flatMap((r) => r.taxes.map(taxKey)))];
  const amountOf = (r: TaxRow, k: string) => r.taxes.find((t) => taxKey(t) === k)?.amount ?? 0;
  const bump = (r: TaxRow, k: string, d: number) => {
    const t = r.taxes.find((x) => taxKey(x) === k);
    if (!t) return false;
    t.amount += d;
    r.tax += d;
    if (opts.taxAddsToTotal) r.total += d;
    return true;
  };
  for (const k of keys) {
    const current = checksSeen.map((c) => sumCents(rows.filter((r) => r.check === c).map((r) => amountOf(r, k))));
    const weights = checksSeen.map((c) => rows.filter((r) => r.check === c).reduce((s, r) => s + ((taxables[r.lineId]?.[k] ?? 0) * r.shareNum) / r.shareDen, 0));
    const total = sumCents(current);
    if (total <= 0 || weights.some((w) => w < 0) || weights.every((w) => w === 0)) continue;
    const target = allocateLargestRemainder(total, weights);
    const delta = checksSeen.map((_, i) => target[i]! - current[i]!);
    for (let guard = 0; guard < 10_000; guard++) {
      const from = delta.findIndex((d) => d < 0);
      const to = delta.findIndex((d) => d > 0);
      if (from < 0 || to < 0) break;
      const cf = checksSeen[from]!;
      const ct = checksSeen[to]!;
      // A line on both bills: move the cent between its two allocations; the line's own tax is unchanged.
      const shared = rows.find((r) => r.check === cf && amountOf(r, k) > 0 && rows.some((x) => x.check === ct && x.lineId === r.lineId && x.taxes.some((t) => taxKey(t) === k)));
      if (shared) {
        const other = rows.find((x) => x.check === ct && x.lineId === shared.lineId)!;
        bump(shared, k, -1);
        bump(other, k, 1);
      } else {
        // Two whole lines of the same rate: one gives a cent of its tax to the other, so the order's tax is unchanged.
        // Only a line whose tax is all on its own amount (no fee carrying tax of its own) gives or takes a cent.
        const whole = (r: TaxRow) => r.shareNum === r.shareDen && r.taxes.some((t) => taxKey(t) === k) && (opts.movable?.has(r.lineId) ?? true);
        const giver = rows.find((r) => r.check === cf && whole(r) && amountOf(r, k) > 0);
        const taker = rows.find((r) => r.check === ct && whole(r));
        if (!giver || !taker) break;
        bump(giver, k, -1);
        bump(taker, k, 1);
        for (const [id, d] of [[giver.lineId, -1], [taker.lineId, 1]] as const) {
          const m = lineDelta.get(id) ?? new Map<string, number>();
          m.set(k, (m.get(k) ?? 0) + d);
          lineDelta.set(id, m);
        }
      }
      delta[from]! += 1;
      delta[to]! -= 1;
    }
  }
  return lineDelta;
}
