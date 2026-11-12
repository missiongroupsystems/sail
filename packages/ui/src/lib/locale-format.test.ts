import { describe, expect, it } from "vitest";
import { makeLocaleFormat } from "./locale-format";

const fmt = (currency: string | null, locale: string, currencyExponent: number | null = null) => makeLocaleFormat({ currency, currencyExponent, locale, timeZone: "UTC" });

describe("money fields read back what they show", () => {
  it("ar-KW: 2.125 KWD shows in the locale's digits and is read as 2125 fils, not 2125 KWD", () => {
    const f = fmt("KWD", "ar-KW", 3);
    expect(f.parseMoney(f.moneyText(2125))).toBe(2125);
    expect(f.parseMoney("2٫250")).toBe(2250);
    expect(f.parseMoney("1٫500")).toBe(1500);
    expect(f.parseMoney("1.5")).toBe(1500);
    expect(f.parseMoney("")).toBeNull();
    expect(f.parseMoney("2٫1255")).toBeUndefined();
  });

  it("en-US does not take Indian grouping; de-DE does not take a dot as the decimal", () => {
    expect(fmt("USD", "en-US", 2).parseMoney("1,00,000")).toBeUndefined();
    expect(fmt("EUR", "de-DE", 2).parseMoney("16.50")).toBeUndefined();
    expect(fmt("EUR", "de-DE", 2).parseMoney("16,50")).toBe(1650);
  });

  it("every amount the field and the register display parses back to itself", () => {
    const pairs: [string | null, string, number | null][] = [
      ["SGD", "en-SG", 2], ["USD", "en-US", 2], ["EUR", "de-DE", 2], ["EUR", "fr-FR", 2], ["CHF", "de-CH", 2], ["JPY", "ja-JP", 0], ["KWD", "ar-KW", 3], ["KWD", "en-KW", 3],
      ["BHD", "ar-BH", 3], ["SAR", "ar-SA", 2], ["IRR", "fa-IR", 0], ["INR", "en-IN", 2], ["INR", "mr-IN", 2], ["IDR", "id-ID", 2], ["VND", "vi-VN", 0], ["THB", "th-TH-u-nu-thai", 2], [null, "ar-EG", null], [null, "en-GB", null],
    ];
    for (const [currency, locale, exponent] of pairs) {
      const f = fmt(currency, locale, exponent);
      for (const minor of [0, 5, -5, 2125, -160, 1_000_000, 123_456_789, Number.MAX_SAFE_INTEGER]) {
        expect(f.parseMoney(f.moneyText(minor)), `${locale} ${currency} ${f.moneyText(minor)}`).toBe(minor);
        expect(f.parseMoney(f.money(minor)), `${locale} ${currency} ${f.money(minor)}`).toBe(minor);
        expect(f.parseMoney(f.money(minor, { signed: true }))).toBe(minor);
      }
    }
  });
});
