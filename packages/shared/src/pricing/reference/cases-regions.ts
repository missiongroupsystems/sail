import type { PricingRuleInput, TaxRateInput } from "../schemas.js";
import { line, NOW, order, type RefCase } from "./dsl.js";

/**
 * Reference cases R154–R162: tax regimes other than Singapore's, minor units
 * other than two decimals, and cash rounding. Every case rounds tax once per
 * rate (`per_rate`): each component is rounded half up on the group's total,
 * then spread back across the group's amounts by largest remainder (floors
 * first, leftover units to the largest fractional remainders, ties to the
 * earlier line).
 */

const US_RATES: TaxRateInput[] = [
  { tax_class_id: "food", components: [{ name: "State sales tax", bps: 400 }, { name: "Local sales tax", bps: 450 }] },
  { tax_class_id: "grocery", components: [] },
];

const EU_RATES: TaxRateInput[] = [
  { tax_class_id: "standard", components: [{ name: "VAT 20%", bps: 2000 }] },
  { tax_class_id: "reduced", components: [{ name: "VAT 10%", bps: 1000 }] },
];

const JP_RATES: TaxRateInput[] = [
  { tax_class_id: "food", components: [{ name: "Consumption tax 10%", bps: 1000 }] },
  { tax_class_id: "food", order_type: "takeaway", components: [{ name: "Consumption tax 8%", bps: 800 }] },
  { tax_class_id: "alcohol", components: [{ name: "Consumption tax 10%", bps: 1000 }] },
];

const percentOffBill: PricingRuleInput = {
  id: "ten-off-bill",
  kind: "discount",
  name: "10% off the bill",
  calc: "percent",
  level: "order",
  value: { type: "fixed", amount: 1000 },
  scope: { type: "all" },
  priority: 50,
  application: "auto",
  report_class: "promo",
};

export const REGION_CASES: RefCase[] = [
  {
    id: "R154",
    title: "US exclusive sales tax with a state and a local component, each rounded once on the order and spread back by largest remainder",
    covers: ["tax_exclusive", "tax_components", "tax_per_rate", "quantity"],
    working:
      "Taxable 1299 + 2 × 349 + 249 = 2246. State 4%: 2246 × 0.04 = 89.84 → 90. Local 4.5%: 2246 × 0.045 = 101.07 → 101. Tax 191; total 2246 + 191 = 2437. " +
      "State 90 by 1299/698/249: 52.05, 27.97, 9.98 → floors 52 + 27 + 9 = 88, the two leftover cents to soda (.98) then fries (.97) → 52/28/10. " +
      "Local 101: 58.42, 31.39, 11.20 → floors 58 + 31 + 11 = 100, the leftover cent to the burger (.42) → 59/31/11. " +
      "Rounding per line instead would give state 52 + 28 + 10 = 90 but local 58 + 31 + 11 = 100: one cent short of the tax on the order.",
    order: order([line("burger", 1299, { tax_class_id: "food" }), line("fries", 349, { tax_class_id: "food", quantity: 2 }), line("soda", 249, { tax_class_id: "food" })]),
    rules: [],
    context: { tax_mode: "exclusive", tax_rounding: "per_rate", tax_rates: US_RATES, now: NOW },
    expect: {
      line_taxes: { burger: { "State sales tax": 52, "Local sales tax": 59 }, fries: { "State sales tax": 28, "Local sales tax": 31 }, soda: { "State sales tax": 10, "Local sales tax": 11 } },
      line_totals: { burger: 1299 + 111, fries: 698 + 59, soda: 249 + 21 },
      taxes: [
        { name: "State sales tax", bps: 400, taxable: 2246, amount: 90 },
        { name: "Local sales tax", bps: 450, taxable: 2246, amount: 101 },
      ],
      tax_total: 191,
      total: 2437,
    },
  },
  {
    id: "R155",
    title: "EU inclusive VAT at 20% and 10% on one bill, 10% off the bill, split in two",
    covers: ["tax_inclusive", "tax_per_rate", "order_percent", "split", "quantity"],
    working:
      "Wine 2 × 900 = 1800 and water 350 at VAT 20%; pasta 1450 at VAT 10%. 10% off the bill: 360 on the pool 3600, spread 180/145/35 (exact). Nets 1620, 1305, 315; total 3240 (inclusive: tax is inside). " +
      "VAT 20% on 1620 + 315 = 1935: 1935 × 20/120 = 322.5 → 323; by 1620/315: 270.42, 52.58 → floors 270 + 52, the leftover cent to water (.58) → 270/53; taxable 1935 − 323 = 1612. " +
      "VAT 10% on 1305: 1305 × 10/110 = 118.64 → 119; taxable 1186. " +
      "Split in two, each line on its own: wine base 900/900, discount −90/−90, VAT 135/135; pasta 725/725, −73/−72 (the odd cent to bill 1), VAT 60/59; water 175/175, −18/−17, VAT 27/26. " +
      "Bill 1 = 810 + 652 + 157 = 1619 with VAT 20% 135 + 27 = 162, VAT 10% 60; bill 2 = 810 + 653 + 158 = 1621 with 161 and 59. 1619 + 1621 = 3240.",
    order: order([line("wine", 900, { quantity: 2 }), line("pasta", 1450, { tax_class_id: "reduced" }), line("water", 350)]),
    rules: [percentOffBill],
    context: { tax_mode: "inclusive", tax_rounding: "per_rate", tax_rates: EU_RATES, now: NOW },
    split: {
      checks: 2,
      expect: [
        { total: 1619, taxes: { "VAT 20%": 162, "VAT 10%": 60 } },
        { total: 1621, taxes: { "VAT 20%": 161, "VAT 10%": 59 } },
      ],
    },
    expect: {
      adjustment_lines: { "ten-off-bill": { wine: -180, pasta: -145, water: -35 } },
      line_nets: { wine: 1620, pasta: 1305, water: 315 },
      line_tax: { wine: 270, pasta: 119, water: 53 },
      taxes: [
        { name: "VAT 20%", bps: 2000, taxable: 1612, amount: 323 },
        { name: "VAT 10%", bps: 1000, taxable: 1186, amount: 119 },
      ],
      tax_total: 442,
      total: 3240,
    },
  },
  {
    id: "R156",
    title: "Japan, takeaway: food at the reduced 8%, alcohol at 10%, inclusive yen (no minor units)",
    covers: ["tax_inclusive", "tax_by_order_type", "tax_per_rate", "zero_decimals", "quantity"],
    working:
      "Amounts are whole yen. Takeaway resolves food to 8%: bento 2 × 780 = 1560 and tea 150, 1710 in all: 1710 × 8/108 = 126.67 → 127; by 1560/150: 115.86, 11.14 → floors 115 + 11, the leftover yen to the bento (.86) → 116/11. " +
      "Beer (alcohol) stays at 10%: 550 × 10/110 = 50 exactly. Tax 177 inside the total 1560 + 150 + 550 = 2260.",
    order: order([line("bento", 780, { tax_class_id: "food", quantity: 2 }), line("tea", 150, { tax_class_id: "food" }), line("beer", 550, { tax_class_id: "alcohol" })], { order_type: "takeaway" }),
    rules: [],
    context: { tax_mode: "inclusive", tax_rounding: "per_rate", tax_rates: JP_RATES, now: NOW },
    expect: {
      line_tax: { bento: 116, tea: 11, beer: 50 },
      taxes: [
        { name: "Consumption tax 8%", bps: 800, taxable: 1710 - 127, amount: 127 },
        { name: "Consumption tax 10%", bps: 1000, taxable: 550 - 50, amount: 50 },
      ],
      tax_total: 177,
      total: 2260,
    },
  },
  {
    id: "R157",
    title: "Japan, the same order dine-in: everything at 10%, one rate group rounded once",
    covers: ["tax_inclusive", "tax_by_order_type", "tax_per_rate", "zero_decimals"],
    working:
      "Dine-in resolves food to 10%, the same components as alcohol, so all three lines form one group: 2260 × 10/110 = 205.45 → 205. " +
      "By 1560/150/550: 141.50, 13.61, 49.89 → floors 141 + 13 + 49 = 203, the two leftover yen to beer (.89) then tea (.61) → 141/14/50. Taxable 2260 − 205 = 2055.",
    order: order([line("bento", 780, { tax_class_id: "food", quantity: 2 }), line("tea", 150, { tax_class_id: "food" }), line("beer", 550, { tax_class_id: "alcohol" })], { order_type: "dine_in" }),
    rules: [],
    context: { tax_mode: "inclusive", tax_rounding: "per_rate", tax_rates: JP_RATES, now: NOW },
    expect: {
      line_tax: { bento: 141, tea: 14, beer: 50 },
      taxes: [{ name: "Consumption tax 10%", bps: 1000, taxable: 2055, amount: 205 }],
      tax_total: 205,
      total: 2260,
    },
  },
  {
    id: "R158",
    title: "Kuwaiti dinar (three decimals, amounts in fils): 10% service charge, no tax",
    covers: ["three_decimals", "fee_percent", "fee_untaxed", "tax_exempt", "quantity", "rounding"],
    working:
      "Kuwait levies no VAT: the one class has no components. Machboos 3 × 2.375 KWD = 7125 fils, juice 0.850 = 850 fils. " +
      "Service charge 10%: 712.5 → 713 and 85, fee total 798. Total 7125 + 850 + 798 = 8773 fils = 8.773 KWD. The tax breakdown is empty.",
    order: order([line("machboos", 2375, { tax_class_id: "none", quantity: 3 }), line("juice", 850, { tax_class_id: "none" })]),
    rules: [
      { id: "service", kind: "fee", name: "Service charge 10%", calc: "percent", value: { type: "fixed", amount: 1000 }, scope: { type: "all" }, priority: 100, application: "auto", tax_class_id: "none", report_class: "service_charge" },
    ],
    context: { tax_mode: "exclusive", tax_rounding: "per_rate", tax_rates: [{ tax_class_id: "none", components: [] }], now: NOW },
    expect: {
      line_fees: { machboos: 713, juice: 85 },
      fee_total: 798,
      taxes: [],
      tax_total: 0,
      total: 8773,
    },
  },
  {
    id: "R159",
    title: "A tax-exempt line next to a taxed one: the exempt line carries no tax component and is outside the taxable amount",
    covers: ["tax_exempt", "tax_exclusive", "tax_components", "tax_per_rate"],
    working:
      "Sandwich 899 is prepared food; a bag of coffee beans 1499 is exempt grocery. State 4% on 899 = 35.96 → 36; local 4.5% = 40.46 → 40. " +
      "The beans line has no tax at all. Total 899 + 1499 + 76 = 2474.",
    order: order([line("sandwich", 899, { tax_class_id: "food" }), line("beans", 1499, { tax_class_id: "grocery" })]),
    rules: [],
    context: { tax_mode: "exclusive", tax_rounding: "per_rate", tax_rates: US_RATES, now: NOW },
    expect: {
      line_taxes: { sandwich: { "State sales tax": 36, "Local sales tax": 40 }, beans: {} },
      line_totals: { sandwich: 975, beans: 1499 },
      taxes: [
        { name: "State sales tax", bps: 400, taxable: 899, amount: 36 },
        { name: "Local sales tax", bps: 450, taxable: 899, amount: 40 },
      ],
      tax_total: 76,
      total: 2474,
    },
  },
  {
    id: "R160",
    title: "Swiss francs, cash rounded to 0.05: inclusive VAT 8.1%, 10.43 is paid as 10.45",
    covers: ["tax_inclusive", "tax_per_rate", "cash_rounding", "quantity"],
    working:
      "Café crème 475 and 2 croissants × 284 = 568, both at VAT 8.1%: total 1043 with 1043 × 8.1/108.1 = 78.15 → 78 inside; by 475/568: 35.52, 42.48 → floors 35 + 42, the leftover rappen to the café crème (.52) → 36/42. " +
      "Cash rounds to 5 rappen: 1043 = 208 × 5 + 3, and 3 × 2 ≥ 5, so up to 1045 (+2).",
    order: order([line("cafe", 475, { tax_class_id: "standard" }), line("croissant", 284, { tax_class_id: "standard", quantity: 2 })]),
    rules: [],
    context: { tax_mode: "inclusive", tax_rounding: "per_rate", tax_rates: [{ tax_class_id: "standard", components: [{ name: "MWST 8.1%", bps: 810 }] }], now: NOW },
    cash: { increment: 5, due: 1045, rounding: 2 },
    expect: {
      line_tax: { cafe: 36, croissant: 42 },
      taxes: [{ name: "MWST 8.1%", bps: 810, taxable: 965, amount: 78 }],
      tax_total: 78,
      total: 1043,
    },
  },
  {
    id: "R161",
    title: "Swedish kronor, cash rounded to 1 krona: food at 12% and beer at 25% inclusive, 263.50 is paid as 264",
    covers: ["tax_inclusive", "tax_per_rate", "cash_rounding"],
    working:
      "Köttbullar 189.00 kr (18900 öre) at moms 12%: 18900 × 12/112 = 2025 exactly. Öl 74.50 kr (7450 öre) at moms 25%: 7450 × 25/125 = 1490 exactly. " +
      "Total 26350 öre. Cash rounds to 100 öre: 26350 = 263 × 100 + 50, and 50 × 2 ≥ 100, so up to 26400 (+50).",
    order: order([line("kottbullar", 18_900, { tax_class_id: "food" }), line("ol", 7450, { tax_class_id: "alcohol" })]),
    rules: [],
    context: {
      tax_mode: "inclusive",
      tax_rounding: "per_rate",
      tax_rates: [
        { tax_class_id: "food", components: [{ name: "Moms 12%", bps: 1200 }] },
        { tax_class_id: "alcohol", components: [{ name: "Moms 25%", bps: 2500 }] },
      ],
      now: NOW,
    },
    cash: { increment: 100, due: 26_400, rounding: 50 },
    expect: {
      taxes: [
        { name: "Moms 12%", bps: 1200, taxable: 16_875, amount: 2025 },
        { name: "Moms 25%", bps: 2500, taxable: 5960, amount: 1490 },
      ],
      tax_total: 3515,
      total: 26_350,
    },
  },
  {
    id: "R162",
    title: "A two-part rate is rounded once at its combined rate, then split between its components",
    covers: ["tax_exclusive", "tax_components", "tax_per_rate"],
    working:
      "One item at 1013 on State 4% + Local 4.5%. The combined 8.5%: 1013 × 0.085 = 86.105 → 86. Split by 400/450: 40.47 and 45.53 → floors 40 + 45 = 85, the leftover cent to local (.53) → 40/46. " +
      "Rounding each component on its own would give 40.52 → 41 plus 45.585 → 46 = 87, a cent more than 8.5% of the amount.",
    order: order([line("plate", 1013, { tax_class_id: "food" })]),
    rules: [],
    context: { tax_mode: "exclusive", tax_rounding: "per_rate", tax_rates: US_RATES, now: NOW },
    expect: {
      line_taxes: { plate: { "State sales tax": 40, "Local sales tax": 46 } },
      taxes: [
        { name: "State sales tax", bps: 400, taxable: 1013, amount: 40 },
        { name: "Local sales tax", bps: 450, taxable: 1013, amount: 46 },
      ],
      tax_total: 86,
      total: 1099,
    },
  },
];
