import { SEED_RULES, SEED_RULE_IDS } from "../seed.js";
import type { PricingRuleInput } from "../schemas.js";
import { ctx, gstIn, line, order, type RefCase } from "./dsl.js";

/**
 * Reference cases R129–R138: minimum spend at exact boundaries in both
 * bases (order and scoped), in both tax modes, measured on undiscounted
 * amounts and with fees in play; customer-group conditions with two groups.
 */

const SC = SEED_RULES.find((r) => r.id === SEED_RULE_IDS.serviceCharge)!;

/** An automatic 10% line-level discount on everything, priority 10; override what differs. */
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

const MIN_50_ORDER = disc("ten-min-50", { conditions: { min_spend: { amount: 5000, basis: "order" } } });

export const BOUNDARY_CASES: RefCase[] = [
  {
    id: "R129",
    title: "Minimum spend (order basis) exactly met on a dine-in order: fees do not count toward it and are computed afterwards on the nets",
    covers: ["min_spend_order", "line_percent", "fee_percent", "fee_no_compounding", "seed_rules", "tax_exclusive"],
    working:
      "Order spend 3000 + 2000 = 5000 ≥ 5000 (the service charge is not part of the spend). 10% off: 300 + 200 → nets 2700, 1800. Service charge 270 + 180 = 450. " +
      "GST on nets 243 + 162; on SC 24.3 → 24, 16.2 → 16. Total = 4500 + 450 + 405 + 40 = 5395.",
    order: order([line("a", 3000, { category_id: "food" }), line("b", 2000, { category_id: "drink" })]),
    rules: [MIN_50_ORDER, SC],
    context: ctx(),
    expect: {
      adjustments: { "ten-min-50": -500, [SEED_RULE_IDS.serviceCharge]: 450 },
      line_nets: { a: 2700, b: 1800 },
      gst_total: 243 + 162 + 24 + 16,
      total: 2700 + 1800 + 450 + 243 + 162 + 24 + 16,
    },
  },
  {
    id: "R130",
    title: "Minimum spend (order basis) is measured on undiscounted amounts: a half-price line takes the order to $35 but the $50 rule still applies",
    covers: ["min_spend_order", "order_percent", "line_percent", "stackable", "scope_products", "rounding", "tax_exclusive"],
    working:
      "half-a (10): 3000 → 1500. bill-10-min-50 (50, order-level) measures the base spend 3000 + 2000 = 5000 ≥ 5000, so it applies to the pool 1500 + 2000 = 3500: 350, spread 150/200. " +
      "Nets 1350, 1800. GST 121.5 → 122; 162. Total = 3150 + 284 = 3434.",
    order: order([line("a", 3000), line("b", 2000)], { order_type: "takeaway" }),
    rules: [
      disc("half-a", { value: { type: "fixed", amount: 5000 }, scope: { type: "products", product_ids: ["prod-a"] }, priority: 10 }),
      disc("bill-10-min-50", { level: "order", conditions: { min_spend: { amount: 5000, basis: "order" } }, priority: 50 }),
    ],
    context: ctx(),
    expect: {
      adjustments: { "half-a": -1500, "bill-10-min-50": -350 },
      adjustment_lines: { "bill-10-min-50": { a: -150, b: -200 } },
      line_nets: { a: 1350, b: 1800 },
      gst_total: 122 + 162,
      total: 1350 + 1800 + 122 + 162,
    },
  },
  {
    id: "R131",
    title: "Minimum spend (scoped basis) exactly met by quantity: 4 × $25 wine reaches $100; the food line neither counts nor is discounted",
    covers: ["min_spend_scoped", "scope_tags", "quantity", "line_percent", "tax_exclusive"],
    working: "Wine 2500 × 4 = 10000 ≥ 10000 (scoped). 10% = 1000 → 9000. Food 500 is outside the scope. GST 810 + 45. Total = 9000 + 500 + 810 + 45 = 10355.",
    order: order([line("wine", 2500, { quantity: 4, tags: ["alcohol"] }), line("food", 500)], { order_type: "takeaway" }),
    rules: [disc("wine-10", { scope: { type: "tags", tags: ["alcohol"] }, conditions: { min_spend: { amount: 10_000, basis: "scoped" } } })],
    context: ctx(),
    expect: {
      adjustments: { "wine-10": -1000 },
      adjustment_lines: { "wine-10": { wine: -1000 } },
      line_nets: { wine: 9000, food: 500 },
      gst_total: 810 + 45,
      total: 9000 + 500 + 810 + 45,
    },
  },
  {
    id: "R132",
    title: "Minimum spend (scoped basis) exactly met across two child categories of the scoped parent",
    covers: ["min_spend_scoped", "scope_categories", "line_percent", "tax_exclusive"],
    working:
      "Scope is the parent category drinks. beer (beer under drinks) 6000 + juice (juice under drinks) 4000 = 10000 ≥ 10000; food 2000 does not count. " +
      "10%: 600 + 400 → nets 5400, 3600; food 2000. GST 486 + 324 + 180 = 990. Total = 11000 + 990 = 11990.",
    order: order(
      [
        line("beer", 6000, { category_id: "beer", parent_category_id: "drinks" }),
        line("juice", 4000, { category_id: "juice", parent_category_id: "drinks" }),
        line("food", 2000, { category_id: "food" }),
      ],
      { order_type: "takeaway" },
    ),
    rules: [disc("drinks-10", { scope: { type: "categories", category_ids: ["drinks"] }, conditions: { min_spend: { amount: 10_000, basis: "scoped" } } })],
    context: ctx(),
    expect: {
      adjustments: { "drinks-10": -1000 },
      adjustment_lines: { "drinks-10": { beer: -600, juice: -400 } },
      line_nets: { beer: 5400, juice: 3600, food: 2000 },
      gst_total: 486 + 324 + 180,
      total: 5400 + 3600 + 2000 + 990,
    },
  },
  {
    id: "R133",
    title: "Minimum spend (order basis) in inclusive mode is measured on the GST-inclusive prices: 2500 + 2500 meets $50",
    covers: ["min_spend_order", "tax_inclusive", "line_percent", "rounding"],
    working: "Spend 5000 ≥ 5000. 10% off: 250 + 250 → 2250 each. GST inside 2250: 2250 × 9/109 = 185.78 → 186 each. Total payable 4500; GST reported 372.",
    order: order([line("a", 2500), line("b", 2500)], { order_type: "takeaway" }),
    rules: [MIN_50_ORDER],
    context: ctx("inclusive"),
    expect: { adjustments: { "ten-min-50": -500 }, line_nets: { a: 2250, b: 2250 }, line_gst: { a: 186, b: 186 }, gst_total: 372, total: 4500 },
  },
  {
    id: "R134",
    title: "Minimum spend (order basis) in inclusive mode missed by one cent: 2500 + 2499",
    covers: ["min_spend_order", "tax_inclusive", "rounding"],
    working: "Spend 4999 < 5000; skipped. GST inside: 2500 × 9/109 = 206.42 → 206; 2499 × 9/109 = 206.34 → 206. Total payable 4999; GST reported 412.",
    order: order([line("a", 2500), line("b", 2499)], { order_type: "takeaway" }),
    rules: [MIN_50_ORDER],
    context: ctx("inclusive"),
    expect: { not_applied: ["ten-min-50"], line_gst: { a: gstIn(2500), b: gstIn(2499) }, gst_total: 206 + 206, total: 4999 },
  },
  {
    id: "R135",
    title: "Two group-conditioned rules, customer in both groups: both apply, stacking in priority order",
    covers: ["customer_group", "line_percent", "stackable", "tax_exclusive"],
    working: "vip-10 (10) needs vip: 2000 → 1800. staff-20 (20) needs staff: 20% of the running 1800 = 360 → 1440. GST 129.6 → 130. Total = 1440 + 130 = 1570.",
    order: order([line("a", 2000)], { order_type: "takeaway", customer_group_ids: ["vip", "staff"] }),
    rules: [disc("vip-10", { conditions: { customer_group_ids: ["vip"] }, priority: 10 }), disc("staff-20", { value: { type: "fixed", amount: 2000 }, conditions: { customer_group_ids: ["staff"] }, priority: 20 })],
    context: ctx(),
    expect: { adjustments: { "vip-10": -200, "staff-20": -360 }, line_nets: { a: 1440 }, gst_total: 130, total: 1440 + 130 },
  },
  {
    id: "R136",
    title: "Two group-conditioned rules, customer in one group only: just that rule applies",
    covers: ["customer_group", "line_percent", "tax_exclusive"],
    working: "Customer is staff but not vip: vip-10 skipped, staff-20 applies: 2000 × 20% = 400 → 1600. GST 144. Total = 1600 + 144 = 1744.",
    order: order([line("a", 2000)], { order_type: "takeaway", customer_group_ids: ["staff"] }),
    rules: [disc("vip-10", { conditions: { customer_group_ids: ["vip"] }, priority: 10 }), disc("staff-20", { value: { type: "fixed", amount: 2000 }, conditions: { customer_group_ids: ["staff"] }, priority: 20 })],
    context: ctx(),
    expect: { adjustments: { "staff-20": -400 }, not_applied: ["vip-10"], line_nets: { a: 1600 }, gst_total: 144, total: 1600 + 144 },
  },
  {
    id: "R137",
    title: "A rule listing two groups applies once to a customer who is in both of them",
    covers: ["customer_group", "line_percent", "tax_exclusive"],
    working: "Rule groups [vip, corporate]; customer [vip, corporate]. The condition is any-of and holds once; the rule is one adjustment: 2000 × 10% = 200 → 1800. GST 162. Total 1962.",
    order: order([line("a", 2000)], { order_type: "takeaway", customer_group_ids: ["vip", "corporate"] }),
    rules: [disc("promo", { conditions: { customer_group_ids: ["vip", "corporate"] } })],
    context: ctx(),
    expect: { adjustments: { promo: -200 }, line_nets: { a: 1800 }, gst_total: 162, total: 1800 + 162 },
  },
  {
    id: "R138",
    title: "Corporate 12% off the bill (order-level, group-conditioned) on a dine-in order, service charge on the discounted nets",
    covers: ["customer_group", "order_percent", "fee_percent", "fee_no_compounding", "seed_rules", "rounding", "tax_exclusive"],
    working:
      "Customer [corporate, staff] ∩ [corporate] holds. Pool 3000 + 1000 = 4000 × 12% = 480, spread 360/120 → nets 2640, 880. Service charge 264 + 88 = 352. " +
      "GST on nets 237.6 → 238, 79.2 → 79; on SC 23.76 → 24, 7.92 → 8. Total = 3520 + 352 + 317 + 32 = 4221.",
    order: order([line("a", 3000), line("b", 1000)], { customer_group_ids: ["corporate", "staff"] }),
    rules: [disc("corp-12", { value: { type: "fixed", amount: 1200 }, level: "order", conditions: { customer_group_ids: ["corporate"] } }), SC],
    context: ctx(),
    expect: {
      adjustments: { "corp-12": -480, [SEED_RULE_IDS.serviceCharge]: 352 },
      adjustment_lines: { "corp-12": { a: -360, b: -120 }, [SEED_RULE_IDS.serviceCharge]: { a: 264, b: 88 } },
      line_nets: { a: 2640, b: 880 },
      gst_total: 238 + 79 + 24 + 8,
      total: 2640 + 880 + 352 + 238 + 79 + 24 + 8,
    },
  },
];
