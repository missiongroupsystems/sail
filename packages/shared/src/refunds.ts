import { allocateLargestRemainder, percentOfCents, roundCash, sumCents, type Cents } from "./money.js";

/**
 * Refund reversal (scope doc 4.5). A refund reverses a share of each line's
 * allocated components on one check: by whole check, by lines and quantities,
 * or by an amount spread across the check's lines in proportion. The caller
 * passes what has already been refunded so caps hold: a line's refunds never
 * exceed its paid amount, and a payment's refunds never exceed what it paid.
 * Pure: no I/O, no clock.
 */
export type RefundableLine = {
  line_id: string;
  quantity: number;
  /** The line's allocation on this check. */
  base: Cents;
  discount: Cents;
  fee: Cents;
  gst: Cents;
  total: Cents;
  adjustments: Record<string, { amount: Cents; gst: Cents }>;
  /** Already refunded on this check for this line. */
  refunded: { quantity: number; base: Cents; discount: Cents; fee: Cents; gst: Cents; total: Cents };
};

export type RefundablePayment = { payment_id: string; tender: string; is_cash: boolean; amount: Cents; refunded: Cents };

export type RefundRequest = { kind: "full" } | { kind: "lines"; lines: { line_id: string; quantity: number }[] } | { kind: "amount"; amount: Cents };

export type RefundLineResult = { line_id: string; quantity: number; base: Cents; discount: Cents; fee: Cents; gst: Cents; total: Cents; adjustments: Record<string, { amount: Cents; gst: Cents }> };
export type RefundTenderResult = { payment_id: string; tender: string; is_cash: boolean; amount: Cents; rounding_cents: Cents };
export type RefundQuote = {
  lines: RefundLineResult[];
  totals: { base: Cents; discount: Cents; fee: Cents; gst: Cents; total: Cents };
  tenders: RefundTenderResult[];
  /** Cash actually handed back = Σ cash tender amounts + rounding. */
  cash_out: Cents;
};

export class RefundError extends Error {
  constructor(
    readonly code: "nothing_to_refund" | "exceeds_line" | "exceeds_payment" | "unknown_line" | "invalid_amount" | "tender_mismatch",
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

/**
 * Reverse a line's components in proportion `num/den` (or to an exact `targetTotal`).
 * Discount, fee and GST are allocated proportionally; the base takes the rounding
 * residue so the parts add up exactly and the base is never negative. Every part
 * is clamped to what is still refundable on the line.
 */
function reverseLine(l: RefundableLine, num: number, den: number, remaining: { base: Cents; discount: Cents; fee: Cents; gst: Cents; total: Cents }, targetTotal?: Cents): Omit<RefundLineResult, "line_id" | "quantity"> {
  const part = (v: Cents) => (den === 0 ? 0 : allocateLargestRemainder(v, [num, den - num])[0]!);
  const discount = clampMag(part(l.discount), remaining.discount);
  const fee = clampMag(part(l.fee), remaining.fee);
  const gstInTotal = l.total === l.base + l.discount + l.fee + l.gst;
  const gst = clampMag(part(l.gst), remaining.gst);
  const target = targetTotal ?? clampMag(part(l.total), remaining.total);
  const base = clampMag(target - discount - fee - (gstInTotal ? gst : 0), remaining.base);
  const total = base + discount + fee + (gstInTotal ? gst : 0);
  const adjustments: Record<string, { amount: Cents; gst: Cents }> = {};
  const fees = Object.entries(l.adjustments).filter(([, a]) => a.amount > 0);
  const discounts = Object.entries(l.adjustments).filter(([, a]) => a.amount < 0);
  if (fees.length) {
    const feeParts = allocateLargestRemainder(fee, fees.map(([, a]) => a.amount));
    const feeGst = clampMag(sumCents(fees.map(([, a]) => part(a.gst))), gst);
    const feeGstParts = allocateLargestRemainder(feeGst, fees.map(([, a]) => Math.max(0, a.gst)));
    fees.forEach(([id], i) => (adjustments[id] = { amount: feeParts[i]!, gst: feeGstParts[i]! }));
  }
  if (discounts.length) {
    const discParts = allocateLargestRemainder(discount, discounts.map(([, a]) => -a.amount));
    discounts.forEach(([id], i) => (adjustments[id] = { amount: discParts[i]!, gst: 0 }));
  }
  return { base, discount, fee, gst, total, adjustments };
}

function clampMag(v: Cents, limit: Cents): Cents {
  if (limit >= 0) return Math.min(Math.max(v, 0), limit);
  return Math.max(Math.min(v, 0), limit);
}

function remainingOf(l: RefundableLine) {
  return { base: l.base - l.refunded.base, discount: l.discount - l.refunded.discount, fee: l.fee - l.refunded.fee, gst: l.gst - l.refunded.gst, total: l.total - l.refunded.total, quantity: l.quantity - l.refunded.quantity };
}

/**
 * Quote a refund. `tenderSplit` fixes how much goes back to each payment; when
 * omitted the total is spread across the payments in proportion to what each
 * can still return. Cash tenders are rounded with `cashRoundingIncrement`.
 */
export function quoteRefund(lines: readonly RefundableLine[], payments: readonly RefundablePayment[], request: RefundRequest, opts: { tenderSplit?: { payment_id: string; amount: Cents }[]; cashRoundingIncrement?: number | null } = {}): RefundQuote {
  const byId = new Map(lines.map((l) => [l.line_id, l]));
  const out: RefundLineResult[] = [];

  if (request.kind === "full") {
    for (const l of lines) {
      const rem = remainingOf(l);
      if (rem.total === 0 && rem.quantity === 0) continue;
      out.push({ line_id: l.line_id, quantity: rem.quantity, ...reverseLine(l, 1, 1, rem) });
    }
  } else if (request.kind === "lines") {
    for (const req of request.lines) {
      const l = byId.get(req.line_id);
      if (!l) throw new RefundError("unknown_line", `line ${req.line_id} is not on this bill`, { line_id: req.line_id });
      const rem = remainingOf(l);
      if (!Number.isInteger(req.quantity) || req.quantity < 1) throw new RefundError("invalid_amount", "quantity must be at least 1");
      if (req.quantity > rem.quantity) throw new RefundError("exceeds_line", `only ${rem.quantity} of ${l.quantity} can still be refunded on this line`, { line_id: l.line_id, remaining_quantity: rem.quantity });
      out.push({ line_id: l.line_id, quantity: req.quantity, ...reverseLine(l, req.quantity, l.quantity, rem) });
    }
  } else {
    if (!Number.isInteger(request.amount) || request.amount <= 0) throw new RefundError("invalid_amount", "amount must be a positive number of cents");
    const eligible = lines.map((l) => ({ l, rem: remainingOf(l) })).filter((x) => x.rem.total > 0);
    const pool = sumCents(eligible.map((x) => x.rem.total));
    if (request.amount > pool) throw new RefundError("exceeds_line", `only ${pool} can still be refunded on this bill`, { refundable: pool });
    const parts = allocateLargestRemainder(request.amount, eligible.map((x) => x.rem.total));
    eligible.forEach(({ l, rem }, i) => {
      const a = parts[i]!;
      if (a === 0) return;
      // Proportion a / remaining line total, applied to each component; quantity stays 0 (goodwill, not a returned item).
      const r = reverseLine(l, a, rem.total, rem, a);
      out.push({ line_id: l.line_id, quantity: 0, ...r });
    });
  }

  const totals = { base: sumCents(out.map((x) => x.base)), discount: sumCents(out.map((x) => x.discount)), fee: sumCents(out.map((x) => x.fee)), gst: sumCents(out.map((x) => x.gst)), total: sumCents(out.map((x) => x.total)) };
  if (totals.total <= 0) throw new RefundError("nothing_to_refund", "Nothing left to refund on this bill");

  // Tenders.
  const refundable = payments.map((p) => ({ ...p, remaining: p.amount - p.refunded }));
  let tenderAmounts: { payment_id: string; amount: Cents }[];
  if (opts.tenderSplit) {
    tenderAmounts = opts.tenderSplit;
    if (sumCents(tenderAmounts.map((t) => t.amount)) !== totals.total) throw new RefundError("tender_mismatch", `tender amounts add up to ${sumCents(tenderAmounts.map((t) => t.amount))}, refund is ${totals.total}`);
  } else {
    const pool = sumCents(refundable.map((p) => Math.max(0, p.remaining)));
    if (pool < totals.total) throw new RefundError("exceeds_payment", `payments can return at most ${pool}`, { refundable: pool });
    const parts = allocateLargestRemainder(totals.total, refundable.map((p) => Math.max(0, p.remaining)));
    tenderAmounts = refundable.map((p, i) => ({ payment_id: p.payment_id, amount: parts[i]! })).filter((t) => t.amount > 0);
  }
  const tenders: RefundTenderResult[] = tenderAmounts.map((t) => {
    const p = refundable.find((x) => x.payment_id === t.payment_id);
    if (!p) throw new RefundError("tender_mismatch", `payment ${t.payment_id} is not on this bill`);
    if (t.amount < 0 || t.amount > p.remaining) throw new RefundError("exceeds_payment", `${p.tender} can return at most ${p.remaining}`, { payment_id: p.payment_id, remaining: p.remaining });
    const rounding = p.is_cash && opts.cashRoundingIncrement && opts.cashRoundingIncrement > 1 ? roundCash(t.amount, opts.cashRoundingIncrement).roundingCents : 0;
    return { payment_id: p.payment_id, tender: p.tender, is_cash: p.is_cash, amount: t.amount, rounding_cents: rounding };
  });
  const cashOut = sumCents(tenders.filter((t) => t.is_cash).map((t) => t.amount + t.rounding_cents));
  return { lines: out, totals, tenders, cash_out: cashOut };
}

export { percentOfCents };
