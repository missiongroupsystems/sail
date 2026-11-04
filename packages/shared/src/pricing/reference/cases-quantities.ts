import { SEED_RULES, SEED_RULE_IDS } from "../seed.js";
import type { PricingRuleInput } from "../schemas.js";
import { ctx, line, order, type RefCase } from "./dsl.js";

/**
 * Reference cases R113–R122: quantities, caps, rule ordering and the
 * interplay of exclusive and stackable discounts with fees.
 * Fixed-per-unit discounts with quantity > 1 and caps; the same basket under a
 * line-level and an order-level percent (different cents); several automatic
 * rules with explicit priorities, including a tie broken by id; and fees that
 * are never blocked by an exclusive discount.
 */

const SC = SEED_RULES.find((r) => r.id === SEED_RULE_IDS.serviceCharge)!;
const DEPOSIT = SEED_RULES.find((r) => r.id === SEED_RULE_IDS.containerDeposit)!;

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

/** Three lines of 1005 each: a 10% line rule and a 10% order rule give different cents. */
const THREE_1005 = [line("a", 1005), line("b", 1005), line("c", 1005)];

export const QUANTITY_CASES: RefCase[] = [
  {
    id: "R113",
    title: "Fixed per unit × quantity 4 hits the rule's cap: 4 × 200 = 800, capped at 500",
    covers: ["line_fixed_per_unit", "quantity", "cap", "tax_exclusive"],
    working: "a 1000 × 4 = 4000. $2 × 4 = 800 > cap 500 → 500 (one line, so the whole cap lands on it; capped). Net 3500. GST 315. Total = 3500 + 315 = 3815.",
    order: order([line("a", 1000, { quantity: 4 })], { order_type: "takeaway" }),
    rules: [disc("two-per-unit", { calc: "fixed_per_unit", value: { type: "fixed", amount: 200 }, cap: 500 })],
    context: ctx(),
    expect: { adjustments: { "two-per-unit": -500 }, line_nets: { a: 3500 }, gst_total: 315, total: 3500 + 315 },
  },
  {
    id: "R114",
    title: "Fixed per unit on two lines with different quantities, capped and spread back by the uncapped amounts (900/300 → 750/250)",
    covers: ["line_fixed_per_unit", "quantity", "cap", "rounding", "tax_exclusive"],
    working:
      "a 1200 × 3 = 3600, $3 × 3 = 900; b 500 × 1, $3 × 1 = 300. Uncapped 1200 > cap 1000; spread 1000 by 900/300: 750/250 (exact). Nets 2850, 250. " +
      "GST 256.5 → 257; 22.5 → 23. Total = 2850 + 250 + 257 + 23 = 3380.",
    order: order([line("a", 1200, { quantity: 3 }), line("b", 500)], { order_type: "takeaway" }),
    rules: [disc("three-per-unit", { calc: "fixed_per_unit", value: { type: "fixed", amount: 300 }, cap: 1000 })],
    context: ctx(),
    expect: {
      adjustments: { "three-per-unit": -1000 },
      adjustment_lines: { "three-per-unit": { a: -750, b: -250 } },
      line_nets: { a: 2850, b: 250 },
      gst_total: 257 + 23,
      total: 2850 + 250 + 257 + 23,
    },
  },
  {
    id: "R115",
    title: "Fixed per unit limited by the line's running amount on one line and by the rule's cap across both (200/1500 → 118/882)",
    covers: ["line_fixed_per_unit", "quantity", "cap", "rounding", "tax_exclusive"],
    working:
      "a 100 × 2 = 200: $3 × 2 = 600 exceeds the line, so min(600, 200) = 200. b 1000 × 5 = 5000: 300 × 5 = 1500. Sum 1700 > cap 1000. Spread 1000 by 200/1500: " +
      "117.65/882.35, floors 117 + 882 = 999, leftover cent to the larger remainder (.65, a) → 118/882. Nets 82, 4118. GST 7.38 → 7; 370.62 → 371. Total = 82 + 4118 + 7 + 371 = 4578.",
    order: order([line("a", 100, { quantity: 2 }), line("b", 1000, { quantity: 5 })], { order_type: "takeaway" }),
    rules: [disc("three-per-unit", { calc: "fixed_per_unit", value: { type: "fixed", amount: 300 }, cap: 1000 })],
    context: ctx(),
    expect: {
      adjustments: { "three-per-unit": -1000 },
      adjustment_lines: { "three-per-unit": { a: -118, b: -882 } },
      line_nets: { a: 82, b: 4118 },
      gst_total: 7 + 371,
      total: 82 + 4118 + 7 + 371,
    },
  },
  {
    id: "R116",
    title: "Line-level 10% on three 1005 lines: each line rounds 100.5 → 101, so 303 off in total",
    covers: ["line_percent", "rounding", "tax_exclusive"],
    working: "1005 × 10% = 100.5 → 101 per line; 3 × 101 = 303. Nets 904 × 3. GST 81.36 → 81 × 3 = 243. Total = 2712 + 243 = 2955. Compare R117.",
    order: order(THREE_1005, { order_type: "takeaway" }),
    rules: [disc("line-10")],
    context: ctx(),
    expect: {
      adjustments: { "line-10": -303 },
      adjustment_lines: { "line-10": { a: -101, b: -101, c: -101 } },
      line_nets: { a: 904, b: 904, c: 904 },
      gst_total: 243,
      total: 2712 + 243,
    },
  },
  {
    id: "R117",
    title: "Order-level 10% on the same three 1005 lines: 10% of 3015 = 301.5 → 302, spread 101/101/100, one cent less than the line rule",
    covers: ["order_percent", "rounding", "tax_exclusive"],
    working:
      "Pool 3015 × 10% = 301.5 → 302 (rounded once, not per line). Spread by equal weights: 100.67 each, floors 100 × 3 = 300, two leftover cents to the earlier lines → 101/101/100. " +
      "Nets 904, 904, 905. GST 81, 81, 81.45 → 81 = 243. Total = 2713 + 243 = 2956 (R116 gave 2955).",
    order: order(THREE_1005, { order_type: "takeaway" }),
    rules: [disc("bill-10", { level: "order" })],
    context: ctx(),
    expect: {
      adjustments: { "bill-10": -302 },
      adjustment_lines: { "bill-10": { a: -101, b: -101, c: -100 } },
      line_nets: { a: 904, b: 904, c: 905 },
      gst_total: 243,
      total: 2713 + 243,
    },
  },
  {
    id: "R118",
    title: "Three automatic rules with explicit priorities: 20% off food (10), then 10% off everything (20), then 5% off the bill (30)",
    covers: ["line_percent", "order_percent", "stackable", "scope_categories", "scope_all", "rounding", "tax_exclusive"],
    working:
      "early-bird (10) 20% off food: main 2000 → 1600; dessert 600 → 480; drink untouched. member (20) 10% off the running amounts: main 160 → 1440; drink 80 → 720; dessert 48 → 432. " +
      "bill-5 (30) order-level: pool 1440 + 720 + 432 = 2592 × 5% = 129.6 → 130, spread 72.22/36.11/21.67 → floors 129, leftover cent to dessert (.67) → 72/36/22. " +
      "Nets 1368, 684, 410. GST 123.12 → 123; 61.56 → 62; 36.9 → 37. Total = 2462 + 222 = 2684.",
    order: order([line("main", 2000, { category_id: "food" }), line("drink", 800, { category_id: "drink" }), line("dessert", 600, { category_id: "food" })], { order_type: "takeaway" }),
    rules: [
      disc("early-bird", { value: { type: "fixed", amount: 2000 }, scope: { type: "categories", category_ids: ["food"] }, priority: 10 }),
      disc("member", { priority: 20 }),
      disc("bill-5", { value: { type: "fixed", amount: 500 }, level: "order", priority: 30 }),
    ],
    context: ctx(),
    expect: {
      adjustments: { "early-bird": -(400 + 120), member: -(160 + 80 + 48), "bill-5": -130 },
      adjustment_lines: { "early-bird": { main: -400, dessert: -120 }, member: { main: -160, drink: -80, dessert: -48 }, "bill-5": { main: -72, drink: -36, dessert: -22 } },
      line_nets: { main: 1368, drink: 684, dessert: 410 },
      gst_total: 123 + 62 + 37,
      total: 1368 + 684 + 410 + 123 + 62 + 37,
    },
  },
  {
    id: "R119",
    title: "Two rules at the same priority are ordered by id: 15% (a-fifteen) before 10% (b-ten) on 1005 gives 769, the other order would give 768",
    covers: ["line_percent", "stackable", "rounding", "tax_exclusive"],
    working:
      "Both rules have priority 10; ties sort by id, so a-fifteen runs first: 1005 × 15% = 150.75 → 151 → 854; then b-ten: 854 × 10% = 85.4 → 85 → 769. " +
      "(Had b-ten run first: 1005 → 100.5 → 101 → 904; 904 × 15% = 135.6 → 136 → 768.) GST 69.21 → 69. Total = 769 + 69 = 838.",
    order: order([line("a", 1005)], { order_type: "takeaway" }),
    rules: [disc("b-ten", { priority: 10 }), disc("a-fifteen", { value: { type: "fixed", amount: 1500 }, priority: 10 })],
    context: ctx(),
    expect: { adjustments: { "a-fifteen": -151, "b-ten": -85 }, line_nets: { a: 769 }, gst_total: 69, total: 769 + 69 },
  },
  {
    id: "R120",
    title: "Exclusive discount blocks later discounts on its line but not the service charge: fees are never blocked",
    covers: ["exclusive", "stackable", "line_percent", "order_percent", "fee_percent", "fee_no_compounding", "scope_categories", "seed_rules", "tax_exclusive"],
    working:
      "x-half-food (10, exclusive) 50% off food: 2000 → 1000, food blocked. y-ten-all (20) applies to drink only: 1000 → 900. z-bill-ten (30, order-level) pool is the unblocked drink: 90 → 810. " +
      "Service charge 10% on every net, including the blocked food line: 100 + 81 = 181. GST on nets 90 + 72.9 → 73; on SC 9 + 7.29 → 7. Total = 1000 + 810 + 181 + 90 + 73 + 9 + 7 = 2170.",
    order: order([line("food", 2000, { category_id: "food" }), line("drink", 1000, { category_id: "drink" })]),
    rules: [
      disc("x-half-food", { value: { type: "fixed", amount: 5000 }, scope: { type: "categories", category_ids: ["food"] }, stacking: "exclusive", priority: 10 }),
      disc("y-ten-all", { priority: 20 }),
      disc("z-bill-ten", { level: "order", priority: 30 }),
      SC,
    ],
    context: ctx(),
    expect: {
      adjustments: { "x-half-food": -1000, "y-ten-all": -100, "z-bill-ten": -90, [SEED_RULE_IDS.serviceCharge]: 181 },
      adjustment_lines: { [SEED_RULE_IDS.serviceCharge]: { food: 100, drink: 81 } },
      line_nets: { food: 1000, drink: 810 },
      line_fees: { food: 100, drink: 81 },
      gst_total: 90 + 73 + 9 + 7,
      total: 1000 + 810 + 181 + 90 + 73 + 9 + 7,
    },
  },
  {
    id: "R121",
    title: "A stackable rule ahead of an exclusive one: the exclusive rule applies to the running amount and blocks only what comes after it",
    covers: ["exclusive", "stackable", "line_percent", "order_percent", "fee_percent", "scope_categories", "seed_rules", "tax_exclusive"],
    working:
      "member (10, stackable) 10% off everything: food 2000 → 1800; drink 1000 → 900. half-food (20, exclusive) 50% of the running food 1800 = 900 → 900, food blocked. " +
      "bill-10 (30, order-level) pool is drink only: 90 → 810. Service charge 90 + 81 = 171. GST on nets 81 + 72.9 → 73; on SC 8.1 → 8, 7.29 → 7. Total = 900 + 810 + 171 + 81 + 73 + 8 + 7 = 2050.",
    order: order([line("food", 2000, { category_id: "food" }), line("drink", 1000, { category_id: "drink" })]),
    rules: [
      disc("member", { priority: 10 }),
      disc("half-food", { value: { type: "fixed", amount: 5000 }, scope: { type: "categories", category_ids: ["food"] }, stacking: "exclusive", priority: 20 }),
      disc("bill-10", { level: "order", priority: 30 }),
      SC,
    ],
    context: ctx(),
    expect: {
      adjustments: { member: -(200 + 100), "half-food": -900, "bill-10": -90, [SEED_RULE_IDS.serviceCharge]: 171 },
      adjustment_lines: { "bill-10": { drink: -90 }, [SEED_RULE_IDS.serviceCharge]: { food: 90, drink: 81 } },
      line_nets: { food: 900, drink: 810 },
      gst_total: 81 + 73 + 8 + 7,
      total: 900 + 810 + 171 + 81 + 73 + 8 + 7,
    },
  },
  {
    id: "R122",
    title: "Quantity 6 with a per-unit discount, a per-unit deposit and the service charge on the same line",
    covers: ["line_fixed_per_unit", "fee_fixed_per_unit", "fee_percent", "fee_not_gst_applicable", "scope_bcrs", "quantity", "seed_rules", "tax_exclusive"],
    working:
      "6 cans × 250 = 1500. $0.50 × 6 = 300 off → 1200. Service charge 10% of 1200 = 120. Deposit 6 × 10 = 60 (no GST, not discounted). " +
      "GST 108 on the net, 10.8 → 11 on the SC. Total = 1200 + 120 + 60 + 108 + 11 = 1499.",
    order: order([line("can", 250, { quantity: 6, is_bcrs: true })]),
    rules: [disc("fifty-per-unit", { calc: "fixed_per_unit", value: { type: "fixed", amount: 50 } }), SC, DEPOSIT],
    context: ctx(),
    expect: {
      adjustments: { "fifty-per-unit": -300, [SEED_RULE_IDS.serviceCharge]: 120, [SEED_RULE_IDS.containerDeposit]: 60 },
      line_nets: { can: 1200 },
      line_fees: { can: 180 },
      fee_total: 180,
      gst_total: 108 + 11,
      total: 1200 + 120 + 60 + 108 + 11,
    },
  },
];
