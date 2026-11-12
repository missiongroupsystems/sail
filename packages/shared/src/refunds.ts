import { allocateLargestRemainder, percentOfCents, roundCash, sumCents, type Cents } from "./money.js";
import type { TaxAmount } from "./pricing/schemas.js";
import { sumTaxes } from "./splits.js";

/**
 * Refund reversal. A refund reverses a share of each line's
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
  /** The allocation's tax by component. */
  taxes: TaxAmount[];
  total: Cents;
  adjustments: Record<string, { amount: Cents; tax: Cents }>;
  /** Already refunded on this check for this line. */
  refunded: { quantity: number; base: Cents; discount: Cents; fee: Cents; taxes: TaxAmount[]; total: Cents };
};

export type RefundablePayment = {
  payment_id: string;
  tender: string;
  is_cash: boolean;
  amount: Cents;
  /** Cash rounding taken with the payment (0 when none): the drawer took `amount + rounding`. */
  rounding?: Cents;
  refunded: Cents;
  /** Cash rounding already handed back by earlier refunds of this payment (0 when none). */
  refunded_rounding?: Cents;
};

export type RefundRequest = { kind: "full" } | { kind: "lines"; lines: { line_id: string; quantity: number }[] } | { kind: "amount"; amount: Cents };

export type RefundLineResult = { line_id: string; quantity: number; base: Cents; discount: Cents; fee: Cents; tax: Cents; taxes: TaxAmount[]; total: Cents; adjustments: Record<string, { amount: Cents; tax: Cents }> };
export type RefundTenderResult = { payment_id: string; tender: string; is_cash: boolean; amount: Cents; rounding_cents: Cents };
export type RefundQuote = {
  lines: RefundLineResult[];
  totals: { base: Cents; discount: Cents; fee: Cents; tax: Cents; taxes: TaxAmount[]; total: Cents };
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
 * Discount, fee and each tax component are allocated proportionally; the base
 * takes the rounding residue so the parts add up exactly and the base is never
 * negative. Every part is clamped to what is still refundable on the line.
 */
function reverseLine(l: RefundableLine, num: number, den: number, remaining: Remaining, targetTotal?: Cents, rest = false): Omit<RefundLineResult, "line_id" | "quantity"> {
  const part = (v: Cents) => (den === 0 ? 0 : allocateLargestRemainder(v, [num, den - num])[0]!);
  // A refund to an exact amount is a share of what is left on the line; a quantity refund is a share of the line as sold;
  // `rest` (the last units of the line) takes exactly what is left of each component.
  const of = targetTotal === undefined ? { discount: l.discount, fee: l.fee, taxes: l.taxes.map((t) => t.amount) } : remaining;
  const discount = rest ? remaining.discount : clampMag(part(of.discount), remaining.discount);
  const fee = rest ? remaining.fee : clampMag(part(of.fee), remaining.fee);
  const taxInTotal = l.total === l.base + l.discount + l.fee + sumCents(l.taxes.map((t) => t.amount));
  const taxes = l.taxes.map((t, k) => ({ name: t.name, bps: t.bps, amount: rest ? remaining.taxes[k]! : clampMag(part(of.taxes[k]!), remaining.taxes[k]!) }));
  const tax = sumCents(taxes.map((t) => t.amount));
  const target = rest ? remaining.total : (targetTotal ?? clampMag(part(l.total), remaining.total));
  const base = clampMag(target - discount - fee - (taxInTotal ? tax : 0), remaining.base);
  const total = base + discount + fee + (taxInTotal ? tax : 0);
  const adjustments: Record<string, { amount: Cents; tax: Cents }> = {};
  const fees = Object.entries(l.adjustments).filter(([, a]) => a.amount > 0);
  const discounts = Object.entries(l.adjustments).filter(([, a]) => a.amount < 0);
  if (fees.length) {
    const feeParts = allocateLargestRemainder(fee, fees.map(([, a]) => a.amount));
    const feeTax = clampMag(sumCents(fees.map(([, a]) => part(a.tax))), tax);
    const feeTaxParts = allocateLargestRemainder(feeTax, fees.map(([, a]) => Math.max(0, a.tax)));
    fees.forEach(([id], i) => (adjustments[id] = { amount: feeParts[i]!, tax: feeTaxParts[i]! }));
  }
  if (discounts.length) {
    const discParts = allocateLargestRemainder(discount, discounts.map(([, a]) => -a.amount));
    discounts.forEach(([id], i) => (adjustments[id] = { amount: discParts[i]!, tax: 0 }));
  }
  return { base, discount, fee, tax, taxes, total, adjustments };
}

type Remaining = { base: Cents; discount: Cents; fee: Cents; taxes: Cents[]; total: Cents; quantity: number };

function clampMag(v: Cents, limit: Cents): Cents {
  if (limit >= 0) return Math.min(Math.max(v, 0), limit);
  return Math.max(Math.min(v, 0), limit);
}

function remainingOf(l: RefundableLine): Remaining {
  const refundedTax = (t: TaxAmount) => sumCents(l.refunded.taxes.filter((r) => r.name === t.name && r.bps === t.bps).map((r) => r.amount));
  return { base: l.base - l.refunded.base, discount: l.discount - l.refunded.discount, fee: l.fee - l.refunded.fee, taxes: l.taxes.map((t) => t.amount - refundedTax(t)), total: l.total - l.refunded.total, quantity: l.quantity - l.refunded.quantity };
}

/**
 * Quote a refund. `tenderSplit` fixes how much goes back to each payment; when
 * omitted the total is spread across the payments in proportion to what each
 * can still return. Cash tenders are rounded with `cashRoundingIncrement` on the
 * payment's running refunded total, so repeated small refunds never pay out more
 * cash than the payment took.
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
      // The last units take whatever is left of the line, so refunding it unit by unit gives back all of it.
      out.push({ line_id: l.line_id, quantity: req.quantity, ...reverseLine(l, req.quantity, l.quantity, rem, undefined, req.quantity === rem.quantity) });
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

  const totals = { base: sumCents(out.map((x) => x.base)), discount: sumCents(out.map((x) => x.discount)), fee: sumCents(out.map((x) => x.fee)), tax: sumCents(out.map((x) => x.tax)), taxes: sumTaxes(out.map((x) => x.taxes)), total: sumCents(out.map((x) => x.total)) };
  if (totals.total <= 0) throw new RefundError("nothing_to_refund", "Nothing left to refund on this bill");

  // Tenders.
  const refundable = payments.map((p) => ({ ...p, remaining: p.amount - p.refunded }));
  let tenderAmounts: { payment_id: string; amount: Cents }[];
  if (opts.tenderSplit) {
    // One payment named twice is one amount against that payment, checked once against what it can still return.
    const byPayment = new Map<string, Cents>();
    for (const t of opts.tenderSplit) byPayment.set(t.payment_id, (byPayment.get(t.payment_id) ?? 0) + t.amount);
    tenderAmounts = [...byPayment].map(([payment_id, amount]) => ({ payment_id, amount }));
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
    // Cash goes back rounded on the payment's running total, not on each refund alone: the drawer pays out the rounded
    // total refunded so far, less what it already paid out, and the whole payment back is exactly the cash it took.
    let rounding = 0;
    if (p.is_cash && opts.cashRoundingIncrement && opts.cashRoundingIncrement > 1) {
      // A part payment in cash may have taken an amount the coins cannot give back exactly: its last refund is rounded
      // down to a whole number of steps, never up past what the drawer took.
      const took = p.amount + (p.rounding ?? 0);
      const taken = took - (took % opts.cashRoundingIncrement);
      const after = p.refunded + t.amount;
      const outAfter = after === p.amount ? taken : Math.min(roundCash(after, opts.cashRoundingIncrement).rounded, taken);
      rounding = outAfter - (p.refunded + (p.refunded_rounding ?? 0)) - t.amount;
    }
    return { payment_id: p.payment_id, tender: p.tender, is_cash: p.is_cash, amount: t.amount, rounding_cents: rounding };
  });
  const cashOut = sumCents(tenders.filter((t) => t.is_cash).map((t) => t.amount + t.rounding_cents));
  return { lines: out, totals, tenders, cash_out: cashOut };
}

export { percentOfCents };
