import { describe, expect, it } from "vitest";
import { taxDue } from "../src/services/tax-due.js";

describe("taxDue", () => {
  it("takes each component's refunded tax off the tax charged, matched on name and rate", () => {
    const charged = [
      { name: "GST", bps: 900, amount: 1800 },
      { name: "Service tax", bps: 600, amount: 120 },
    ];
    const refunded = [{ name: "GST", bps: 900, amount: 450 }];
    expect(taxDue(charged, refunded)).toEqual([
      { name: "GST", bps: 900, amount: 1350 },
      { name: "Service tax", bps: 600, amount: 120 },
    ]);
  });

  it("keeps two rates with one name apart, and lists a component refunded but not charged in the period as negative", () => {
    const charged = [
      { name: "VAT", bps: 2000, amount: 400 },
      { name: "VAT", bps: 500, amount: 50 },
    ];
    const refunded = [
      { name: "VAT", bps: 500, amount: 50 },
      { name: "Old levy", bps: 100, amount: 7 },
    ];
    expect(taxDue(charged, refunded)).toEqual([
      { name: "VAT", bps: 2000, amount: 400 },
      { name: "VAT", bps: 500, amount: 0 },
      { name: "Old levy", bps: 100, amount: -7 },
    ]);
  });

  it("is empty when nothing was charged or refunded", () => {
    expect(taxDue([], [])).toEqual([]);
  });
});
