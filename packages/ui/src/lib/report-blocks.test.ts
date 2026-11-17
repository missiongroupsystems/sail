import { describe, expect, it } from "vitest";
import { refundableQuantity, refundBlocks, reversedRows, showsCardNet, tenderRows } from "./report-blocks";

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

describe("tax inside prices (review 3, R5)", () => {
  const refunds = { count: 0, amount: 0, net: 0, fees: 0, tax: 0, tips: 0, taxes: [] };
  it("a VAT-inclusive report takes the tax in prices out between discounts and net, so the rows add up as written", () => {
    const b = refundBlocks({ gross: 9895, discounts: 0, fees: 0, taxes: [{ name: "VAT 10%", bps: 1000, amount: 600 }, { name: "VAT 20%", bps: 2000, amount: 550 }], net: 8745, total: 9895, net_before_refunds: 8745, total_after_refunds: 9895, tax_in_prices: 1150 }, refunds, "inclusive")!;
    expect(b.before.map((r) => r.key).slice(0, 4)).toEqual(["gross", "discounts", "tax_in_prices", "net_before_refunds"]);
    expect(b.before[2]!.amount).toBe(-1150);
  });
  it("tax on top has no such row", () => {
    const b = refundBlocks({ gross: 1000, discounts: 0, fees: 0, taxes: [], net: 1000, total: 1085, net_before_refunds: 1000, total_after_refunds: 1085, tax_in_prices: 0 }, refunds, "exclusive")!;
    expect(b.before.some((r) => r.key === "tax_in_prices")).toBe(false);
  });
  it("the card-net hint shows only with a card terminal's net row", () => {
    expect(showsCardNet([{ tender_type_id: "c", tender: "Card (terminal)", is_cash: false, terminal: true, count: 2, amount: 4713, rounding: 0, tips: 0, refunds: 0, net: 4713 }])).toBe(false);
    expect(showsCardNet([{ tender_type_id: "c", tender: "Card (terminal)", is_cash: false, terminal: true, count: 2, amount: 4713, rounding: 0, tips: 200, refunds: 0, net: 4913 }])).toBe(true);
    // A keyed card has a net, but no integrated terminal to compare it with.
    expect(showsCardNet([{ tender_type_id: "k", tender: "Card", is_cash: false, count: 2, amount: 4713, rounding: 0, tips: 200, refunds: 0, net: 4913 }])).toBe(false);
  });
});

/** Adds a block's rows the way a reader does, top to bottom: each strong row must equal the unindented rows above it since the last strong row (or, for a strong row followed by indented rows, the sum of those rows). */
function readsAsWritten(rows: { amount: number; strong?: boolean; indent?: boolean }[]) {
  let running = 0;
  rows.forEach((r, i) => {
    if (r.indent) return;
    if (r.strong) {
      expect(r.amount, `row ${i}`).toBe(running);
      const parts = rows.slice(i + 1);
      const end = parts.findIndex((x) => !x.indent);
      const breakdown = parts.slice(0, end === -1 ? parts.length : end);
      if (breakdown.length) expect(breakdown.reduce((s, x) => s + x.amount, 0), `breakdown of row ${i}`).toBe(r.amount);
      running = r.amount;
    } else running += r.amount;
  });
}

describe("the Sales and Z-report blocks read top to bottom as sums (review 4, T3)", () => {
  const none = { count: 0, amount: 0, net: 0, fees: 0, tax: 0, tips: 0, taxes: [] };
  it("tax in prices (the café, A P3 / C 3): Gross €2,316.40 − Discounts €0.00 + Fees €0.00 = Collected €2,316.40 = net €2,023.09 + VAT €111.31 + €182.00", () => {
    const b = refundBlocks({ gross: 231640, discounts: 0, fees: 0, fees_charged: 0, taxes: [{ name: "VAT 20%", bps: 2000, amount: 18200 }, { name: "VAT 10%", bps: 1000, amount: 11131 }], net: 197848, total: 231640, net_before_refunds: 202309, total_after_refunds: 226645, tax_in_prices: 29331 }, none, "inclusive")!;
    expect(b.before.map((r) => [r.label, r.amount, Boolean(r.strong), Boolean(r.indent)])).toEqual([
      ["Gross (items)", 231640, false, false],
      ["Discounts", 0, false, false],
      ["Fees", 0, false, false],
      ["Collected", 231640, true, false],
      ["Of which net before refunds", 202309, false, true],
      ["Of which VAT 10%", 11131, false, true],
      ["Of which VAT 20%", 18200, false, true],
    ]);
    readsAsWritten(b.before);
    expect(202309 + 11131 + 18200).toBe(231640);
  });
  it("tax in prices with a discount and a fee: €100.00 − €10.00 + €5.50 = €95.50 = €86.82 net + €5.00 fee + €3.68 VAT", () => {
    // The fee is €5.50 with 10% VAT inside it (€0.50); the items' VAT is €3.18 of the €90.00.
    const b = refundBlocks({ gross: 10000, discounts: -1000, fees: 500, fees_charged: 550, taxes: [{ name: "VAT 10%", bps: 1000, amount: 368 }], net: 8682, total: 9550, net_before_refunds: 8682, total_after_refunds: 9550, tax_in_prices: 318 }, none, "inclusive")!;
    expect(b.before.map((r) => [r.key, r.amount])).toEqual([
      ["gross", 10000],
      ["discounts", -1000],
      ["fees_charged", 550],
      ["total", 9550],
      ["net_before_refunds", 8682],
      ["fees", 500],
      ["tax:0:VAT 10%", 368],
    ]);
    readsAsWritten(b.before);
  });
  it("tax on top (the diner): Gross $218.09 − $6.64 = net $211.45, + fees $0.00 + tax $8.38 + $9.42 = Collected $229.25", () => {
    const b = refundBlocks({ gross: 21809, discounts: -664, fees: 0, fees_charged: 0, taxes: [{ name: "State", bps: 400, amount: 838 }, { name: "Local", bps: 450, amount: 942 }], net: 21145, total: 22925, net_before_refunds: 21145, total_after_refunds: 22925, tax_in_prices: 0 }, none, "exclusive")!;
    expect(b.before.map((r) => r.key)).toEqual(["gross", "discounts", "net_before_refunds", "fees", "tax:0:State", "tax:1:Local", "total"]);
    // Net before refunds is a subtotal; Collected adds fees and tax to it.
    expect(21809 - 664).toBe(21145);
    expect(21145 + 0 + 838 + 942).toBe(22925);
    readsAsWritten(b.before);
  });
  it("an older stored report with no fees as charged keeps the previous layout", () => {
    const b = refundBlocks({ gross: 9895, discounts: 0, fees: 0, taxes: [{ name: "VAT 10%", bps: 1000, amount: 600 }], net: 9295, total: 9895, net_before_refunds: 9295, total_after_refunds: 9895, tax_in_prices: 600 }, none, "inclusive")!;
    expect(b.before.map((r) => r.key)).toContain("tax_in_prices");
  });
});

describe("tender rows (review 4, T3 / A P4)", () => {
  const terminal = { tender_type_id: "t", tender: "Card (terminal)", is_cash: false, terminal: true, count: 5, amount: 7652, rounding: 0, tips: 852, refunds: 324, reversed: 324, net: 8180 };
  const keyed = { tender_type_id: "k", tender: "Card", is_cash: false, count: 2, amount: 4310, rounding: 0, tips: 254, refunds: 0, reversed: 0, net: 4564 };
  it("only the terminal's net says it is what the terminal shows; the net adds up from the rows above it", () => {
    expect(tenderRows(terminal).map((r) => [r.label, r.amount])).toEqual([
      ["Card (terminal) (5)", 7652],
      ["Tips", 852],
      ["Refunded", -324],
      ["Card (terminal) net, as the terminal shows", 8180],
    ]);
    expect(7652 + 852 - 324).toBe(8180);
    expect(tenderRows(keyed).at(-1)!.label).toBe("Card net");
  });
  it("a payment taken and reversed is not set under the net: it has its own rows, unsigned and not indented", () => {
    expect(tenderRows(terminal).some((r) => r.key.endsWith(":reversed"))).toBe(false);
    expect(reversedRows([terminal, keyed])).toEqual([{ key: "t:reversed", label: "Card (terminal) taken and reversed", amount: 324 }]);
  });
});
