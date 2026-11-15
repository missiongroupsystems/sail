import { SEED_RULE_IDS } from "../seed.js";
import { SG_SEED_RULES } from "./dsl.js";
import { ctx, line, order, type RefCase } from "./dsl.js";

/**
 * Reference cases R139–R146: one case per manual preset in SG_SEED_RULES,
 * each applied to the same four-line dine-in order with the full seed set,
 * plus two combinations. Adjustment keys are `rule_id#application_id`.
 *
 * The order: a 2500 (food), b 1250 (food), c 380 × 2 = 760 (drink),
 * d 250 × 2 = 500 (BCRS drink). Subtotal 5010. Without any preset the
 * service charge is 250 + 125 + 76 + 50 = 501 and the deposit 20.
 */

const S = SEED_RULE_IDS;

const PRESET_ORDER = [line("a", 2500, { category_id: "food" }), line("b", 1250, { category_id: "food" }), line("c", 380, { quantity: 2, category_id: "drink" }), line("d", 250, { quantity: 2, category_id: "drink", has_deposit: true })];

export const PRESET_CASES: RefCase[] = [
  {
    id: "R139",
    title: "Preset '% off bill' 15% on four lines: 751.5 → 752 spread by largest remainder, service charge on the nets",
    covers: ["manual_open", "order_percent", "fee_percent", "fee_fixed_per_unit", "fee_no_compounding", "seed_rules", "rounding", "tax_exclusive"],
    working:
      "Pool 5010 × 15% = 751.5 → 752. Shares 752 × 2500/5010 = 375.25, × 1250/5010 = 187.62, × 760/5010 = 114.08, × 500/5010 = 75.05; floors 375 + 187 + 114 + 75 = 751, " +
      "leftover cent to the largest remainder (.62, b) → 375/188/114/75. Nets 2125, 1062, 646, 425 = 4258. Service charge: 212.5 → 213; 106.2 → 106; 64.6 → 65; 42.5 → 43 = 427. Deposit 20. " +
      "GST on nets: 191.25 → 191; 95.58 → 96; 58.14 → 58; 38.25 → 38 = 383. GST on SC: 19.17 → 19; 9.54 → 10; 5.85 → 6; 3.87 → 4 = 39. Total = 4258 + 427 + 20 + 383 + 39 = 5127.",
    order: order(PRESET_ORDER, { manual_applications: [{ application_id: "pb-1", rule_id: S.percentOffBill, entered_value: 1500, applied_by: "mgr-1" }] }),
    rules: SG_SEED_RULES,
    context: ctx(),
    expect: {
      subtotal: 5010,
      adjustments: { [`${S.percentOffBill}#pb-1`]: -752, [S.serviceCharge]: 427, [S.containerDeposit]: 20 },
      adjustment_lines: { [`${S.percentOffBill}#pb-1`]: { a: -375, b: -188, c: -114, d: -75 }, [S.serviceCharge]: { a: 213, b: 106, c: 65, d: 43 } },
      line_nets: { a: 2125, b: 1062, c: 646, d: 425 },
      line_tax: { a: 191, b: 96, c: 58, d: 38 },
      fee_total: 427 + 20,
      tax_total: 383 + 39,
      total: 4258 + 427 + 20 + 383 + 39,
    },
  },
  {
    id: "R140",
    title: "Preset '$ off bill' $20 on four lines: spread 998/499/303/200 with the leftover cent to the largest remainder (d)",
    covers: ["manual_open", "order_fixed", "fee_percent", "fee_fixed_per_unit", "seed_rules", "rounding", "tax_exclusive"],
    working:
      "2000 × 2500/5010 = 998.00 (.004), × 1250/5010 = 499.00 (.002), × 760/5010 = 303.39, × 500/5010 = 199.60; floors 1999, leftover cent to d (.60) → 998/499/303/200. " +
      "Nets 1502, 751, 457, 300 = 3010. Service charge: 150.2 → 150; 75.1 → 75; 45.7 → 46; 30 = 301. Deposit 20. GST on nets: 135.18 → 135; 67.59 → 68; 41.13 → 41; 27 = 271. " +
      "GST on SC: 13.5 → 14; 6.75 → 7; 4.14 → 4; 2.7 → 3 = 28. Total = 3010 + 301 + 20 + 271 + 28 = 3630.",
    order: order(PRESET_ORDER, { manual_applications: [{ application_id: "ab-1", rule_id: S.amountOffBill, entered_value: 2000, applied_by: "mgr-1" }] }),
    rules: SG_SEED_RULES,
    context: ctx(),
    expect: {
      adjustments: { [`${S.amountOffBill}#ab-1`]: -2000, [S.serviceCharge]: 301, [S.containerDeposit]: 20 },
      adjustment_lines: { [`${S.amountOffBill}#ab-1`]: { a: -998, b: -499, c: -303, d: -200 }, [S.serviceCharge]: { a: 150, b: 75, c: 46, d: 30 } },
      line_nets: { a: 1502, b: 751, c: 457, d: 300 },
      line_tax: { a: 135, b: 68, c: 41, d: 27 },
      fee_total: 301 + 20,
      tax_total: 271 + 28,
      total: 3010 + 301 + 20 + 271 + 28,
    },
  },
  {
    id: "R141",
    title: "Preset '% off item' 25% on two of four lines via line_ids",
    covers: ["manual_open", "manual_lines", "line_percent", "fee_percent", "seed_rules", "rounding", "tax_exclusive"],
    working:
      "a 2500 × 25% = 625 → 1875; c 760 × 25% = 190 → 570 (815 total, well under the 5000 cap). b 1250 and d 500 untouched. Nets 4195. " +
      "Service charge: 187.5 → 188; 125; 57; 50 = 420. Deposit 20. GST on nets: 168.75 → 169; 112.5 → 113; 51.3 → 51; 45 = 378. GST on SC: 16.92 → 17; 11.25 → 11; 5.13 → 5; 4.5 → 5 = 38. " +
      "Total = 4195 + 420 + 20 + 378 + 38 = 5051.",
    order: order(PRESET_ORDER, { manual_applications: [{ application_id: "pi-1", rule_id: S.percentOffItem, entered_value: 2500, line_ids: ["a", "c"], applied_by: "user-1" }] }),
    rules: SG_SEED_RULES,
    context: ctx(),
    expect: {
      adjustments: { [`${S.percentOffItem}#pi-1`]: -(625 + 190), [S.serviceCharge]: 420, [S.containerDeposit]: 20 },
      adjustment_lines: { [`${S.percentOffItem}#pi-1`]: { a: -625, c: -190 }, [S.serviceCharge]: { a: 188, b: 125, c: 57, d: 50 } },
      line_nets: { a: 1875, b: 1250, c: 570, d: 500 },
      line_tax: { a: 169, b: 113, c: 51, d: 45 },
      tax_total: 378 + 38,
      total: 4195 + 420 + 20 + 378 + 38,
    },
  },
  {
    id: "R142",
    title: "Preset 'Staff meal' (fixed 50%) on the whole four-line order",
    covers: ["manual_fixed", "line_percent", "fee_percent", "fee_fixed_per_unit", "seed_rules", "rounding", "tax_exclusive"],
    working:
      "50% of each line: 1250, 625, 380, 250 off → nets 1250, 625, 380, 250 = 2505. Service charge: 125; 62.5 → 63; 38; 25 = 251. Deposit 20 (not discounted). " +
      "GST on nets: 112.5 → 113; 56.25 → 56; 34.2 → 34; 22.5 → 23 = 226. GST on SC: 11.25 → 11; 5.67 → 6; 3.42 → 3; 2.25 → 2 = 22. Total = 2505 + 251 + 20 + 226 + 22 = 3024.",
    order: order(PRESET_ORDER, { manual_applications: [{ application_id: "sm-1", rule_id: S.staffMeal, applied_by: "user-1", reason: "staff dinner" }] }),
    rules: SG_SEED_RULES,
    context: ctx(),
    expect: {
      adjustments: { [`${S.staffMeal}#sm-1`]: -2505, [S.serviceCharge]: 251, [S.containerDeposit]: 20 },
      adjustment_lines: { [`${S.staffMeal}#sm-1`]: { a: -1250, b: -625, c: -380, d: -250 }, [S.serviceCharge]: { a: 125, b: 63, c: 38, d: 25 } },
      line_nets: { a: 1250, b: 625, c: 380, d: 250 },
      line_tax: { a: 113, b: 56, c: 34, d: 23 },
      tax_total: 226 + 22,
      total: 2505 + 251 + 20 + 226 + 22,
    },
  },
  {
    id: "R143",
    title: "Preset 'Manager comp' (exclusive 100%) on two lines: zero nets and zero service charge there, but the deposit on the comped cans stays",
    covers: ["manual_fixed", "manual_lines", "exclusive", "fee_percent", "fee_fixed_per_unit", "fee_untaxed", "scope_deposit", "seed_rules", "tax_exclusive"],
    working:
      "b 1250 → 0 and d 500 → 0, both blocked. a 2500 and c 760 untouched. Nets 3260. Service charge: 250 + 0 + 76 + 0 = 326. Deposit 2 × 10 = 20 on d (fees are never blocked). " +
      "GST on nets 225 + 0 + 68.4 → 68 + 0 = 293; on SC 22.5 → 23 + 6.84 → 7 = 30. Total = 3260 + 326 + 20 + 293 + 30 = 3929.",
    order: order(PRESET_ORDER, { manual_applications: [{ application_id: "mc-1", rule_id: S.managerComp, line_ids: ["b", "d"], applied_by: "mgr-1", reason: "cold food" }] }),
    rules: SG_SEED_RULES,
    context: ctx(),
    expect: {
      adjustments: { [`${S.managerComp}#mc-1`]: -(1250 + 500), [S.serviceCharge]: 326, [S.containerDeposit]: 20 },
      adjustment_lines: { [S.serviceCharge]: { a: 250, b: 0, c: 76, d: 0 }, [S.containerDeposit]: { d: 20 } },
      line_nets: { a: 2500, b: 0, c: 760, d: 0 },
      line_fees: { a: 250, b: 0, c: 76, d: 20 },
      tax_total: 225 + 68 + 23 + 7,
      total: 3260 + 326 + 20 + 225 + 68 + 23 + 7,
    },
  },
  {
    id: "R144",
    title: "Preset 'Service charge waiver' on four lines: the service charge goes, the deposit (a different reporting class) stays",
    covers: ["waiver", "manual_fixed", "fee_fixed_per_unit", "fee_untaxed", "seed_rules", "tax_exclusive"],
    working: "The waiver disables the service_charge class only. Nets 5010. Deposit 20. GST on nets 225 + 112.5 → 113 + 68.4 → 68 + 45 = 451. Total = 5010 + 20 + 451 = 5481.",
    order: order(PRESET_ORDER, { manual_applications: [{ application_id: "w-1", rule_id: S.serviceChargeWaiver, applied_by: "mgr-1", reason: "slow service" }] }),
    rules: SG_SEED_RULES,
    context: ctx(),
    expect: {
      adjustments: { [`${S.serviceChargeWaiver}#w-1`]: 0, [S.containerDeposit]: 20 },
      not_applied: [S.serviceCharge],
      fee_total: 20,
      tax_total: 225 + 113 + 68 + 45,
      total: 5010 + 20 + 225 + 113 + 68 + 45,
    },
  },
  {
    id: "R145",
    title: "'% off bill' 10% with the waiver, inclusive GST: exact 10% spread, no service charge, GST inside the nets",
    covers: ["manual_open", "waiver", "order_percent", "tax_inclusive", "fee_untaxed", "seed_rules", "rounding"],
    working:
      "Pool 5010 × 10% = 501, spread exactly 250/125/76/50. Nets 2250, 1125, 684, 450 = 4509. Waiver removes the service charge; deposit 20. Payable 4529. " +
      "GST inside nets: 2250 → 185.78 → 186; 1125 → 92.89 → 93; 684 → 56.48 → 56; 450 → 37.16 → 37 = 372.",
    order: order(PRESET_ORDER, {
      manual_applications: [
        { application_id: "pb-1", rule_id: S.percentOffBill, entered_value: 1000, applied_by: "mgr-1" },
        { application_id: "w-1", rule_id: S.serviceChargeWaiver, applied_by: "mgr-1", reason: "slow service" },
      ],
    }),
    rules: SG_SEED_RULES,
    context: ctx("inclusive"),
    expect: {
      adjustments: { [`${S.percentOffBill}#pb-1`]: -501, [`${S.serviceChargeWaiver}#w-1`]: 0, [S.containerDeposit]: 20 },
      adjustment_lines: { [`${S.percentOffBill}#pb-1`]: { a: -250, b: -125, c: -76, d: -50 } },
      not_applied: [S.serviceCharge],
      line_nets: { a: 2250, b: 1125, c: 684, d: 450 },
      line_tax: { a: 186, b: 93, c: 56, d: 37 },
      fee_total: 20,
      tax_total: 372,
      total: 4509 + 20,
    },
  },
  {
    id: "R146",
    title: "All three line presets at once: Manager comp on b (10), % off item 10% on a (20), Staff meal on c (30)",
    covers: ["manual_fixed", "manual_open", "manual_lines", "exclusive", "line_percent", "fee_percent", "fee_fixed_per_unit", "seed_rules", "rounding", "tax_exclusive"],
    working:
      "Priority order: comp b 1250 → 0 (blocked); % off item 10% on a: 250 → 2250; Staff meal 50% on c: 380 → 380. d 500 untouched. Nets 3130. " +
      "Service charge 225 + 0 + 38 + 50 = 313. Deposit 20. GST on nets 202.5 → 203; 0; 34.2 → 34; 45 = 282. GST on SC 20.25 → 20; 0; 3.42 → 3; 4.5 → 5 = 28. " +
      "Total = 3130 + 313 + 20 + 282 + 28 = 3773.",
    order: order(PRESET_ORDER, {
      manual_applications: [
        { application_id: "mc-1", rule_id: S.managerComp, line_ids: ["b"], applied_by: "mgr-1", reason: "dropped" },
        { application_id: "pi-1", rule_id: S.percentOffItem, entered_value: 1000, line_ids: ["a"], applied_by: "user-1" },
        { application_id: "sm-1", rule_id: S.staffMeal, line_ids: ["c"], applied_by: "user-1", reason: "staff" },
      ],
    }),
    rules: SG_SEED_RULES,
    context: ctx(),
    expect: {
      adjustments: { [`${S.managerComp}#mc-1`]: -1250, [`${S.percentOffItem}#pi-1`]: -250, [`${S.staffMeal}#sm-1`]: -380, [S.serviceCharge]: 313, [S.containerDeposit]: 20 },
      adjustment_lines: { [S.serviceCharge]: { a: 225, b: 0, c: 38, d: 50 } },
      line_nets: { a: 2250, b: 0, c: 380, d: 500 },
      line_tax: { a: 203, b: 0, c: 34, d: 45 },
      tax_total: 282 + 28,
      total: 3130 + 313 + 20 + 282 + 28,
    },
  },
];
