import type { PricingRuleInput } from "../schemas.js";
import { ctx, taxEx, line, order, type RefCase } from "./dsl.js";

/**
 * Reference cases R012–R027: discount mechanics.
 * Line percent, fixed per unit, order percent, fixed per order (largest remainder),
 * exclusive vs stackable, caps, and half-up rounding. Every expected amount is a
 * hand calculation written as arithmetic; discounts are negative.
 *
 * None of these orders carry a service charge: only the rules listed in each
 * case are passed to the engine.
 */

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

export const DISCOUNT_CASES: RefCase[] = [
  {
    id: "R012",
    title: "Line percent: 10% off each line, rounded per line",
    covers: ["line_percent", "scope_all", "tax_exclusive"],
    working:
      "a 2500 × 10% = 250 → net 2250; b 1800 × 10% = 180 → net 1620. GST 9%: 2250 × 0.09 = 202.5 → 203 (half up); 1620 × 0.09 = 145.8 → 146. " +
      "Total = 2250 + 1620 + 203 + 146 = 4219.",
    order: order([line("a", 2500), line("b", 1800)]),
    rules: [disc("ten-off")],
    context: ctx(),
    expect: {
      adjustments: { "ten-off": -(250 + 180) },
      adjustment_lines: { "ten-off": { a: -250, b: -180 } },
      line_nets: { a: 2250, b: 1620 },
      line_tax: { a: 203, b: 146 },
      tax_total: 203 + 146,
      total: 2250 + 1620 + 203 + 146,
    },
  },
  {
    id: "R013",
    title: "Fixed per unit: $3 off per unit, capped at the line's running amount so net never goes below 0",
    covers: ["line_fixed_per_unit", "quantity", "tax_exclusive"],
    working:
      "a 1200 × 3 = 3600; 300 × 3 = 900 off → net 2700. b 200 × 1 = 200; 300 × 1 = 300 would exceed the line, so the discount is min(300, 200) = 200 → net 0. " +
      "GST: 2700 × 0.09 = 243; 0. Total = 2700 + 0 + 243 = 2943.",
    order: order([line("a", 1200, { quantity: 3 }), line("b", 200)]),
    rules: [disc("three-per-unit", { calc: "fixed_per_unit", value: { type: "fixed", amount: 300 } })],
    context: ctx(),
    expect: {
      adjustments: { "three-per-unit": -(900 + 200) },
      adjustment_lines: { "three-per-unit": { a: -900, b: -200 } },
      line_nets: { a: 2700, b: 0 },
      subtotal: 3600 + 200,
      tax_total: 243,
      total: 2700 + 243,
    },
  },
  {
    id: "R014",
    title: "Order percent: 10% of the eligible pool, spread across lines in proportion",
    covers: ["order_percent", "scope_all", "tax_exclusive"],
    working:
      "Pool 3000 + 1000 + 500 = 4500; 10% = 450. Shares 450 × 3000/4500 = 300, × 1000/4500 = 100, × 500/4500 = 50 (exact). " +
      "Nets 2700, 900, 450. GST 243, 81, 40.5 → 41. Total = 4050 + 243 + 81 + 41 = 4415.",
    order: order([line("a", 3000), line("b", 1000), line("c", 500)]),
    rules: [disc("bill-10", { level: "order" })],
    context: ctx(),
    expect: {
      adjustments: { "bill-10": -450 },
      adjustment_lines: { "bill-10": { a: -300, b: -100, c: -50 } },
      line_nets: { a: 2700, b: 900, c: 450 },
      line_tax: { a: 243, b: 81, c: 41 },
      total: 2700 + 900 + 450 + 243 + 81 + 41,
    },
  },
  {
    id: "R015",
    title: "Fixed per order: $10 off spread across 3000/1000/500 by largest remainder (667/222/111)",
    covers: ["order_fixed", "rounding", "tax_exclusive"],
    working:
      "Pool 4500. Exact shares: 1000 × 3000/4500 = 666.67, × 1000/4500 = 222.22, × 500/4500 = 111.11. Floors 666 + 222 + 111 = 999; the leftover cent goes to the " +
      "largest remainder (.67, line a) → 667/222/111. Nets 2333, 778, 389. GST 209.97 → 210, 70.02 → 70, 35.01 → 35. Total = 3500 + 210 + 70 + 35 = 3815.",
    order: order([line("a", 3000), line("b", 1000), line("c", 500)]),
    rules: [disc("ten-dollars", { calc: "fixed_per_order", level: "order", value: { type: "fixed", amount: 1000 } })],
    context: ctx(),
    expect: {
      adjustments: { "ten-dollars": -1000 },
      adjustment_lines: { "ten-dollars": { a: -667, b: -222, c: -111 } },
      line_nets: { a: 3000 - 667, b: 1000 - 222, c: 500 - 111 },
      line_tax: { a: 210, b: 70, c: 35 },
      total: 2333 + 778 + 389 + 210 + 70 + 35,
    },
  },
  {
    id: "R016",
    title: "Fixed per order larger than the pool takes the whole pool: $50 off a $20 order leaves nets of 0",
    covers: ["order_fixed", "tax_exclusive"],
    working: "Pool 1200 + 800 = 2000 < 5000, so the discount is min(5000, 2000) = 2000, spread 1200/800. Nets 0 and 0. GST 0. Total 0.",
    order: order([line("a", 1200), line("b", 800)]),
    rules: [disc("fifty-dollars", { calc: "fixed_per_order", level: "order", value: { type: "fixed", amount: 5000 } })],
    context: ctx(),
    expect: {
      adjustments: { "fifty-dollars": -2000 },
      adjustment_lines: { "fifty-dollars": { a: -1200, b: -800 } },
      line_nets: { a: 0, b: 0 },
      discount_total: -2000,
      tax_total: 0,
      total: 0,
    },
  },
  {
    id: "R017",
    title: "Exclusive line rule blocks lower-priority line rules AND the order-level discount on its lines",
    covers: ["exclusive", "stackable", "line_percent", "order_percent", "scope_categories", "tax_exclusive"],
    working:
      "X (priority 10, exclusive) 50% off food: 2000 × 50% = 1000 → food net 1000, food blocked. Y (priority 20, stackable) 10% off everything applies to drink only: " +
      "1000 × 10% = 100 → 900. Z (priority 30, order-level 10%) sees a pool of the unblocked lines only: 900 × 10% = 90 → drink 810. " +
      "GST 90 and 72.9 → 73. Total = 1000 + 810 + 90 + 73 = 1973.",
    order: order([line("food", 2000, { category_id: "food" }), line("drink", 1000, { category_id: "drink" })]),
    rules: [
      disc("x-half-food", { value: { type: "fixed", amount: 5000 }, scope: { type: "categories", category_ids: ["food"] }, stacking: "exclusive", priority: 10 }),
      disc("y-ten-all", { priority: 20 }),
      disc("z-bill-ten", { level: "order", priority: 30 }),
    ],
    context: ctx(),
    expect: {
      adjustments: { "x-half-food": -1000, "y-ten-all": -100, "z-bill-ten": -90 },
      adjustment_lines: { "y-ten-all": { drink: -100 }, "z-bill-ten": { drink: -90 } },
      line_nets: { food: 1000, drink: 810 },
      tax_total: 90 + 73,
      total: 1000 + 810 + 90 + 73,
    },
  },
  {
    id: "R018",
    title: "Stackable discounts apply to the running amount: 20% then 10% is 28% off, not 30%",
    covers: ["stackable", "line_percent", "tax_exclusive"],
    working: "5000 × 20% = 1000 → 4000. Then 10% of the running 4000 = 400 (not 500) → 3600. GST 324. Total = 3600 + 324 = 3924.",
    order: order([line("a", 5000)]),
    rules: [disc("twenty", { value: { type: "fixed", amount: 2000 }, priority: 10 }), disc("ten", { priority: 20 })],
    context: ctx(),
    expect: { adjustments: { twenty: -1000, ten: -400 }, line_nets: { a: 3600 }, tax_total: 324, total: 3600 + 324 },
  },
  {
    id: "R019",
    title: "Two exclusive rules on the same line: only the higher-priority one applies",
    covers: ["exclusive", "line_percent", "tax_exclusive"],
    working: "P (priority 5, exclusive 30%) applies first: 2000 × 30% = 600 → 1400 and blocks the line. Q (priority 15, exclusive 50%) finds every line blocked and is skipped. GST 126. Total 1526.",
    order: order([line("a", 2000)]),
    rules: [
      disc("p-thirty", { value: { type: "fixed", amount: 3000 }, stacking: "exclusive", priority: 5 }),
      disc("q-half", { value: { type: "fixed", amount: 5000 }, stacking: "exclusive", priority: 15 }),
    ],
    context: ctx(),
    expect: { adjustments: { "p-thirty": -600 }, not_applied: ["q-half"], line_nets: { a: 1400 }, tax_total: 126, total: 1400 + 126 },
  },
  {
    id: "R020",
    title: "Cap: 25% of 8000 and 4000 is 3000, capped at 1000 and spread back 667/333",
    covers: ["cap", "line_percent", "rounding", "tax_exclusive"],
    working:
      "Uncapped 2000 + 1000 = 3000 > cap 1000. Spread 1000 by the uncapped amounts: 1000 × 2000/3000 = 666.67, 1000 × 1000/3000 = 333.33; floors 666 + 333 = 999, the leftover cent " +
      "goes to a → 667/333. Nets 7333, 3667. GST 659.97 → 660, 330.03 → 330. Total = 7333 + 3667 + 660 + 330 = 11990.",
    order: order([line("a", 8000), line("b", 4000)]),
    rules: [disc("quarter-capped", { value: { type: "fixed", amount: 2500 }, cap: 1000 })],
    context: ctx(),
    expect: {
      adjustments: { "quarter-capped": -1000 },
      adjustment_lines: { "quarter-capped": { a: -667, b: -333 } },
      line_nets: { a: 8000 - 667, b: 4000 - 333 },
      tax_total: 660 + 330,
      total: 7333 + 3667 + 660 + 330,
    },
  },
  {
    id: "R021",
    title: "Cap exactly equal to the computed total is not a cap: 25% of 4000 = 1000 with cap 1000",
    covers: ["cap", "line_percent", "tax_exclusive"],
    working: "4000 × 25% = 1000, which does not exceed the cap of 1000, so the full 1000 applies (the adjustment is not marked capped). Net 3000; GST 270; total 3270.",
    order: order([line("a", 4000)]),
    rules: [disc("quarter-cap-1000", { value: { type: "fixed", amount: 2500 }, cap: 1000 })],
    context: ctx(),
    expect: { adjustments: { "quarter-cap-1000": -1000 }, line_nets: { a: 3000 }, tax_total: 270, total: 3000 + 270 },
  },
  {
    id: "R022",
    title: "Capped order percent: 10% of 10000 = 1000, cap 700, spread 420/280",
    covers: ["cap", "order_percent", "tax_exclusive"],
    working:
      "Pool 6000 + 4000 = 10000; 10% = 1000; uncapped shares 600/400. Cap 700 spread by 600/400: 700 × 600/1000 = 420, 700 × 400/1000 = 280 (exact). " +
      "Nets 5580, 3720. GST 502.2 → 502, 334.8 → 335. Total = 5580 + 3720 + 502 + 335 = 10137.",
    order: order([line("a", 6000), line("b", 4000)]),
    rules: [disc("bill-ten-cap", { level: "order", cap: 700 })],
    context: ctx(),
    expect: {
      adjustments: { "bill-ten-cap": -700 },
      adjustment_lines: { "bill-ten-cap": { a: -420, b: -280 } },
      line_nets: { a: 5580, b: 3720 },
      tax_total: 502 + 335,
      total: 5580 + 3720 + 502 + 335,
    },
  },
  {
    id: "R023",
    title: "Rounding: 10% of 1005 = 100.5 → 101 (half up); 10% of 1050 = 105 exactly",
    covers: ["rounding", "line_percent", "tax_exclusive"],
    working:
      "a 1005 × 10% = 100.5 → 101 → net 904. b 1050 × 10% = 105 → net 945. GST 904 × 0.09 = 81.36 → 81; 945 × 0.09 = 85.05 → 85. " +
      "Total = 904 + 945 + 81 + 85 = 2015.",
    order: order([line("a", 1005), line("b", 1050)]),
    rules: [disc("ten-off")],
    context: ctx(),
    expect: {
      adjustment_lines: { "ten-off": { a: -101, b: -105 } },
      line_nets: { a: 1005 - 101, b: 1050 - 105 },
      line_tax: { a: 81, b: 85 },
      total: 904 + 945 + 81 + 85,
    },
  },
  {
    id: "R024",
    title: "GST rounding half up per line: 9% of 1005 = 90.45 → 90; 9% of 1050 = 94.5 → 95",
    covers: ["rounding", "tax_exclusive", "base_price"],
    working: "No discounts or fees. GST: 1005 × 0.09 = 90.45 → 90 (below the half); 1050 × 0.09 = 94.5 → 95 (exactly half rounds up). Total = 1005 + 1050 + 90 + 95 = 2240.",
    order: order([line("a", 1005), line("b", 1050)]),
    rules: [],
    context: ctx(),
    expect: { line_tax: { a: 90, b: 95 }, tax_total: 90 + 95, total: 1005 + 1050 + 90 + 95 },
  },
  {
    id: "R025",
    title: "GST total is the sum of per-line GST (90 + 90 = 180), not GST of the total (9% of 2010 = 180.9 → 181)",
    covers: ["rounding", "tax_exclusive"],
    working:
      "Two lines of 1005. Per line: 1005 × 0.09 = 90.45 → 90; sum 180. Had GST been taken on the total, 2010 × 0.09 = 180.9 → 181. The receipt shows 180 so the GST line equals the sum of its parts. " +
      "Total = 2010 + 180 = 2190.",
    order: order([line("a", 1005), line("b", 1005)]),
    rules: [],
    context: ctx(),
    expect: { line_tax: { a: 90, b: 90 }, tax_total: 180, total: 2010 + 180 },
  },
  {
    id: "R026",
    title: "Fixed per unit after a percent discount is capped at the running amount, not the base",
    covers: ["line_fixed_per_unit", "line_percent", "stackable", "quantity", "tax_exclusive"],
    working:
      "500 × 3 = 1500. Half-price (priority 10): 750 off → running 750. $3 per unit (priority 20): 300 × 3 = 900 but the line only has 750 left, so min(900, 750) = 750 → net 0. Total 0.",
    order: order([line("a", 500, { quantity: 3 })]),
    rules: [
      disc("half", { value: { type: "fixed", amount: 5000 }, priority: 10 }),
      disc("three-per-unit", { calc: "fixed_per_unit", value: { type: "fixed", amount: 300 }, priority: 20 }),
    ],
    context: ctx(),
    expect: { adjustments: { half: -750, "three-per-unit": -750 }, line_nets: { a: 0 }, discount_total: -1500, tax_total: 0, total: 0 },
  },
  {
    id: "R027",
    title: "An exclusive rule blocks a line even when its own amount on that line rounds to zero",
    covers: ["exclusive", "order_percent", "rounding", "tax_exclusive"],
    working:
      "X (exclusive 10%): a 3000 → 300; b 4 → 0.4 → 0. X applied (total 300) and both lines are blocked. The order-level 10% finds every line blocked and is skipped. " +
      "Nets 2700 and 4. GST 243 and 0.36 → 0. Total = 2700 + 4 + 243 = 2947. (The engine records b's amount on X as zero cents; it is not asserted here because " +
      "JavaScript represents a negated zero as -0.)",
    order: order([line("a", 3000), line("b", 4)]),
    rules: [disc("x-excl", { stacking: "exclusive", priority: 10 }), disc("z-bill", { level: "order", priority: 20 })],
    context: ctx(),
    expect: {
      adjustments: { "x-excl": -300 },
      adjustment_lines: { "x-excl": { a: -300 } },
      not_applied: ["z-bill"],
      line_nets: { a: 2700, b: 4 },
      tax_total: taxEx(2700) + taxEx(4),
      total: 2700 + 4 + 243 + 0,
    },
  },
];
