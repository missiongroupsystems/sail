import { freezeFrom, price } from "../engine.js";
import { SEED_RULE_IDS } from "../seed.js";
import { SG_SEED_RULES } from "./dsl.js";
import type { PricingContextInput, PricingOrderInput, PricingRuleInput } from "../schemas.js";
import { ctx, taxEx, line, NOW, order, type RefCase } from "./dsl.js";

/**
 * Reference cases R081–R087: freeze at first payment.
 * Each case prices a live order, extracts the frozen set with `freezeFrom`
 * (exactly as the server does at the first payment), then re-prices a changed
 * order with `context.frozen` set. The expected frozen amounts are also worked
 * by hand in `working`, so the reviewer can check what `freezeFrom` stored.
 */

const SC = SG_SEED_RULES.find((r) => r.id === SEED_RULE_IDS.serviceCharge)!;
const PCT_BILL = SG_SEED_RULES.find((r) => r.id === SEED_RULE_IDS.percentOffBill)!;

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

/** Price `live`, freeze it, and return a context frozen to that result. */
function frozenAfter(live: PricingOrderInput, rules: PricingRuleInput[], tax: "inclusive" | "exclusive" = "exclusive"): PricingContextInput {
  const result = price(live, rules, ctx(tax));
  return ctx(tax, { frozen: { frozen_at: NOW, adjustments: freezeFrom(result, rules) } });
}

const PB = { application_id: "pb-1", rule_id: SEED_RULE_IDS.percentOffBill, entered_value: 1000 };
const PB_KEY = `${SEED_RULE_IDS.percentOffBill}#pb-1`;

/* R081: live takeaway, 10% line rule plus 10% off bill. */
const r081Rules = [disc("line-10", { priority: 20 }), PCT_BILL];
const r081Live = order([line("a", 3000), line("b", 1000)], { order_type: "takeaway", manual_applications: [PB] });

/* R082: a minimum-spend rule that was not met at the freeze. */
const r082Rules = [disc("wine-10", { scope: { type: "tags", tags: ["alcohol"] }, conditions: { min_spend: { amount: 10_000, basis: "scoped" } } })];
const r082Live = order([line("wine1", 6000, { tags: ["alcohol"] })], { order_type: "takeaway" });

/* R083: $10 off the bill, then one line is removed. */
const r083Rules = [disc("bill-1000", { calc: "fixed_per_order", level: "order", value: { type: "fixed", amount: 1000 } })];
const r083Live = order([line("a", 3000), line("b", 1000)], { order_type: "takeaway" });

/* R084: dine-in with the service charge; a line is added after the freeze. */
const r084Rules = [SC, PCT_BILL];
const r084Live = order([line("a", 3000), line("b", 1000)], { manual_applications: [PB] });

/* R085: nothing freezable was applied; the order rule would qualify after the new line. */
const r085Rules = [disc("line-5", { value: { type: "fixed", amount: 500 }, priority: 10 }), disc("bill-10-min-50", { level: "order", conditions: { min_spend: { amount: 5000, basis: "order" } }, priority: 50 })];
const r085Live = order([line("a", 3000)], { order_type: "takeaway" });

/* R086: a line-level rule with a minimum spend was applied at the freeze. */
const r086Rules = [disc("wine-10", { scope: { type: "tags", tags: ["alcohol"] }, conditions: { min_spend: { amount: 10_000, basis: "scoped" } } })];
const r086Live = order([line("wine1", 12_000, { tags: ["alcohol"] })], { order_type: "takeaway" });

/* R087: same lines before and after the freeze. */
const r087Rules = [PCT_BILL];
const r087Live = order([line("a", 3000), line("b", 1000)], { order_type: "takeaway", manual_applications: [PB] });

/* R153: a fixed-per-order delivery fee is frozen at the first payment; a line added afterwards takes no share of it. */
const r153Rules: PricingRuleInput[] = [{ id: "delivery", kind: "fee", name: "Delivery fee", calc: "fixed_per_order", value: { type: "fixed", amount: 500 }, scope: { type: "all" }, priority: 100, application: "auto", report_class: "delivery_fee", tax_class_id: "standard" }];
const r153Live = order([line("a", 3000), line("b", 1000)], { order_type: "delivery" });

export const FREEZE_CASES: RefCase[] = [
  {
    id: "R081",
    title: "Freeze: a frozen % off bill keeps its per-line amounts; a line added afterwards gets line-level rules only",
    covers: ["freeze", "order_percent", "line_percent", "manual_open", "tax_exclusive"],
    working:
      "Live: line-10 takes a 3000 → 2700 and b 1000 → 900; % off bill 10% of the pool 3600 = 360, spread 270/90. Frozen set: {% off bill: a −270, b −90}. " +
      "Re-price with c 2000 added: line-10 → a 2700, b 900, c 1800. % off bill is re-emitted as frozen: a −270, b −90, nothing on c. " +
      "Nets 2430, 810, 1800. GST 218.7 → 219, 72.9 → 73, 162. Total = 5040 + 454 = 5494. Status frozen.",
    order: order([line("a", 3000), line("b", 1000), line("c", 2000)], { order_type: "takeaway", manual_applications: [PB] }),
    rules: r081Rules,
    context: frozenAfter(r081Live, r081Rules),
    expect: {
      adjustments: { "line-10": -(300 + 100 + 200), [PB_KEY]: -(270 + 90) },
      adjustment_lines: { "line-10": { a: -300, b: -100, c: -200 }, [PB_KEY]: { a: -270, b: -90 } },
      line_nets: { a: 2700 - 270, b: 900 - 90, c: 1800 },
      tax_total: 219 + 73 + 162,
      total: 2430 + 810 + 1800 + 219 + 73 + 162,
      pricing_status: "frozen",
    },
  },
  {
    id: "R082",
    title: "Freeze: a minimum-spend rule that was not met at the freeze stays off even when a new line would satisfy it",
    covers: ["freeze", "min_spend_scoped", "scope_tags", "tax_exclusive"],
    working:
      "Live: wine1 6000 < 10000, wine-10 not applied; the frozen set is empty. Re-price with wine2 6000: scoped spend is now 12000 ≥ 10000, but the rule is frozen as 'not applied' and stays off. " +
      "GST 540 + 540. Total = 12000 + 1080 = 13080. Status frozen.",
    order: order([line("wine1", 6000, { tags: ["alcohol"] }), line("wine2", 6000, { tags: ["alcohol"] })], { order_type: "takeaway" }),
    rules: r082Rules,
    context: frozenAfter(r082Live, r082Rules),
    expect: { not_applied: ["wine-10"], line_nets: { wine1: 6000, wine2: 6000 }, tax_total: 540 + 540, total: 12_000 + 1080, pricing_status: "frozen" },
  },
  {
    id: "R083",
    title: "Freeze: when a frozen rule's line is removed, only the remaining line's stored amount is re-emitted",
    covers: ["freeze", "order_fixed", "tax_exclusive"],
    working:
      "Live: $10 off the pool 4000 spread 750/250. Frozen set: {bill-1000: a −750, b −250}. Re-price with b removed: a −750 only (b's amount is dropped). " +
      "Net 2250. GST 202.5 → 203. Total = 2250 + 203 = 2453. Status frozen.",
    order: order([line("a", 3000)], { order_type: "takeaway" }),
    rules: r083Rules,
    context: frozenAfter(r083Live, r083Rules),
    expect: {
      adjustments: { "bill-1000": -750 },
      adjustment_lines: { "bill-1000": { a: -750 } },
      line_nets: { a: 3000 - 750 },
      tax_total: 203,
      total: 2250 + 203,
      pricing_status: "frozen",
    },
  },
  {
    id: "R084",
    title: "Freeze: fees recompute on the current nets; the frozen discount does not reach the new line",
    covers: ["freeze", "order_percent", "fee_percent", "seed_rules", "manual_open", "tax_exclusive"],
    working:
      "Live dine-in: % off bill 10% of 4000 = 400, spread 300/100. Frozen set: {a −300, b −100}. Re-price with c 2000 added: a 2700, b 900, c 2000 (no discount). " +
      "Service charge is recomputed on the current nets: 270 + 90 + 200 = 560. GST on nets 243 + 81 + 180 = 504; on SC 24.3 → 24, 8.1 → 8, 18 = 50. " +
      "Total = 5600 + 560 + 504 + 50 = 6714. Status frozen.",
    order: order([line("a", 3000), line("b", 1000), line("c", 2000)], { manual_applications: [PB] }),
    rules: r084Rules,
    context: frozenAfter(r084Live, r084Rules),
    expect: {
      adjustments: { [PB_KEY]: -400, [SEED_RULE_IDS.serviceCharge]: 270 + 90 + 200 },
      adjustment_lines: { [PB_KEY]: { a: -300, b: -100 }, [SEED_RULE_IDS.serviceCharge]: { a: 270, b: 90, c: 200 } },
      line_nets: { a: 2700, b: 900, c: 2000 },
      fee_total: 560,
      tax_total: 243 + 81 + 180 + 24 + 8 + 18,
      total: 2700 + 900 + 2000 + 560 + 504 + 50,
      pricing_status: "frozen",
    },
  },
  {
    id: "R085",
    title: "Freeze with an empty frozen set: line-level rules still apply to new lines; an order rule that would now qualify stays off",
    covers: ["freeze", "min_spend_order", "line_percent", "order_percent", "tax_exclusive"],
    working:
      "Live: a 3000, line-5 → 2850; the 10%-off-bill-above-$50 rule is not met (3000 < 5000). Frozen set is empty. Re-price with b 3000: line-5 applies to both (150 each); " +
      "the order rule now sees 6000 ≥ 5000 but was frozen off. Nets 2850 × 2. GST 256.5 → 257 × 2. Total = 5700 + 514 = 6214. Status frozen.",
    order: order([line("a", 3000), line("b", 3000)], { order_type: "takeaway" }),
    rules: r085Rules,
    context: frozenAfter(r085Live, r085Rules),
    expect: {
      adjustments: { "line-5": -300 },
      not_applied: ["bill-10-min-50"],
      line_nets: { a: 2850, b: 2850 },
      tax_total: 257 + 257,
      total: 2850 + 2850 + 257 + 257,
      pricing_status: "frozen",
    },
  },
  {
    id: "R086",
    title: "Freeze: a line-level minimum-spend rule applied at the freeze keeps its amount and does not extend to a new line",
    covers: ["freeze", "min_spend_scoped", "line_percent", "scope_tags", "tax_exclusive"],
    working:
      "Live: wine1 12000 ≥ 10000 → 10% = 1200 → 10800. Frozen set: {wine-10: wine1 −1200}. Re-price with wine2 5000 added: wine1 keeps −1200; wine2 gets nothing because " +
      "rules with a minimum spend are frozen. Nets 10800, 5000. GST 972 + 450. Total = 15800 + 1422 = 17222. Status frozen.",
    order: order([line("wine1", 12_000, { tags: ["alcohol"] }), line("wine2", 5000, { tags: ["alcohol"] })], { order_type: "takeaway" }),
    rules: r086Rules,
    context: frozenAfter(r086Live, r086Rules),
    expect: {
      adjustments: { "wine-10": -1200 },
      adjustment_lines: { "wine-10": { wine1: -1200 } },
      line_nets: { wine1: 10_800, wine2: 5000 },
      tax_total: taxEx(10_800) + taxEx(5000),
      total: 10_800 + 5000 + 972 + 450,
      pricing_status: "frozen",
    },
  },
  {
    id: "R087",
    title: "Freeze then re-price the same lines: identical amounts (invariant 7)",
    covers: ["freeze", "order_percent", "manual_open", "tax_exclusive"],
    working: "Live and frozen alike: % off bill 10% of 4000 = 400 → 300/100; nets 2700, 900. GST 243 + 81. Total = 3600 + 324 = 3924. Status frozen.",
    order: r087Live,
    rules: r087Rules,
    context: frozenAfter(r087Live, r087Rules),
    expect: {
      adjustments: { [PB_KEY]: -400 },
      adjustment_lines: { [PB_KEY]: { a: -300, b: -100 } },
      line_nets: { a: 2700, b: 900 },
      tax_total: 243 + 81,
      total: 2700 + 900 + 243 + 81,
      pricing_status: "frozen",
    },
  },
  {
    id: "R153",
    title: "Freeze: a fixed-per-order fee keeps its per-line spread; a line added after the first payment takes no share of it",
    covers: ["freeze", "fee_fixed_per_order", "fee_taxed", "rounding", "tax_exclusive"],
    working:
      "Live delivery order: $5 delivery fee spread by the nets 3000/1000 → 375/125. Frozen set: {delivery: a 375, b 125}. Re-price with c 2000 added: the fee is re-emitted as frozen " +
      "(a 375, b 125, nothing on c), so the paid lines never move and the customer is not charged a second delivery fee. GST on nets 270 + 90 + 180 = 540; on the fee 33.75 → 34 and 11.25 → 11. " +
      "Total = 6000 + 500 + 540 + 45 = 7085. Status frozen.",
    order: order([line("a", 3000), line("b", 1000), line("c", 2000)], { order_type: "delivery" }),
    rules: r153Rules,
    context: frozenAfter(r153Live, r153Rules),
    expect: {
      adjustments: { delivery: 500 },
      adjustment_lines: { delivery: { a: 375, b: 125 } },
      line_nets: { a: 3000, b: 1000, c: 2000 },
      line_fees: { a: 375, b: 125, c: 0 },
      fee_total: 500,
      tax_total: 270 + 90 + 180 + 34 + 11,
      total: 6000 + 500 + 540 + 45,
      pricing_status: "frozen",
    },
  },
];
