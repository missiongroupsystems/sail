import { SEED_RULE_IDS } from "../seed.js";
import { SG_SEED_RULES } from "./dsl.js";
import type { PricingRuleInput } from "../schemas.js";
import { ctx, taxEx, taxIn, line, order, type RefCase } from "./dsl.js";

/**
 * Reference cases R028–R037: fees.
 * Percent, fixed per unit, fixed per order (spread by discounted amounts, evenly
 * when they are all zero), caps, GST-applicable and not, two fees on one order,
 * a fee switched off by a manual rule, and the rule that fees never compound.
 */

const SC = SG_SEED_RULES.find((r) => r.id === SEED_RULE_IDS.serviceCharge)!;
const DEPOSIT = SG_SEED_RULES.find((r) => r.id === SEED_RULE_IDS.containerDeposit)!;

/** An automatic GST-applicable 10% fee on everything, priority 100; override what differs. */
function fee(id: string, over: Partial<PricingRuleInput> = {}): PricingRuleInput {
  return {
    id,
    kind: "fee",
    name: id,
    calc: "percent",
    value: { type: "fixed", amount: 1000 },
    scope: { type: "all" },
    priority: 100,
    application: "auto",
    tax_class_id: "standard",
    report_class: "other",
    ...over,
  };
}

/** An automatic 10% line-level discount on everything, priority 10. */
function disc(id: string, over: Partial<PricingRuleInput> = {}): PricingRuleInput {
  return {
    id,
    kind: "discount",
    name: id,
    calc: "percent",
    value: { type: "fixed", amount: 1000 },
    scope: { type: "all" },
    priority: 10,
    application: "auto",
    report_class: "promo",
    ...over,
  };
}

export const FEE_CASES: RefCase[] = [
  {
    id: "R028",
    title: "Fees never compound: service charge is 10% of the discounted nets, not of the delivery fee evaluated before it",
    covers: ["fee_no_compounding", "fee_fixed_per_order", "fee_percent", "fee_taxed", "scope_products", "tax_exclusive", "rounding"],
    working:
      "10% off product a: 3000 → 2700; b stays 1000. Delivery fee 500 (priority 100) spread by nets 2700/1000: 500 × 2700/3700 = 364.86, 500 × 1000/3700 = 135.14; " +
      "floors 364 + 135 = 499, leftover cent to a → 365/135. Service charge 10% (priority 110) is taken on the nets only: 270 + 100 = 370 (not on the 500 delivery fee). " +
      "Fee total 870. GST on nets 243 + 90; on delivery 32.85 → 33 and 12.15 → 12; on SC 24.3 → 24 and 9. GST total 411. Total = 3700 + 870 + 411 = 4981.",
    order: order([line("a", 3000), line("b", 1000)], { order_type: "delivery" }),
    rules: [
      disc("ten-off-a", { scope: { type: "products", product_ids: ["prod-a"] } }),
      fee("delivery", { calc: "fixed_per_order", value: { type: "fixed", amount: 500 }, priority: 100, report_class: "delivery_fee" }),
      fee("service", { priority: 110, report_class: "service_charge" }),
    ],
    context: ctx(),
    expect: {
      adjustments: { "ten-off-a": -300, delivery: 500, service: 270 + 100 },
      adjustment_lines: { delivery: { a: 365, b: 135 }, service: { a: 270, b: 100 } },
      line_nets: { a: 2700, b: 1000 },
      line_fees: { a: 365 + 270, b: 135 + 100 },
      fee_total: 500 + 370,
      tax_total: 243 + 90 + 33 + 12 + 24 + 9,
      line_totals: { a: 2700 + 635 + 243 + 33 + 24, b: 1000 + 235 + 90 + 12 + 9 },
      total: 3700 + 870 + 411,
    },
  },
  {
    id: "R029",
    title: "Fixed per order fee with all nets at zero is split evenly; the odd cent goes to the earliest line",
    covers: ["fee_fixed_per_order", "line_percent", "fee_taxed", "rounding", "tax_exclusive"],
    working:
      "100% off takes every line to 0. Packaging fee 100 cannot be spread by nets (all 0), so it is split evenly: 33.33 each, floors 33 + 33 + 33 = 99, the leftover cent goes to the first line → 34/33/33. " +
      "GST on fees 3.06 → 3, 2.97 → 3, 3 = 9. Total = 0 + 100 + 9 = 109.",
    order: order([line("a", 500), line("b", 500), line("c", 500)]),
    rules: [disc("free", { value: { type: "fixed", amount: 10_000 } }), fee("packaging", { calc: "fixed_per_order", value: { type: "fixed", amount: 100 }, report_class: "packaging_fee" })],
    context: ctx(),
    expect: {
      adjustments: { free: -1500, packaging: 100 },
      adjustment_lines: { packaging: { a: 34, b: 33, c: 33 } },
      line_nets: { a: 0, b: 0, c: 0 },
      fee_total: 100,
      tax_total: 3 + 3 + 3,
      total: 0 + 100 + 9,
    },
  },
  {
    id: "R030",
    title: "Fixed per unit fee with GST: $0.50 packaging per unit on tagged items only",
    covers: ["fee_fixed_per_unit", "fee_taxed", "scope_tags", "quantity", "tax_exclusive"],
    working:
      "a 200 × 4 = 800 tagged packaged → fee 50 × 4 = 200; b 700 not tagged → no fee. GST on nets 72 + 63; on the fee 18. Total = 800 + 700 + 200 + 72 + 63 + 18 = 1853.",
    order: order([line("a", 200, { quantity: 4, tags: ["packaged"] }), line("b", 700)], { order_type: "takeaway" }),
    rules: [fee("packaging", { calc: "fixed_per_unit", value: { type: "fixed", amount: 50 }, scope: { type: "tags", tags: ["packaged"] }, report_class: "packaging_fee" })],
    context: ctx(),
    expect: {
      adjustments: { packaging: 200 },
      line_fees: { a: 200, b: 0 },
      tax_total: 72 + 63 + 18,
      total: 800 + 700 + 200 + 72 + 63 + 18,
    },
  },
  {
    id: "R031",
    title: "Non-GST deposit next to a GST-applicable service charge on the same line",
    covers: ["fee_untaxed", "fee_taxed", "fee_fixed_per_unit", "fee_percent", "scope_deposit", "seed_rules", "tax_exclusive"],
    working:
      "6 cans × 250 = 1500. Service charge 10% = 150, GST on it 13.5 → 14. Deposit 6 × 10 = 60, no GST. GST on the net 135. Total = 1500 + 150 + 60 + 135 + 14 = 1859.",
    order: order([line("can", 250, { quantity: 6, has_deposit: true })]),
    rules: [SC, DEPOSIT],
    context: ctx(),
    expect: {
      adjustments: { [SEED_RULE_IDS.serviceCharge]: 150, [SEED_RULE_IDS.containerDeposit]: 60 },
      line_fees: { can: 150 + 60 },
      fee_total: 210,
      tax_total: 135 + 14,
      total: 1500 + 150 + 60 + 135 + 14,
    },
  },
  {
    id: "R032",
    title: "Two fees on one order: service charge and per-unit packaging, each on the nets, neither on the other",
    covers: ["fee_percent", "fee_fixed_per_unit", "fee_no_compounding", "quantity", "tax_exclusive"],
    working:
      "a 1000 × 2 = 2000, b 1000. SC 10%: 200 + 100 = 300. Packaging 30 per unit: 60 + 30 = 90. Fee total 390. " +
      "GST on nets 180 + 90; on SC 18 + 9; on packaging 5.4 → 5 and 2.7 → 3. GST total 305. Total = 3000 + 390 + 305 = 3695.",
    order: order([line("a", 1000, { quantity: 2 }), line("b", 1000)]),
    rules: [fee("service", { priority: 100 }), fee("packaging", { calc: "fixed_per_unit", value: { type: "fixed", amount: 30 }, priority: 110 })],
    context: ctx(),
    expect: {
      adjustments: { service: 300, packaging: 90 },
      adjustment_lines: { service: { a: 200, b: 100 }, packaging: { a: 60, b: 30 } },
      line_fees: { a: 260, b: 130 },
      fee_total: 390,
      tax_total: 180 + 90 + 18 + 9 + 5 + 3,
      total: 3000 + 390 + 305,
    },
  },
  {
    id: "R033",
    title: "Fee cap: 15% delivery surcharge on two $20 lines is 600, capped at 500 and spread 250/250",
    covers: ["cap", "fee_percent", "fee_taxed", "tax_exclusive"],
    working:
      "15% of 2000 = 300 per line, 600 total > cap 500. Spread 500 by 300/300 → 250/250. GST on nets 180 + 180; on the fee 22.5 → 23 twice = 46. Total = 4000 + 500 + 360 + 46 = 4906.",
    order: order([line("a", 2000), line("b", 2000)], { order_type: "delivery" }),
    rules: [fee("surcharge", { value: { type: "fixed", amount: 1500 }, cap: 500, report_class: "delivery_fee" })],
    context: ctx(),
    expect: {
      adjustments: { surcharge: 500 },
      adjustment_lines: { surcharge: { a: 250, b: 250 } },
      fee_total: 500,
      tax_total: 180 + 180 + 23 + 23,
      total: 4000 + 500 + 360 + 46,
    },
  },
  {
    id: "R034",
    title: "A manual rule switches off a fee by rule id: 'No delivery fee' removes the 400 delivery fee, the service charge stays",
    covers: ["fee_fixed_per_order", "fee_percent", "manual_fixed", "waiver", "tax_exclusive"],
    working:
      "The manual 'No delivery fee' rule (value 0, disables rule delivery) is applied, so the delivery fee is skipped. It is recorded as a zero adjustment for the audit trail. " +
      "Service charge 10% of 2000 = 200, GST on it 18. GST on net 180. Total = 2000 + 200 + 180 + 18 = 2398.",
    order: order([line("a", 2000)], { order_type: "delivery", manual_applications: [{ application_id: "nd-1", rule_id: "no-delivery", reason: "late delivery" }] }),
    rules: [
      fee("delivery", { calc: "fixed_per_order", value: { type: "fixed", amount: 400 }, priority: 100, report_class: "delivery_fee" }),
      fee("service", { priority: 110, report_class: "service_charge" }),
      {
        id: "no-delivery",
        kind: "discount",
        name: "No delivery fee",
        calc: "fixed_per_order",
        level: "order",
        value: { type: "fixed", amount: 0 },
        scope: { type: "all" },
        priority: 90,
        application: "manual",
        min_role: "manager",
        reason_required: true,
        report_class: "other",
        disables: { rule_ids: ["delivery"] },
      },
    ],
    context: ctx(),
    expect: {
      adjustments: { "no-delivery#nd-1": 0, service: 200 },
      not_applied: ["delivery"],
      fee_total: 200,
      tax_total: 180 + 18,
      total: 2000 + 200 + 180 + 18,
    },
  },
  {
    id: "R035",
    title: "Inclusive GST with a discount and a fee: the service charge is 10% of the GST-inclusive discounted price and itself includes GST",
    covers: ["tax_inclusive", "fee_percent", "fee_taxed", "line_percent", "scope_products", "rounding"],
    working:
      "10% off a: 2180 → 1962; b 1090. SC 10%: 196.2 → 196 and 109; fee total 305. GST inside the nets: 1962 × 9/109 = 162 exactly; 1090 × 9/109 = 90. " +
      "GST inside the SC: 196 × 9/109 = 16.18 → 16; 109 × 9/109 = 9. GST reported 162 + 90 + 16 + 9 = 277, not added. Total = 1962 + 1090 + 305 = 3357.",
    order: order([line("a", 2180), line("b", 1090)]),
    rules: [disc("ten-off-a", { scope: { type: "products", product_ids: ["prod-a"] } }), fee("service", { report_class: "service_charge" })],
    context: ctx("inclusive"),
    expect: {
      adjustments: { "ten-off-a": -218, service: 196 + 109 },
      line_nets: { a: 1962, b: 1090 },
      line_tax: { a: taxIn(1962), b: taxIn(1090) },
      fee_total: 305,
      tax_total: 162 + 90 + 16 + 9,
      total: 1962 + 1090 + 305,
    },
  },
  {
    id: "R036",
    title: "Fee scope and exclusions: packaging per unit on food, except items tagged no-pack; drinks out of scope",
    covers: ["fee_fixed_per_unit", "scope_categories", "exclusions", "quantity", "tax_exclusive"],
    working:
      "a food × 2: fee 20 × 2 = 40. b food but tagged no-pack: excluded, no fee. c drink: not in scope. GST on nets 180 + 72 + 27 = 279; on the fee 3.6 → 4. " +
      "Total = 2000 + 800 + 300 + 40 + 279 + 4 = 3423.",
    order: order([line("a", 1000, { quantity: 2, category_id: "food" }), line("b", 800, { category_id: "food", tags: ["no-pack"] }), line("c", 300, { category_id: "drink" })], {
      order_type: "takeaway",
    }),
    rules: [
      fee("packaging", {
        calc: "fixed_per_unit",
        value: { type: "fixed", amount: 20 },
        scope: { type: "categories", category_ids: ["food"] },
        exclusions: { tags: ["no-pack"] },
        report_class: "packaging_fee",
      }),
    ],
    context: ctx(),
    expect: {
      adjustments: { packaging: 40 },
      line_fees: { a: 40, b: 0, c: 0 },
      tax_total: 180 + 72 + 27 + 4,
      total: 2000 + 800 + 300 + 40 + 279 + 4,
    },
  },
  {
    id: "R037",
    title: "Fixed per order fee spread 667/222/111 across nets 3000/1000/500, GST per fee line",
    covers: ["fee_fixed_per_order", "fee_taxed", "rounding", "tax_exclusive"],
    working:
      "Delivery 1000 by nets 3000/1000/500: 666.67/222.22/111.11 → floors 999, leftover cent to a → 667/222/111. GST on the fee lines 60.03 → 60, 19.98 → 20, 9.99 → 10 = 90. " +
      "GST on nets 270 + 90 + 45 = 405. Total = 4500 + 1000 + 405 + 90 = 5995.",
    order: order([line("a", 3000), line("b", 1000), line("c", 500)], { order_type: "delivery" }),
    rules: [fee("delivery", { calc: "fixed_per_order", value: { type: "fixed", amount: 1000 }, report_class: "delivery_fee" })],
    context: ctx(),
    expect: {
      adjustments: { delivery: 1000 },
      adjustment_lines: { delivery: { a: 667, b: 222, c: 111 } },
      tax_total: taxEx(3000) + taxEx(1000) + taxEx(500) + 60 + 20 + 10,
      total: 4500 + 1000 + 405 + 90,
    },
  },
];
