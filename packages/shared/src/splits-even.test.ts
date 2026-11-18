import { describe, expect, it } from "vitest";
import { allocateLargestRemainder } from "./money.js";
import { allocateLine, evenShares, ownBillTax, settleSplit, type BaseRow, type BillTaxItem, type LineComponents } from "./splits.js";

/**
 * Review 4, T4: an even split is even. Over seeded baskets in six regimes and 2–6 bills, allocating each line, the
 * per-rate tax rebalance and the even-out together leave bills no more than a cent apart, every line's allocations
 * adding up to the line part by part, the order's tax per rate unchanged, and no allocation below zero.
 */
type Rate = { name: string; bps: number }[];
type Regime = { key: string; inclusive: boolean; rates: Rate[]; price: [number, number]; discounts: boolean; fees: boolean };
const REGIMES: Regime[] = [
  { key: "sg", inclusive: false, rates: [[{ name: "GST", bps: 900 }]], price: [5, 12_005], discounts: true, fees: true },
  { key: "eu", inclusive: true, rates: [[{ name: "VAT 10%", bps: 1000 }], [{ name: "VAT 20%", bps: 2000 }], []], price: [3, 1_450], discounts: true, fees: true },
  { key: "us", inclusive: false, rates: [[{ name: "State", bps: 400 }, { name: "Local", bps: 450 }], []], price: [3, 1_749], discounts: true, fees: false },
  { key: "jp", inclusive: true, rates: [[{ name: "Consumption 8%", bps: 800 }], [{ name: "Consumption 10%", bps: 1000 }]], price: [1, 12_345], discounts: true, fees: false },
  { key: "id", inclusive: false, rates: [[{ name: "PPN", bps: 1100 }]], price: [7, 2_147_483_647], discounts: false, fees: true },
  { key: "kw", inclusive: false, rates: [[{ name: "State", bps: 400 }, { name: "Local", bps: 450 }], []], price: [7, 2_125], discounts: true, fees: true },
];

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  const next = () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
  return { int: (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1)), pick: <T,>(xs: readonly T[]) => xs[Math.floor(next() * xs.length)]!, chance: (p: number) => next() < p };
}

const pct = (amount: number, bps: number) => Math.floor((amount * bps) / 10_000 + 0.5);

function basket(r: Regime, R: ReturnType<typeof rng>): (LineComponents & { taxables: Record<string, number>; rate: Rate })[] {
  return Array.from({ length: R.int(1, 6) }, () => {
    const base = R.int(...r.price) * R.int(1, 3);
    const discount = r.discounts && R.chance(0.3) ? -Math.min(base, pct(base, 1500)) : 0;
    const fee = r.fees && R.chance(0.3) ? R.int(1, 100) : 0;
    const rate = R.pick(r.rates);
    const amount = base + discount + fee;
    const combined = rate.reduce((n, c) => n + c.bps, 0);
    const taxes = rate.map((c) => ({ name: c.name, bps: c.bps, amount: r.inclusive ? Math.floor((amount * c.bps) / (10_000 + combined) + 0.5) : pct(amount, c.bps) }));
    const taxables = Object.fromEntries(rate.map((c, i) => [`${c.bps}|${c.name}`, r.inclusive ? amount - taxes.reduce((n, t) => n + t.amount, 0) : amount + 0 * i]));
    return { base, discount, fee, taxes, taxables, rate, adjustments: {} };
  });
}

describe("T4 property: even splits are a cent apart at most", () => {
  for (const r of REGIMES) {
    it(`${r.key}: 150 baskets × 2–6 ways`, () => {
      const R = rng(r.key.charCodeAt(0) * 7919 + r.key.charCodeAt(1));
      for (let b = 0; b < 150; b++) {
        const lines = basket(r, R);
        for (let n = 2; n <= 6; n++) {
          const shares = evenShares(n);
          const balance = shares.map(() => 0);
          const rows: BaseRow[] = lines.flatMap((l, li) =>
            allocateLine(l, shares, { taxAddsToTotal: !r.inclusive, balance }).map((p, check) => ({ check, lineId: String(li), shareNum: 1, shareDen: n, taxes: p.taxes, tax: p.tax, total: p.total, base: p.base, discount: p.discount })),
          );
          const fees = new Map(lines.flatMap((l, li) => allocateLine(l, shares, { taxAddsToTotal: !r.inclusive }).map((p, check) => [`${li}:${check}`, p.fee] as const)));
          const orderTax = (rs: BaseRow[]) => {
            const m: Record<string, number> = {};
            for (const x of rs) for (const t of x.taxes) m[`${t.bps}|${t.name}`] = (m[`${t.bps}|${t.name}`] ?? 0) + t.amount;
            return m;
          };
          const before = orderTax(rows);
          const lineTotal0 = lines.map((_, li) => rows.filter((x) => x.lineId === String(li)).reduce((s, x) => s + x.total, 0));
          // Each bill's taxed amounts: its net and fee cents of each line, at the line's rate (the fee is taxed with its line).
          const items = (check: number): BillTaxItem[] => rows.filter((x) => x.check === check).map((x) => ({ components: lines[Number(x.lineId)]!.rate, amount: x.base + (x.discount ?? 0) + (fees.get(`${Number(x.lineId)}:${x.check}`) ?? 0) }));
          settleSplit(rows, { perRate: true, taxAddsToTotal: !r.inclusive, taxMode: r.inclusive ? "inclusive" : "exclusive", items });
          const label = `${r.key} basket ${b} / ${n}`;
          const totals = Array.from({ length: n }, (_, c) => rows.filter((x) => x.check === c).reduce((s, x) => s + x.total, 0));
          expect(Math.max(...totals) - Math.min(...totals), `${label}: ${totals.join(" / ")}`).toBeLessThanOrEqual(1);
          expect(orderTax(rows), label).toEqual(before);
          lines.forEach((l, li) => {
            const mine = rows.filter((x) => x.lineId === String(li));
            expect(mine.reduce((s, x) => s + x.base, 0), label).toBe(l.base);
            expect(mine.reduce((s, x) => s + (x.discount ?? 0), 0), label).toBe(l.discount);
            // A line's total changes only by the tax cents the rebalance moves between whole lines (tax on top).
            const taxNow = mine.reduce((s, x) => s + x.tax, 0);
            const taxThen = l.taxes.reduce((s, t) => s + t.amount, 0);
            expect(mine.reduce((s, x) => s + x.total, 0), label).toBe(lineTotal0[li]! + (r.inclusive ? 0 : taxNow - taxThen));
            for (const x of mine) expect(x.base + (x.discount ?? 0) + (fees.get(`${li}:${x.check}`) ?? 0), label).toBeGreaterThanOrEqual(0);
          });
        }
      }
    });
  }
});

/**
 * Review 5, V1 and V2. Baskets priced as the engine prices them under per-rate rounding: every taxed amount (a line's
 * net amount, a fee on a line) is an item at its rate, each rate's tax is rounded once on its items' total and spread
 * back by largest remainder. A fee can be taxed at another rate than its line (a 20% service fee on 10% food, a taxed
 * fee on an exempt bottle of water). The rules checked, per tax component:
 * - the order's tax never changes;
 * - when the bills' own roundings add up to the order's tax, every bill's tax is its own rounding;
 * - otherwise exactly the difference moves (the fewest cents), when the bills share a line or two whole lines at that rate;
 * - bills of an even split are a cent apart at most, and (counted, not asserted) each line's shares a cent apart.
 */
type Item = { line: number; components: Rate; amount: number; fee: boolean };
type Priced = LineComponents & { rate: Rate; netTax: number; feeRate: Rate | null };
function priceBasket(lines: { amount: number; rate: Rate; fee: number; feeRate: Rate | null }[], inclusive: boolean): Priced[] {
  const items: Item[] = lines.flatMap((l, i) => [{ line: i, components: l.rate, amount: l.amount, fee: false }, ...(l.fee && l.feeRate ? [{ line: i, components: l.feeRate, amount: l.fee, fee: true }] : [])]);
  const gkey = (r: Rate) => r.map((c) => `${c.bps}|${c.name}`).join("+");
  const tax = new Map<Item, number[]>();
  for (const g of new Set(items.map((i) => gkey(i.components)))) {
    const group = items.filter((i) => gkey(i.components) === g);
    const comps = group[0]!.components;
    const sum = group.reduce((n, i) => n + i.amount, 0);
    const combined = comps.reduce((n, c) => n + c.bps, 0);
    comps.forEach((c, k) => {
      const t = inclusive ? Math.floor((sum * c.bps) / (10_000 + combined) + 0.5) : pct(sum, c.bps);
      allocateLargestRemainder(t, group.map((i) => i.amount)).forEach((v, j) => tax.set(group[j]!, [...(tax.get(group[j]!) ?? []), v]));
      void k;
    });
  }
  return lines.map((l, i) => {
    const byKey = new Map<string, { name: string; bps: number; amount: number }>();
    let netTax = 0;
    for (const it of items.filter((x) => x.line === i)) {
      it.components.forEach((c, k) => {
        const cur = byKey.get(`${c.bps}|${c.name}`) ?? { name: c.name, bps: c.bps, amount: 0 };
        cur.amount += tax.get(it)![k]!;
        byKey.set(`${c.bps}|${c.name}`, cur);
        if (!it.fee) netTax += tax.get(it)![k]!;
      });
    }
    return { base: l.amount, discount: 0, fee: l.fee, taxes: [...byKey.values()], adjustments: {}, rate: l.rate, netTax, feeRate: l.feeRate };
  });
}

const STATE_LOCAL: Rate = [{ name: "State", bps: 400 }, { name: "Local", bps: 450 }];
const V10: Rate = [{ name: "VAT 10%", bps: 1000 }];
const V20: Rate = [{ name: "VAT 20%", bps: 2000 }];

/** Split, rebalance as syncAllocations does, and check the rules; returns whether every line's shares stayed within a cent. */
function splitAndCheck(lines: Priced[], shares: { num: number; den: number }[][], n: number, inclusive: boolean, label: string): { sharesEven: boolean; converged: boolean; extra: boolean } {
  const balance = Array.from({ length: n }, () => 0);
  const rows: BaseRow[] = [];
  const fees = new Map<string, number>();
  lines.forEach((l, li) => {
    allocateLine(l, shares[li]!, { taxAddsToTotal: !inclusive, balance }).forEach((p, check) => {
      if (shares[li]![check]!.num === 0) return;
      rows.push({ check, lineId: String(li), shareNum: shares[li]![check]!.num, shareDen: shares[li]![check]!.den, taxes: p.taxes, tax: p.tax, total: p.total, base: p.base, discount: p.discount });
      fees.set(`${li}:${check}`, p.fee);
    });
  });
  const items = (check: number): BillTaxItem[] =>
    rows.filter((x) => x.check === check).flatMap((x) => {
      const l = lines[Number(x.lineId)]!;
      const f = fees.get(`${x.lineId}:${x.check}`) ?? 0;
      return [{ components: l.rate, amount: x.base + (x.discount ?? 0) }, ...(f && l.feeRate ? [{ components: l.feeRate, amount: f }] : [])];
    });
  const orderTax = () => {
    const m: Record<string, number> = {};
    for (const x of rows) for (const t of x.taxes) m[`${t.bps}|${t.name}`] = (m[`${t.bps}|${t.name}`] ?? 0) + t.amount;
    return m;
  };
  const before = orderTax();
  const netTax = new Map(lines.map((l, li) => [String(li), l.netTax]));
  const slots = (id: string) => {
    const l = lines[Number(id)]!;
    const fee = l.taxes.reduce((n, t) => n + t.amount, 0) - l.netTax;
    return [{ id: "net", group: l.rate.map((c) => `${c.bps}|${c.name}`).join("+"), tax: l.netTax }, ...(l.feeRate && l.fee ? [{ id: "fee", group: l.feeRate.map((c) => `${c.bps}|${c.name}`).join("+"), tax: fee }] : [])];
  };
  const { converged } = settleSplit(rows, { perRate: true, taxAddsToTotal: !inclusive, taxMode: inclusive ? "inclusive" : "exclusive", items, slots });
  expect(orderTax(), label).toEqual(before);
  // Fewest cents: per component, the bills are off their own rounding by exactly the cents the order needs.
  const own = Array.from({ length: n }, (_, c) => ownBillTax(items(c), inclusive ? "inclusive" : "exclusive"));
  let extra = false;
  for (const k of Object.keys(before)) {
    if (before[k]! <= 0) continue;
    const taxOf = (c: number) => rows.filter((x) => x.check === c).reduce((s, x) => s + (x.taxes.find((t) => `${t.bps}|${t.name}` === k)?.amount ?? 0), 0);
    const off = Array.from({ length: n }, (_, c) => Math.abs(taxOf(c) - (own[c]!.get(k)?.own ?? 0))).reduce((a, b) => a + b, 0);
    const need = Math.abs(before[k]! - own.reduce((s, o) => s + (o.get(k)?.own ?? 0), 0));
    if (off === need) continue;
    // Bills are off by more than the fewest cents only when the bills that need a cent and those that have one too many
    // share no line and no taxed amount of the same kind at this rate (the cent would have to move between a line's own
    // tax and a fee's), or when the totals rule won on an even split (`converged` false). Counted.
    const sig = (c: number) => new Set(rows.filter((x) => x.check === c && x.taxes.some((t) => `${t.bps}|${t.name}` === k)).flatMap((x) => slots(x.lineId).filter((sl) => sl.group.split("+").includes(k)).map((sl) => `${sl.id}:${sl.group}`).concat(x.shareNum !== x.shareDen ? [`line:${x.lineId}`] : [])));
    const over = Array.from({ length: n }, (_, c) => c).filter((c) => taxOf(c) > (own[c]!.get(k)?.own ?? 0));
    const under = Array.from({ length: n }, (_, c) => c).filter((c) => taxOf(c) < (own[c]!.get(k)?.own ?? 0));
    const reachable = over.some((a) => under.some((b) => [...sig(a)].some((x) => sig(b).has(x))));
    expect(reachable && converged, `${label} ${k}: bills off their own rounding by ${off}, the order needs ${need}`).toBe(false);
    extra = true;
  }
  let sharesEven = true;
  lines.forEach((_, li) => {
    const bases = rows.filter((x) => x.lineId === String(li)).map((x) => x.base);
    if (bases.length > 1 && Math.max(...bases) - Math.min(...bases) > 1) sharesEven = false;
  });
  return { sharesEven, converged, extra };
}

describe("V1 and V2 property: own rounding when it adds up, the fewest cents when it does not", () => {
  it("A's and B's baskets: whole lines by item, with the service fee", () => {
    const fee10 = (a: number) => Math.round(a / 10);
    // US P-0004: veggie, classic + bacon, salad, beer, water (exempt, its fee taxed), soda; salad alone on Bill 2.
    const us = [1249, 1449, 899, 699, 199, 249].map((amount, i) => ({ amount, rate: i === 4 ? [] : STATE_LOCAL, fee: fee10(amount), feeRate: STATE_LOCAL }));
    const usLines = priceBasket(us, false);
    for (const bill2 of [[2], [2, 3, 5], [3, 4]]) splitAndCheck(usLines, usLines.map((_, i) => (bill2.includes(i) ? [{ num: 0, den: 1 }, { num: 1, den: 1 }] : [{ num: 1, den: 1 }, { num: 0, den: 1 }])), 2, false, `US ${bill2}`);
    // Café P-0005: sandwich, wine, tea, quiche, scone, flat white (oat), juice; 10% fee at 20% VAT; Bill 2 built up line by line.
    const eu = [[850, V10], [750, V20], [300, V20], [1150, V10], [350, V10], [420, V20], [400, V20]].map(([amount, rate]) => ({ amount: amount as number, rate: rate as Rate, fee: fee10(amount as number), feeRate: V20 }));
    const euLines = priceBasket(eu, true);
    for (const bill2 of [[3], [3, 4], [3, 4, 5], [3, 4, 5, 6]]) splitAndCheck(euLines, euLines.map((_, i) => (bill2.includes(i) ? [{ num: 0, den: 1 }, { num: 1, den: 1 }] : [{ num: 1, den: 1 }, { num: 0, den: 1 }])), 2, true, `café ${bill2}`);
  });

  const regimes = [
    { key: "us fee", inclusive: false, rates: [STATE_LOCAL, [] as Rate], feeRate: STATE_LOCAL },
    { key: "eu fee at 20%", inclusive: true, rates: [V10, V20, [] as Rate], feeRate: V20 },
    { key: "eu no fee", inclusive: true, rates: [V10, V20], feeRate: null },
    { key: "us no fee", inclusive: false, rates: [STATE_LOCAL, [] as Rate], feeRate: null },
  ];
  for (const g of regimes) {
    it(`${g.key}: 200 baskets by item into 2–3 bills and evenly 2–6 ways`, () => {
      const R = rng(g.key.length * 104729 + g.key.charCodeAt(0));
      let even = 0;
      let unevenShares = 0;
      let unsettled = 0;
      let stuck = 0;
      for (let b = 0; b < 200; b++) {
        const lines = priceBasket(Array.from({ length: R.int(2, 8) }, () => {
          const amount = R.int(99, 2_500);
          return { amount, rate: R.pick(g.rates), fee: g.feeRate && R.chance(0.8) ? Math.round(amount / 10) : 0, feeRate: g.feeRate };
        }), g.inclusive);
        const n = R.int(2, 3);
        // By item every line is whole on one bill: the bills' totals are what they are, and the tax rule always holds.
        const byItem = splitAndCheck(lines, lines.map(() => { const to = R.int(0, n - 1); return Array.from({ length: n }, (_, c) => ({ num: c === to ? 1 : 0, den: 1 })); }), n, g.inclusive, `${g.key} ${b} by item`);
        expect(byItem.converged).toBe(true);
        if (byItem.extra) stuck++;
        for (let m = 2; m <= 6; m++) {
          even++;
          const res = splitAndCheck(lines, lines.map(() => evenShares(m)), m, g.inclusive, `${g.key} ${b} / ${m}`);
          if (!res.sharesEven) unevenShares++;
          if (!res.converged && res.extra) unsettled++;
        }
      }
      // Rule 4 (each line's shares a cent apart) gives way only to rule 3 (bills a cent apart); say how often.
      console.log(`${g.key}: of ${even} even splits, ${unevenShares} move a cent of a line's share to keep the bills a cent apart; ${unsettled} keep the bills a cent apart with a rounding cent more than the fewest; by item, ${stuck} of 200 have a cent that could only move between a line's own tax and a fee's`);
    });
  }
});
