import { SEED_RULE_IDS } from "../seed.js";
import { SG_SEED_RULES } from "./dsl.js";
import type { PricingRuleInput } from "../schemas.js";
import { ctx, taxIn, line, order, type RefCase } from "./dsl.js";

/**
 * Reference cases R092–R101: inclusive GST with discounts, fees and caps.
 * In inclusive mode every amount already contains GST. The GST inside an
 * amount is amount × 9/109, rounded half up, per line and per fee line; the
 * total payable is net + fees and the GST is reported, never added.
 * Every expected amount is a hand calculation written as arithmetic.
 */

const SC = SG_SEED_RULES.find((r) => r.id === SEED_RULE_IDS.serviceCharge)!;
const DEPOSIT = SG_SEED_RULES.find((r) => r.id === SEED_RULE_IDS.containerDeposit)!;

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

export const INCLUSIVE_CASES: RefCase[] = [
  {
    id: "R092",
    title: "Inclusive: line percent discount, then the GST inside each discounted line",
    covers: ["tax_inclusive", "line_percent", "rounding"],
    working:
      "a 1500 × 10% = 150 → 1350; b 999 × 10% = 99.9 → 100 → 899. Takeaway, no fee. GST inside: 1350 × 9/109 = 111.47 → 111; 899 × 9/109 = 74.23 → 74. " +
      "Total payable = 1350 + 899 = 2249; GST reported 185.",
    order: order([line("a", 1500), line("b", 999)], { order_type: "takeaway" }),
    rules: [disc("ten-off")],
    context: ctx("inclusive"),
    expect: {
      adjustments: { "ten-off": -(150 + 100) },
      adjustment_lines: { "ten-off": { a: -150, b: -100 } },
      line_nets: { a: 1350, b: 899 },
      line_tax: { a: 111, b: 74 },
      tax_total: 111 + 74,
      total: 1350 + 899,
    },
  },
  {
    id: "R093",
    title: "Inclusive: order percent spread across lines, GST inside each net",
    covers: ["tax_inclusive", "order_percent", "rounding"],
    working:
      "Pool 3000 + 1000 + 500 = 4500; 10% = 450, spread 300/100/50 (exact). Nets 2700, 900, 450. GST inside: 2700 × 9/109 = 222.94 → 223; 900 × 9/109 = 74.31 → 74; " +
      "450 × 9/109 = 37.16 → 37. Total payable 4050; GST reported 334.",
    order: order([line("a", 3000), line("b", 1000), line("c", 500)], { order_type: "takeaway" }),
    rules: [disc("bill-10", { level: "order" })],
    context: ctx("inclusive"),
    expect: {
      adjustments: { "bill-10": -450 },
      adjustment_lines: { "bill-10": { a: -300, b: -100, c: -50 } },
      line_nets: { a: 2700, b: 900, c: 450 },
      line_tax: { a: 223, b: 74, c: 37 },
      tax_total: 223 + 74 + 37,
      total: 2700 + 900 + 450,
    },
  },
  {
    id: "R094",
    title: "Inclusive: $10 off the bill spread 667/222/111, GST inside the odd nets",
    covers: ["tax_inclusive", "order_fixed", "rounding"],
    working:
      "Pool 4500; 1000 spread 666.67/222.22/111.11 → 667/222/111 (leftover cent to a). Nets 2333, 778, 389. GST inside: 2333 × 9/109 = 192.63 → 193; " +
      "778 × 9/109 = 64.24 → 64; 389 × 9/109 = 32.12 → 32. Total payable 3500; GST reported 289.",
    order: order([line("a", 3000), line("b", 1000), line("c", 500)], { order_type: "takeaway" }),
    rules: [disc("ten-dollars", { calc: "fixed_per_order", level: "order", value: { type: "fixed", amount: 1000 } })],
    context: ctx("inclusive"),
    expect: {
      adjustments: { "ten-dollars": -1000 },
      adjustment_lines: { "ten-dollars": { a: -667, b: -222, c: -111 } },
      line_nets: { a: 2333, b: 778, c: 389 },
      line_tax: { a: 193, b: 64, c: 32 },
      tax_total: 193 + 64 + 32,
      total: 2333 + 778 + 389,
    },
  },
  {
    id: "R095",
    title: "Inclusive: capped line percent (25% of 8000 and 4000 capped at 1000 → 667/333), GST inside the nets",
    covers: ["tax_inclusive", "cap", "line_percent", "rounding"],
    working:
      "Uncapped 2000 + 1000 = 3000 > cap 1000; spread 1000 by 2000/1000 → 667/333. Nets 7333, 3667. GST inside: 7333 × 9/109 = 605.48 → 605; 3667 × 9/109 = 302.78 → 303. " +
      "Total payable 11000; GST reported 908.",
    order: order([line("a", 8000), line("b", 4000)], { order_type: "takeaway" }),
    rules: [disc("quarter-capped", { value: { type: "fixed", amount: 2500 }, cap: 1000 })],
    context: ctx("inclusive"),
    expect: {
      adjustments: { "quarter-capped": -1000 },
      adjustment_lines: { "quarter-capped": { a: -667, b: -333 } },
      line_nets: { a: 7333, b: 3667 },
      line_tax: { a: 605, b: 303 },
      tax_total: 605 + 303,
      total: 7333 + 3667,
    },
  },
  {
    id: "R096",
    title: "Inclusive: fixed per unit discount with quantities, then the seeded service charge on the discounted GST-inclusive nets",
    covers: ["tax_inclusive", "line_fixed_per_unit", "quantity", "fee_percent", "fee_taxed", "seed_rules", "rounding"],
    working:
      "a 1200 × 3 = 3600, $3 × 3 = 900 off → 2700. b 500 × 2 = 1000, 300 × 2 = 600 off → 400. Service charge 10%: 270 + 40 = 310. " +
      "GST inside nets: 2700 → 223; 400 × 9/109 = 33.03 → 33. GST inside SC: 270 × 9/109 = 22.29 → 22; 40 × 9/109 = 3.30 → 3. " +
      "Total payable = 2700 + 400 + 310 = 3410; GST reported 223 + 33 + 22 + 3 = 281.",
    order: order([line("a", 1200, { quantity: 3 }), line("b", 500, { quantity: 2 })]),
    rules: [disc("three-per-unit", { calc: "fixed_per_unit", value: { type: "fixed", amount: 300 } }), SC],
    context: ctx("inclusive"),
    expect: {
      adjustments: { "three-per-unit": -(900 + 600), [SEED_RULE_IDS.serviceCharge]: 270 + 40 },
      adjustment_lines: { [SEED_RULE_IDS.serviceCharge]: { a: 270, b: 40 } },
      line_nets: { a: 2700, b: 400 },
      line_tax: { a: 223, b: 33 },
      fee_total: 310,
      tax_total: 223 + 33 + 22 + 3,
      total: 2700 + 400 + 310,
    },
  },
  {
    id: "R097",
    title: "Inclusive: fixed per order delivery fee spread by discounted nets (365/135), each fee line carrying its own GST inside",
    covers: ["tax_inclusive", "fee_fixed_per_order", "line_percent", "scope_products", "order_type_condition", "fee_taxed", "rounding"],
    working:
      "10% off product a: 3000 → 2700; b 1000. Delivery fee 500 by nets 2700/1000: 364.86/135.14 → 365/135. GST inside nets: 2700 → 223; 1000 × 9/109 = 82.57 → 83. " +
      "GST inside the fee lines: 365 × 9/109 = 30.14 → 30; 135 × 9/109 = 11.15 → 11. Total payable = 2700 + 1000 + 500 = 4200; GST reported 223 + 83 + 30 + 11 = 347.",
    order: order([line("a", 3000), line("b", 1000)], { order_type: "delivery" }),
    rules: [
      disc("ten-off-a", { scope: { type: "products", product_ids: ["prod-a"] } }),
      fee("delivery", { calc: "fixed_per_order", value: { type: "fixed", amount: 500 }, conditions: { order_types: ["delivery"] }, report_class: "delivery_fee" }),
    ],
    context: ctx("inclusive"),
    expect: {
      adjustments: { "ten-off-a": -300, delivery: 500 },
      adjustment_lines: { delivery: { a: 365, b: 135 } },
      line_nets: { a: 2700, b: 1000 },
      line_fees: { a: 365, b: 135 },
      line_tax: { a: 223, b: 83 },
      fee_total: 500,
      tax_total: 223 + 83 + 30 + 11,
      total: 2700 + 1000 + 500,
    },
  },
  {
    id: "R098",
    title: "Inclusive: discounted BCRS cans keep the full per-unit deposit (no GST), service charge on the discounted net",
    covers: ["tax_inclusive", "scope_deposit", "fee_fixed_per_unit", "fee_untaxed", "fee_percent", "line_percent", "quantity", "seed_rules"],
    working:
      "6 cans × 250 = 1500; 10% off = 150 → 1350. Deposit is per unit and never discounted: 6 × 10 = 60, no GST. Service charge 10% of 1350 = 135. " +
      "GST inside 1350 = 111; inside 135: 135 × 9/109 = 11.15 → 11. Total payable = 1350 + 135 + 60 = 1545; GST reported 122.",
    order: order([line("can", 250, { quantity: 6, has_deposit: true })]),
    rules: [disc("ten-off"), SC, DEPOSIT],
    context: ctx("inclusive"),
    expect: {
      adjustments: { "ten-off": -150, [SEED_RULE_IDS.serviceCharge]: 135, [SEED_RULE_IDS.containerDeposit]: 60 },
      line_nets: { can: 1350 },
      line_fees: { can: 135 + 60 },
      line_tax: { can: 111 },
      fee_total: 195,
      tax_total: 111 + 11,
      total: 1350 + 135 + 60,
    },
  },
  {
    id: "R099",
    title: "Inclusive: capped percent fee (15% of two $20 lines = 600, cap 500 → 250/250) with GST inside each fee line",
    covers: ["tax_inclusive", "cap", "fee_percent", "fee_taxed", "rounding"],
    working:
      "15% of 2000 = 300 per line; 600 > cap 500; spread 500 by 300/300 → 250/250. GST inside nets: 2000 × 9/109 = 165.14 → 165 each. " +
      "GST inside each fee line: 250 × 9/109 = 20.64 → 21. Total payable = 4000 + 500 = 4500; GST reported 165 + 165 + 21 + 21 = 372.",
    order: order([line("a", 2000), line("b", 2000)], { order_type: "delivery" }),
    rules: [fee("surcharge", { value: { type: "fixed", amount: 1500 }, cap: 500, report_class: "delivery_fee" })],
    context: ctx("inclusive"),
    expect: {
      adjustments: { surcharge: 500 },
      adjustment_lines: { surcharge: { a: 250, b: 250 } },
      line_tax: { a: 165, b: 165 },
      fee_total: 500,
      tax_total: 165 + 165 + 21 + 21,
      total: 4000 + 500,
    },
  },
  {
    id: "R100",
    title: "Inclusive: GST reported is the sum of per-line GST (99 + 99 = 198), not the GST inside the total (2386 × 9/109 = 197.01 → 197)",
    covers: ["tax_inclusive", "rounding", "base_price"],
    working:
      "Two lines of 1193. Per line: 1193 × 9/109 = 98.50 → 99 (exactly half of a cent above 98.5 rounds up); sum 198. Had the GST been taken inside the total, " +
      "2386 × 9/109 = 197.01 → 197. The receipt shows 198 so the GST line equals the sum of its parts. Total payable 2386.",
    order: order([line("a", 1193), line("b", 1193)], { order_type: "takeaway" }),
    rules: [],
    context: ctx("inclusive"),
    expect: { line_tax: { a: 99, b: 99 }, tax_total: 198, total: 2386 },
  },
  {
    id: "R101",
    title: "Inclusive: order-level 10% of two 1005 lines is 201 (not 202), spread 101/100 with the odd cent to the earlier line",
    covers: ["tax_inclusive", "order_percent", "rounding"],
    working:
      "Pool 2010 × 10% = 201 (a line-level rule would take 100.5 → 101 per line = 202). Spread 201 by equal weights: 100.5 each, floors 100 + 100, leftover cent to the earlier line → 101/100. " +
      "Nets 904, 905. GST inside: 904 × 9/109 = 74.64 → 75; 905 × 9/109 = 74.72 → 75. Total payable 1809; GST reported 150.",
    order: order([line("a", 1005), line("b", 1005)], { order_type: "takeaway" }),
    rules: [disc("bill-10", { level: "order" })],
    context: ctx("inclusive"),
    expect: {
      adjustments: { "bill-10": -201 },
      adjustment_lines: { "bill-10": { a: -101, b: -100 } },
      line_nets: { a: 904, b: 905 },
      line_tax: { a: taxIn(904), b: taxIn(905) },
      tax_total: 75 + 75,
      total: 904 + 905,
    },
  },
];
