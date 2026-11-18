import { allocateByShares, sumCents, type Cents, type Share } from "./money.js";
import type { TaxAmount } from "./pricing/schemas.js";
import { componentTax } from "./pricing/engine.js";

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

/** One amount on a bill that carries tax, with its rate: a line's net share, or its share of one taxed fee. */
export type BillTaxItem = { components: readonly { name: string; bps: number }[]; amount: Cents };

/**
 * A bill's own tax by component: its items grouped by rate, each component rounded once on the group's total, as the
 * engine rounds the order (a fee taxed at another rate than its line is in that rate's group). `exact` is the unrounded
 * figure. Keyed by `bps|name`.
 */
export function ownBillTax(items: readonly BillTaxItem[], taxMode: "inclusive" | "exclusive"): Map<string, { own: Cents; exact: number }> {
  const groups = new Map<string, { components: BillTaxItem["components"]; amount: Cents }>();
  for (const i of items) {
    if (i.components.length === 0) continue;
    const g = i.components.map(taxKey).join("+");
    const cur = groups.get(g) ?? { components: i.components, amount: 0 };
    cur.amount += i.amount;
    groups.set(g, cur);
  }
  const out = new Map<string, { own: Cents; exact: number }>();
  for (const g of groups.values()) {
    const combined = sumCents(g.components.map((c) => c.bps));
    const own = componentTax(g.amount, g.components, taxMode);
    g.components.forEach((c, k) => {
      const cur = out.get(taxKey(c)) ?? { own: 0, exact: 0 };
      cur.own += own[k]!;
      cur.exact += (g.amount * c.bps) / (taxMode === "inclusive" ? 10_000 + combined : 10_000);
      out.set(taxKey(c), cur);
    });
  }
  return out;
}

/** One taxed amount on a line: its own amount (`net`) or one fee (its adjustment id), with its rate and its tax now. */
export type TaxSlot = { id: string; group: string; tax: Cents };
export type RebalanceOptions = { taxAddsToTotal: boolean; taxMode: "inclusive" | "exclusive"; items: (check: number) => BillTaxItem[]; slots?: (lineId: string) => TaxSlot[] };
/** Tax cents moved between whole lines: by line and component key, and by line and taxed amount (`TaxSlot.id`). */
export type TaxMoves = { lines: Map<string, Map<string, number>>; slots: Map<string, Map<string, number>> };

/**
 * Split bills under per-rate rounding (review 5, V1). For each tax component, every bill starts from its own rounding
 * (`ownBillTax` of its items). When the bills' own roundings add up to the order's tax for that component, that is
 * each bill's tax and no rounding cent is needed. Otherwise the order's tax wins and the difference, the fewest cents,
 * goes to as many bills: with tax on top, to the bills whose totals are furthest under (or over) their exact share, so
 * an even split stays even (review 5, V2); then to the bill whose own figure is furthest from its exact one; then by
 * bill order. Nothing here depends on ids.
 * Cents move between bills on a line the bills share (the line's tax is unchanged), else between two whole lines, from
 * one of the giver's taxed amounts (`slots`) to the same kind on the taker: two own amounts at the same rate, or the same
 * fee; the order's tax per component never changes, nor does any fee's tax or any rate's tax on items.
 * Mutates `rows`; returns the per-line tax change by component key.
 */
export function rebalanceBillTax(rows: TaxRow[], opts: RebalanceOptions): TaxMoves {
  const lineDelta = new Map<string, Map<string, number>>();
  const slotDelta = new Map<string, Map<string, number>>();
  const checksSeen = [...new Set(rows.map((r) => r.check))].sort((a, b) => a - b);
  if (checksSeen.length < 2) return { lines: lineDelta, slots: slotDelta };
  const keys = [...new Set(rows.flatMap((r) => r.taxes.map(taxKey)))].sort();
  const amountOf = (r: TaxRow, k: string) => r.taxes.find((t) => taxKey(t) === k)?.amount ?? 0;
  const bump = (r: TaxRow, k: string, d: number) => {
    const t = r.taxes.find((x) => taxKey(x) === k)!;
    t.amount += d;
    r.tax += d;
    if (opts.taxAddsToTotal) r.total += d;
  };
  const own = checksSeen.map((c) => ownBillTax(opts.items(c), opts.taxMode));
  // What each whole line can still give from each of its taxed amounts (unbounded when the caller does not say).
  const slotLeft = new Map<string, TaxSlot[]>();
  for (const r of rows) if (!slotLeft.has(r.lineId)) slotLeft.set(r.lineId, opts.slots ? opts.slots(r.lineId).map((x) => ({ ...x })) : [{ id: "net", group: r.taxes.map(taxKey).join("+"), tax: Number.POSITIVE_INFINITY }]);
  const lineOrder = [...new Set(rows.map((r) => r.lineId))];
  // Each component starts from the bills' own roundings; the components whose own roundings do not add up to the order
  // then get their difference, decided with every component's figure in view.
  type Plan = { k: string; current: Cents[]; target: Cents[]; diff: number };
  const plans: Plan[] = [];
  for (const k of keys) {
    const current = checksSeen.map((c) => sumCents(rows.filter((r) => r.check === c).map((r) => amountOf(r, k))));
    const total = sumCents(current);
    if (total <= 0) continue;
    const target = checksSeen.map((_, i) => own[i]!.get(k)?.own ?? 0);
    if (target.some((t) => t < 0)) continue;
    plans.push({ k, current, target, diff: total - sumCents(target) });
  }
  // With tax on top, each bill's distance from its exact share of the order once every planned component has its target.
  const lean = checksSeen.map(() => 0);
  if (opts.taxAddsToTotal) {
    const planned = new Set(plans.map((p) => p.k));
    const lineTotal = new Map<string, number>();
    for (const r of rows) lineTotal.set(r.lineId, (lineTotal.get(r.lineId) ?? 0) + r.total);
    checksSeen.forEach((c, i) => {
      for (const r of rows.filter((x) => x.check === c)) lean[i]! += r.total - r.taxes.filter((t) => planned.has(taxKey(t))).reduce((n, t) => n + t.amount, 0) - (lineTotal.get(r.lineId)! * r.shareNum) / r.shareDen;
    });
    for (const p of plans) p.target.forEach((t, i) => (lean[i]! += t));
  }
  const gap = (x: number) => (Math.abs(x) < 1e-6 ? 0 : x);
  for (const { k, target } of plans) {
    const p = plans.find((x) => x.k === k)!;
    const eligible = checksSeen.map((c, i) => (own[i]!.get(k)?.exact ?? 0) > 0 || rows.some((r) => r.check === c && r.taxes.some((t) => taxKey(t) === k)));
    for (let guard = 0; p.diff !== 0 && guard < 10_000; guard++) {
      const sign = p.diff > 0 ? 1 : -1;
      const pick = checksSeen
        .map((_, i) => i)
        .filter((i) => eligible[i] && target[i]! + sign >= 0)
        .sort((a, b) => (opts.taxAddsToTotal ? gap(sign * (lean[a]! - lean[b]!)) : 0) || gap(sign * ((own[b]!.get(k)?.exact ?? 0) - target[b]! - ((own[a]!.get(k)?.exact ?? 0) - target[a]!))) || a - b)[0];
      if (pick === undefined) break;
      target[pick]! += sign;
      lean[pick]! += sign;
      p.diff -= sign;
    }
  }
  for (const { k, current, target } of plans) {
    const delta = checksSeen.map((_, i) => target[i]! - current[i]!);
    // One cent at a time, from a bill with a cent too many; when one such bill cannot give, the next is tried.
    const step = (from: number): boolean => {
      const cf = checksSeen[from]!;
      // A bill short of its target that shares a line with this one, else any bill short of its target.
      const takers = checksSeen.map((_, i) => i).filter((i) => delta[i]! > 0);
      if (!takers.length) return false;
      let done = false;
      // A line on both bills: move the cent between its two allocations, from the larger share; the line's tax is unchanged.
      let best: { r: TaxRow; x: TaxRow; to: number } | undefined;
      for (const to of takers) {
        for (const r of rows) {
          if (r.check !== cf || amountOf(r, k) <= 0) continue;
          const x = rows.find((y) => y.check === checksSeen[to] && y.lineId === r.lineId && y.taxes.some((t) => taxKey(t) === k));
          if (!x) continue;
          if (!best || amountOf(r, k) - amountOf(x, k) > amountOf(best.r, k) - amountOf(best.x, k)) best = { r, x, to };
        }
      }
      if (best) {
        bump(best.r, k, -1);
        bump(best.x, k, 1);
        delta[from]! += 1;
        delta[best.to]! -= 1;
        done = true;
      } else {
        // Two whole lines: one gives a cent of its tax to the other, from one amount to another taxed at the same rate in
        // the same way (two lines' own amounts at that rate, or the same fee on both lines), so the order's tax, each
        // rate's tax on items and each fee's tax are unchanged.
        const whole = (r: TaxRow) => r.shareNum === r.shareDen && r.taxes.some((t) => taxKey(t) === k);
        const slotsOf = (r: TaxRow) => (slotLeft.get(r.lineId) ?? []).filter((x) => x.group.split("+").includes(k));
        const givers = rows.filter((r) => r.check === cf && whole(r) && amountOf(r, k) > 0).sort((a, b) => lineOrder.indexOf(a.lineId) - lineOrder.indexOf(b.lineId));
        outer: for (const giver of givers) {
          for (const gs of slotsOf(giver).filter((x) => x.tax > 0)) {
            for (const to of takers) {
              const taker = rows.find((r) => r.check === checksSeen[to] && whole(r) && slotsOf(r).some((x) => x.id === gs.id && x.group === gs.group));
              if (!taker) continue;
              const ts = slotsOf(taker).find((x) => x.id === gs.id && x.group === gs.group)!;
              bump(giver, k, -1);
              bump(taker, k, 1);
              gs.tax -= 1;
              ts.tax += 1;
              for (const [id, d] of [[giver.lineId, -1], [taker.lineId, 1]] as const) {
                const m = lineDelta.get(id) ?? new Map<string, number>();
                m.set(k, (m.get(k) ?? 0) + d);
                lineDelta.set(id, m);
                const sm = slotDelta.get(id) ?? new Map<string, number>();
                sm.set(gs.id, (sm.get(gs.id) ?? 0) + d);
                slotDelta.set(id, sm);
              }
              delta[from]! += 1;
              delta[to]! -= 1;
              done = true;
              break outer;
            }
          }
        }
      }
      return done;
    };
    for (let guard = 0; guard < 100_000; guard++) {
      const givers = checksSeen.map((_, i) => i).filter((i) => delta[i]! < 0);
      if (!givers.length || !givers.some((from) => step(from))) break;
    }
  }
  return { lines: lineDelta, slots: slotDelta };
}

/** One bill's allocation of one line with its base, as `balanceBillTotals` moves it. */
export type BaseRow = TaxRow & { base: Cents; discount?: Cents };

/**
 * Even out split bills' totals (review 4, T4). Each line's cents are allocated on their own, and the per-rate tax
 * rebalance moves tax cents after that, so the odd cents could pile up on the same bills ($40.80 five ways came to $8.14
 * to $8.18). Here a cent of base moves, on a line two bills share, from the bill furthest over its exact share of the
 * order to the one furthest under, until no two bills are more than a cent apart from their exact shares. A line's
 * allocations still add up to the line and no tax moves, so the order's tax per rate is untouched. A move that keeps both
 * allocations within a cent of their own exact share is taken first. Mutates `rows`; returns the number of cents moved.
 */
export function balanceBillTotals(rows: BaseRow[]): number {
  const checksSeen = [...new Set(rows.map((r) => r.check))].sort((a, b) => a - b);
  if (checksSeen.length < 2) return 0;
  const lineTotal = new Map<string, number>();
  const lineBase = new Map<string, number>();
  for (const r of rows) {
    lineTotal.set(r.lineId, (lineTotal.get(r.lineId) ?? 0) + r.total);
    lineBase.set(r.lineId, (lineBase.get(r.lineId) ?? 0) + r.base);
  }
  const exact = (r: BaseRow, of: Map<string, number>) => ((of.get(r.lineId) ?? 0) * r.shareNum) / r.shareDen;
  const dev = new Map<number, number>(checksSeen.map((c) => [c, 0]));
  for (const r of rows) dev.set(r.check, dev.get(r.check)! + r.total - exact(r, lineTotal));
  const eps = 1e-9;
  let moved = 0;
  for (let guard = 0; guard < 100_000; guard++) {
    const byDev = [...checksSeen].sort((a, b) => dev.get(b)! - dev.get(a)! || a - b);
    let done = true;
    // The furthest-over bill gives to the furthest-under one it shares a line with.
    outer: for (const from of byDev) {
      for (const to of [...byDev].reverse()) {
        if (dev.get(from)! - dev.get(to)! <= 1 + eps) break;
        // The giver keeps base + discount at zero or above, so no allocation's amount turns negative.
        const candidates = rows.filter((r) => r.check === from && r.base > 0 && r.base + (r.discount ?? 0) > 0 && rows.some((x) => x.check === to && x.lineId === r.lineId));
        if (!candidates.length) continue;
        const pair = (r: BaseRow) => rows.find((x) => x.check === to && x.lineId === r.lineId)!;
        const within = (r: BaseRow) => r.base - 1 - exact(r, lineBase) > -1 + eps && pair(r).base + 1 - exact(pair(r), lineBase) < 1 - eps;
        const giver = candidates.find(within) ?? candidates[0]!;
        const taker = pair(giver);
        giver.base -= 1;
        giver.total -= 1;
        taker.base += 1;
        taker.total += 1;
        dev.set(from, dev.get(from)! - 1);
        dev.set(to, dev.get(to)! + 1);
        moved++;
        done = false;
        break outer;
      }
    }
    if (done) break;
  }
  return moved;
}

/**
 * Settle a split's tax and totals as `syncAllocations` does: under per-rate rounding the tax rebalance; with tax on top
 * the even-out of bill totals; again while either moves anything (at most six rounds). `converged` is false when the
 * two still disagreed after the last round; the bills' totals are then within a cent (the even-out ran last) and a bill
 * may carry a rounding cent more than the fewest, which its note says. Mutates `rows`.
 */
export function settleSplit(rows: BaseRow[], opts: RebalanceOptions & { perRate: boolean }): TaxMoves & { converged: boolean } {
  const moves: TaxMoves = { lines: new Map(), slots: new Map() };
  const merge = (into: Map<string, Map<string, number>>, from: Map<string, Map<string, number>>) => {
    for (const [id, byKey] of from) {
      const m = into.get(id) ?? new Map<string, number>();
      for (const [k, d] of byKey) m.set(k, (m.get(k) ?? 0) + d);
      into.set(id, m);
    }
  };
  for (let pass = 0; pass < 6; pass++) {
    const before = JSON.stringify(rows.map((r) => [r.base, r.taxes]));
    if (opts.perRate) {
      // Each pass sees what the earlier passes moved on each taxed amount, so none gives more than it holds.
      const base = opts.slots;
      const slots = base ? (lineId: string) => base(lineId).map((x) => ({ ...x, tax: x.tax + (moves.slots.get(lineId)?.get(x.id) ?? 0) })) : undefined;
      const d = rebalanceBillTax(rows, { ...opts, slots });
      merge(moves.lines, d.lines);
      merge(moves.slots, d.slots);
    }
    // An even split is even: no two bills' totals more than a cent apart (review 4, T4). Only with tax on top: there the
    // tax rebalance changes bill totals; with tax in prices it does not, and each line's odd cents already keep them even.
    if (!opts.taxAddsToTotal) return { ...moves, converged: true };
    balanceBillTotals(rows);
    if (JSON.stringify(rows.map((r) => [r.base, r.taxes])) === before) return { ...moves, converged: true };
  }
  return { ...moves, converged: false };
}
