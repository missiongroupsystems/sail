import type { PricingContextInput, PricingLineInput, PricingOrderInput, PricingRuleInput } from "../schemas.js";

/**
 * Readable fixture format for the pricing reference set (scope doc 9; roadmap v0.2).
 *
 * Every expected amount is hand-calculated and written as an arithmetic
 * expression so a second person (Phil or Finance) can check it by reading the
 * case, not by running code. Amounts are integer cents; discounts are negative.
 */
export type RefCase = {
  /** Stable ID, for example "R012". */
  id: string;
  title: string;
  /** Which features the case covers, for coverage reporting. */
  covers: Coverage[];
  /** Hand calculation shown as prose, so the reviewer can follow it. */
  working?: string;
  order: PricingOrderInput;
  rules: PricingRuleInput[];
  context: PricingContextInput;
  expect: {
    /** rule_id (or `rule_id#application_id` for manual applications) → signed total */
    adjustments?: Record<string, number>;
    /** rule_id (or `rule_id#application_id`) → line_id → signed amount */
    adjustment_lines?: Record<string, Record<string, number>>;
    /** line_id → net amount after discounts */
    line_nets?: Record<string, number>;
    /** line_id → fee amount attached to the line */
    line_fees?: Record<string, number>;
    /** line_id → GST on the net amount */
    line_gst?: Record<string, number>;
    /** line_id → everything the customer pays for the line */
    line_totals?: Record<string, number>;
    subtotal?: number;
    discount_total?: number;
    fee_total?: number;
    gst_total?: number;
    total: number;
    /** Rule IDs that must NOT appear as adjustments. */
    not_applied?: string[];
    warnings?: number;
    pricing_status?: "live" | "frozen";
  };
};

export type Coverage =
  | "base_price"
  | "order_type_price"
  | "open_price"
  | "modifiers"
  | "quantity"
  | "line_percent"
  | "line_fixed_per_unit"
  | "order_percent"
  | "order_fixed"
  | "exclusive"
  | "stackable"
  | "cap"
  | "min_spend_scoped"
  | "min_spend_order"
  | "customer_group"
  | "order_type_condition"
  | "channel_condition"
  | "outlet_condition"
  | "brand_condition"
  | "date_range"
  | "scope_all"
  | "scope_categories"
  | "scope_products"
  | "scope_tags"
  | "scope_bcrs"
  | "exclusions"
  | "fee_percent"
  | "fee_fixed_per_unit"
  | "fee_fixed_per_order"
  | "fee_gst_applicable"
  | "fee_not_gst_applicable"
  | "fee_no_compounding"
  | "tax_inclusive"
  | "tax_exclusive"
  | "manual_fixed"
  | "manual_open"
  | "manual_lines"
  | "waiver"
  | "freeze"
  | "rounding"
  | "zero_quantity"
  | "seed_rules";

export const NOW = "2026-11-04T12:00:00.000Z";

export function ctx(tax_mode: "inclusive" | "exclusive" = "exclusive", extra: Partial<PricingContextInput> = {}): PricingContextInput {
  return { tax_mode, gst_bps: 900, now: NOW, ...extra };
}

export function line(id: string, base: number, opts: Partial<PricingLineInput> = {}): PricingLineInput {
  return { line_id: id, product_id: opts.product_id ?? `prod-${id}`, quantity: 1, prices: { base }, ...opts };
}

export function order(lines: PricingLineInput[], opts: Partial<PricingOrderInput> = {}): PricingOrderInput {
  return { order_type: "dine_in", channel: "pos", outlet_id: "outlet-1", brand_id: "brand-1", lines, ...opts };
}

/** GST at 9% on an exclusive amount, rounded half up (mirrors percentOfCents). */
export function gstEx(amount: number, bps = 900): number {
  const num = Math.abs(amount) * bps;
  const q = Math.floor(num / 10_000);
  const r = num - q * 10_000;
  const v = r * 2 >= 10_000 ? q + 1 : q;
  return amount < 0 ? -v : v;
}

/** GST portion inside a GST-inclusive amount at 9%, rounded half up. */
export function gstIn(amount: number, bps = 900): number {
  const num = Math.abs(amount) * bps;
  const den = 10_000 + bps;
  const q = Math.floor(num / den);
  const r = num - q * den;
  const v = r * 2 >= den ? q + 1 : q;
  return amount < 0 ? -v : v;
}

/** Percent (bps) of an amount, rounded half up. */
export function pct(amount: number, bps: number): number {
  return gstEx(amount, bps);
}
