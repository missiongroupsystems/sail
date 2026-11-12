import { describe, expect, it } from "vitest";
import { sumCents } from "./money.js";
import { allocateLine, evenShares, sharedAmong, sumAllocations, wholeTo } from "./splits.js";
import { quoteRefund, RefundError, type RefundableLine, type RefundablePayment } from "./refunds.js";
import type { TaxAmount } from "./pricing/schemas.js";

/**
 * Hand-worked reference cases for bill splitting (`allocateLine`) and refund
 * quotes (`quoteRefund`). Every expected cent is derived in the comment above
 * the assertion so a second person can check it by reading, not by running.
 *
 * Rounding rule used throughout (allocateLargestRemainder): each part is
 * floored, then the leftover cents go one each to the parts with the largest
 * fractional remainder. Ties (every part of an even split) go to the check that
 * is furthest under its exact share of the components so far (base, discount,
 * fee, then tax in exclusive mode), then to the EARLIER check. Negative amounts
 * (discounts) are allocated by absolute value and the sign re-applied, and their
 * extra cent goes to the check furthest OVER its share, so a discount's odd cent
 * evens out the base's.
 *
 * The three-line dine-in bill (exclusive GST 9%, service charge 10%):
 *   L1 chicken rice 450 × 2 = 900; SC 90; GST 81 on the net + 8 on the SC = 89; total 1079.
 *   L2 beer 1300 × 1, happy hour −130 → 1170; SC 117; GST 105 (105.3) + 11 (10.53) = 116; total 1403.
 *   L3 satay 80 × 5 = 400; SC 40; GST 36 + 4 (3.6) = 40; total 480.
 *   Bill total 1079 + 1403 + 480 = 2962.
 */

/** The Singapore preset's single tax component, as a line's tax breakdown. */
const sgTax = (amount: number): TaxAmount[] => [{ name: "GST 9%", bps: 900, amount }];

const L1 = { base: 900, discount: 0, fee: 90, taxes: sgTax(89), adjustments: { sc: { amount: 90, tax: 8 } } };
const L2 = { base: 1300, discount: -130, fee: 117, taxes: sgTax(116), adjustments: { hh: { amount: -130, tax: 0 }, sc: { amount: 117, tax: 11 } } };
const L3 = { base: 400, discount: 0, fee: 40, taxes: sgTax(40), adjustments: { sc: { amount: 40, tax: 4 } } };
/** An inclusive-mode line: kopi 1090 with GST 90 inside, SC 109 with GST 9 inside; total 1199 (GST reported, not added). */
const KOPI_INCL = { base: 1090, discount: 0, fee: 109, taxes: sgTax(99), adjustments: { sc: { amount: 109, tax: 9 } } };

const EXCL = { taxAddsToTotal: true };
const INCL = { taxAddsToTotal: false };

describe("bill splitting reference (allocateLine)", () => {
  it("S01: L1 (1079) split evenly in 2: base 450/450, fee 45/45, GST 44.5 → 45/44; totals 540/539, the extra cent on the first check", () => {
    const parts = allocateLine(L1, evenShares(2), EXCL);
    expect(parts.map((p) => p.base)).toEqual([450, 450]);
    expect(parts.map((p) => p.fee)).toEqual([45, 45]);
    expect(parts.map((p) => p.tax)).toEqual([45, 44]);
    expect(parts.map((p) => p.total)).toEqual([450 + 45 + 45, 450 + 45 + 44]);
    expect(sumAllocations(parts)).toBe(1079);
  });

  it("S02: L1 split in 3: base 300 each, fee 30 each, GST 89/3 = 29.67 → floors 29 × 3 = 87, two leftover cents to checks 1 and 2 → 30/30/29; totals 360/360/359", () => {
    const parts = allocateLine(L1, evenShares(3), EXCL);
    expect(parts.map((p) => p.base)).toEqual([300, 300, 300]);
    expect(parts.map((p) => p.fee)).toEqual([30, 30, 30]);
    expect(parts.map((p) => p.tax)).toEqual([30, 30, 29]);
    expect(parts.map((p) => p.total)).toEqual([360, 360, 359]);
    // The service-charge adjustment is allocated on its own: 90/3 = 30 each, its GST 8/3 = 2.67 → 3/3/2.
    expect(parts.map((p) => p.adjustments["sc"]!.amount)).toEqual([30, 30, 30]);
    expect(parts.map((p) => p.adjustments["sc"]!.tax)).toEqual([3, 3, 2]);
    expect(sumAllocations(parts)).toBe(1079);
  });

  it("S03: L1 split in 4: base 225 each; fee 90/4 = 22.5 → 22 × 4 = 88, two leftover cents to checks 1 and 2 → 23/23/22/22; GST 89/4 = 22.25 → the one leftover cent to check 3, the first still under its share → 22/22/23/22; totals 270/270/270/269", () => {
    const parts = allocateLine(L1, evenShares(4), EXCL);
    expect(parts.map((p) => p.base)).toEqual([225, 225, 225, 225]);
    expect(parts.map((p) => p.fee)).toEqual([23, 23, 22, 22]);
    expect(parts.map((p) => p.tax)).toEqual([22, 22, 23, 22]);
    expect(parts.map((p) => p.total)).toEqual([225 + 23 + 22, 225 + 23 + 22, 225 + 22 + 23, 225 + 22 + 22]);
    expect(parts.map((p) => p.adjustments["sc"]!.tax)).toEqual([2, 2, 2, 2]);
    expect(sumAllocations(parts)).toBe(1079);
  });

  it("S04: L2 (discounted beer) split in 3: base 1300/3 → 434/433/433, discount −130/3 → −44/−43/−43 (extra cent of discount also to check 1), fee 39 each, GST 116/3 → 39/39/38; totals 468/468/467", () => {
    const parts = allocateLine(L2, evenShares(3), EXCL);
    expect(parts.map((p) => p.base)).toEqual([434, 433, 433]);
    expect(parts.map((p) => p.discount)).toEqual([-44, -43, -43]);
    expect(parts.map((p) => p.fee)).toEqual([39, 39, 39]);
    expect(parts.map((p) => p.tax)).toEqual([39, 39, 38]);
    expect(parts.map((p) => p.total)).toEqual([434 - 44 + 39 + 39, 433 - 43 + 39 + 39, 433 - 43 + 39 + 38]);
    expect(parts.map((p) => p.adjustments["hh"]!.amount)).toEqual([-44, -43, -43]);
    expect(parts.map((p) => p.adjustments["sc"]!.amount)).toEqual([39, 39, 39]);
    // SC GST 11/3 = 3.67 → floors 3 × 3 = 9, two leftover cents → 4/4/3.
    expect(parts.map((p) => p.adjustments["sc"]!.tax)).toEqual([4, 4, 3]);
    expect(sumAllocations(parts)).toBe(1403);
  });

  it("S05: the whole bill split evenly in 3, one balance across the lines: L1 360/360/359 (check 3 is a cent under); L2's odd base cent goes to check 3 (433/433/434), its odd discount cent to check 1, now over (−44/−43/−43), GST 39/39/38 → 467/468/468; L3 base 134/133/133, fee 13/13/14, GST 14/13/13 → 161/159/160; checks 988/987/987 add to 2962, a cent apart at most (one balance per line would give 990/987/985)", () => {
    const balance = [0, 0, 0];
    const l1 = allocateLine(L1, evenShares(3), { ...EXCL, balance });
    const l2 = allocateLine(L2, evenShares(3), { ...EXCL, balance });
    const l3 = allocateLine(L3, evenShares(3), { ...EXCL, balance });
    expect(l1.map((p) => p.total)).toEqual([360, 360, 359]);
    expect(l2.map((p) => p.base)).toEqual([433, 433, 434]);
    expect(l2.map((p) => p.discount)).toEqual([-44, -43, -43]);
    expect(l2.map((p) => p.total)).toEqual([467, 468, 468]);
    expect(l3.map((p) => p.base)).toEqual([134, 133, 133]);
    expect(l3.map((p) => p.fee)).toEqual([13, 13, 14]);
    expect(l3.map((p) => p.tax)).toEqual([14, 13, 13]);
    expect(l3.map((p) => p.total)).toEqual([161, 159, 160]);
    const checks = [0, 1, 2].map((i) => l1[i]!.total + l2[i]!.total + l3[i]!.total);
    expect(checks).toEqual([988, 987, 987]);
    expect(checks[0]! + checks[1]! + checks[2]!).toBe(2962);
  });

  it("S06: the beer shared by checks 1 and 3 of 3: base 650/0/650, discount −65/0/−65, fee 117/2 = 58.5 → 59/0/58, GST 58/0/58; totals 702/0/701", () => {
    const parts = allocateLine(L2, sharedAmong(3, [0, 2]), EXCL);
    expect(parts.map((p) => p.base)).toEqual([650, 0, 650]);
    // The non-participating check's discount share is zero cents; the allocator re-applies the sign of a negative total, so JavaScript holds it as -0 (+ 0 normalises it).
    expect(parts.map((p) => p.discount + 0)).toEqual([-65, 0, -65]);
    expect(parts.map((p) => p.fee)).toEqual([59, 0, 58]);
    expect(parts.map((p) => p.tax)).toEqual([58, 0, 58]);
    expect(parts.map((p) => p.total)).toEqual([650 - 65 + 59 + 58, 0, 650 - 65 + 58 + 58]);
    expect(parts[1]!.adjustments["sc"]).toEqual({ amount: 0, tax: 0 });
    expect(sumAllocations(parts)).toBe(1403);
  });

  it("S07: a whole inclusive-mode line to check 2 of 3: every component lands on that check, total 1090 + 109 = 1199 with GST 99 reported", () => {
    const parts = allocateLine(KOPI_INCL, wholeTo(3, 1), INCL);
    expect(parts.map((p) => p.base)).toEqual([0, 1090, 0]);
    expect(parts.map((p) => p.fee)).toEqual([0, 109, 0]);
    expect(parts.map((p) => p.tax)).toEqual([0, 99, 0]);
    expect(parts.map((p) => p.total)).toEqual([0, 1199, 0]);
    expect(sumAllocations(parts)).toBe(1199);
  });

  it("S08: the same components split in 2 under both tax modes: base 545/545, fee 109 → 55/54, GST 99 → 49/50 (check 2 is the one under its share); exclusive totals 649/649 (1298), inclusive 600/599 (1199, tax reported, not added)", () => {
    const ex = allocateLine(KOPI_INCL, evenShares(2), EXCL);
    const inc = allocateLine(KOPI_INCL, evenShares(2), INCL);
    expect(ex.map((p) => p.fee)).toEqual([55, 54]);
    expect(ex.map((p) => p.tax)).toEqual([49, 50]);
    expect(ex.map((p) => p.total)).toEqual([545 + 55 + 49, 545 + 54 + 50]);
    expect(sumAllocations(ex)).toBe(1090 + 109 + 99);
    expect(inc.map((p) => p.tax)).toEqual([49, 50]);
    expect(inc.map((p) => p.total)).toEqual([545 + 55, 545 + 54]);
    expect(sumAllocations(inc)).toBe(1090 + 109);
  });

  it("S09: explicit 2/3 : 1/3 : 0 shares of the satay: base 400 → 266.67/133.33 → 267/133/0, fee 40 → 27/13/0, GST 40 → 27/13/0; totals 321/159/0", () => {
    const parts = allocateLine(L3, [{ num: 2, den: 3 }, { num: 1, den: 3 }, { num: 0, den: 1 }], EXCL);
    expect(parts.map((p) => p.base)).toEqual([267, 133, 0]);
    expect(parts.map((p) => p.fee)).toEqual([27, 13, 0]);
    expect(parts.map((p) => p.tax)).toEqual([27, 13, 0]);
    expect(parts.map((p) => p.total)).toEqual([267 + 27 + 27, 133 + 13 + 13, 0]);
    expect(sumAllocations(parts)).toBe(480);
  });

  it("S10: an odd-cent discount split in 2: −333 → |333|/2 = 166.5 → 167/166 → −167/−166, so the first check pays one cent LESS (363 vs 364)", () => {
    const parts = allocateLine({ base: 1000, discount: -333, fee: 0, taxes: sgTax(60), adjustments: { promo: { amount: -333, tax: 0 } } }, evenShares(2), EXCL);
    expect(parts.map((p) => p.base)).toEqual([500, 500]);
    expect(parts.map((p) => p.discount)).toEqual([-167, -166]);
    expect(parts.map((p) => p.tax)).toEqual([30, 30]);
    expect(parts.map((p) => p.total)).toEqual([500 - 167 + 30, 500 - 166 + 30]);
    expect(sumAllocations(parts)).toBe(1000 - 333 + 60);
  });
});

/* ---------------------------------------------------------------------- */

const NONE = { quantity: 0, base: 0, discount: 0, fee: 0, taxes: [], total: 0 };
const rl = (line_id: string, quantity: number, c: { base: number; discount: number; fee: number; taxes: TaxAmount[]; adjustments: Record<string, { amount: number; tax: number }> }, inclusive = false): RefundableLine => ({
  line_id,
  quantity,
  ...c,
  total: c.base + c.discount + c.fee + (inclusive ? 0 : sumCents(c.taxes.map((t) => t.amount))),
  refunded: NONE,
});

const R1 = rl("chicken-rice", 2, L1); // total 1079
const R2 = rl("beer", 1, L2); // total 1403
const R3 = rl("satay", 5, L3); // total 480
/** Prawn noodle 800 × 3 = 2400 with an exclusive 50% comp (−1200) → 1200; SC 120; GST 108 + 11 (10.8) = 119; total 1439. */
const PRAWN = rl("prawn", 3, { base: 2400, discount: -1200, fee: 120, taxes: sgTax(119), adjustments: { comp50: { amount: -1200, tax: 0 }, sc: { amount: 120, tax: 11 } } });

const card = (amount: number, refunded = 0): RefundablePayment => ({ payment_id: "card", tender: "Card", is_cash: false, amount, refunded });
const cash = (amount: number, refunded = 0): RefundablePayment => ({ payment_id: "cash", tender: "Cash", is_cash: true, amount, refunded });

describe("refund reference (quoteRefund)", () => {
  it("F01: full refund of the 2962 bill paid 2000 card + 962 cash: every component reversed in full; cash 962 rounds down to 960 at 5 cents (rounding −2)", () => {
    // Totals: base 900 + 1300 + 400 = 2600; discount −130; fee 90 + 117 + 40 = 247; GST 89 + 116 + 40 = 245; total 2962.
    // Tenders in proportion to what each can still return: 2962 × 2000/2962 = 2000 exactly; cash 962. roundCash(962, 5): remainder 2, 2 × 2 = 4 < 5 → 960.
    const q = quoteRefund([R1, R2, R3], [card(2000), cash(962)], { kind: "full" }, { cashRoundingIncrement: 5 });
    expect(q.totals).toEqual({ base: 2600, discount: -130, fee: 247, tax: 245, taxes: sgTax(245), total: 2962 });
    expect(q.lines.map((l) => [l.line_id, l.quantity, l.total])).toEqual([
      ["chicken-rice", 2, 1079],
      ["beer", 1, 1403],
      ["satay", 5, 480],
    ]);
    expect(q.tenders).toEqual([
      { payment_id: "card", tender: "Card", is_cash: false, amount: 2000, rounding_cents: 0 },
      { payment_id: "cash", tender: "Cash", is_cash: true, amount: 962, rounding_cents: -2 },
    ]);
    expect(q.cash_out).toBe(960);
  });

  it("F02: refund 1 of 3 prawn noodles (exclusive 50% comp + service charge): discount −1200/3 = −400, fee 40, GST 119/3 = 39.67 → 40 (leftover cent to the refunded part), total 1439/3 = 479.67 → 480, base = 480 + 400 − 40 − 40 = 800", () => {
    const q = quoteRefund([PRAWN], [card(1439)], { kind: "lines", lines: [{ line_id: "prawn", quantity: 1 }] });
    const l = q.lines[0]!;
    expect(l).toMatchObject({ line_id: "prawn", quantity: 1, base: 800, discount: -400, fee: 40, tax: 40, total: 480 });
    expect(l.base + l.discount + l.fee + l.tax).toBe(l.total);
    // Per-adjustment consistency: the SC share is 40 with GST 11/3 = 3.67 → 4; the comp share is −400.
    expect(l.adjustments).toEqual({ sc: { amount: 40, tax: 4 }, comp50: { amount: -400, tax: 0 } });
    expect(q.tenders).toEqual([{ payment_id: "card", tender: "Card", is_cash: false, amount: 480, rounding_cents: 0 }]);
  });

  it("F03: refund 2 of 3 prawn noodles: discount −800, fee 80, GST 119 × 2/3 = 79.33 → 79 (the leftover cent goes to the larger remainder, the 1/3 part), total 959.33 → 959, base 1600; F02 + F03 = the whole line", () => {
    const q = quoteRefund([PRAWN], [card(1439)], { kind: "lines", lines: [{ line_id: "prawn", quantity: 2 }] });
    const l = q.lines[0]!;
    expect(l).toMatchObject({ quantity: 2, base: 1600, discount: -800, fee: 80, tax: 79, total: 959 });
    expect(l.adjustments).toEqual({ sc: { amount: 80, tax: 7 }, comp50: { amount: -800, tax: 0 } });
    expect(480 + 959).toBe(1439);
  });

  it("F04: after 1 unit was refunded (480), the remaining 2 units refund exactly the remainder 1439 − 480 = 959, and a third unit is refused", () => {
    const after1: RefundableLine = { ...PRAWN, refunded: { quantity: 1, base: 800, discount: -400, fee: 40, taxes: sgTax(40), total: 480 } };
    const q = quoteRefund([after1], [card(1439)], { kind: "lines", lines: [{ line_id: "prawn", quantity: 2 }] });
    expect(q.lines[0]).toMatchObject({ quantity: 2, base: 1600, discount: -800, fee: 80, tax: 79, total: 959 });
    expect(q.totals.total).toBe(1439 - 480);
    expect(() => quoteRefund([after1], [card(1439)], { kind: "lines", lines: [{ line_id: "prawn", quantity: 3 }] })).toThrow(RefundError);
    try {
      quoteRefund([after1], [card(1439)], { kind: "lines", lines: [{ line_id: "prawn", quantity: 3 }] });
    } catch (e) {
      expect((e as RefundError).code).toBe("exceeds_line");
      expect((e as RefundError).details).toEqual({ line_id: "prawn", remaining_quantity: 2 });
    }
  });

  it("F05: remaining caps: chicken rice (1079) after a 300 goodwill and one unit (540) has 239 left; the last unit's proportional half (fee 45, GST 45, total 540) is clamped to fee 20, GST 19, total 239, base 200", () => {
    // Already refunded: base 250 + 450 = 700, fee 25 + 45 = 70, GST 25 + 45 = 70, total 300 + 540 = 840, quantity 1.
    // Remaining: base 200, fee 20, GST 19, total 239, quantity 1. Half of the line would be fee 45, GST 44.5 → 45, total 539.5 → 540: each is clamped to what remains;
    // base = 239 − 20 − 19 = 200 (within the remaining 200).
    const l1: RefundableLine = { ...R1, refunded: { quantity: 1, base: 700, discount: 0, fee: 70, taxes: sgTax(70), total: 840 } };
    const q = quoteRefund([l1], [card(1079)], { kind: "lines", lines: [{ line_id: "chicken-rice", quantity: 1 }] });
    expect(q.lines[0]).toMatchObject({ quantity: 1, base: 200, discount: 0, fee: 20, tax: 19, total: 239 });
    // The SC adjustment carries the clamped fee 20; its GST share is 8/2 = 4.
    expect(q.lines[0]!.adjustments).toEqual({ sc: { amount: 20, tax: 4 } });
    expect(q.totals.total).toBe(1079 - 840);
  });

  it("F06: a 1000 goodwill refund across chicken rice (1079) and beer (1403): split 434.73/565.27 → 435/565; each line's components reversed in that proportion and consistent per adjustment; tenders 806 card / 194 cash → cash 195 (+1)", () => {
    // Chicken rice, proportion 435/1079: fee 90 × 435/1079 = 36.28 → 36 (the leftover cent goes to the other part, remainder .72); GST 89 × 435/1079 = 35.88 → 36;
    //   base = 435 − 36 − 36 = 363; SC GST 8 × 435/1079 = 3.22 → 3.
    // Beer, proportion 565/1403: discount 130 × 565/1403 = 52.35 → 52 → −52; fee 117 × 565/1403 = 47.12 → 47; GST 116 × 565/1403 = 46.71 → 47;
    //   base = 565 + 52 − 47 − 47 = 523; SC GST 11 × 565/1403 = 4.43 → 4.
    // Totals: base 363 + 523 = 886; discount −52; fee 83; GST 83; 886 − 52 + 83 + 83 = 1000.
    // Tenders: 1000 × 2000/2482 = 805.80 → 806 (larger remainder), cash 194.20 → 194; roundCash(194, 5): remainder 4 → up to 195 (+1).
    const q = quoteRefund([R1, R2], [card(2000), cash(482)], { kind: "amount", amount: 1000 }, { cashRoundingIncrement: 5 });
    expect(q.lines).toEqual([
      { line_id: "chicken-rice", quantity: 0, base: 363, discount: 0, fee: 36, tax: 36, taxes: sgTax(36), total: 435, adjustments: { sc: { amount: 36, tax: 3 } } },
      { line_id: "beer", quantity: 0, base: 523, discount: -52, fee: 47, tax: 47, taxes: sgTax(47), total: 565, adjustments: { sc: { amount: 47, tax: 4 }, hh: { amount: -52, tax: 0 } } },
    ]);
    expect(q.totals).toEqual({ base: 886, discount: -52, fee: 83, tax: 83, taxes: sgTax(83), total: 1000 });
    expect(q.tenders).toEqual([
      { payment_id: "card", tender: "Card", is_cash: false, amount: 806, rounding_cents: 0 },
      { payment_id: "cash", tender: "Cash", is_cash: true, amount: 194, rounding_cents: 1 },
    ]);
    expect(q.cash_out).toBe(195);
  });

  it("F07: explicit tender split at 5-cent cash rounding: cash 243 has remainder 3, 3 × 2 = 6 ≥ 5 → 245 (+2); card untouched", () => {
    const q = quoteRefund([R3], [card(2000), cash(962)], { kind: "full" }, { tenderSplit: [{ payment_id: "card", amount: 237 }, { payment_id: "cash", amount: 243 }], cashRoundingIncrement: 5 });
    expect(q.totals.total).toBe(480);
    expect(q.tenders).toEqual([
      { payment_id: "card", tender: "Card", is_cash: false, amount: 237, rounding_cents: 0 },
      { payment_id: "cash", tender: "Cash", is_cash: true, amount: 243, rounding_cents: 2 },
    ]);
    expect(q.cash_out).toBe(245);
  });

  it("F08: halves round up: at a 10-cent increment cash 245 (remainder 5) rounds to 250 (+5), while 244 would round to 240 (−4)", () => {
    const up = quoteRefund([R3], [card(2000), cash(962)], { kind: "full" }, { tenderSplit: [{ payment_id: "card", amount: 235 }, { payment_id: "cash", amount: 245 }], cashRoundingIncrement: 10 });
    expect(up.tenders.find((t) => t.payment_id === "cash")).toEqual({ payment_id: "cash", tender: "Cash", is_cash: true, amount: 245, rounding_cents: 5 });
    expect(up.cash_out).toBe(250);
    const down = quoteRefund([R3], [card(2000), cash(962)], { kind: "full" }, { tenderSplit: [{ payment_id: "card", amount: 236 }, { payment_id: "cash", amount: 244 }], cashRoundingIncrement: 10 });
    expect(down.tenders.find((t) => t.payment_id === "cash")).toEqual({ payment_id: "cash", tender: "Cash", is_cash: true, amount: 244, rounding_cents: -4 });
    expect(down.cash_out).toBe(240);
  });

  it("F09: default tender split uses what each payment can still return: card 2000 with 1500 refunded (500 left) and cash 962 → 480 × 500/1462 = 164.16 → 164, 480 × 962/1462 = 315.84 → 316; cash 316 → 315 (−1)", () => {
    const q = quoteRefund([R3], [card(2000, 1500), cash(962)], { kind: "full" }, { cashRoundingIncrement: 5 });
    expect(q.tenders).toEqual([
      { payment_id: "card", tender: "Card", is_cash: false, amount: 164, rounding_cents: 0 },
      { payment_id: "cash", tender: "Cash", is_cash: true, amount: 316, rounding_cents: -1 },
    ]);
    expect(q.cash_out).toBe(315);
  });

  it("F10: payment cap refusal: card has 100 left and cash nothing, so a 480 refund is refused (pool 100), as is an explicit split asking the card for 480", () => {
    const payments = [card(2000, 1900), cash(962, 962)];
    try {
      quoteRefund([R3], payments, { kind: "full" });
      expect.unreachable("expected exceeds_payment");
    } catch (e) {
      expect(e).toBeInstanceOf(RefundError);
      expect((e as RefundError).code).toBe("exceeds_payment");
      expect((e as RefundError).details).toEqual({ refundable: 100 });
    }
    try {
      quoteRefund([R3], payments, { kind: "full" }, { tenderSplit: [{ payment_id: "card", amount: 480 }] });
      expect.unreachable("expected exceeds_payment");
    } catch (e) {
      expect((e as RefundError).code).toBe("exceeds_payment");
      expect((e as RefundError).details).toEqual({ payment_id: "card", remaining: 100 });
    }
  });

  it("F11: inclusive mode: kopi × 2 (base 2180, SC 218, GST 198 inside, total 2398); 1 of 2 refunds fee 109, GST 99 reported, base 1199 − 109 = 1090 (GST is not subtracted), total 1199; full refund 2398", () => {
    const kopi2 = rl("kopi", 2, { base: 2180, discount: 0, fee: 218, taxes: sgTax(198), adjustments: { sc: { amount: 218, tax: 18 } } }, true);
    expect(kopi2.total).toBe(2398);
    const half = quoteRefund([kopi2], [card(2398)], { kind: "lines", lines: [{ line_id: "kopi", quantity: 1 }] });
    expect(half.lines[0]).toMatchObject({ quantity: 1, base: 1090, discount: 0, fee: 109, tax: 99, total: 1199 });
    expect(half.lines[0]!.adjustments).toEqual({ sc: { amount: 109, tax: 9 } });
    const full = quoteRefund([kopi2], [card(2398)], { kind: "full" });
    expect(full.totals).toEqual({ base: 2180, discount: 0, fee: 218, tax: 198, taxes: sgTax(198), total: 2398 });
  });

  it("F12: refusals: an amount above the refundable pool (2962), an amount of 0, an unknown line, a tender split that does not add up, and a bill with nothing left", () => {
    const lines = [R1, R2, R3];
    const pay = [card(2962)];
    const code = (fn: () => unknown) => {
      try {
        fn();
      } catch (e) {
        return (e as RefundError).code;
      }
      return "no error";
    };
    expect(code(() => quoteRefund(lines, pay, { kind: "amount", amount: 2963 }))).toBe("exceeds_line");
    expect(code(() => quoteRefund(lines, pay, { kind: "amount", amount: 2962 }))).toBe("no error");
    expect(code(() => quoteRefund(lines, pay, { kind: "amount", amount: 0 }))).toBe("invalid_amount");
    expect(code(() => quoteRefund(lines, pay, { kind: "lines", lines: [{ line_id: "nasi", quantity: 1 }] }))).toBe("unknown_line");
    expect(code(() => quoteRefund(lines, pay, { kind: "full" }, { tenderSplit: [{ payment_id: "card", amount: 2961 }] }))).toBe("tender_mismatch");
    const spent = lines.map((l) => ({ ...l, refunded: { quantity: l.quantity, base: l.base, discount: l.discount, fee: l.fee, taxes: l.taxes, total: l.total } }));
    expect(code(() => quoteRefund(spent, pay, { kind: "full" }))).toBe("nothing_to_refund");
  });

  it("F13: full refund skips a line that was already fully refunded: with the satay (480) gone, only chicken rice (1079) and beer (1403) come back = 2482", () => {
    const satayDone: RefundableLine = { ...R3, refunded: { quantity: 5, base: 400, discount: 0, fee: 40, taxes: sgTax(40), total: 480 } };
    const q = quoteRefund([R1, R2, satayDone], [card(2962)], { kind: "full" });
    expect(q.lines.map((l) => l.line_id)).toEqual(["chicken-rice", "beer"]);
    expect(q.totals.total).toBe(1079 + 1403);
    expect(q.tenders).toEqual([{ payment_id: "card", tender: "Card", is_cash: false, amount: 2482, rounding_cents: 0 }]);
  });

  it("F14: full refund after a 300 goodwill (base 250, fee 25, GST 25, no units): the whole remaining 779 comes back with both units: base 650, fee 65, GST 64", () => {
    // Remaining: base 900 − 250 = 650, fee 90 − 25 = 65, GST 89 − 25 = 64, total 1079 − 300 = 779, quantity 2.
    // The full proportion (fee 90, GST 89, total 1079) is clamped to each remainder; base = 779 − 65 − 64 = 650.
    const l1: RefundableLine = { ...R1, refunded: { quantity: 0, base: 250, discount: 0, fee: 25, taxes: sgTax(25), total: 300 } };
    const q = quoteRefund([l1], [card(1079)], { kind: "full" });
    expect(q.lines[0]).toMatchObject({ quantity: 2, base: 650, discount: 0, fee: 65, tax: 64, total: 779 });
    expect(q.totals.total).toBe(1079 - 300);
  });
});
