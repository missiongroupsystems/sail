import { describe, expect, it } from "vitest";
import { refundableQuantity, refundBlocks } from "./report-blocks";

const sales = { gross: 6900, discounts: -1725, fees: 406, taxes: [{ name: "GST 9%", bps: 900, amount: 501 }], net: 4655, total: 6082 };

describe("refundBlocks", () => {
  it("keeps the single block when the register reports no before/after split", () => {
    expect(refundBlocks(sales, { count: 0, amount: 0 }, "exclusive")).toBeNull();
    expect(refundBlocks({ ...sales, net_before_refunds: 5175, total_after_refunds: 5400 }, { count: 1, amount: 682 }, "exclusive")).toBeNull();
  });

  const full = { ...sales, net_before_refunds: 5175, total_after_refunds: 5400 };
  const refunds = { count: 1, amount: 682, net: 520, fees: 52, tax: 110, tips: 100, taxes: [{ name: "GST 9%", bps: 900, amount: 110 }] };

  it("puts every figure in the block for its state, as the register returned it", () => {
    const b = refundBlocks(full, refunds, "exclusive")!;
    expect(b.before.map((r) => [r.key, r.amount])).toEqual([
      ["gross", 6900],
      ["discounts", -1725],
      ["net_before_refunds", 5175],
      ["fees", 406],
      ["tax:0:GST 9%", 501],
      ["total", 6082],
    ]);
    expect(b.refunds.map((r) => [r.key, r.amount])).toEqual([
      ["refunds.net", 520],
      ["refunds.fees", 52],
      ["refunds.tax", 110],
      ["refunds.tax:0:GST 9%", 110],
      ["refunds.amount", 682],
    ]);
    expect(b.tipsBack).toEqual({ key: "refunds.tips", label: "Tips given back", amount: 100 });
    expect(b.after.map((r) => [r.key, r.amount])).toEqual([
      ["net", 4655],
      ["total_after_refunds", 5400],
    ]);
  });

  it("never shows the after-refunds net beside the before-refunds figures", () => {
    const b = refundBlocks(full, refunds, "exclusive")!;
    expect(b.before.some((r) => r.key === "net")).toBe(false);
    expect(b.after.some((r) => r.key === "net_before_refunds" || r.key === "total")).toBe(false);
  });

  it("signs discounts as returned and lists inclusive tax after the total", () => {
    const b = refundBlocks(full, refunds, "inclusive")!;
    expect(b.before.find((r) => r.key === "discounts")).toMatchObject({ amount: -1725, signed: true });
    expect(b.before.at(-1)).toMatchObject({ label: "GST 9% (included)", amount: 501 });
  });

  it("lists the register's tax due by component, and nothing when it does not report it", () => {
    const b = refundBlocks(full, refunds, "exclusive", [{ name: "GST", bps: 900, amount: 410 }])!;
    expect(b.taxDue.map((r) => [r.label, r.amount])).toEqual([["GST due", 410]]);
    expect(refundBlocks(full, refunds, "exclusive")!.taxDue).toEqual([]);
    const two = refundBlocks(full, refunds, "exclusive", [{ name: "GST", bps: 900, amount: 410 }, { name: "GST", bps: 800, amount: -20 }])!;
    expect(two.taxDue.map((r) => r.label)).toEqual(["GST (8%) due", "GST (9%) due"]);
  });
});

describe("refundableQuantity", () => {
  it("is the line's quantity less what this bill already refunded", () => {
    expect(refundableQuantity(3, 1)).toBe(2);
    expect(refundableQuantity(3, undefined)).toBe(3);
    expect(refundableQuantity(2, 2)).toBe(0);
    expect(refundableQuantity(1, 4)).toBe(0);
  });
});

describe("one rate order in every block (F notes)", () => {
  it("lists refunded tax and tax due lowest rate first, as the sales block does", async () => {
    const { refundBlocks } = await import("./report-blocks");
    const sales = { gross: 1000, discounts: 0, fees: 0, total: 1000, net: 800, net_before_refunds: 850, total_after_refunds: 900, taxes: [{ name: "VAT 20%", bps: 2000, amount: 100 }, { name: "VAT 10%", bps: 1000, amount: 50 }] };
    const refunds = { count: 1, amount: 100, net: 50, fees: 0, tax: 10, tips: 0, taxes: [{ name: "VAT 20%", bps: 2000, amount: 6 }, { name: "VAT 10%", bps: 1000, amount: 4 }] };
    const b = refundBlocks(sales, refunds, "inclusive", [{ name: "VAT 20%", bps: 2000, amount: 94 }, { name: "VAT 10%", bps: 1000, amount: 46 }])!;
    const order = (rows: { label: string }[]) => rows.filter((r) => r.label.startsWith("VAT")).map((r) => r.label.replace(" (included)", "").replace(" due", ""));
    expect(order(b.before)).toEqual(["VAT 10%", "VAT 20%"]);
    expect(order(b.refunds)).toEqual(["VAT 10%", "VAT 20%"]);
    expect(order(b.taxDue)).toEqual(["VAT 10%", "VAT 20%"]);
  });
});
