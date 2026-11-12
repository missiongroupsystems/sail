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

  it("uneven cents go to earlier checks", () => {
    const parts = allocateLine({ base: 1000, discount: 0, fee: 100, taxes: sgTax(99), adjustments: {} }, evenShares(3), { taxAddsToTotal: true });
    expect(parts.map((p) => p.base)).toEqual([334, 333, 333]);
    expect(parts.map((p) => p.fee)).toEqual([34, 33, 33]);
    expect(parts.map((p) => p.tax)).toEqual([33, 33, 33]);
    expect(parts.map((p) => p.total)).toEqual([401, 399, 399]);
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
