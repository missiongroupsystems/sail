import { describe, expect, it } from "vitest";
import { sortTaxes, taxRows } from "./tax";

describe("tax rows", () => {
  it("list rates in one order whatever order the register met them in (C-8): lowest rate first, then by name", () => {
    const bill = [
      { name: "VAT 10%", bps: 1000, amount: 151 },
      { name: "VAT 20%", bps: 2000, amount: 1277 },
    ];
    const order = [...bill].reverse();
    expect(taxRows(bill, "inclusive").after.map((r) => r.label)).toEqual(["VAT 10% (included)", "VAT 20% (included)"]);
    expect(taxRows(order, "inclusive").after.map((r) => r.label)).toEqual(taxRows(bill, "inclusive").after.map((r) => r.label));
    expect(sortTaxes([{ name: "State", bps: 625, amount: 1 }, { name: "City", bps: 625, amount: 1 }]).map((t) => t.name)).toEqual(["City", "State"]);
  });

  it("put exclusive tax before the total and inclusive tax after it", () => {
    const t = [{ name: "GST 9%", bps: 900, amount: 115 }];
    expect(taxRows(t, "exclusive")).toMatchObject({ before: [{ label: "GST 9%" }], after: [] });
    expect(taxRows(t, "inclusive")).toMatchObject({ before: [], after: [{ label: "GST 9% (included)" }] });
  });
});
