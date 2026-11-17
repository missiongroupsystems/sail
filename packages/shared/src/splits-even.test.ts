import { describe, expect, it } from "vitest";
import { allocateLine, balanceBillTotals, evenShares, rebalanceBillTax, type BaseRow, type LineComponents } from "./splits.js";

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

function basket(r: Regime, R: ReturnType<typeof rng>): (LineComponents & { taxables: Record<string, number> })[] {
  return Array.from({ length: R.int(1, 6) }, () => {
    const base = R.int(...r.price) * R.int(1, 3);
    const discount = r.discounts && R.chance(0.3) ? -Math.min(base, pct(base, 1500)) : 0;
    const fee = r.fees && R.chance(0.3) ? R.int(1, 100) : 0;
    const rate = R.pick(r.rates);
    const amount = base + discount + fee;
    const combined = rate.reduce((n, c) => n + c.bps, 0);
    const taxes = rate.map((c) => ({ name: c.name, bps: c.bps, amount: r.inclusive ? Math.floor((amount * c.bps) / (10_000 + combined) + 0.5) : pct(amount, c.bps) }));
    const taxables = Object.fromEntries(rate.map((c, i) => [`${c.bps}|${c.name}`, r.inclusive ? amount - taxes.reduce((n, t) => n + t.amount, 0) : amount + 0 * i]));
    return { base, discount, fee, taxes, taxables, adjustments: {} };
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
          for (let pass = 0; pass < 6; pass++) {
            const snap = JSON.stringify(rows.map((x) => [x.base, x.taxes]));
            rebalanceBillTax(rows, Object.fromEntries(lines.map((l, li) => [String(li), l.taxables])), { taxAddsToTotal: !r.inclusive, movable: new Set(lines.flatMap((l, li) => (l.fee === 0 ? [String(li)] : []))) });
            // As syncAllocations does: with tax in prices one rebalance, which leaves bill totals as they were.
            if (r.inclusive) break;
            balanceBillTotals(rows);
            if (JSON.stringify(rows.map((x) => [x.base, x.taxes])) === snap) break;
          }
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
