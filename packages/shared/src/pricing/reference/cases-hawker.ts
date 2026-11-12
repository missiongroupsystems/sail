import { SEED_RULE_IDS } from "../seed.js";
import { SG_SEED_RULES } from "./dsl.js";
import type { PricingRuleInput } from "../schemas.js";
import { ctx, line, order, type RefCase } from "./dsl.js";

/**
 * Reference cases R123–R128: realistic hawker baskets (6–10 lines) priced
 * with the full seed set, in both tax modes, dine-in and takeaway, with one
 * manual preset and one automatic happy-hour rule. Every per-line figure is
 * written out so the receipt can be checked line by line.
 */

const S = SEED_RULE_IDS;

/** Basket A, eight lines: subtotal 4130. */
const BASKET_A = [
  line("chicken-rice", 450, { quantity: 2 }),
  line("ckt", 550),
  line("laksa", 600),
  line("satay", 80, { quantity: 10 }),
  line("kopi", 140, { quantity: 2 }),
  line("teh-peng", 160),
  line("can", 180, { quantity: 3, has_deposit: true }),
  line("ice-kacang", 300),
];

/** Basket B, ten lines with a modifier: subtotal 5120. */
const BASKET_B = [
  line("nasi-lemak", 480, { quantity: 2, modifiers: [{ modifier_id: "m1", product_id: "extra-egg", quantity: 1, price: 80 }] }),
  line("mee", 520),
  line("prata", 120, { quantity: 4 }),
  line("curry", 650),
  line("milo", 350),
  line("kopi-o", 120, { quantity: 3 }),
  line("water", 150, { quantity: 2, has_deposit: true }),
  line("coke", 180, { has_deposit: true }),
  line("chendol", 280, { quantity: 2 }),
  line("popiah", 200, { quantity: 3 }),
];

/** Automatic happy hour: 20% off the drinks category (matched on the parent), dine-in, 08:00–13:00 UTC on the case date. */
const HAPPY_HOUR: PricingRuleInput = {
  id: "happy-hour",
  kind: "discount",
  name: "Happy hour 20% off drinks",
  calc: "percent",
  value: { type: "fixed", amount: 2000 },
  scope: { type: "categories", category_ids: ["drinks"] },
  conditions: { order_types: ["dine_in"], active_from: "2026-11-04T08:00:00.000Z", active_to: "2026-11-04T13:00:00.000Z" },
  priority: 10,
  application: "auto",
  report_class: "promo",
};

export const HAWKER_CASES: RefCase[] = [
  {
    id: "R123",
    title: "Hawker basket A (8 lines), dine-in, exclusive GST: service charge and deposit per line",
    covers: ["seed_rules", "quantity", "fee_percent", "fee_fixed_per_unit", "fee_untaxed", "scope_deposit", "base_price", "tax_exclusive", "rounding"],
    working:
      "Lines: 450 × 2 = 900; 550; 600; 80 × 10 = 800; 140 × 2 = 280; 160; 180 × 3 = 540 (BCRS); 300. Subtotal 4130. " +
      "Service charge 10% per line: 90 + 55 + 60 + 80 + 28 + 16 + 54 + 30 = 413. Deposit 3 × 10 = 30, no GST. " +
      "GST on nets: 81; 49.5 → 50; 54; 72; 25.2 → 25; 14.4 → 14; 48.6 → 49; 27 = 372. GST on SC: 8.1 → 8; 4.95 → 5; 5.4 → 5; 7.2 → 7; 2.52 → 3; 1.44 → 1; 4.86 → 5; 2.7 → 3 = 37. " +
      "Total = 4130 + 413 + 30 + 372 + 37 = 4982.",
    order: order(BASKET_A),
    rules: SG_SEED_RULES,
    context: ctx(),
    expect: {
      subtotal: 4130,
      adjustments: { [S.serviceCharge]: 413, [S.containerDeposit]: 30 },
      adjustment_lines: { [S.serviceCharge]: { "chicken-rice": 90, ckt: 55, laksa: 60, satay: 80, kopi: 28, "teh-peng": 16, can: 54, "ice-kacang": 30 }, [S.containerDeposit]: { can: 30 } },
      line_tax: { "chicken-rice": 81, ckt: 50, laksa: 54, satay: 72, kopi: 25, "teh-peng": 14, can: 49, "ice-kacang": 27 },
      fee_total: 413 + 30,
      tax_total: 372 + 37,
      total: 4130 + 413 + 30 + 372 + 37,
    },
  },
  {
    id: "R124",
    title: "Hawker basket A, takeaway, exclusive GST: no service charge, deposit stays",
    covers: ["seed_rules", "order_type_condition", "fee_fixed_per_unit", "fee_untaxed", "tax_exclusive"],
    working: "Subtotal 4130. No service charge on takeaway. Deposit 30. GST on nets 372 (as R123). Total = 4130 + 30 + 372 = 4532.",
    order: order(BASKET_A, { order_type: "takeaway" }),
    rules: SG_SEED_RULES,
    context: ctx(),
    expect: {
      subtotal: 4130,
      adjustments: { [S.containerDeposit]: 30 },
      not_applied: [S.serviceCharge],
      fee_total: 30,
      tax_total: 372,
      total: 4130 + 30 + 372,
    },
  },
  {
    id: "R125",
    title: "Hawker basket A, dine-in, inclusive GST: same payable fees, GST reported from inside each amount",
    covers: ["seed_rules", "tax_inclusive", "fee_percent", "fee_untaxed", "rounding"],
    working:
      "Payable: 4130 + SC 413 + deposit 30 = 4573. GST inside nets (× 9/109): 900 → 74.31 → 74; 550 → 45.41 → 45; 600 → 49.54 → 50; 800 → 66.06 → 66; 280 → 23.12 → 23; " +
      "160 → 13.21 → 13; 540 → 44.59 → 45; 300 → 24.77 → 25 = 341. Inside the SC: 90 → 7.43 → 7; 55 → 4.54 → 5; 60 → 4.95 → 5; 80 → 6.61 → 7; 28 → 2.31 → 2; 16 → 1.32 → 1; " +
      "54 → 4.46 → 4; 30 → 2.48 → 2 = 33. Deposit has no GST. GST reported 374.",
    order: order(BASKET_A),
    rules: SG_SEED_RULES,
    context: ctx("inclusive"),
    expect: {
      adjustments: { [S.serviceCharge]: 413, [S.containerDeposit]: 30 },
      line_tax: { "chicken-rice": 74, ckt: 45, laksa: 50, satay: 66, kopi: 23, "teh-peng": 13, can: 45, "ice-kacang": 25 },
      fee_total: 443,
      tax_total: 341 + 33,
      total: 4130 + 413 + 30,
    },
  },
  {
    id: "R126",
    title: "Hawker basket B (10 lines, modifier), dine-in, exclusive GST, Staff meal on one line",
    covers: ["seed_rules", "modifiers", "quantity", "manual_fixed", "manual_lines", "line_percent", "fee_percent", "fee_fixed_per_unit", "scope_deposit", "tax_exclusive", "rounding"],
    working:
      "Lines: (480 + 80) × 2 = 1120; 520; 120 × 4 = 480; 650; 350; 120 × 3 = 360; 150 × 2 = 300 (BCRS); 180 (BCRS); 280 × 2 = 560; 200 × 3 = 600. Subtotal 5120. " +
      "Staff meal 50% on mee: 260 → 260. Net subtotal 4860. Service charge 10% per net: 112 + 26 + 48 + 65 + 35 + 36 + 30 + 18 + 56 + 60 = 486. Deposit (2 + 1) × 10 = 30. " +
      "GST on nets: 100.8 → 101; 23.4 → 23; 43.2 → 43; 58.5 → 59; 31.5 → 32; 32.4 → 32; 27; 16.2 → 16; 50.4 → 50; 54 = 437. " +
      "GST on SC: 10.08 → 10; 2.34 → 2; 4.32 → 4; 5.85 → 6; 3.15 → 3; 3.24 → 3; 2.7 → 3; 1.62 → 2; 5.04 → 5; 5.4 → 5 = 43. Total = 4860 + 486 + 30 + 437 + 43 = 5856.",
    order: order(BASKET_B, { manual_applications: [{ application_id: "sm-1", rule_id: S.staffMeal, line_ids: ["mee"], applied_by: "user-1", reason: "staff lunch" }] }),
    rules: SG_SEED_RULES,
    context: ctx(),
    expect: {
      subtotal: 5120,
      adjustments: { [`${S.staffMeal}#sm-1`]: -260, [S.serviceCharge]: 486, [S.containerDeposit]: 30 },
      adjustment_lines: { [S.serviceCharge]: { "nasi-lemak": 112, mee: 26, prata: 48, curry: 65, milo: 35, "kopi-o": 36, water: 30, coke: 18, chendol: 56, popiah: 60 }, [S.containerDeposit]: { water: 20, coke: 10 } },
      line_nets: { "nasi-lemak": 1120, mee: 260 },
      line_tax: { "nasi-lemak": 101, mee: 23, prata: 43, curry: 59, milo: 32, "kopi-o": 32, water: 27, coke: 16, chendol: 50, popiah: 54 },
      fee_total: 486 + 30,
      tax_total: 437 + 43,
      total: 4860 + 486 + 30 + 437 + 43,
    },
  },
  {
    id: "R127",
    title: "Hawker basket B, takeaway, inclusive GST, 10% off the bill: every line is exactly 10% so the spread is exact",
    covers: ["seed_rules", "tax_inclusive", "manual_open", "order_percent", "fee_fixed_per_unit", "fee_untaxed", "rounding"],
    working:
      "Pool 5120 × 10% = 512, spread in proportion to the bases; every line's share is exactly 10%: 112, 52, 48, 65, 35, 36, 30, 18, 56, 60. " +
      "Nets 1008, 468, 432, 585, 315, 324, 270, 162, 504, 540 = 4608. No service charge (takeaway); deposit 30. Payable 4638. " +
      "GST inside nets (× 9/109): 1008 → 83.23 → 83; 468 → 38.64 → 39; 432 → 35.67 → 36; 585 → 48.30 → 48; 315 → 26.01 → 26; 324 → 26.75 → 27; 270 → 22.29 → 22; " +
      "162 → 13.38 → 13; 504 → 41.61 → 42; 540 → 44.59 → 45 = 381. Deposit carries no GST.",
    order: order(BASKET_B, { order_type: "takeaway", manual_applications: [{ application_id: "pb-1", rule_id: S.percentOffBill, entered_value: 1000, applied_by: "mgr-1" }] }),
    rules: SG_SEED_RULES,
    context: ctx("inclusive"),
    expect: {
      adjustments: { [`${S.percentOffBill}#pb-1`]: -512, [S.containerDeposit]: 30 },
      adjustment_lines: { [`${S.percentOffBill}#pb-1`]: { "nasi-lemak": -112, mee: -52, prata: -48, curry: -65, milo: -35, "kopi-o": -36, water: -30, coke: -18, chendol: -56, popiah: -60 } },
      not_applied: [S.serviceCharge],
      line_tax: { "nasi-lemak": 83, mee: 39, prata: 36, curry: 48, milo: 26, "kopi-o": 27, water: 22, coke: 13, chendol: 42, popiah: 45 },
      fee_total: 30,
      tax_total: 381,
      total: 4608 + 30,
    },
  },
  {
    id: "R128",
    title: "Six-line dine-in basket with an automatic happy hour on the drinks parent category, seeds on top",
    covers: ["seed_rules", "scope_categories", "date_range", "order_type_condition", "line_percent", "fee_percent", "fee_fixed_per_unit", "scope_deposit", "quantity", "tax_exclusive", "rounding"],
    working:
      "Lines: beer 900 × 2 = 1800 (beer under drinks, BCRS); satay 80 × 10 = 800; wings 650; lime juice 300 × 2 = 600 (juice under drinks); fries 450; ice cream 350. Subtotal 4650. " +
      "Happy hour 20% on the drinks parent (12:00 is inside 08:00–13:00): beer 360 → 1440; lime 120 → 480. Net subtotal 4170. " +
      "Service charge: 144 + 80 + 65 + 48 + 45 + 35 = 417. Deposit 2 × 10 = 20. GST on nets: 129.6 → 130; 72; 58.5 → 59; 43.2 → 43; 40.5 → 41; 31.5 → 32 = 377. " +
      "GST on SC: 12.96 → 13; 7.2 → 7; 5.85 → 6; 4.32 → 4; 4.05 → 4; 3.15 → 3 = 37. Total = 4170 + 417 + 20 + 377 + 37 = 5021.",
    order: order([
      line("beer", 900, { quantity: 2, category_id: "beer", parent_category_id: "drinks", has_deposit: true }),
      line("satay", 80, { quantity: 10, category_id: "food" }),
      line("wings", 650, { category_id: "food" }),
      line("lime", 300, { quantity: 2, category_id: "juice", parent_category_id: "drinks" }),
      line("fries", 450, { category_id: "food" }),
      line("ice-cream", 350, { category_id: "dessert" }),
    ]),
    rules: [...SG_SEED_RULES, HAPPY_HOUR],
    context: ctx(),
    expect: {
      subtotal: 4650,
      adjustments: { "happy-hour": -(360 + 120), [S.serviceCharge]: 417, [S.containerDeposit]: 20 },
      adjustment_lines: { "happy-hour": { beer: -360, lime: -120 }, [S.serviceCharge]: { beer: 144, satay: 80, wings: 65, lime: 48, fries: 45, "ice-cream": 35 } },
      line_nets: { beer: 1440, lime: 480, satay: 800 },
      line_tax: { beer: 130, satay: 72, wings: 59, lime: 43, fries: 41, "ice-cream": 32 },
      fee_total: 417 + 20,
      tax_total: 377 + 37,
      total: 4170 + 417 + 20 + 377 + 37,
    },
  },
];
