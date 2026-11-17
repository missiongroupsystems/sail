import { describe, expect, it } from "vitest";
import { csvCell, minorToDecimal, toCsv } from "./report-csv";

describe("report CSV (A P3)", () => {
  it("writes minor units as plain decimals in the currency's exponent, without rounding", () => {
    expect(minorToDecimal(1234, 2)).toBe("12.34");
    expect(minorToDecimal(5, 2)).toBe("0.05");
    expect(minorToDecimal(-5, 2)).toBe("-0.05");
    expect(minorToDecimal(0, 2)).toBe("0.00");
    expect(minorToDecimal(-123456, 2)).toBe("-1234.56");
    expect(minorToDecimal(500, 0)).toBe("500");
    expect(minorToDecimal(1, 3)).toBe("0.001");
    expect(() => minorToDecimal(1.5, 2)).toThrow();
  });
  it("quotes commas, quotes and line breaks, and neutralises formula characters but not negative amounts", () => {
    expect(csvCell("Fish, chips")).toBe('"Fish, chips"');
    expect(csvCell('The "big" one')).toBe('"The ""big"" one"');
    expect(csvCell("=SUM(A1)")).toBe("'=SUM(A1)");
    expect(csvCell("-0.05")).toBe("-0.05");
    expect(csvCell("-cmd")).toBe("'-cmd");
  });
  it("joins rows with CRLF and ends with one", () => {
    expect(toCsv([["Tender", "Amount"], ["Cash", "12.00"], []])).toBe("Tender,Amount\r\nCash,12.00\r\n\r\n");
  });
});
