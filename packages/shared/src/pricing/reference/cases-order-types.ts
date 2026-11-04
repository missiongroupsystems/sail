import { SEED_RULES, SEED_RULE_IDS } from "../seed.js";
import type { PricingRuleInput } from "../schemas.js";
import { ctx, line, order, type RefCase } from "./dsl.js";

/**
 * Reference cases R102–R112: order types.
 * One product priced per order type (base 1600, takeaway 1500, delivery 1800,
 * no pickup price) taken through dine-in, takeaway, pickup and delivery with
 * the seeded service charge (dine-in only), a delivery fee (delivery only) and
 * a per-unit packaging fee (takeaway, pickup and delivery). Then the container
 * deposit next to discounts, and open-price items with fees.
 */

const SC = SEED_RULES.find((r) => r.id === SEED_RULE_IDS.serviceCharge)!;
const DEPOSIT = SEED_RULES.find((r) => r.id === SEED_RULE_IDS.containerDeposit)!;

/** $5 delivery fee per order, delivery orders only, GST applicable (defined here, like cases-fees.ts; it is not a seed rule). */
const DELIVERY_FEE: PricingRuleInput = {
  id: "delivery-fee",
  kind: "fee",
  name: "Delivery fee",
  calc: "fixed_per_order",
  value: { type: "fixed", amount: 500 },
  scope: { type: "all" },
  conditions: { order_types: ["delivery"] },
  priority: 120,
  application: "auto",
  gst_applicable: true,
  report_class: "delivery_fee",
};

/** $0.20 packaging per unit on every line for orders that leave the premises. */
const PACKAGING: PricingRuleInput = {
  id: "packaging",
  kind: "fee",
  name: "Packaging",
  calc: "fixed_per_unit",
  value: { type: "fixed", amount: 20 },
  scope: { type: "all" },
  conditions: { order_types: ["takeaway", "pickup", "delivery"] },
  priority: 115,
  application: "auto",
  gst_applicable: true,
  report_class: "packaging_fee",
};

const OFF_PREMISES_RULES = [SC, DELIVERY_FEE, PACKAGING];

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

const PRICES = { base: 1600, by_order_type: { takeaway: 1500, delivery: 1800 } };

export const ORDER_TYPE_CASES: RefCase[] = [
  {
    id: "R102",
    title: "Dine-in: base price, service charge, neither the delivery fee nor packaging",
    covers: ["order_type_price", "order_type_condition", "fee_percent", "seed_rules", "tax_exclusive"],
    working: "Dine-in has no price of its own, so base 1600. Service charge 10% = 160; delivery fee and packaging need other order types. GST 144 on the net, 14.4 → 14 on the SC. Total = 1600 + 160 + 144 + 14 = 1918.",
    order: order([line("laksa", 1600, { prices: PRICES })]),
    rules: OFF_PREMISES_RULES,
    context: ctx(),
    expect: { subtotal: 1600, adjustments: { [SEED_RULE_IDS.serviceCharge]: 160 }, not_applied: ["delivery-fee", "packaging"], gst_total: 144 + 14, total: 1600 + 160 + 144 + 14 },
  },
  {
    id: "R103",
    title: "Takeaway: takeaway price 1500, packaging per unit, no service charge, no delivery fee",
    covers: ["order_type_price", "order_type_condition", "fee_fixed_per_unit", "tax_exclusive"],
    working: "Takeaway price 1500 replaces base 1600. Packaging 20 × 1 = 20. GST 135 on the net, 1.8 → 2 on packaging. Total = 1500 + 20 + 135 + 2 = 1657.",
    order: order([line("laksa", 1600, { prices: PRICES })], { order_type: "takeaway" }),
    rules: OFF_PREMISES_RULES,
    context: ctx(),
    expect: { subtotal: 1500, adjustments: { packaging: 20 }, not_applied: [SEED_RULE_IDS.serviceCharge, "delivery-fee"], gst_total: 135 + 2, total: 1500 + 20 + 135 + 2 },
  },
  {
    id: "R104",
    title: "Pickup: no pickup price, so the base price is used; packaging applies, no service charge, no delivery fee",
    covers: ["order_type_price", "order_type_condition", "fee_fixed_per_unit", "tax_exclusive"],
    working: "No pickup price → base 1600. Packaging 20. GST 144 + 2 (1.8 → 2). Total = 1600 + 20 + 144 + 2 = 1766.",
    order: order([line("laksa", 1600, { prices: PRICES })], { order_type: "pickup" }),
    rules: OFF_PREMISES_RULES,
    context: ctx(),
    expect: { subtotal: 1600, adjustments: { packaging: 20 }, not_applied: [SEED_RULE_IDS.serviceCharge, "delivery-fee"], gst_total: 144 + 2, total: 1600 + 20 + 144 + 2 },
  },
  {
    id: "R105",
    title: "Delivery: delivery price 1800 × 2, the $5 delivery fee lands on the only line, packaging per unit, no service charge",
    covers: ["order_type_price", "order_type_condition", "fee_fixed_per_order", "fee_fixed_per_unit", "quantity", "tax_exclusive"],
    working:
      "Delivery price 1800 × 2 = 3600. Delivery fee 500 (fixed per order, one line takes it all). Packaging 20 × 2 = 40. " +
      "GST: 324 on the net, 45 on the delivery fee, 3.6 → 4 on packaging. Total = 3600 + 500 + 40 + 324 + 45 + 4 = 4513.",
    order: order([line("laksa", 1600, { quantity: 2, prices: PRICES })], { order_type: "delivery" }),
    rules: OFF_PREMISES_RULES,
    context: ctx(),
    expect: {
      subtotal: 3600,
      adjustments: { "delivery-fee": 500, packaging: 40 },
      not_applied: [SEED_RULE_IDS.serviceCharge],
      fee_total: 540,
      gst_total: 324 + 45 + 4,
      total: 3600 + 540 + 324 + 45 + 4,
    },
  },
  {
    id: "R106",
    title: "Delivery-only 10% promotion on a delivery order: order-type price and order-type condition together, delivery fee spread by the discounted nets",
    covers: ["order_type_price", "order_type_condition", "line_percent", "fee_fixed_per_order", "fee_fixed_per_unit", "fee_no_compounding", "quantity", "tax_exclusive"],
    working:
      "Laksa delivery price 1800; drink 300 × 2 = 600 (no delivery price). Delivery-only 10%: 180 → 1620; 60 → 540. Delivery fee 500 by nets 1620/540 (sum 2160): 375/125 exactly. " +
      "Packaging 20 × 1 + 20 × 2 = 60. GST on nets 145.8 → 146, 48.6 → 49; on the delivery fee 33.75 → 34, 11.25 → 11; on packaging 1.8 → 2, 3.6 → 4. " +
      "Total = 1620 + 540 + 500 + 60 + 146 + 49 + 34 + 11 + 2 + 4 = 2966.",
    order: order([line("laksa", 1600, { prices: PRICES }), line("drink", 300, { quantity: 2 })], { order_type: "delivery" }),
    rules: [...OFF_PREMISES_RULES, disc("delivery-10", { conditions: { order_types: ["delivery"] } })],
    context: ctx(),
    expect: {
      subtotal: 1800 + 600,
      adjustments: { "delivery-10": -(180 + 60), "delivery-fee": 500, packaging: 60 },
      adjustment_lines: { "delivery-fee": { laksa: 375, drink: 125 }, packaging: { laksa: 20, drink: 40 } },
      line_nets: { laksa: 1620, drink: 540 },
      line_fees: { laksa: 375 + 20, drink: 125 + 40 },
      fee_total: 560,
      gst_total: 146 + 49 + 34 + 11 + 2 + 4,
      total: 2160 + 560 + 246,
    },
  },
  {
    id: "R107",
    title: "The same rules on a dine-in order: base price, no delivery promotion, no delivery fee, no packaging; service charge only",
    covers: ["order_type_price", "order_type_condition", "fee_percent", "seed_rules", "tax_exclusive"],
    working: "Base 1600 and 600. Service charge 160 + 60 = 220. GST on nets 144 + 54; on SC 14.4 → 14, 5.4 → 5. Total = 2200 + 220 + 198 + 19 = 2637.",
    order: order([line("laksa", 1600, { prices: PRICES }), line("drink", 300, { quantity: 2 })]),
    rules: [...OFF_PREMISES_RULES, disc("delivery-10", { conditions: { order_types: ["delivery"] } })],
    context: ctx(),
    expect: {
      subtotal: 2200,
      adjustments: { [SEED_RULE_IDS.serviceCharge]: 220 },
      not_applied: ["delivery-10", "delivery-fee", "packaging"],
      gst_total: 144 + 54 + 14 + 5,
      total: 2200 + 220 + 144 + 54 + 14 + 5,
    },
  },
  {
    id: "R108",
    title: "Takeaway-only 5% off the takeaway price with per-unit packaging",
    covers: ["order_type_price", "order_type_condition", "line_percent", "fee_fixed_per_unit", "quantity", "tax_exclusive"],
    working: "Takeaway price 1500 × 2 = 3000; 5% = 150 → 2850. Packaging 20 × 2 = 40. GST 256.5 → 257 on the net, 3.6 → 4 on packaging. Total = 2850 + 40 + 257 + 4 = 3151.",
    order: order([line("laksa", 1600, { quantity: 2, prices: PRICES })], { order_type: "takeaway" }),
    rules: [...OFF_PREMISES_RULES, disc("takeaway-5", { value: { type: "fixed", amount: 500 }, conditions: { order_types: ["takeaway"] } })],
    context: ctx(),
    expect: {
      subtotal: 3000,
      adjustments: { "takeaway-5": -150, packaging: 40 },
      not_applied: [SEED_RULE_IDS.serviceCharge, "delivery-fee"],
      line_nets: { laksa: 2850 },
      gst_total: 257 + 4,
      total: 2850 + 40 + 257 + 4,
    },
  },
  {
    id: "R109",
    title: "Container deposit next to a 20% discount: the deposit is per unit and never discounted",
    covers: ["scope_bcrs", "fee_fixed_per_unit", "fee_not_gst_applicable", "line_percent", "quantity", "seed_rules", "tax_exclusive"],
    working:
      "4 cans × 250 = 1000; 20% = 200 → 800. Plate 1200; 20% = 240 → 960. Deposit 4 × 10 = 40 regardless of the discount, no GST. Takeaway, no service charge. " +
      "GST on nets 72 + 86.4 → 86. Total = 800 + 960 + 40 + 72 + 86 = 1958.",
    order: order([line("can", 250, { quantity: 4, is_bcrs: true }), line("plate", 1200)], { order_type: "takeaway" }),
    rules: [disc("twenty-off", { value: { type: "fixed", amount: 2000 } }), DEPOSIT],
    context: ctx(),
    expect: {
      adjustments: { "twenty-off": -(200 + 240), [SEED_RULE_IDS.containerDeposit]: 40 },
      adjustment_lines: { [SEED_RULE_IDS.containerDeposit]: { can: 40 } },
      line_nets: { can: 800, plate: 960 },
      line_fees: { can: 40, plate: 0 },
      gst_total: 72 + 86,
      total: 800 + 960 + 40 + 72 + 86,
    },
  },
  {
    id: "R110",
    title: "Container deposit on a comped line: Manager comp takes the cans to zero, the deposit is still charged",
    covers: ["scope_bcrs", "fee_fixed_per_unit", "fee_not_gst_applicable", "manual_fixed", "manual_lines", "exclusive", "fee_percent", "seed_rules", "tax_exclusive"],
    working:
      "3 cans × 250 = 750, comped 100% → 0 (line blocked). Rice 1200. Service charge on nets: 0 + 120. Deposit 3 × 10 = 30 (fees are never blocked). " +
      "GST on nets 0 + 108; on SC 0 + 10.8 → 11. Total = 0 + 1200 + 120 + 30 + 108 + 11 = 1469.",
    order: order([line("can", 250, { quantity: 3, is_bcrs: true }), line("rice", 1200)], {
      manual_applications: [{ application_id: "mc-1", rule_id: SEED_RULE_IDS.managerComp, line_ids: ["can"], applied_by: "mgr-1", reason: "warm cans" }],
    }),
    rules: SEED_RULES,
    context: ctx(),
    expect: {
      adjustments: { [`${SEED_RULE_IDS.managerComp}#mc-1`]: -750, [SEED_RULE_IDS.serviceCharge]: 120, [SEED_RULE_IDS.containerDeposit]: 30 },
      adjustment_lines: { [SEED_RULE_IDS.serviceCharge]: { can: 0, rice: 120 }, [SEED_RULE_IDS.containerDeposit]: { can: 30 } },
      line_nets: { can: 0, rice: 1200 },
      line_fees: { can: 30, rice: 120 },
      gst_total: 108 + 11,
      total: 1200 + 120 + 30 + 108 + 11,
    },
  },
  {
    id: "R111",
    title: "Open-price item × 2 with a discount, the service charge and a per-unit packaging fee",
    covers: ["open_price", "quantity", "line_percent", "fee_percent", "fee_fixed_per_unit", "fee_no_compounding", "seed_rules", "tax_exclusive"],
    working:
      "Open price 2550 (base 1000 ignored) × 2 = 5100. 10% off = 510 → 4590. Service charge 10% of 4590 = 459. Packaging 50 × 2 = 100. " +
      "GST: 413.1 → 413 on the net, 41.31 → 41 on the SC, 9 on packaging. Total = 4590 + 459 + 100 + 413 + 41 + 9 = 5612.",
    order: order([line("misc", 1000, { quantity: 2, open_price: 2550 })]),
    rules: [
      disc("ten-off"),
      SC,
      { id: "pack-50", kind: "fee", name: "Packaging", calc: "fixed_per_unit", value: { type: "fixed", amount: 50 }, scope: { type: "all" }, priority: 110, application: "auto", report_class: "packaging_fee" },
    ],
    context: ctx(),
    expect: {
      subtotal: 5100,
      adjustments: { "ten-off": -510, [SEED_RULE_IDS.serviceCharge]: 459, "pack-50": 100 },
      line_nets: { misc: 4590 },
      line_fees: { misc: 459 + 100 },
      fee_total: 559,
      gst_total: 413 + 41 + 9,
      total: 4590 + 559 + 413 + 41 + 9,
    },
  },
  {
    id: "R112",
    title: "Open price of zero: the line is free but still carries its per-unit packaging fee; the service charge on it is zero",
    covers: ["open_price", "quantity", "fee_fixed_per_unit", "fee_percent", "scope_tags", "seed_rules", "tax_exclusive"],
    working:
      "Sample: open price 0 replaces base 500 → 0 × 2 = 0. Rice 1200. Service charge: 0 + 120. Packaging on tagged items: 20 × 2 = 40 on the sample only. " +
      "GST: 0 + 108 on nets, 10.8 → 11 on the SC, 3.6 → 4 on packaging. Total = 0 + 1200 + 120 + 40 + 108 + 11 + 4 = 1483.",
    order: order([line("sample", 500, { quantity: 2, open_price: 0, tags: ["packaged"] }), line("rice", 1200)]),
    rules: [SC, { ...PACKAGING, conditions: {}, scope: { type: "tags", tags: ["packaged"] } }],
    context: ctx(),
    expect: {
      subtotal: 1200,
      adjustments: { [SEED_RULE_IDS.serviceCharge]: 120, packaging: 40 },
      adjustment_lines: { [SEED_RULE_IDS.serviceCharge]: { sample: 0, rice: 120 }, packaging: { sample: 40 } },
      line_nets: { sample: 0, rice: 1200 },
      line_fees: { sample: 40, rice: 120 },
      gst_total: 108 + 11 + 4,
      total: 1200 + 120 + 40 + 108 + 11 + 4,
    },
  },
];
