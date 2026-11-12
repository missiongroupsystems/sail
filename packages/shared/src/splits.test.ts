import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { allocateLine, evenShares, sharedAmong, sumAllocations, wholeTo } from "./splits.js";
import { sumCents } from "./money.js";
import type { TaxAmount } from "./pricing/schemas.js";

/** The Singapore preset's single tax component, as a line's tax breakdown. */
const sgTax = (amount: number): TaxAmount[] => [{ name: "GST 9%", bps: 900, amount }];

describe("bill allocation", () => {
  const wine = { base: 6600, discount: -600, fee: 600, taxes: sgTax(594), adjustments: { sc: { amount: 600, tax: 54 }, promo: { amount: -600, tax: 0 } } };

  it("splits a bottle three ways with every component adding up", () => {
    const parts = allocateLine(wine, evenShares(3), { taxAddsToTotal: true });
    expect(parts.map((p) => p.base)).toEqual([2200, 2200, 2200]);
    expect(parts.map((p) => p.discount)).toEqual([-200, -200, -200]);
    expect(parts.map((p) => p.tax)).toEqual([198, 198, 198]);
    expect(parts.map((p) => p.adjustments["sc"]!.tax)).toEqual([18, 18, 18]);
    expect(sumAllocations(parts)).toBe(6600 - 600 + 600 + 594);
  });

  it("an odd cent goes to the check furthest under its share, so even bills differ by a cent at most", () => {
    const parts = allocateLine({ base: 1000, discount: 0, fee: 100, taxes: sgTax(99), adjustments: {} }, evenShares(3), { taxAddsToTotal: true });
    expect(parts.map((p) => p.base)).toEqual([334, 333, 333]);
    // Check 1 took the base's odd cent, so the fee's goes to check 2.
    expect(parts.map((p) => p.fee)).toEqual([33, 34, 33]);
    expect(parts.map((p) => p.tax)).toEqual([33, 33, 33]);
    expect(parts.map((p) => p.total)).toEqual([400, 400, 399]);
  });

  it("property: an even split of a whole bill, one balance across its lines, gives bills a cent apart at most (two guests sharing a bill pay the same)", () => {
    fc.assert(
      fc.property(
        fc.array(fc.record({ base: fc.integer({ min: 0, max: 50_000 }), discount: fc.integer({ min: -5_000, max: 0 }), fee: fc.integer({ min: 0, max: 5_000 }), gst: fc.integer({ min: 0, max: 5_000 }), levy: fc.integer({ min: 0, max: 500 }) }), { minLength: 1, maxLength: 15 }),
        fc.integer({ min: 2, max: 12 }),
        fc.boolean(),
        (lines, n, inclusive) => {
          const balance = Array.from({ length: n }, () => 0);
          const totals = Array.from({ length: n }, () => 0);
          for (const l of lines) {
            const line = { base: l.base, discount: Math.max(l.discount, -l.base), fee: l.fee, taxes: [...sgTax(l.gst), { name: "Levy 1%", bps: 100, amount: l.levy }], adjustments: {} };
            allocateLine(line, evenShares(n), { taxAddsToTotal: !inclusive, balance }).forEach((p, i) => (totals[i] = totals[i]! + p.total));
          }
          expect(Math.max(...totals) - Math.min(...totals)).toBeLessThanOrEqual(1);
        },
      ),
      { numRuns: 1000 },
    );
  });

  it("shared among some checks and whole to one check", () => {
    const parts = allocateLine(wine, sharedAmong(3, [0, 2]), { taxAddsToTotal: true });
    expect(parts.map((p) => p.base)).toEqual([3300, 0, 3300]);
    const whole = allocateLine(wine, wholeTo(3, 1), { taxAddsToTotal: false });
    expect(whole.map((p) => p.total)).toEqual([0, 6600 - 600 + 600, 0]);
  });

  it("property: for any line and any shares, every component and the totals add up exactly", () => {
    fc.assert(
      fc.property(
        fc.record({ base: fc.integer({ min: 0, max: 200_000 }), discount: fc.integer({ min: -50_000, max: 0 }), fee: fc.integer({ min: 0, max: 30_000 }), tax: fc.integer({ min: 0, max: 20_000 }) }),
        fc.integer({ min: 1, max: 12 }),
        fc.boolean(),
        (c, n, inclusive) => {
          const line = { base: c.base, discount: c.discount, fee: c.fee, taxes: sgTax(c.tax), adjustments: { a: { amount: c.fee, tax: Math.floor(c.tax / 2) }, b: { amount: c.discount, tax: 0 } } };
          const parts = allocateLine(line, evenShares(n), { taxAddsToTotal: !inclusive });
          expect(sumCents(parts.map((p) => p.base))).toBe(c.base);
          expect(sumCents(parts.map((p) => p.discount))).toBe(c.discount);
          expect(sumCents(parts.map((p) => p.fee))).toBe(c.fee);
          expect(sumCents(parts.map((p) => p.tax))).toBe(c.tax);
          expect(sumCents(parts.map((p) => p.adjustments["a"]!.amount))).toBe(c.fee);
          expect(sumAllocations(parts)).toBe(c.base + c.discount + c.fee + (inclusive ? 0 : c.tax));
          for (const p of parts) expect(p.total).toBe(p.base + p.discount + p.fee + (inclusive ? 0 : p.tax));
        },
      ),
      { numRuns: 500 },
    );
  });
});

describe("money review: a bill's adjustment rows add up to its discount and fee", () => {
  it("a 0.04 item with two 25% discounts split three ways prints rows that add up to each bill's discount", () => {
    const parts = allocateLine({ base: 4, discount: -2, fee: 0, taxes: [], adjustments: { a: { amount: -1, tax: 0 }, b: { amount: -1, tax: 0 } } }, evenShares(3), { taxAddsToTotal: true });
    for (const p of parts) expect(Object.values(p.adjustments).filter((a) => a.amount < 0).reduce((s, a) => s + a.amount, 0)).toBe(p.discount + 0);
    expect(parts.reduce((s, p) => s + p.discount, 0)).toBe(-2);
  });
  it("property: per bill, discount rows sum to the discount and fee rows to the fee; bills still add up to the line", () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: -500, max: -1 }), { maxLength: 4 }), fc.array(fc.integer({ min: 1, max: 500 }), { maxLength: 3 }), fc.integer({ min: 0, max: 5000 }), fc.integer({ min: 1, max: 6 }), (discs, fees, extra, n) => {
        const adjustments: Record<string, { amount: number; tax: number }> = {};
        discs.forEach((d, i) => (adjustments[`d${i}`] = { amount: d, tax: 0 }));
        fees.forEach((f, i) => (adjustments[`f${i}`] = { amount: f, tax: 0 }));
        const discount = discs.reduce((a, b) => a + b, 0);
        const fee = fees.reduce((a, b) => a + b, 0);
        const parts = allocateLine({ base: -discount + extra, discount, fee, taxes: [], adjustments }, evenShares(n), { taxAddsToTotal: true });
        for (const p of parts) {
          const rows = Object.entries(p.adjustments);
          expect(rows.filter(([k]) => k.startsWith("d")).reduce((s, [, a]) => s + a.amount, 0)).toBe(p.discount + 0);
          expect(rows.filter(([k]) => k.startsWith("f")).reduce((s, [, a]) => s + a.amount, 0)).toBe(p.fee + 0);
        }
        expect(parts.reduce((s, p) => s + p.discount, 0)).toBe(discount);
        expect(parts.reduce((s, p) => s + p.fee, 0)).toBe(fee);
        for (const [k, a] of Object.entries(adjustments)) expect(parts.reduce((s, p) => s + p.adjustments[k]!.amount, 0)).toBe(a.amount);
        for (const p of parts) for (const [k, a] of Object.entries(p.adjustments)) expect(Math.sign(a.amount) * Math.sign(adjustments[k]!.amount)).toBeGreaterThanOrEqual(0);
        for (const p of parts) expect(p.base + p.discount).toBeGreaterThanOrEqual(0);
      }),
    );
  });
});
