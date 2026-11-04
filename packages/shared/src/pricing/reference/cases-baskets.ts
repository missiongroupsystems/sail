import { SEED_RULES, SEED_RULE_IDS } from "../seed.js";
import { ctx, line, order, type RefCase } from "./dsl.js";

/**
 * Reference cases R088–R091: realistic baskets priced with the full seed set,
 * in both tax modes, plus order-type prices and modifier quantities.
 */

const S = SEED_RULE_IDS;

/** A five-line dine-in basket: subtotal 6740. */
const BASKET = [
  line("laksa", 1600, { quantity: 2, modifiers: [{ modifier_id: "m1", product_id: "extra-prawn", quantity: 1, price: 200 }] }),
  line("rice", 1200),
  line("teh", 320, { quantity: 3 }),
  line("can", 250, { quantity: 2, is_bcrs: true }),
  line("toast", 480),
];

export const BASKET_CASES: RefCase[] = [
  {
    id: "R088",
    title: "Seed rules on a five-line dine-in basket, exclusive GST",
    covers: ["seed_rules", "modifiers", "quantity", "fee_percent", "fee_fixed_per_unit", "fee_not_gst_applicable", "scope_bcrs", "base_price", "tax_exclusive", "rounding"],
    working:
      "Laksa (1600 + 200) × 2 = 3600; rice 1200; teh 320 × 3 = 960; cans 250 × 2 = 500; toast 480. Subtotal 6740. " +
      "Service charge 10% per line: 360 + 120 + 96 + 50 + 48 = 674. Deposit 10 × 2 cans = 20 (no GST). " +
      "GST on nets: 324 + 108 + 86.4 → 86 + 45 + 43.2 → 43 = 606. GST on SC: 32.4 → 32 + 10.8 → 11 + 8.64 → 9 + 4.5 → 5 + 4.32 → 4 = 61. " +
      "Total = 6740 + 674 + 20 + 606 + 61 = 8101.",
    order: order(BASKET),
    rules: SEED_RULES,
    context: ctx(),
    expect: {
      subtotal: 3600 + 1200 + 960 + 500 + 480,
      adjustments: { [S.serviceCharge]: 674, [S.containerDeposit]: 20 },
      adjustment_lines: { [S.serviceCharge]: { laksa: 360, rice: 120, teh: 96, can: 50, toast: 48 }, [S.containerDeposit]: { can: 20 } },
      line_gst: { laksa: 324, rice: 108, teh: 86, can: 45, toast: 43 },
      fee_total: 674 + 20,
      gst_total: 606 + 61,
      total: 6740 + 674 + 20 + 606 + 61,
    },
  },
  {
    id: "R089",
    title: "The same basket with inclusive GST: GST is reported inside the prices and the service charge; nothing is added",
    covers: ["seed_rules", "tax_inclusive", "fee_percent", "fee_not_gst_applicable", "rounding"],
    working:
      "Subtotal 6740, SC 674, deposit 20 as before: total payable 6740 + 674 + 20 = 7434. GST inside the nets (× 9/109): 3600 → 297.25 → 297; 1200 → 99.08 → 99; 960 → 79.27 → 79; " +
      "500 → 41.28 → 41; 480 → 39.63 → 40; sum 556. Inside the SC: 360 → 29.72 → 30; 120 → 9.91 → 10; 96 → 7.93 → 8; 50 → 4.13 → 4; 48 → 3.96 → 4; sum 56. " +
      "Deposit has no GST. GST reported 556 + 56 = 612.",
    order: order(BASKET),
    rules: SEED_RULES,
    context: ctx("inclusive"),
    expect: {
      adjustments: { [S.serviceCharge]: 674, [S.containerDeposit]: 20 },
      line_gst: { laksa: 297, rice: 99, teh: 79, can: 41, toast: 40 },
      fee_total: 694,
      gst_total: 556 + 56,
      total: 6740 + 674 + 20,
    },
  },
  {
    id: "R090",
    title: "Order-type price with modifiers and quantity: delivery price replaces the base, modifiers add per unit",
    covers: ["order_type_price", "modifiers", "quantity", "seed_rules", "tax_exclusive"],
    working: "Delivery price 1800 (base 1600 ignored) + modifiers 200 + 150 = 2150 per unit × 2 = 4300. Delivery: no service charge. GST 387. Total = 4300 + 387 = 4687.",
    order: order(
      [
        line("laksa", 1600, {
          quantity: 2,
          prices: { base: 1600, by_order_type: { delivery: 1800 } },
          modifiers: [
            { modifier_id: "m1", product_id: "extra-prawn", quantity: 1, price: 200 },
            { modifier_id: "m2", product_id: "extra-noodles", quantity: 1, price: 150 },
          ],
        }),
      ],
      { order_type: "delivery" },
    ),
    rules: SEED_RULES,
    context: ctx(),
    expect: { subtotal: (1800 + 200 + 150) * 2, not_applied: [S.serviceCharge], gst_total: 387, total: 4300 + 387 },
  },
  {
    id: "R091",
    title: "Modifier quantity: two extra toppings at 150 each on a line of three",
    covers: ["modifiers", "quantity", "seed_rules", "tax_exclusive"],
    working: "(1000 + 2 × 150) × 3 = 3900. Takeaway: no service charge. GST 351. Total = 3900 + 351 = 4251.",
    order: order([line("bowl", 1000, { quantity: 3, modifiers: [{ modifier_id: "m1", product_id: "topping", quantity: 2, price: 150 }] })], { order_type: "takeaway" }),
    rules: SEED_RULES,
    context: ctx(),
    expect: { subtotal: 3900, gst_total: 351, total: 3900 + 351 },
  },
];
