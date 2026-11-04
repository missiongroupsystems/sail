import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { allocateByShares, allocateLargestRemainder, formatCents, percentOfCents, roundCash, sumCents } from "./money.js";

describe("allocateLargestRemainder", () => {
  it("splits evenly with ties going to earlier parts", () => {
    expect(allocateLargestRemainder(100, [1, 1, 1])).toEqual([34, 33, 33]);
    expect(allocateLargestRemainder(101, [1, 1, 1])).toEqual([34, 34, 33]);
    expect(allocateLargestRemainder(2, [1, 1, 1])).toEqual([1, 1, 0]);
  });
  it("is proportional to weights", () => {
    expect(allocateLargestRemainder(1000, [8000, 12000])).toEqual([400, 600]);
    expect(allocateLargestRemainder(1680, [8000, 12000])).toEqual([672, 1008]);
  });
  it("handles negative totals by sign", () => {
    expect(allocateLargestRemainder(-100, [1, 1, 1])).toEqual([-34, -33, -33]);
  });
  it("treats all-zero weights as even", () => {
    expect(allocateLargestRemainder(5, [0, 0])).toEqual([3, 2]);
  });
  it("gives zero-weight parts nothing when others have weight", () => {
    expect(allocateLargestRemainder(5, [0, 1])).toEqual([0, 5]);
  });
  it("rejects non-integer totals and negative weights", () => {
    expect(() => allocateLargestRemainder(1.5, [1])).toThrow(TypeError);
    expect(() => allocateLargestRemainder(1, [-1])).toThrow(RangeError);
    expect(() => allocateLargestRemainder(1, [])).toThrow(RangeError);
    expect(allocateLargestRemainder(0, [])).toEqual([]);
  });
  it("property: parts always sum to the total and are within 1 cent of the exact share", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -5_000_000, max: 5_000_000 }),
        fc.array(fc.integer({ min: 0, max: 100_000 }), { minLength: 1, maxLength: 40 }),
        (total, weights) => {
          const parts = allocateLargestRemainder(total, weights);
          expect(parts).toHaveLength(weights.length);
          expect(sumCents(parts)).toBe(total);
          const sum = weights.reduce((a, b) => a + b, 0) || weights.length;
          const eff = weights.every((w) => w === 0) ? weights.map(() => 1) : weights;
          for (let i = 0; i < parts.length; i++) {
            const exact = (Math.abs(total) * eff[i]!) / sum;
            expect(Math.abs(Math.abs(parts[i]!) - exact)).toBeLessThan(1 + 1e-9);
            if (total >= 0) expect(parts[i]!).toBeGreaterThanOrEqual(0);
            else expect(parts[i]!).toBeLessThanOrEqual(0);
          }
        },
      ),
      { numRuns: 2000 },
    );
  });
  it("property: deterministic for identical inputs", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 1_000_000 }), fc.array(fc.nat(1000), { minLength: 1, maxLength: 20 }), (t, w) => {
        expect(allocateLargestRemainder(t, w)).toEqual(allocateLargestRemainder(t, [...w]));
      }),
    );
  });
});

describe("allocateByShares", () => {
  it("splits a $66.00 bottle three ways", () => {
    expect(allocateByShares(6600, [{ num: 1, den: 3 }, { num: 1, den: 3 }, { num: 1, den: 3 }])).toEqual([2200, 2200, 2200]);
    expect(allocateByShares(6601, [{ num: 1, den: 3 }, { num: 1, den: 3 }, { num: 1, den: 3 }])).toEqual([2201, 2200, 2200]);
  });
  it("handles mixed denominators", () => {
    expect(allocateByShares(1000, [{ num: 1, den: 2 }, { num: 1, den: 4 }, { num: 1, den: 4 }])).toEqual([500, 250, 250]);
  });
});

describe("percentOfCents", () => {
  it("rounds half up", () => {
    expect(percentOfCents(16800, 1000)).toBe(1680);
    expect(percentOfCents(1005, 1000)).toBe(101); // 100.5 → 101
    expect(percentOfCents(1004, 1000)).toBe(100);
    expect(percentOfCents(-1005, 1000)).toBe(-101);
  });
});

describe("roundCash", () => {
  it("rounds to the nearest 5 cents, halves up", () => {
    expect(roundCash(4316, 5)).toEqual({ rounded: 4315, roundingCents: -1 });
    expect(roundCash(4318, 5)).toEqual({ rounded: 4320, roundingCents: 2 });
    expect(roundCash(4315, 5)).toEqual({ rounded: 4315, roundingCents: 0 });
    expect(roundCash(1, 10)).toEqual({ rounded: 0, roundingCents: -1 });
    expect(roundCash(5, 10)).toEqual({ rounded: 10, roundingCents: 5 });
  });
  it("increment 1 is a no-op", () => {
    expect(roundCash(4316, 1)).toEqual({ rounded: 4316, roundingCents: 0 });
  });
  it("property: rounding never moves more than half an increment", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 10_000_000 }), fc.constantFrom(5, 10, 50), (amt, inc) => {
        const { rounded, roundingCents } = roundCash(amt, inc);
        expect(rounded % inc).toBe(0);
        expect(Math.abs(roundingCents) * 2).toBeLessThanOrEqual(inc);
        expect(rounded - amt).toBe(roundingCents);
      }),
    );
  });
});

describe("formatCents", () => {
  it("formats en-SG with a true minus sign", () => {
    expect(formatCents(1600)).toBe("$16.00");
    expect(formatCents(-160)).toBe("−$1.60");
    expect(formatCents(0)).toBe("$0.00");
  });
});
