import { freezeFrom, price } from "../engine.js";
import { SEED_RULES, SEED_RULE_IDS } from "../seed.js";
import type { PricingContextInput, PricingOrderInput, PricingRuleInput } from "../schemas.js";
import { ctx, line, NOW, order, type RefCase } from "./dsl.js";

/**
 * Reference cases R147–R152: freeze at first payment where the order
 * changes in both directions afterwards: one line is removed and another is
 * added. As in cases-freeze.ts, each case prices the live order, extracts the
 * frozen set with `freezeFrom` (as the server does at the first payment), and
 * re-prices the changed order with `context.frozen` set.
 */

const SC = SEED_RULES.find((r) => r.id === SEED_RULE_IDS.serviceCharge)!;
const PCT_BILL = SEED_RULES.find((r) => r.id === SEED_RULE_IDS.percentOffBill)!;
const AMT_BILL = SEED_RULES.find((r) => r.id === SEED_RULE_IDS.amountOffBill)!;

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
const AB = { application_id: "ab-1", rule_id: SEED_RULE_IDS.amountOffBill, entered_value: 1000 };
const AB_KEY = `${SEED_RULE_IDS.amountOffBill}#ab-1`;

/* R147/R148: % off bill on three lines; then b is removed and d added. */
const threeLines = [line("a", 3000), line("b", 1000), line("c", 500)];
const swapped = [line("a", 3000), line("c", 500), line("d", 2000)];
const r147Rules = [PCT_BILL];
const r147Live = order(threeLines, { order_type: "takeaway", manual_applications: [PB] });
const r148Rules = [SC, PCT_BILL];
const r148Live = order(threeLines, { manual_applications: [PB] });

/* R149: a line rule plus $ off bill; the line carrying most of the frozen amount is removed. */
const r149Rules = [disc("line-10", { priority: 20 }), AMT_BILL];
const r149Live = order([line("a", 3000), line("b", 1000)], { order_type: "takeaway", manual_applications: [AB] });

/* R150/R151: a line-level minimum-spend rule frozen as applied. */
const wineRule = disc("wine-10", { scope: { type: "tags", tags: ["alcohol"] }, conditions: { min_spend: { amount: 10_000, basis: "scoped" } } });
const r150Live = order([line("wine1", 7000, { tags: ["alcohol"] }), line("wine2", 5000, { tags: ["alcohol"] })], { order_type: "takeaway" });
const r151Live = order([line("wine1", 12_000, { tags: ["alcohol"] })], { order_type: "takeaway" });

/* R152: inclusive dine-in with the service charge; b removed, c added. */
const r152Rules = [SC, PCT_BILL];
const r152Live = order([line("a", 2180), line("b", 1090)], { manual_applications: [PB] });

export const FREEZE_CHANGE_CASES: RefCase[] = [
  {
    id: "R147",
    title: "Freeze: % off bill frozen on three lines; one line removed and another added keeps only the surviving lines' stored amounts",
    covers: ["freeze", "order_percent", "manual_open", "tax_exclusive"],
    working:
      "Live: pool 4500 × 10% = 450 → a −300, b −100, c −50. Frozen set {a −300, b −100, c −50}. Re-price with b removed and d 2000 added: a −300 and c −50 are re-emitted (b dropped); " +
      "d gets nothing (order-level rules are frozen). Nets 2700, 450, 2000. GST 243; 40.5 → 41; 180. Total = 5150 + 464 = 5614. Status frozen.",
    order: order(swapped, { order_type: "takeaway", manual_applications: [PB] }),
    rules: r147Rules,
    context: frozenAfter(r147Live, r147Rules),
    expect: {
      adjustments: { [PB_KEY]: -(300 + 50) },
      adjustment_lines: { [PB_KEY]: { a: -300, c: -50 } },
      line_nets: { a: 2700, c: 450, d: 2000 },
      gst_total: 243 + 41 + 180,
      total: 2700 + 450 + 2000 + 243 + 41 + 180,
      pricing_status: "frozen",
    },
  },
  {
    id: "R148",
    title: "Freeze on a dine-in order: the same swap, with the service charge recomputed on the current nets including the new line",
    covers: ["freeze", "order_percent", "fee_percent", "manual_open", "seed_rules", "tax_exclusive"],
    working:
      "Frozen set {a −300, b −100, c −50} as in R147. After the swap: nets 2700, 450, 2000. Service charge is live: 270 + 45 + 200 = 515. " +
      "GST on nets 243 + 41 + 180 = 464; on SC 24.3 → 24, 4.05 → 4, 18 = 46. Total = 5150 + 515 + 464 + 46 = 6175. Status frozen.",
    order: order(swapped, { manual_applications: [PB] }),
    rules: r148Rules,
    context: frozenAfter(r148Live, r148Rules),
    expect: {
      adjustments: { [PB_KEY]: -350, [SEED_RULE_IDS.serviceCharge]: 515 },
      adjustment_lines: { [PB_KEY]: { a: -300, c: -50 }, [SEED_RULE_IDS.serviceCharge]: { a: 270, c: 45, d: 200 } },
      line_nets: { a: 2700, c: 450, d: 2000 },
      fee_total: 515,
      gst_total: 464 + 46,
      total: 5150 + 515 + 464 + 46,
      pricing_status: "frozen",
    },
  },
  {
    id: "R149",
    title: "Freeze: $10 off the bill frozen as 750/250; the 750 line is removed and a new line added, so only 250 of the $10 survives while the line rule is live",
    covers: ["freeze", "order_fixed", "line_percent", "manual_open", "tax_exclusive"],
    working:
      "Live: line-10 → a 2700, b 900; $ off bill 1000 on the pool 3600 → 750/250. Frozen set {a −750, b −250}. Re-price with a removed and c 4000 added: line-10 is live → b −100 → 900, c −400 → 3600; " +
      "the frozen $ off bill re-emits b −250 only → b 650. The stored amounts are what is kept, not the entered $10. Nets 650, 3600. GST 58.5 → 59; 324. Total = 4250 + 383 = 4633. Status frozen.",
    order: order([line("b", 1000), line("c", 4000)], { order_type: "takeaway", manual_applications: [AB] }),
    rules: r149Rules,
    context: frozenAfter(r149Live, r149Rules),
    expect: {
      adjustments: { "line-10": -(100 + 400), [AB_KEY]: -250 },
      adjustment_lines: { "line-10": { b: -100, c: -400 }, [AB_KEY]: { b: -250 } },
      line_nets: { b: 650, c: 3600 },
      gst_total: 59 + 324,
      total: 650 + 3600 + 59 + 324,
      pricing_status: "frozen",
    },
  },
  {
    id: "R150",
    title: "Freeze: a line-level minimum-spend rule frozen on two wines; one is swapped for a dearer one, which gets nothing",
    covers: ["freeze", "min_spend_scoped", "line_percent", "scope_tags", "tax_exclusive"],
    working:
      "Live: scoped spend 7000 + 5000 = 12000 ≥ 10000 → wine-10: wine1 −700, wine2 −500. Frozen set {wine1 −700, wine2 −500}. Re-price with wine2 removed and wine3 8000 added: " +
      "wine1 keeps −700; wine3 gets nothing even though the scoped spend is now 15000, because minimum-spend rules are frozen. Nets 6300, 8000. GST 567 + 720. Total = 14300 + 1287 = 15587.",
    order: order([line("wine1", 7000, { tags: ["alcohol"] }), line("wine3", 8000, { tags: ["alcohol"] })], { order_type: "takeaway" }),
    rules: [wineRule],
    context: frozenAfter(r150Live, [wineRule]),
    expect: {
      adjustments: { "wine-10": -700 },
      adjustment_lines: { "wine-10": { wine1: -700 } },
      line_nets: { wine1: 6300, wine3: 8000 },
      gst_total: 567 + 720,
      total: 6300 + 8000 + 567 + 720,
      pricing_status: "frozen",
    },
  },
  {
    id: "R151",
    title: "Freeze: the only line a minimum-spend rule was frozen on is removed; the replacement gets nothing and the frozen rule re-emits as zero",
    covers: ["freeze", "min_spend_scoped", "scope_tags", "tax_exclusive"],
    working:
      "Live: wine1 12000 → −1200. Frozen set {wine1 −1200}. Re-price with wine1 removed and wine2 11000 added: no stored line survives, so the frozen rule is re-emitted with no lines and a zero total " +
      "(it stays in the audit trail); wine2 is not discounted although 11000 ≥ 10000. Net 11000. GST 990. Total = 11000 + 990 = 11990. Status frozen.",
    order: order([line("wine2", 11_000, { tags: ["alcohol"] })], { order_type: "takeaway" }),
    rules: [wineRule],
    context: frozenAfter(r151Live, [wineRule]),
    expect: {
      adjustments: { "wine-10": 0 },
      line_nets: { wine2: 11_000 },
      discount_total: 0,
      gst_total: 990,
      total: 11_000 + 990,
      pricing_status: "frozen",
    },
  },
  {
    id: "R152",
    title: "Freeze in inclusive mode: % off bill frozen 218/109; b removed, c added; the service charge is live on the GST-inclusive nets",
    covers: ["freeze", "order_percent", "fee_percent", "manual_open", "tax_inclusive", "seed_rules", "rounding"],
    working:
      "Live: pool 3270 × 10% = 327 → a −218, b −109 (exact). Frozen set {a −218, b −109}. Re-price with b removed and c 545 added: a −218 → 1962; c 545 (no discount). " +
      "Service charge 10%: 196.2 → 196; 54.5 → 55 = 251. Payable = 1962 + 545 + 251 = 2758. GST inside: 1962 → 162; 545 × 9/109 = 45; SC 196 → 16.18 → 16; 55 → 4.54 → 5. GST reported 228. Status frozen.",
    order: order([line("a", 2180), line("c", 545)], { manual_applications: [PB] }),
    rules: r152Rules,
    context: frozenAfter(r152Live, r152Rules, "inclusive"),
    expect: {
      adjustments: { [PB_KEY]: -218, [SEED_RULE_IDS.serviceCharge]: 196 + 55 },
      adjustment_lines: { [PB_KEY]: { a: -218 }, [SEED_RULE_IDS.serviceCharge]: { a: 196, c: 55 } },
      line_nets: { a: 1962, c: 545 },
      line_gst: { a: 162, c: 45 },
      fee_total: 251,
      gst_total: 162 + 45 + 16 + 5,
      total: 1962 + 545 + 251,
      pricing_status: "frozen",
    },
  },
];
