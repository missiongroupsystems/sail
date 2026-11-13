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

describe("clock times", () => {
  it("a 24-hour locale writes the hour with two digits (C-7: en-IE showed 9:05), a 12-hour one does not", () => {
    const at = new Date("2026-11-13T09:05:00Z");
    expect(fmt("EUR", "en-IE").clock(at)).toBe("09:05");
    expect(fmt("EUR", "de-DE").clock(at)).toBe("09:05");
    expect(fmt("USD", "en-US").clock(at)).toMatch(/^9:05\s?am$/i);
  });
});

describe("business dates", () => {
  it("are written for people, not as the register's YYYY-MM-DD (C-8, F-10)", () => {
    expect(fmt("SGD", "en-SG").businessDay("2026-11-13")).toMatch(/^Fri,? 13 Nov 2026$/);
    expect(makeLocaleFormat({ currency: "USD", currencyExponent: null, locale: "en-US", timeZone: "Pacific/Honolulu" }).businessDay("2026-11-13")).toMatch(/Fri.*Nov.*13.*2026/);
    expect(fmt("SGD", "en-SG").businessDay("not a date")).toBe("not a date");
  });
});

describe("dates: the weekday always belongs to the date shown", () => {
  it("a business day names its own weekday in every zone and on every device clock", () => {
    for (const timeZone of ["Pacific/Kiritimati", "Asia/Singapore", "UTC", "America/Los_Angeles", "Pacific/Pago_Pago"]) {
      const f = makeLocaleFormat({ currency: "SGD", currencyExponent: 2, locale: "en-SG", timeZone });
      expect(f.businessDay("2026-11-13"), timeZone).toBe("Fri, 13 Nov 2026");
      expect(f.businessDay("2026-11-14"), timeZone).toBe("Sat, 14 Nov 2026");
    }
  });

  it("the lock screen's today is the outlet's calendar day, with its own weekday, in the same form", () => {
    // 02:33 in Singapore on Saturday 14 November is 18:33 UTC on Friday 13 November.
    const at = new Date("2026-11-13T18:33:00Z");
    const sg = makeLocaleFormat({ currency: "SGD", currencyExponent: 2, locale: "en-SG", timeZone: "Asia/Singapore" });
    expect(sg.businessDay(sg.isoDate(at))).toBe("Sat, 14 Nov 2026");
    const la = makeLocaleFormat({ currency: "USD", currencyExponent: 2, locale: "en-US", timeZone: "America/Los_Angeles" });
    expect(la.businessDay(la.isoDate(at))).toBe("Fri, Nov 13, 2026");
  });
});
