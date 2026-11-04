import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { quoteRefund, RefundError, type RefundableLine, type RefundablePayment } from "./refunds.js";
import { sumCents } from "./money.js";

const none = { quantity: 0, base: 0, discount: 0, fee: 0, gst: 0, total: 0 };
// Laksa ×2 at 1600 with 25% off food, 10% service charge, 9% GST exclusive, on one bill.
const laksa: RefundableLine = { line_id: "laksa", quantity: 2, base: 3200, discount: -800, fee: 240, gst: 216 + 22, total: 3200 - 800 + 240 + 238, adjustments: { promo: { amount: -800, gst: 0 }, sc: { amount: 240, gst: 22 } }, refunded: none };
const kopi: RefundableLine = { line_id: "kopi", quantity: 1, base: 180, discount: 0, fee: 18, gst: 16 + 2, total: 180 + 18 + 18, adjustments: { sc: { amount: 18, gst: 2 } }, refunded: none };
const card: RefundablePayment = { payment_id: "card", tender: "Card", is_cash: false, amount: 2000, refunded: 0 };
const cash: RefundablePayment = { payment_id: "cash", tender: "Cash", is_cash: true, amount: laksa.total + kopi.total - 2000, refunded: 0 };

describe("refund quotes", () => {
  it("a full refund reverses every component and spreads it across the original tenders", () => {
    const q = quoteRefund([laksa, kopi], [card, cash], { kind: "full" }, { cashRoundingIncrement: 5 });
    expect(q.totals.total).toBe(laksa.total + kopi.total);
    expect(q.totals).toMatchObject({ base: 3380, discount: -800, fee: 258, gst: 256 });
    expect(sumCents(q.tenders.map((t) => t.amount))).toBe(q.totals.total);
    expect(q.tenders.find((t) => t.payment_id === "card")!.amount).toBe(2000);
    const cashT = q.tenders.find((t) => t.payment_id === "cash")!;
    expect(cashT.amount).toBe(cash.amount);
    expect(Math.abs(cashT.rounding_cents) * 2).toBeLessThanOrEqual(5);
    expect(q.cash_out).toBe(cashT.amount + cashT.rounding_cents);
  });

  it("refunding one of two laksa reverses half of each component, including the service charge and the promo", () => {
    const q = quoteRefund([laksa, kopi], [card, cash], { kind: "lines", lines: [{ line_id: "laksa", quantity: 1 }] });
    const l = q.lines[0]!;
    expect(l).toMatchObject({ quantity: 1, base: 1600, discount: -400, fee: 120, gst: 119, total: 1439 });
    expect(l.adjustments["sc"]!.amount).toBe(120);
    expect(l.adjustments["promo"]!.amount).toBe(-400);
    expect(l.base + l.discount + l.fee + l.gst).toBe(l.total);
  });

  it("refuses more than the remaining quantity and tracks what was already refunded", () => {
    const half: RefundableLine = { ...laksa, refunded: { quantity: 1, base: 1600, discount: -400, fee: 120, gst: 119, total: 1439 } };
    expect(() => quoteRefund([half], [card, cash], { kind: "lines", lines: [{ line_id: "laksa", quantity: 2 }] })).toThrow(RefundError);
    const rest = quoteRefund([half], [card, cash], { kind: "lines", lines: [{ line_id: "laksa", quantity: 1 }] });
    expect(rest.lines[0]!.total).toBe(laksa.total - 1439);
    expect(rest.lines[0]!.gst).toBe(238 - 119);
  });

  it("a goodwill amount is spread across lines in proportion and keeps GST consistent", () => {
    const q = quoteRefund([laksa, kopi], [card, cash], { kind: "amount", amount: 1000 });
    expect(q.totals.total).toBe(1000);
    expect(q.lines.every((l) => l.quantity === 0)).toBe(true);
    for (const l of q.lines) expect(l.base + l.discount + l.fee + l.gst).toBe(l.total);
    const laksaShare = q.lines.find((l) => l.line_id === "laksa")!;
    expect(laksaShare.total).toBe(Math.round((1000 * laksa.total) / (laksa.total + kopi.total)));
    expect(() => quoteRefund([laksa, kopi], [card, cash], { kind: "amount", amount: 999_999 })).toThrow(/can still be refunded/);
  });

  it("an explicit tender split is honoured and capped per payment", () => {
    const q = quoteRefund([kopi], [card, cash], { kind: "full" }, { tenderSplit: [{ payment_id: "card", amount: 216 }] });
    expect(q.tenders).toEqual([{ payment_id: "card", tender: "Card", is_cash: false, amount: 216, rounding_cents: 0 }]);
    expect(() => quoteRefund([kopi], [{ ...card, refunded: 1900 }], { kind: "full" }, { tenderSplit: [{ payment_id: "card", amount: 216 }] })).toThrow(/can return at most/);
    expect(() => quoteRefund([kopi], [card], { kind: "full" }, { tenderSplit: [{ payment_id: "card", amount: 100 }] })).toThrow(/add up to/);
  });

  it("property: refunds never exceed a line's components, totals add up, and a full refund nets everything to zero", () => {
    const arbLine = (id: string) =>
      fc.record({ quantity: fc.integer({ min: 1, max: 6 }), base: fc.integer({ min: 0, max: 50_000 }), disc: fc.integer({ min: 0, max: 20_000 }), fee: fc.integer({ min: 0, max: 5000 }), gst: fc.integer({ min: 0, max: 5000 }) }).map((r): RefundableLine => {
        const discount = -Math.min(r.disc, r.base);
        const total = r.base + discount + r.fee + r.gst;
        return { line_id: id, quantity: r.quantity, base: r.base, discount, fee: r.fee, gst: r.gst, total, adjustments: { f: { amount: r.fee, gst: Math.floor(r.gst / 3) }, d: { amount: discount, gst: 0 } }, refunded: none };
      });
    fc.assert(
      fc.property(fc.tuple(arbLine("a"), arbLine("b"), arbLine("c")), fc.integer({ min: 1, max: 6 }), (lines, qty) => {
        const total = sumCents(lines.map((l) => l.total));
        if (total <= 0) return;
        const pay: RefundablePayment = { payment_id: "p", tender: "Card", is_cash: false, amount: total, refunded: 0 };
        const full = quoteRefund(lines, [pay], { kind: "full" });
        expect(full.totals.total).toBe(total);
        expect(full.totals.base).toBe(sumCents(lines.map((l) => l.base)));
        expect(full.totals.gst).toBe(sumCents(lines.map((l) => l.gst)));
        expect(full.tenders[0]!.amount).toBe(total);
        const a = lines[0]!;
        const q = Math.min(qty, a.quantity);
        const part = quoteRefund(lines, [pay], { kind: "lines", lines: [{ line_id: "a", quantity: q }] });
        const l = part.lines[0]!;
        expect(Math.abs(l.base)).toBeLessThanOrEqual(Math.abs(a.base));
        expect(Math.abs(l.fee)).toBeLessThanOrEqual(Math.abs(a.fee));
        expect(Math.abs(l.gst)).toBeLessThanOrEqual(Math.abs(a.gst));
        expect(Math.abs(l.total)).toBeLessThanOrEqual(Math.abs(a.total));
        expect(l.base + l.discount + l.fee + l.gst).toBe(l.total);
        if (q === a.quantity) expect(l.total).toBe(a.total);
      }),
      { numRuns: 300 },
    );
  });
});
