import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { quoteRefund, RefundError, type RefundableLine, type RefundablePayment } from "./refunds.js";
import { roundCash, sumCents } from "./money.js";
import type { TaxAmount } from "./pricing/schemas.js";

/** The Singapore preset's single tax component, as a line's tax breakdown. */
const sgTax = (amount: number): TaxAmount[] => [{ name: "GST 9%", bps: 900, amount }];

const none = { quantity: 0, base: 0, discount: 0, fee: 0, taxes: [], total: 0 };
// Laksa ×2 at 1600 with 25% off food, 10% service charge, 9% GST exclusive, on one bill.
const laksa: RefundableLine = { line_id: "laksa", quantity: 2, base: 3200, discount: -800, fee: 240, taxes: sgTax(216 + 22), total: 3200 - 800 + 240 + 238, adjustments: { promo: { amount: -800, tax: 0 }, sc: { amount: 240, tax: 22 } }, refunded: none };
const kopi: RefundableLine = { line_id: "kopi", quantity: 1, base: 180, discount: 0, fee: 18, taxes: sgTax(16 + 2), total: 180 + 18 + 18, adjustments: { sc: { amount: 18, tax: 2 } }, refunded: none };
const card: RefundablePayment = { payment_id: "card", tender: "Card", is_cash: false, amount: 2000, refunded: 0 };
const cash: RefundablePayment = { payment_id: "cash", tender: "Cash", is_cash: true, amount: laksa.total + kopi.total - 2000, refunded: 0 };

describe("refund quotes", () => {
  it("a full refund reverses every component and spreads it across the original tenders", () => {
    const q = quoteRefund([laksa, kopi], [card, cash], { kind: "full" }, { cashRoundingIncrement: 5 });
    expect(q.totals.total).toBe(laksa.total + kopi.total);
    expect(q.totals).toMatchObject({ base: 3380, discount: -800, fee: 258, tax: 256 });
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
    expect(l).toMatchObject({ quantity: 1, base: 1600, discount: -400, fee: 120, tax: 119, total: 1439 });
    expect(l.adjustments["sc"]!.amount).toBe(120);
    expect(l.adjustments["promo"]!.amount).toBe(-400);
    expect(l.base + l.discount + l.fee + l.tax).toBe(l.total);
  });

  it("a second refund by amount takes its share of what is left on the line, not of the line as sold", () => {
    // Base 1000 + GST 90 = 1090. Refund 545 (half): tax 45. Then 272 of the 545 left: 272/545 of the 45 left = 22.46 → 22, not all 45.
    const line: RefundableLine = { line_id: "l", quantity: 1, base: 1000, discount: 0, fee: 0, taxes: sgTax(90), total: 1090, adjustments: {}, refunded: none };
    const pay: RefundablePayment = { payment_id: "card", tender: "Card", is_cash: false, amount: 1090, refunded: 0 };
    const first = quoteRefund([line], [pay], { kind: "amount", amount: 545 }).lines[0]!;
    expect(first).toMatchObject({ base: 500, tax: 45, total: 545 });
    const after: RefundableLine = { ...line, refunded: { quantity: 0, base: first.base, discount: 0, fee: 0, taxes: first.taxes, total: first.total } };
    const second = quoteRefund([after], [{ ...pay, refunded: 545 }], { kind: "amount", amount: 272 }).lines[0]!;
    expect(second).toMatchObject({ base: 250, tax: 22, total: 272 });
  });

  it("refuses more than the remaining quantity and tracks what was already refunded", () => {
    const half: RefundableLine = { ...laksa, refunded: { quantity: 1, base: 1600, discount: -400, fee: 120, taxes: sgTax(119), total: 1439 } };
    expect(() => quoteRefund([half], [card, cash], { kind: "lines", lines: [{ line_id: "laksa", quantity: 2 }] })).toThrow(RefundError);
    const rest = quoteRefund([half], [card, cash], { kind: "lines", lines: [{ line_id: "laksa", quantity: 1 }] });
    expect(rest.lines[0]!.total).toBe(laksa.total - 1439);
    expect(rest.lines[0]!.tax).toBe(238 - 119);
  });

  it("a goodwill amount is spread across lines in proportion and keeps GST consistent", () => {
    const q = quoteRefund([laksa, kopi], [card, cash], { kind: "amount", amount: 1000 });
    expect(q.totals.total).toBe(1000);
    expect(q.lines.every((l) => l.quantity === 0)).toBe(true);
    for (const l of q.lines) expect(l.base + l.discount + l.fee + l.tax).toBe(l.total);
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
      fc.record({ quantity: fc.integer({ min: 1, max: 6 }), base: fc.integer({ min: 0, max: 50_000 }), disc: fc.integer({ min: 0, max: 20_000 }), fee: fc.integer({ min: 0, max: 5000 }), tax: fc.integer({ min: 0, max: 5000 }) }).map((r): RefundableLine => {
        const discount = -Math.min(r.disc, r.base);
        const total = r.base + discount + r.fee + r.tax;
        return { line_id: id, quantity: r.quantity, base: r.base, discount, fee: r.fee, taxes: sgTax(r.tax), total, adjustments: { f: { amount: r.fee, tax: Math.floor(r.tax / 3) }, d: { amount: discount, tax: 0 } }, refunded: none };
      });
    fc.assert(
      fc.property(fc.tuple(arbLine("a"), arbLine("b"), arbLine("c")), fc.integer({ min: 1, max: 6 }), (lines, qty) => {
        const total = sumCents(lines.map((l) => l.total));
        if (total <= 0) return;
        const pay: RefundablePayment = { payment_id: "p", tender: "Card", is_cash: false, amount: total, refunded: 0 };
        const full = quoteRefund(lines, [pay], { kind: "full" });
        expect(full.totals.total).toBe(total);
        expect(full.totals.base).toBe(sumCents(lines.map((l) => l.base)));
        expect(full.totals.tax).toBe(sumCents(lines.map((l) => sumCents(l.taxes.map((t) => t.amount)))));
        expect(full.tenders[0]!.amount).toBe(total);
        const a = lines[0]!;
        const q = Math.min(qty, a.quantity);
        const part = quoteRefund(lines, [pay], { kind: "lines", lines: [{ line_id: "a", quantity: q }] });
        const l = part.lines[0]!;
        expect(Math.abs(l.base)).toBeLessThanOrEqual(Math.abs(a.base));
        expect(Math.abs(l.fee)).toBeLessThanOrEqual(Math.abs(a.fee));
        expect(Math.abs(l.tax)).toBeLessThanOrEqual(Math.abs(sumCents(a.taxes.map((t) => t.amount))));
        expect(Math.abs(l.total)).toBeLessThanOrEqual(Math.abs(a.total));
        expect(l.base + l.discount + l.fee + l.tax).toBe(l.total);
        if (q === a.quantity) expect(l.total).toBe(a.total);
      }),
      { numRuns: 300 },
    );
  });
});

/** Apply a quote to a line and its payments, as the server does when it records the refund. */
function apply(l: RefundableLine, pays: RefundablePayment[], q: ReturnType<typeof quoteRefund>): RefundableLine {
  const r = q.lines.find((x) => x.line_id === l.line_id);
  for (const t of q.tenders) {
    const p = pays.find((x) => x.payment_id === t.payment_id)!;
    p.refunded += t.amount;
    p.refunded_rounding = (p.refunded_rounding ?? 0) + t.rounding_cents;
  }
  if (!r) return l;
  const taxes = l.refunded.taxes.map((t) => ({ ...t }));
  for (const t of r.taxes) {
    const cur = taxes.find((x) => x.name === t.name && x.bps === t.bps);
    if (cur) cur.amount += t.amount;
    else taxes.push({ ...t });
  }
  return { ...l, refunded: { quantity: l.refunded.quantity + r.quantity, base: l.refunded.base + r.base, discount: l.refunded.discount + r.discount, fee: l.refunded.fee + r.fee, taxes, total: l.refunded.total + r.total } };
}

describe("money review: refunds that leak or strand money", () => {
  it("refunding every unit of a line one at a time gives back the whole line, the last unit taking the remainder", () => {
    // 3 × 10.04 + GST: 3012 + 271 = 3283. Each unit as sold is 1094.33, so three unit refunds used to return 3282.
    let l: RefundableLine = { line_id: "L", quantity: 3, base: 3012, discount: 0, fee: 0, taxes: sgTax(271), total: 3283, adjustments: {}, refunded: none };
    const pays: RefundablePayment[] = [{ payment_id: "P", tender: "Card", is_cash: false, amount: 3283, refunded: 0 }];
    for (let i = 0; i < 3; i++) l = apply(l, pays, quoteRefund([l], pays, { kind: "lines", lines: [{ line_id: "L", quantity: 1 }] }));
    expect(l.refunded).toMatchObject({ quantity: 3, base: 3012, total: 3283 });
    expect(l.refunded.taxes).toEqual(sgTax(271));
  });

  it("property: unit by unit, every line comes back whole", () => {
    fc.assert(
      fc.property(fc.integer({ min: 2, max: 7 }), fc.integer({ min: 1, max: 99_999 }), fc.integer({ min: 0, max: 2000 }), (quantity, unit, bps) => {
        const base = unit * quantity;
        const tax = Math.round((base * bps) / 10_000);
        let l: RefundableLine = { line_id: "L", quantity, base, discount: 0, fee: 0, taxes: sgTax(tax), total: base + tax, adjustments: {}, refunded: none };
        const pays: RefundablePayment[] = [{ payment_id: "P", tender: "Card", is_cash: false, amount: base + tax, refunded: 0 }];
        for (let i = 0; i < quantity; i++) l = apply(l, pays, quoteRefund([l], pays, { kind: "lines", lines: [{ line_id: "L", quantity: 1 }] }));
        expect(l.refunded.total).toBe(l.total);
        expect(l.refunded.base).toBe(l.base);
      }),
    );
  });

  it("a tender split naming one payment twice is checked against that payment once", () => {
    const l: RefundableLine = { line_id: "L", quantity: 1, base: 1000, discount: 0, fee: 0, taxes: sgTax(90), total: 1090, adjustments: {}, refunded: none };
    const pays: RefundablePayment[] = [
      { payment_id: "CARD", tender: "Card", is_cash: false, amount: 545, refunded: 0 },
      { payment_id: "CASH", tender: "Cash", is_cash: true, amount: 545, refunded: 0 },
    ];
    expect(() => quoteRefund([l], pays, { kind: "full" }, { tenderSplit: [{ payment_id: "CARD", amount: 545 }, { payment_id: "CARD", amount: 545 }] })).toThrow(/at most 545/);
    const q = quoteRefund([l], pays, { kind: "full" }, { tenderSplit: [{ payment_id: "CARD", amount: 300 }, { payment_id: "CARD", amount: 245 }, { payment_id: "CASH", amount: 545 }] });
    expect(q.tenders.map((t) => [t.payment_id, t.amount])).toEqual([["CARD", 545], ["CASH", 545]]);
  });

  it("cash rounding on repeated small refunds never hands out more cash than the payment took", () => {
    // 10.02 paid in cash and rounded to 10.00 at the till (amount 1002, rounding -2). 0.03 at a time used to hand out 0.05 each.
    let l: RefundableLine = { line_id: "L", quantity: 1, base: 1002, discount: 0, fee: 0, taxes: [], total: 1002, adjustments: {}, refunded: none };
    const pays: RefundablePayment[] = [{ payment_id: "P", tender: "Cash", is_cash: true, amount: 1002, rounding: -2, refunded: 0 }];
    let cashOut = 0;
    while (l.total - l.refunded.total > 0) {
      const q = quoteRefund([l], pays, { kind: "amount", amount: Math.min(3, l.total - l.refunded.total) }, { cashRoundingIncrement: 5 });
      expect(q.cash_out).toBeGreaterThanOrEqual(0);
      expect(q.cash_out % 5).toBe(0);
      cashOut += q.cash_out;
      l = apply(l, pays, q);
      expect(cashOut).toBeLessThanOrEqual(1000);
    }
    expect(cashOut).toBe(1000);
  });

  it("property: across any sequence of cash refunds, the cash handed back ends exactly at the cash taken", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 50_000 }), fc.constantFrom(5, 10, 100), fc.array(fc.integer({ min: 1, max: 5000 }), { minLength: 1, maxLength: 30 }), (amount, inc, steps) => {
        const rounding = roundCash(amount, inc).roundingCents;
        let l: RefundableLine = { line_id: "L", quantity: 1, base: amount, discount: 0, fee: 0, taxes: [], total: amount, adjustments: {}, refunded: none };
        const pays: RefundablePayment[] = [{ payment_id: "P", tender: "Cash", is_cash: true, amount, rounding, refunded: 0 }];
        const taken = amount + rounding;
        let out = 0;
        for (const s of [...steps, amount]) {
          const left = l.total - l.refunded.total;
          if (left <= 0) break;
          const q = quoteRefund([l], pays, { kind: "amount", amount: Math.min(s, left) }, { cashRoundingIncrement: inc });
          out += q.cash_out;
          l = apply(l, pays, q);
          expect(out).toBeLessThanOrEqual(taken);
        }
        expect(out).toBe(taken);
      }),
    );
  });
});
