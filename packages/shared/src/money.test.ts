import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { allocateByShares, allocateLargestRemainder, currencyExponent, formatMoney, parseMoney, percentOfCents, roundCash, sumCents } from "./money.js";

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

describe("currencyExponent", () => {
  it("follows ISO 4217", () => {
    expect(currencyExponent("SGD")).toBe(2);
    expect(currencyExponent("EUR")).toBe(2);
    expect(currencyExponent("JPY")).toBe(0);
    expect(currencyExponent("KWD")).toBe(3);
    expect(currencyExponent("IQD")).toBe(3);
  });
  it("rejects unknown codes", () => {
    expect(() => currencyExponent("XYZ")).toThrow(RangeError);
    expect(() => currencyExponent("eur")).toThrow(RangeError);
  });
});

describe("formatMoney", () => {
  it("formats in the given currency and locale with a true minus sign", () => {
    expect(formatMoney(1600, { currency: "SGD", locale: "en-SG" })).toBe("$16.00");
    expect(formatMoney(-160, { currency: "SGD", locale: "en-SG" })).toBe("−$1.60");
    expect(formatMoney(0, { currency: "SGD", locale: "en-SG" })).toBe("$0.00");
    expect(formatMoney(1650, { currency: "EUR", locale: "de-DE" })).toBe("16,50\u00a0€");
    expect(formatMoney(1600, { currency: "JPY", locale: "ja-JP" })).toBe("￥1,600");
    expect(formatMoney(1234, { currency: "KWD", locale: "en-KW" })).toBe("KWD\u00a01.234");
    expect(formatMoney(5, { currency: "USD", locale: "en-US" }, { sign: "always" })).toBe("+$0.05");
  });
  it("keeps large amounts exact", () => {
    expect(formatMoney(9_007_199_254_740_991, { currency: "USD", locale: "en-US" })).toBe("$90,071,992,547,409.91");
  });
});

describe("parseMoney", () => {
  it("reads the locale's separators into minor units", () => {
    expect(parseMoney("16.50", { currency: "SGD", locale: "en-SG" })).toBe(1650);
    expect(parseMoney("$1,234.5", { currency: "USD", locale: "en-US" })).toBe(123450);
    expect(parseMoney("1.234,56 €", { currency: "EUR", locale: "de-DE" })).toBe(123456);
    expect(parseMoney("CHF 1’234.05", { currency: "CHF", locale: "de-CH" })).toBe(123405);
    expect(parseMoney("￥1,600", { currency: "JPY", locale: "ja-JP" })).toBe(1600);
    expect(parseMoney("1.234", { currency: "KWD", locale: "en-KW" })).toBe(1234);
    expect(parseMoney("−2.00", { currency: "SGD", locale: "en-SG" })).toBe(-200);
  });
  it("refuses more decimals than the currency has, and text that is not an amount", () => {
    expect(() => parseMoney("16.5", { currency: "JPY", locale: "ja-JP" })).toThrow(RangeError);
    expect(() => parseMoney("1.2345", { currency: "KWD", locale: "en-KW" })).toThrow(RangeError);
    expect(() => parseMoney("abc", { currency: "EUR", locale: "de-DE" })).toThrow(RangeError);
    // "." groups thousands in de-DE: 16.50 typed out of habit must not become 1650 euros.
    expect(() => parseMoney("16.50", { currency: "EUR", locale: "de-DE" })).toThrow(RangeError);
    expect(() => parseMoney("1,2345.00", { currency: "USD", locale: "en-US" })).toThrow(RangeError);
    expect(parseMoney("12,34,567.00", { currency: "INR", locale: "en-IN" })).toBe(123_456_700);
    // Only a sign, spaces, the currency's symbol or its code may surround the number.
    for (const junk of ["1-2", "5e2", "12abc", "1 2 3", "12 EUR"]) expect(() => parseMoney(junk, { currency: "USD", locale: "en-US" })).toThrow(RangeError);
    expect(parseMoney("12 USD", { currency: "USD", locale: "en-US" })).toBe(1200);
    expect(parseMoney("1 234,50 kr", { currency: "SEK", locale: "sv-SE" })).toBe(123_450);
  });
  it("property: parsing what formatMoney prints returns the amount", () => {
    const money = fc.constantFrom({ currency: "SGD", locale: "en-SG" }, { currency: "EUR", locale: "de-DE" }, { currency: "JPY", locale: "ja-JP" }, { currency: "KWD", locale: "en-KW" }, { currency: "CHF", locale: "de-CH" }, { currency: "EUR", locale: "fr-FR" }, { currency: "INR", locale: "en-IN" }, { currency: "SEK", locale: "sv-SE" }, { currency: "USD", locale: "en-US" });
    fc.assert(fc.property(fc.integer({ min: -10_000_000, max: 10_000_000 }), money, (amount, m) => parseMoney(formatMoney(amount, m), m) === amount));
  });
});

describe("roundCash in minor units", () => {
  it("rounds CHF to 0.05, SEK to 1 krona, JPY to 10 yen and KWD to 5 fils", () => {
    expect(roundCash(1234, 5)).toEqual({ rounded: 1235, roundingCents: 1 });
    expect(roundCash(1232, 5)).toEqual({ rounded: 1230, roundingCents: -2 });
    expect(roundCash(12_349, 100)).toEqual({ rounded: 12_300, roundingCents: -49 });
    expect(roundCash(12_350, 100)).toEqual({ rounded: 12_400, roundingCents: 50 });
    expect(roundCash(1234, 10)).toEqual({ rounded: 1230, roundingCents: -4 });
    expect(roundCash(1_002, 5)).toEqual({ rounded: 1_000, roundingCents: -2 });
  });
});
