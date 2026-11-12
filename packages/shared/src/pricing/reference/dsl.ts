import { presetSeedRules, REGION_PRESETS } from "../../presets.js";
import type { PricingContextInput, PricingLineInput, PricingOrderInput, PricingRuleInput, TaxRateInput } from "../schemas.js";

/**
 * Readable fixture format for the pricing reference set (scope doc 9; roadmap v0.2).
 *
 * Every expected amount is hand-calculated and written as an arithmetic
 * expression so a second person (a product owner or someone in finance) can check it by reading the
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
  /** Split every line evenly across `checks` bills (allocateLine) and check each bill's total and tax by component name. */
  split?: { checks: number; expect: { total: number; taxes: Record<string, number> }[] };
  /** Settle the total in cash rounded to `increment` minor units (roundCash). */
  cash?: { increment: number; due: number; rounding: number };
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
    line_tax?: Record<string, number>;
    /** line_id → everything the customer pays for the line */
    line_totals?: Record<string, number>;
    subtotal?: number;
    discount_total?: number;
    fee_total?: number;
    tax_total?: number;
    /** The order's tax breakdown, exactly and in order. */
    taxes?: { name: string; bps: number; taxable: number; amount: number }[];
    /** line_id → component name → tax on that line */
    line_taxes?: Record<string, Record<string, number>>;
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
  | "scope_deposit"
  | "exclusions"
  | "fee_percent"
  | "fee_fixed_per_unit"
  | "fee_fixed_per_order"
  | "fee_taxed"
  | "fee_untaxed"
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
  | "seed_rules"
  | "tax_components"
  | "tax_per_rate"
  | "tax_by_order_type"
  | "tax_exempt"
  | "zero_decimals"
  | "three_decimals"
  | "split"
  | "cash_rounding";

export const NOW = "2026-11-04T12:00:00.000Z";

/** The Singapore preset's tax table as the reference set uses it: one class, `standard`, at GST 9%. */
export const SG_TAX_RATES: TaxRateInput[] = [{ tax_class_id: "standard", components: [{ name: "GST 9%", bps: 900 }] }];

/** The Singapore preset's seed rules, with its tax class wired to `standard`. */
export const SG_SEED_RULES: PricingRuleInput[] = presetSeedRules(REGION_PRESETS.sg, { standard: "standard" });

/** Singapore context (GST 9%, rounded per line) unless `extra` says otherwise. */
export function ctx(tax_mode: "inclusive" | "exclusive" = "exclusive", extra: Partial<PricingContextInput> = {}): PricingContextInput {
  return { tax_mode, tax_rounding: "per_line", tax_rates: SG_TAX_RATES, now: NOW, ...extra };
}

/** A line in tax class `standard` unless `opts` says otherwise. */
export function line(id: string, base: number, opts: Partial<PricingLineInput> = {}): PricingLineInput {
  return { line_id: id, product_id: opts.product_id ?? `prod-${id}`, tax_class_id: "standard", quantity: 1, prices: { base }, ...opts };
}

export function order(lines: PricingLineInput[], opts: Partial<PricingOrderInput> = {}): PricingOrderInput {
  return { order_type: "dine_in", channel: "pos", outlet_id: "outlet-1", brand_id: "brand-1", lines, ...opts };
}

/** GST at 9% on an exclusive amount, rounded half up (mirrors percentOfCents). */
export function taxEx(amount: number, bps = 900): number {
  const num = Math.abs(amount) * bps;
  const q = Math.floor(num / 10_000);
  const r = num - q * 10_000;
  const v = r * 2 >= 10_000 ? q + 1 : q;
  return amount < 0 ? -v : v;
}

/** GST portion inside a GST-inclusive amount at 9%, rounded half up. */
export function taxIn(amount: number, bps = 900): number {
  const num = Math.abs(amount) * bps;
  const den = 10_000 + bps;
  const q = Math.floor(num / den);
  const r = num - q * den;
  const v = r * 2 >= den ? q + 1 : q;
  return amount < 0 ? -v : v;
}

/** Percent (bps) of an amount, rounded half up. */
export function pct(amount: number, bps: number): number {
  return taxEx(amount, bps);
}
