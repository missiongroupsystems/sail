import { SEED_RULE_IDS } from "../seed.js";
import { SG_SEED_RULES } from "./dsl.js";
import type { PricingRuleInput } from "../schemas.js";
import { ctx, taxEx, taxIn, line, order, type RefCase } from "./dsl.js";

/**
 * Reference cases R001–R010: the worked example and the basics.
 * Each `expect` is a hand calculation. Discounts are negative.
 */

const SC = SG_SEED_RULES.find((r) => r.id === SEED_RULE_IDS.serviceCharge)!;
const DEPOSIT = SG_SEED_RULES.find((r) => r.id === SEED_RULE_IDS.containerDeposit)!;

export const ruleA: PricingRuleInput = {
  id: "rule-a",
  kind: "discount",
  name: "25% off food",
  calc: "percent",
  value: { type: "fixed", amount: 2500 },
  scope: { type: "categories", category_ids: ["food"] },
  priority: 10,
  application: "auto",
  report_class: "promo",
};
export const ruleB: PricingRuleInput = {
  id: "rule-b",
  kind: "discount",
  name: "10% off alcohol above $100 for VIP/Corporate",
  calc: "percent",
  value: { type: "fixed", amount: 1000 },
  scope: { type: "tags", tags: ["alcohol"] },
  conditions: { min_spend: { amount: 10_000, basis: "scoped" }, customer_group_ids: ["vip", "corporate"] },
  priority: 20,
  application: "auto",
  report_class: "promo",
};

export const CORE_CASES: RefCase[] = [
  {
    id: "R001",
    title: "Scope doc 4.8 worked example: VIP orders $80 food and $120 wine (exclusive GST)",
    covers: ["line_percent", "scope_categories", "scope_tags", "min_spend_scoped", "customer_group", "fee_percent", "fee_taxed", "tax_exclusive", "seed_rules"],
    working:
      "Rule A: 25% of 8000 = 2000 off food → food net 6000. Rule B: wine spend 12000 ≥ 10000 and customer is VIP → 10% of 12000 = 1200 → wine net 10800. " +
      "Service charge 10% on 16800 = 1680, attached per line: food 600, wine 1080. GST 9% exclusive: food 540, wine 972, SC-food 54, SC-wine 97.2→97. " +
      "Total = 6000 + 10800 + 1680 + 540 + 972 + 54 + 97 = 20143.",
    order: order([line("food", 8000, { category_id: "food" }), line("wine", 12_000, { tags: ["alcohol"] })], { customer_group_ids: ["vip"] }),
    rules: [ruleA, ruleB, SC],
    context: ctx(),
    expect: {
      adjustments: { "rule-a": -2000, "rule-b": -1200, [SEED_RULE_IDS.serviceCharge]: 1680 },
      adjustment_lines: { [SEED_RULE_IDS.serviceCharge]: { food: 600, wine: 1080 } },
      line_nets: { food: 6000, wine: 10_800 },
      line_tax: { food: 540, wine: 972 },
      tax_total: 540 + 972 + 54 + 97,
      total: 6000 + 10_800 + 1680 + 540 + 972 + 54 + 97,
    },
  },
  {
    id: "R002",
    title: "Same basket, customer not in a group: rule B does not apply",
    covers: ["customer_group", "line_percent", "fee_percent", "tax_exclusive"],
    working: "Food net 6000, wine 12000. SC 10% of 18000 = 1800 (600 + 1200). GST: 540 + 1080 + 54 + 108 = 1782. Total 6000+12000+1800+1782 = 21582.",
    order: order([line("food", 8000, { category_id: "food" }), line("wine", 12_000, { tags: ["alcohol"] })]),
    rules: [ruleA, ruleB, SC],
    context: ctx(),
    expect: {
      adjustments: { "rule-a": -2000, [SEED_RULE_IDS.serviceCharge]: 1800 },
      not_applied: ["rule-b"],
      tax_total: 540 + 1080 + 54 + 108,
      total: 6000 + 12_000 + 1800 + 540 + 1080 + 54 + 108,
    },
  },
  {
    id: "R003",
    title: "Minimum spend is measured on undiscounted scoped amounts: $99.99 of wine misses the $100 minimum",
    covers: ["min_spend_scoped", "customer_group", "tax_exclusive"],
    working: "Wine 9999 < 10000, so rule B is skipped even for a VIP. Takeaway, so no service charge. GST 9% of 9999 = 899.91 → 900. Total 10899.",
    order: order([line("wine", 9999, { tags: ["alcohol"] })], { customer_group_ids: ["vip"], order_type: "takeaway" }),
    rules: [ruleB, SC],
    context: ctx(),
    expect: { not_applied: ["rule-b", SEED_RULE_IDS.serviceCharge], tax_total: 900, total: 9999 + 900 },
  },
  {
    id: "R004",
    title: "Plain dine-in order, two items with quantities, service charge only",
    covers: ["base_price", "quantity", "fee_percent", "scope_all", "order_type_condition", "tax_exclusive", "seed_rules"],
    working: "Laksa 1600 × 3 = 4800; Kopi 380 × 2 = 760. Subtotal 5560. SC 10%: 480 + 76 = 556. GST: 432 + 68.4→68 + 43.2→43 + 6.84→7 = 550. Total 5560+556+550 = 6666.",
    order: order([line("laksa", 1600, { quantity: 3 }), line("kopi", 380, { quantity: 2 })]),
    rules: SG_SEED_RULES,
    context: ctx(),
    expect: {
      subtotal: 5560,
      adjustments: { [SEED_RULE_IDS.serviceCharge]: 556 },
      adjustment_lines: { [SEED_RULE_IDS.serviceCharge]: { laksa: 480, kopi: 76 } },
      line_tax: { laksa: 432, kopi: 68 },
      tax_total: 432 + 68 + 43 + 7,
      total: 5560 + 556 + 432 + 68 + 43 + 7,
    },
  },
  {
    id: "R005",
    title: "Takeaway: no service charge; GST only",
    covers: ["order_type_condition", "tax_exclusive", "seed_rules"],
    working: "Subtotal 5560; no SC on takeaway. GST 432 + 68 = 500. Total 6060.",
    order: order([line("laksa", 1600, { quantity: 3 }), line("kopi", 380, { quantity: 2 })], { order_type: "takeaway" }),
    rules: SG_SEED_RULES,
    context: ctx(),
    expect: { not_applied: [SEED_RULE_IDS.serviceCharge], tax_total: 500, total: 5560 + 500 },
  },
  {
    id: "R006",
    title: "Delivery price per order type is used; pickup falls back to the base price",
    covers: ["order_type_price", "tax_exclusive"],
    working: "Delivery price 1800 replaces base 1600. GST 9% of 1800 = 162. Total 1962.",
    order: order([line("laksa", 1600, { prices: { base: 1600, by_order_type: { delivery: 1800 } } })], { order_type: "delivery" }),
    rules: SG_SEED_RULES,
    context: ctx(),
    expect: { subtotal: 1800, tax_total: 162, total: 1962, not_applied: [SEED_RULE_IDS.serviceCharge] },
  },
  {
    id: "R007",
    title: "Modifiers add per unit, then multiply by quantity",
    covers: ["modifiers", "quantity", "tax_exclusive"],
    working: "(1600 + 200 extra prawn + 0 less spicy) × 2 = 3600. Takeaway: no SC. GST 324. Total 3924.",
    order: order(
      [
        line("laksa", 1600, {
          quantity: 2,
          modifiers: [
            { modifier_id: "m1", product_id: "extra-prawn", quantity: 1, price: 200 },
            { modifier_id: "m2", product_id: "less-spicy", quantity: 1, price: 0 },
          ],
        }),
      ],
      { order_type: "takeaway" },
    ),
    rules: SG_SEED_RULES,
    context: ctx(),
    expect: { subtotal: 3600, tax_total: 324, total: 3924 },
  },
  {
    id: "R008",
    title: "Open-price item replaces the product price",
    covers: ["open_price", "tax_exclusive"],
    working: "Open price 2550 (base 1000 ignored). Dine-in SC 255. GST 229.5→230 on the line, 22.95→23 on SC. Total 2550+255+230+23 = 3058.",
    order: order([line("misc", 1000, { open_price: 2550 })]),
    rules: SG_SEED_RULES,
    context: ctx(),
    expect: { subtotal: 2550, fee_total: 255, tax_total: 230 + 23, total: 2550 + 255 + 230 + 23 },
  },
  {
    id: "R009",
    title: "Inclusive GST: amounts already include GST; the service charge is also GST-inclusive",
    covers: ["tax_inclusive", "fee_percent", "fee_taxed"],
    working: "Line 1090 includes GST 90 (1090 × 9/109). SC 10% of 1090 = 109, which includes GST 9. Total payable 1090 + 109 = 1199; GST reported 99.",
    order: order([line("a", 1090)]),
    rules: SG_SEED_RULES,
    context: ctx("inclusive"),
    expect: { fee_total: 109, tax_total: 90 + 9, line_totals: { a: 1199 }, total: 1199 },
  },
  {
    id: "R010",
    title: "Container deposit: $0.10 per unit on BCRS products, no GST on the deposit",
    covers: ["fee_fixed_per_unit", "scope_deposit", "fee_untaxed", "tax_exclusive", "seed_rules"],
    working: "6 cans × 250 = 1500; deposit 6 × 10 = 60 with no GST. Plate 1000. Takeaway: no SC. GST on nets: 135 + 90 = 225. Total 1500 + 1000 + 60 + 225 = 2785.",
    order: order([line("can", 250, { has_deposit: true, quantity: 6 }), line("plate", 1000)], { order_type: "takeaway" }),
    rules: [DEPOSIT, SC],
    context: ctx(),
    expect: {
      adjustments: { [SEED_RULE_IDS.containerDeposit]: 60 },
      line_fees: { can: 60, plate: 0 },
      tax_total: taxEx(1500) + taxEx(1000),
      total: 1500 + 1000 + 60 + 135 + 90,
    },
  },
  {
    id: "R011",
    title: "Inclusive mode sanity: GST inside 2000 is 165 (2000 × 9/109 = 165.14)",
    covers: ["tax_inclusive", "rounding"],
    working: "2000 × 900 / 10900 = 165.137… → 165. Takeaway: no fee. Total 2000.",
    order: order([line("a", 2000)], { order_type: "takeaway" }),
    rules: SG_SEED_RULES,
    context: ctx("inclusive"),
    expect: { tax_total: taxIn(2000), total: 2000 },
  },
];
