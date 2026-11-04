import { SEED_RULES, SEED_RULE_IDS } from "../seed.js";
import type { PricingRuleInput } from "../schemas.js";
import { ctx, gstEx, line, order, type RefCase } from "./dsl.js";

/**
 * Reference cases R067–R080: manual rules, using the seeded presets.
 * Fixed-value (Staff meal, Manager comp), open-value (% off item, % off bill,
 * $ off bill), line restrictions, repeated applications, out-of-range values,
 * the service-charge waiver, and a manual rule whose conditions do not hold.
 * Adjustment keys are `rule_id#application_id`.
 */

const S = SEED_RULE_IDS;

/** A manual 20% line-level discount on food, dine-in only (not seeded; used to show conditions and scope on manual rules). */
const LUNCH_SET: PricingRuleInput = {
  id: "lunch-set",
  kind: "discount",
  name: "Lunch set 20% off food",
  calc: "percent",
  level: "line",
  value: { type: "fixed", amount: 2000 },
  scope: { type: "categories", category_ids: ["food"] },
  conditions: { order_types: ["dine_in"] },
  priority: 25,
  application: "manual",
  min_role: "cashier",
  report_class: "promo",
};

export const MANUAL_CASES: RefCase[] = [
  {
    id: "R067",
    title: "Staff meal (fixed 50%) on one line via line_ids",
    covers: ["manual_fixed", "manual_lines", "line_percent", "seed_rules", "tax_exclusive"],
    working: "Staff meal is a fixed 50%: 1600 × 50% = 800 → a 800; b 800 untouched. Takeaway so no service charge. GST 72 + 72. Total = 800 + 800 + 144 = 1744.",
    order: order([line("a", 1600), line("b", 800)], {
      order_type: "takeaway",
      manual_applications: [{ application_id: "sm-1", rule_id: S.staffMeal, line_ids: ["a"], applied_by: "user-1", reason: "staff lunch" }],
    }),
    rules: SEED_RULES,
    context: ctx(),
    expect: { adjustments: { [`${S.staffMeal}#sm-1`]: -800 }, line_nets: { a: 800, b: 800 }, gst_total: 72 + 72, total: 800 + 800 + 72 + 72 },
  },
  {
    id: "R068",
    title: "% off item with an entered value: 20% off one line",
    covers: ["manual_open", "manual_lines", "line_percent", "seed_rules", "tax_exclusive"],
    working: "Entered 2000 bps = 20%: 1250 × 20% = 250 → a 1000; b 500. GST 90 + 45. Total = 1000 + 500 + 135 = 1635.",
    order: order([line("a", 1250), line("b", 500)], { order_type: "takeaway", manual_applications: [{ application_id: "pi-1", rule_id: S.percentOffItem, entered_value: 2000, line_ids: ["a"] }] }),
    rules: SEED_RULES,
    context: ctx(),
    expect: { adjustments: { [`${S.percentOffItem}#pi-1`]: -250 }, line_nets: { a: 1000, b: 500 }, gst_total: 90 + 45, total: 1000 + 500 + 90 + 45 },
  },
  {
    id: "R069",
    title: "$ off bill with an entered value: $10 off spread 667/222/111",
    covers: ["manual_open", "order_fixed", "rounding", "seed_rules", "tax_exclusive"],
    working:
      "Entered 1000 cents. Pool 4500; shares 666.67/222.22/111.11 → 667/222/111 (leftover cent to the largest remainder, a). Nets 2333/778/389. GST 210 + 70 + 35. " +
      "Total = 3500 + 315 = 3815.",
    order: order([line("a", 3000), line("b", 1000), line("c", 500)], { order_type: "takeaway", manual_applications: [{ application_id: "ab-1", rule_id: S.amountOffBill, entered_value: 1000 }] }),
    rules: SEED_RULES,
    context: ctx(),
    expect: {
      adjustments: { [`${S.amountOffBill}#ab-1`]: -1000 },
      adjustment_lines: { [`${S.amountOffBill}#ab-1`]: { a: -667, b: -222, c: -111 } },
      line_nets: { a: 2333, b: 778, c: 389 },
      gst_total: 210 + 70 + 35,
      total: 2333 + 778 + 389 + 210 + 70 + 35,
    },
  },
  {
    id: "R070",
    title: "Two applications of % off item on different lines, each its own adjustment",
    covers: ["manual_open", "manual_lines", "line_percent", "seed_rules", "tax_exclusive"],
    working: "pi-1: 10% of 1000 = 100 → a 900. pi-2: 25% of 2000 = 500 → b 1500. GST 81 + 135 = 216. Total = 900 + 1500 + 216 = 2616.",
    order: order([line("a", 1000), line("b", 2000)], {
      order_type: "takeaway",
      manual_applications: [
        { application_id: "pi-1", rule_id: S.percentOffItem, entered_value: 1000, line_ids: ["a"] },
        { application_id: "pi-2", rule_id: S.percentOffItem, entered_value: 2500, line_ids: ["b"] },
      ],
    }),
    rules: SEED_RULES,
    context: ctx(),
    expect: {
      adjustments: { [`${S.percentOffItem}#pi-1`]: -100, [`${S.percentOffItem}#pi-2`]: -500 },
      line_nets: { a: 900, b: 1500 },
      gst_total: 81 + 135,
      total: 900 + 1500 + 81 + 135,
    },
  },
  {
    id: "R071",
    title: "Open value out of range: 60% off item exceeds the 50% maximum, so it is skipped with one warning",
    covers: ["manual_open", "seed_rules", "tax_exclusive"],
    working: "Entered 6000 bps > max 5000. The rule is skipped and a warning returned; no adjustment. GST 90. Total 1090.",
    order: order([line("a", 1000)], { order_type: "takeaway", manual_applications: [{ application_id: "pi-1", rule_id: S.percentOffItem, entered_value: 6000 }] }),
    rules: SEED_RULES,
    context: ctx(),
    expect: { not_applied: [`${S.percentOffItem}#pi-1`], warnings: 1, gst_total: 90, total: 1000 + 90 },
  },
  {
    id: "R072",
    title: "Open value missing: $ off bill without an entered value is skipped with one warning",
    covers: ["manual_open", "seed_rules", "tax_exclusive"],
    working: "No entered value for an open-value rule → skipped, one warning. GST 90. Total 1090.",
    order: order([line("a", 1000)], { order_type: "takeaway", manual_applications: [{ application_id: "ab-1", rule_id: S.amountOffBill }] }),
    rules: SEED_RULES,
    context: ctx(),
    expect: { not_applied: [`${S.amountOffBill}#ab-1`], warnings: 1, gst_total: 90, total: 1000 + 90 },
  },
  {
    id: "R073",
    title: "Service-charge waiver: a zero adjustment is recorded and the service charge is gone",
    covers: ["waiver", "manual_fixed", "fee_percent", "seed_rules", "tax_exclusive"],
    working:
      "Dine-in would carry a 10% service charge of 300. The waiver disables the service_charge class, so the fee is skipped; the waiver itself is recorded with amount 0 for the audit trail. " +
      "GST 180 + 90 = 270. Total = 2000 + 1000 + 270 = 3270.",
    order: order([line("a", 2000), line("b", 1000)], { manual_applications: [{ application_id: "w-1", rule_id: S.serviceChargeWaiver, applied_by: "mgr-1", reason: "slow service" }] }),
    rules: SEED_RULES,
    context: ctx(),
    expect: {
      adjustments: { [`${S.serviceChargeWaiver}#w-1`]: 0 },
      not_applied: [S.serviceCharge],
      fee_total: 0,
      gst_total: 180 + 90,
      total: 2000 + 1000 + 180 + 90,
    },
  },
  {
    id: "R074",
    title: "Manager comp (exclusive 100%) on one line, then % off bill on the rest; service charge on the nets",
    covers: ["manual_fixed", "manual_open", "manual_lines", "exclusive", "order_percent", "fee_percent", "seed_rules", "tax_exclusive"],
    working:
      "Comp a: 2000 × 100% = 2000 → 0, and a is blocked. % off bill 10% sees the pool b + c = 1500 → 150, spread 100/50 → b 900, c 450. " +
      "Service charge 10% of the nets: 0 + 90 + 45 = 135. GST on nets 0 + 81 + 40.5 → 41; on SC 0 + 8.1 → 8 + 4.05 → 4. Total = 0 + 900 + 450 + 135 + 122 + 12 = 1619.",
    order: order([line("a", 2000), line("b", 1000), line("c", 500)], {
      manual_applications: [
        { application_id: "mc-1", rule_id: S.managerComp, line_ids: ["a"], applied_by: "mgr-1", reason: "dropped plate" },
        { application_id: "pb-1", rule_id: S.percentOffBill, entered_value: 1000, applied_by: "mgr-1" },
      ],
    }),
    rules: SEED_RULES,
    context: ctx(),
    expect: {
      adjustments: { [`${S.managerComp}#mc-1`]: -2000, [`${S.percentOffBill}#pb-1`]: -150, [S.serviceCharge]: 135 },
      adjustment_lines: { [`${S.percentOffBill}#pb-1`]: { b: -100, c: -50 }, [S.serviceCharge]: { a: 0, b: 90, c: 45 } },
      line_nets: { a: 0, b: 900, c: 450 },
      fee_total: 135,
      gst_total: 0 + 81 + 41 + 0 + 8 + 4,
      total: 0 + 900 + 450 + 135 + 81 + 41 + 8 + 4,
    },
  },
  {
    id: "R075",
    title: "A manual rule whose conditions do not hold is skipped: a dine-in-only lunch set applied to a takeaway",
    covers: ["manual_fixed", "order_type_condition", "scope_categories", "tax_exclusive"],
    working: "The application is present but the order is takeaway, not dine-in, so the rule is skipped (no adjustment, no warning: the server rejects it before it gets here). GST 135. Total 1635.",
    order: order([line("a", 1500, { category_id: "food" })], { order_type: "takeaway", manual_applications: [{ application_id: "ls-1", rule_id: "lunch-set" }] }),
    rules: [...SEED_RULES, LUNCH_SET],
    context: ctx(),
    expect: { not_applied: ["lunch-set#ls-1"], warnings: 0, gst_total: 135, total: 1500 + 135 },
  },
  {
    id: "R076",
    title: "% off bill 15% on a dine-in order: spread across lines, service charge on the discounted nets",
    covers: ["manual_open", "order_percent", "fee_percent", "fee_no_compounding", "seed_rules", "tax_exclusive"],
    working:
      "Pool 4000 × 15% = 600, spread 450/150 → nets 2550, 850. SC 10%: 255 + 85 = 340. GST on nets 229.5 → 230, 76.5 → 77; on SC 22.95 → 23, 7.65 → 8. " +
      "Total = 2550 + 850 + 340 + 230 + 77 + 23 + 8 = 4078.",
    order: order([line("a", 3000), line("b", 1000)], { manual_applications: [{ application_id: "pb-1", rule_id: S.percentOffBill, entered_value: 1500 }] }),
    rules: SEED_RULES,
    context: ctx(),
    expect: {
      adjustments: { [`${S.percentOffBill}#pb-1`]: -600, [S.serviceCharge]: 340 },
      adjustment_lines: { [`${S.percentOffBill}#pb-1`]: { a: -450, b: -150 } },
      line_nets: { a: 2550, b: 850 },
      gst_total: 230 + 77 + 23 + 8,
      total: 2550 + 850 + 340 + 230 + 77 + 23 + 8,
    },
  },
  {
    id: "R077",
    title: "Staff meal without line_ids applies to every line in scope",
    covers: ["manual_fixed", "line_percent", "seed_rules", "tax_exclusive"],
    working: "50% of 1600 = 800 and 50% of 800 = 400 → nets 800, 400. GST 72 + 36. Total = 1200 + 108 = 1308.",
    order: order([line("a", 1600), line("b", 800)], { order_type: "takeaway", manual_applications: [{ application_id: "sm-1", rule_id: S.staffMeal, reason: "staff dinner" }] }),
    rules: SEED_RULES,
    context: ctx(),
    expect: {
      adjustments: { [`${S.staffMeal}#sm-1`]: -(800 + 400) },
      adjustment_lines: { [`${S.staffMeal}#sm-1`]: { a: -800, b: -400 } },
      gst_total: 72 + 36,
      total: 800 + 400 + 72 + 36,
    },
  },
  {
    id: "R078",
    title: "% off item is capped at $50 per order: 50% off a $200 line is 10000, capped at 5000",
    covers: ["manual_open", "cap", "seed_rules", "tax_exclusive"],
    working: "50% of 20000 = 10000 > cap 5000 → 5000 off → net 15000. GST 1350. Total = 15000 + 1350 = 16350.",
    order: order([line("a", 20_000)], { order_type: "takeaway", manual_applications: [{ application_id: "pi-1", rule_id: S.percentOffItem, entered_value: 5000 }] }),
    rules: SEED_RULES,
    context: ctx(),
    expect: { adjustments: { [`${S.percentOffItem}#pi-1`]: -5000 }, line_nets: { a: 15_000 }, gst_total: 1350, total: 15_000 + 1350 },
  },
  {
    id: "R079",
    title: "A manual application restricted to lines outside the rule's scope is recorded as a zero adjustment",
    covers: ["manual_fixed", "manual_lines", "scope_categories", "tax_exclusive"],
    working: "Lunch set is scoped to food; line_ids names the drink line only, so no line is eligible. The application is kept as a zero adjustment (audit). GST 90 + 45. Total 1635.",
    order: order([line("food", 1000, { category_id: "food" }), line("drink", 500, { category_id: "drink" })], { manual_applications: [{ application_id: "ls-1", rule_id: "lunch-set", line_ids: ["drink"] }] }),
    rules: [LUNCH_SET],
    context: ctx(),
    expect: { adjustments: { "lunch-set#ls-1": 0 }, line_nets: { food: 1000, drink: 500 }, gst_total: 90 + 45, total: 1000 + 500 + 90 + 45 },
  },
  {
    id: "R080",
    title: "Two manual rules stack on one line in priority order: % off item (priority 20) then Staff meal (priority 30)",
    covers: ["manual_open", "manual_fixed", "stackable", "line_percent", "seed_rules", "rounding", "tax_exclusive"],
    working: "% off item 10%: 1000 → 900. Staff meal 50% of the running 900 = 450 → 450. GST 40.5 → 41. Total = 450 + 41 = 491.",
    order: order([line("a", 1000)], {
      order_type: "takeaway",
      manual_applications: [
        { application_id: "pi-1", rule_id: S.percentOffItem, entered_value: 1000 },
        { application_id: "sm-1", rule_id: S.staffMeal, reason: "staff" },
      ],
    }),
    rules: SEED_RULES,
    context: ctx(),
    expect: {
      adjustments: { [`${S.percentOffItem}#pi-1`]: -100, [`${S.staffMeal}#sm-1`]: -450 },
      line_nets: { a: 450 },
      gst_total: gstEx(450),
      total: 450 + 41,
    },
  },
];
