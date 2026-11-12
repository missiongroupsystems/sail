import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { freezeFrom, price, sortRules } from "./engine.js";
import type { PricingLineInput, PricingOrderInput, PricingRuleInput, TaxRateInput } from "./schemas.js";
import type { TaxRounding } from "../domain.js";
import { SEED_RULE_IDS } from "./seed.js";
import { SG_SEED_RULES, SG_TAX_RATES } from "./reference/dsl.js";
import { percentOfCents, sumCents } from "../money.js";
import { allocateLine, evenShares, sumTaxes } from "../splits.js";

const NOW = "2026-11-04T12:00:00.000Z";
const ctx = (tax_mode: "inclusive" | "exclusive" = "exclusive", tax_rounding: TaxRounding = "per_line", tax_rates: TaxRateInput[] = SG_TAX_RATES) => ({ tax_mode, tax_rounding, tax_rates, now: NOW });

export function line(id: string, base: number, opts: Partial<PricingLineInput> = {}): PricingLineInput {
  return { line_id: id, product_id: opts.product_id ?? `prod-${id}`, tax_class_id: "standard", quantity: 1, prices: { base }, ...opts };
}

/**
 * A tax table for the property tests: a single rate, a two-component rate
 * (state + city), a rate that depends on the order type (Japan), a zero rate
 * and an exempt class.
 */
const MIXED_TAX_RATES: TaxRateInput[] = [
  { tax_class_id: "standard", components: [{ name: "VAT 20%", bps: 2000 }] },
  { tax_class_id: "reduced", components: [{ name: "VAT 10%", bps: 1000 }] },
  { tax_class_id: "us", components: [{ name: "State tax", bps: 625 }, { name: "City tax", bps: 225 }] },
  { tax_class_id: "jp", components: [{ name: "Consumption tax 10%", bps: 1000 }] },
  { tax_class_id: "jp", order_type: "takeaway", components: [{ name: "Consumption tax 8%", bps: 800 }] },
  { tax_class_id: "zero", components: [{ name: "VAT 0%", bps: 0 }] },
  { tax_class_id: "exempt", components: [] },
];
const TAX_CLASSES = ["standard", "reduced", "us", "jp", "zero", "exempt"] as const;

export function order(lines: PricingLineInput[], opts: Partial<PricingOrderInput> = {}): PricingOrderInput {
  return { order_type: "dine_in", channel: "pos", outlet_id: "outlet-1", brand_id: "brand-1", lines, ...opts };
}

const ruleA: PricingRuleInput = {
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
const ruleB: PricingRuleInput = {
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
const serviceCharge = SG_SEED_RULES.find((r) => r.id === SEED_RULE_IDS.serviceCharge)!;

describe("worked example", () => {
  const o = order([line("food", 8000, { category_id: "food" }), line("wine", 12_000, { tags: ["alcohol"] })], { customer_group_ids: ["vip"] });

  it("produces $20 off food, $12 off wine and $16.80 service charge", () => {
    const r = price(o, [ruleA, ruleB, serviceCharge], ctx());
    const byRule = Object.fromEntries(r.adjustments.map((a) => [a.rule_id, a.total]));
    expect(byRule["rule-a"]).toBe(-2000);
    expect(byRule["rule-b"]).toBe(-1200);
    expect(byRule[SEED_RULE_IDS.serviceCharge]).toBe(1680);
    // GST 9% exclusive: per line on the net amount, plus on the service charge per line.
    const food = r.lines.find((l) => l.line_id === "food")!;
    const wine = r.lines.find((l) => l.line_id === "wine")!;
    expect(food.net_amount).toBe(6000);
    expect(wine.net_amount).toBe(10_800);
    expect(food.tax_on_net).toBe(540);
    expect(wine.tax_on_net).toBe(972);
    expect(food.fee_amount).toBe(600);
    expect(wine.fee_amount).toBe(1080);
    expect(food.tax_on_fees).toBe(54);
    expect(wine.tax_on_fees).toBe(97); // 97.2 → 97
    expect(r.totals.tax_total).toBe(540 + 972 + 54 + 97);
    expect(r.totals.total).toBe(6000 + 10_800 + 1680 + 540 + 972 + 54 + 97);
    expect(r.totals.total).toBe(sumCents(r.lines.map((l) => l.total)));
  });

  it("skips rule B when the customer is not in a qualifying group", () => {
    const r = price({ ...o, customer_group_ids: [] }, [ruleA, ruleB, serviceCharge], ctx());
    expect(r.adjustments.map((a) => a.rule_id)).toEqual(["rule-a", SEED_RULE_IDS.serviceCharge]);
    const skipped = r.trace[2]!.entries.concat(r.trace[1]!.entries).find((e) => e.rule_id === "rule-b");
    expect(skipped?.outcome).toBe("skipped");
  });

  it("skips rule B when the scoped spend is below the minimum (measured before discounts)", () => {
    const o2 = order([line("food", 8000, { category_id: "food" }), line("wine", 9999, { tags: ["alcohol"] })], { customer_group_ids: ["vip"] });
    const r = price(o2, [ruleA, ruleB, serviceCharge], ctx());
    expect(r.adjustments.find((a) => a.rule_id === "rule-b")).toBeUndefined();
  });

  it("does not depend on the order rules are passed in", () => {
    const a = price(o, [ruleA, ruleB, serviceCharge], ctx());
    const b = price(o, [serviceCharge, ruleB, ruleA], ctx());
    expect(b).toEqual(a);
  });

  it("the service charge applies only to dine-in", () => {
    const r = price({ ...o, order_type: "takeaway" }, [ruleA, ruleB, serviceCharge], ctx());
    expect(r.adjustments.find((a) => a.rule_id === SEED_RULE_IDS.serviceCharge)).toBeUndefined();
  });
});

describe("semantics", () => {
  it("uses the order-type price when one exists, else the base price", () => {
    const l = line("x", 1000, { prices: { base: 1000, by_order_type: { delivery: 1200 } } });
    expect(price(order([l], { order_type: "delivery" }), [], ctx()).totals.subtotal).toBe(1200);
    expect(price(order([l], { order_type: "pickup" }), [], ctx()).totals.subtotal).toBe(1000);
  });

  it("open price replaces the product price; modifiers add per unit", () => {
    const l = line("x", 1000, { open_price: 2500, quantity: 2, modifiers: [{ modifier_id: "m1", product_id: "p-m1", quantity: 1, price: 100 }] });
    const r = price(order([l]), [], ctx());
    expect(r.lines[0]!.unit_price).toBe(2500);
    expect(r.lines[0]!.modifiers_per_unit).toBe(100);
    expect(r.lines[0]!.base_amount).toBe(5200);
  });

  it("exclusive discounts block later discounts on the lines they touched", () => {
    const comp: PricingRuleInput = { ...ruleA, id: "comp", name: "50% off food, exclusive", value: { type: "fixed", amount: 5000 }, stacking: "exclusive", priority: 5 };
    const r = price(order([line("food", 8000, { category_id: "food" }), line("drink", 500)]), [comp, ruleA], ctx());
    expect(r.adjustments.map((a) => [a.rule_id, a.total])).toEqual([["comp", -4000]]);
    expect(r.trace[1]!.entries.find((e) => e.rule_id === "rule-a")!.detail).toMatch(/blocked/);
  });

  it("stackable discounts apply to the running amount", () => {
    const second: PricingRuleInput = { ...ruleA, id: "rule-c", name: "10% off food too", value: { type: "fixed", amount: 1000 }, priority: 15 };
    const r = price(order([line("food", 8000, { category_id: "food" })]), [ruleA, second], ctx());
    expect(r.adjustments.map((a) => a.total)).toEqual([-2000, -600]); // 10% of 6000
    expect(r.lines[0]!.net_amount).toBe(5400);
  });

  it("order-level fixed discounts spread in proportion, never exceed the pool, and freeze", () => {
    const tenOff: PricingRuleInput = { id: "ten", kind: "discount", name: "$10 off", calc: "fixed_per_order", value: { type: "fixed", amount: 1000 }, scope: { type: "all" }, priority: 50, application: "auto", report_class: "promo" };
    const r = price(order([line("a", 3000), line("b", 1000)]), [tenOff], ctx());
    expect(r.adjustments[0]!.lines.map((l) => l.amount)).toEqual([-750, -250]);
    const small = price(order([line("a", 300), line("b", 100)]), [tenOff], ctx());
    expect(small.adjustments[0]!.total).toBe(-400);
    expect(small.totals.net_subtotal).toBe(0);
  });

  it("caps a rule's total and spreads the reduction back across its lines", () => {
    const capped: PricingRuleInput = { ...ruleA, id: "cap", cap: 1000 };
    const r = price(order([line("f1", 8000, { category_id: "food" }), line("f2", 4000, { category_id: "food" })]), [capped], ctx());
    expect(r.adjustments[0]!.total).toBe(-1000);
    expect(r.adjustments[0]!.capped).toBe(true);
    expect(r.adjustments[0]!.lines.map((l) => l.amount)).toEqual([-667, -333]);
  });

  it("fixed-per-unit discounts never take a line below zero", () => {
    const perUnit: PricingRuleInput = { id: "pu", kind: "discount", name: "$2 off each", calc: "fixed_per_unit", value: { type: "fixed", amount: 200 }, scope: { type: "all" }, priority: 1, application: "auto", report_class: "promo" };
    const r = price(order([line("cheap", 150, { quantity: 3 })]), [perUnit], ctx());
    expect(r.adjustments[0]!.total).toBe(-450);
    expect(r.lines[0]!.net_amount).toBe(0);
  });

  it("fees never compound: a percent fee is calculated on discounted line amounts only", () => {
    const delivery: PricingRuleInput = { id: "del", kind: "fee", name: "Delivery fee", calc: "fixed_per_order", value: { type: "fixed", amount: 500 }, scope: { type: "all" }, conditions: { order_types: ["delivery"] }, priority: 90, application: "auto", tax_class_id: "standard", report_class: "delivery_fee" };
    const scAll: PricingRuleInput = { ...serviceCharge, id: "sc-any", conditions: {} };
    const r = price(order([line("a", 2000), line("b", 2000)], { order_type: "delivery" }), [delivery, scAll, ruleA], ctx());
    const sc = r.adjustments.find((a) => a.rule_id === "sc-any")!;
    expect(sc.total).toBe(400); // 10% of 4000, not of 4500
    expect(r.adjustments.find((a) => a.rule_id === "del")!.lines.map((l) => l.amount)).toEqual([250, 250]);
  });

  it("container deposit is per unit on deposit products, untaxed, with outlet exclusions", () => {
    const deposit = { ...SG_SEED_RULES.find((r) => r.id === SEED_RULE_IDS.containerDeposit)!, conditions: { excluded_outlet_ids: ["outlet-9"] } };
    const o = order([line("can", 250, { has_deposit: true, quantity: 6 }), line("plate", 1000)]);
    const r = price(o, [deposit], ctx());
    const d = r.adjustments[0]!;
    expect(d.total).toBe(60);
    expect(d.tax_total).toBe(0);
    expect(r.lines[0]!.fee_amount).toBe(60);
    expect(price({ ...o, outlet_id: "outlet-9" }, [deposit], ctx()).adjustments).toEqual([]);
  });

  it("inclusive tax mode reports the GST inside the amounts and does not add it", () => {
    const r = price(order([line("a", 1090)]), [serviceCharge], ctx("inclusive"));
    expect(r.lines[0]!.tax_on_net).toBe(90);
    expect(r.lines[0]!.fee_amount).toBe(109);
    expect(r.lines[0]!.tax_on_fees).toBe(9); // 109 × 9/109 = 9
    expect(r.totals.total).toBe(1090 + 109);
    expect(r.totals.tax_total).toBe(99);
  });

  it("exclusive tax mode adds GST per line, rounded half up", () => {
    const r = price(order([line("a", 1005), line("b", 1004)], { order_type: "takeaway" }), [], ctx());
    expect(r.lines.map((l) => l.tax_on_net)).toEqual([90, 90]); // 90.45 → 90; 90.36 → 90
    expect(r.totals.total).toBe(2009 + 180);
  });

  it("manual rules apply only when an application exists, with their entered value and lines", () => {
    const o = order([line("a", 2000), line("b", 1000)], {
      manual_applications: [{ application_id: "app-1", rule_id: SEED_RULE_IDS.percentOffItem, entered_value: 2000, line_ids: ["a"], applied_by: "staff-1" }],
    });
    const r = price(o, SG_SEED_RULES, ctx());
    const adj = r.adjustments.find((a) => a.rule_id === SEED_RULE_IDS.percentOffItem)!;
    expect(adj.total).toBe(-400);
    expect(adj.lines).toEqual([{ line_id: "a", amount: -400, tax_amount: 0 }]);
    expect(adj.manual_application_id).toBe("app-1");
    expect(adj.applied_by).toBe("staff-1");
    const none = price(order([line("a", 2000)]), SG_SEED_RULES, ctx());
    expect(none.adjustments.map((a) => a.rule_id)).toEqual([SEED_RULE_IDS.serviceCharge]);
  });

  it("an open value outside the range is skipped with a warning", () => {
    const o = order([line("a", 2000)], { manual_applications: [{ application_id: "app-1", rule_id: SEED_RULE_IDS.percentOffItem, entered_value: 9000 }] });
    const r = price(o, SG_SEED_RULES, ctx());
    expect(r.adjustments.find((a) => a.rule_id === SEED_RULE_IDS.percentOffItem)).toBeUndefined();
    expect(r.warnings).toHaveLength(1);
  });

  it("the service-charge waiver switches off the service charge and is recorded as a zero adjustment", () => {
    const o = order([line("a", 2000)], { manual_applications: [{ application_id: "w", rule_id: SEED_RULE_IDS.serviceChargeWaiver, reason: "kitchen 40 min late", applied_by: "m1" }] });
    const r = price(o, SG_SEED_RULES, ctx());
    expect(r.adjustments.find((a) => a.rule_id === SEED_RULE_IDS.serviceCharge)).toBeUndefined();
    const waiver = r.adjustments.find((a) => a.rule_id === SEED_RULE_IDS.serviceChargeWaiver)!;
    expect(waiver.total).toBe(0);
    expect(waiver.reason).toBe("kitchen 40 min late");
    expect(r.totals.fee_total).toBe(0);
  });

  it("manager comp is exclusive: 100% off the line and nothing else discounts it", () => {
    const o = order([line("a", 2000), line("b", 1000)], {
      manual_applications: [
        { application_id: "comp", rule_id: SEED_RULE_IDS.managerComp, line_ids: ["a"], reason: "late", applied_by: "m" },
        { application_id: "pct", rule_id: SEED_RULE_IDS.percentOffItem, entered_value: 1000, line_ids: ["a", "b"] },
      ],
    });
    const r = price(o, SG_SEED_RULES, ctx());
    expect(r.adjustments.find((a) => a.rule_id === SEED_RULE_IDS.managerComp)!.total).toBe(-2000);
    expect(r.adjustments.find((a) => a.rule_id === SEED_RULE_IDS.percentOffItem)!.lines).toEqual([{ line_id: "b", amount: -100, tax_amount: 0 }]);
    expect(r.lines[0]!.fee_amount).toBe(0); // service charge on a $0 line
  });

  it("date range conditions use the explicit evaluation time", () => {
    const dated: PricingRuleInput = { ...ruleA, id: "dated", conditions: { active_from: "2026-12-01T00:00:00.000Z", active_to: "2026-12-31T00:00:00.000Z" } };
    expect(price(order([line("f", 1000, { category_id: "food" })]), [dated], ctx()).adjustments).toEqual([]);
    expect(price(order([line("f", 1000, { category_id: "food" })]), [dated], { ...ctx(), now: "2026-12-15T00:00:00.000Z" }).adjustments).toHaveLength(1);
    expect(price(order([line("f", 1000, { category_id: "food" })]), [dated], { ...ctx(), now: "2026-12-31T00:00:00.000Z" }).adjustments).toEqual([]);
  });

  it("category scope matches the parent category too; exclusions win", () => {
    const o = order([line("x", 1000, { category_id: "noodles", parent_category_id: "food" }), line("y", 1000, { category_id: "rice", parent_category_id: "food", tags: ["no-promo"] })]);
    const r = price(o, [{ ...ruleA, exclusions: { tags: ["no-promo"] } }], ctx());
    expect(r.adjustments[0]!.lines.map((l) => l.line_id)).toEqual(["x"]);
  });

  describe("freeze at first payment", () => {
    const tenOff: PricingRuleInput = { id: "ten", kind: "discount", name: "$10 off", calc: "fixed_per_order", value: { type: "fixed", amount: 1000 }, scope: { type: "all" }, priority: 50, application: "auto", report_class: "promo" };
    const rules = [tenOff, ruleA, serviceCharge];
    const before = order([line("f", 4000, { category_id: "food" }), line("d", 1000)]);

    it("keeps frozen order-level results and prices new lines with line-level rules only", () => {
      const live = price(before, rules, ctx());
      expect(live.adjustments.find((a) => a.rule_id === "ten")!.lines.map((l) => l.amount)).toEqual([-750, -250]);
      const frozen = freezeFrom(live, rules);
      expect(frozen.map((f) => f.rule_id)).toEqual(["ten"]);

      const after = order([...before.lines, line("f2", 2000, { category_id: "food" })]);
      const r = price(after, rules, { ...ctx(), frozen: { frozen_at: NOW, adjustments: frozen } });
      expect(r.pricing_status).toBe("frozen");
      const ten = r.adjustments.find((a) => a.rule_id === "ten")!;
      expect(ten.frozen).toBe(true);
      expect(ten.lines.map((l) => [l.line_id, l.amount])).toEqual([
        ["f", -750],
        ["d", -250],
      ]);
      // The new food line still gets the line-level 25% discount and the service charge.
      const f2 = r.lines.find((l) => l.line_id === "f2")!;
      expect(f2.discount_amount).toBe(-500);
      expect(f2.fee_amount).toBe(150);
      // Old lines are unchanged.
      const f = r.lines.find((l) => l.line_id === "f")!;
      expect(f.total).toBe(live.lines.find((l) => l.line_id === "f")!.total);
    });

    it("a frozen rule that was not applied stays off even if its conditions now hold", () => {
      const minSpend: PricingRuleInput = { ...tenOff, id: "ms", conditions: { min_spend: { amount: 10_000, basis: "order" } } };
      const live = price(before, [minSpend], ctx());
      expect(live.adjustments).toEqual([]);
      const after = order([...before.lines, line("big", 20_000)]);
      const r = price(after, [minSpend], { ...ctx(), frozen: { frozen_at: NOW, adjustments: freezeFrom(live, [minSpend]) } });
      expect(r.adjustments).toEqual([]);
      expect(r.trace[2]!.entries[0]!.detail).toMatch(/frozen/);
    });

    it("a frozen order discount never takes more than a line is now worth after a quantity cut and a comp", () => {
      // 50% off the bill frozen at the first payment; then the kopi goes from 5 to 1 and is comped.
      const halfOff: PricingRuleInput = { ...tenOff, id: "half", calc: "percent", level: "order", value: { type: "fixed", amount: 5000 } };
      const comp = SG_SEED_RULES.find((r) => r.id === SEED_RULE_IDS.managerComp)!;
      const lines = [line("laksa", 1600), line("kopi", 180, { quantity: 5 })];
      const live = price(order(lines), [halfOff, comp], ctx());
      expect(live.lines.find((l) => l.line_id === "kopi")!.discount_amount).toBe(-450);
      const frozen = { frozen_at: NOW, adjustments: freezeFrom(live, [halfOff, comp]) };
      const cut = order([lines[0]!, { ...lines[1]!, quantity: 1 }], { manual_applications: [{ application_id: "c1", rule_id: comp.id, line_ids: ["kopi"] }] });
      const r = price(cut, [halfOff, comp], { ...ctx(), frozen });
      const kopi = r.lines.find((l) => l.line_id === "kopi")!;
      expect(kopi.net_amount).toBe(0);
      expect(kopi.total).toBe(0);
      expect(r.adjustments.find((a) => a.rule_id === "half")!.lines.find((l) => l.line_id === "kopi")!.amount).toBe(0);
      // The quantity cut alone: the frozen share is capped at the one kopi left.
      const r2 = price(order([lines[0]!, { ...lines[1]!, quantity: 1 }]), [halfOff, comp], { ...ctx(), frozen });
      expect(r2.lines.find((l) => l.line_id === "kopi")!.net_amount).toBe(0);
      expect(r2.lines.find((l) => l.line_id === "laksa")!.total).toBe(live.lines.find((l) => l.line_id === "laksa")!.total);
      // An exclusive 20% item discount after the freeze blocks the frozen bill discount on its line, as it would live.
      const exclusive: PricingRuleInput = { ...comp, id: "x20", value: { type: "fixed", amount: 2000 } };
      const r3 = price(order(lines, { manual_applications: [{ application_id: "x1", rule_id: "x20", line_ids: ["kopi"] }] }), [halfOff, comp, exclusive], { ...ctx(), frozen });
      expect(r3.lines.find((l) => l.line_id === "kopi")!.discount_amount).toBe(-180);
    });
  });
});

/* ------------------------------------------------------------------ */
/* Property tests                                                       */
/* ------------------------------------------------------------------ */

const arbLine = (i: number) =>
  fc.record({
    base: fc.integer({ min: 0, max: 50_000 }),
    quantity: fc.integer({ min: 1, max: 6 }),
    category: fc.constantFrom("food", "drink", "alcohol", null),
    tag: fc.constantFrom("alcohol", "promo", "deposit", null),
    deposit: fc.boolean(),
    taxClass: fc.constantFrom(...TAX_CLASSES),
    mods: fc.array(fc.integer({ min: 0, max: 500 }), { maxLength: 3 }),
  }).map(
    (l): PricingLineInput => ({
      line_id: `L${i}`,
      product_id: `P${i % 7}`,
      category_id: l.category,
      tags: l.tag ? [l.tag] : [],
      tax_class_id: l.taxClass,
      has_deposit: l.deposit,
      quantity: l.quantity,
      prices: { base: l.base },
      modifiers: l.mods.map((p, k) => ({ modifier_id: `M${i}-${k}`, product_id: `PM${k}`, quantity: 1, price: p })),
    }),
  );

type Scope = PricingRuleInput["scope"];
const arbScope: fc.Arbitrary<Scope> = fc.oneof(
  fc.constant<Scope>({ type: "all" }),
  fc.constantFrom("food", "drink", "alcohol").map((c): Scope => ({ type: "categories", category_ids: [c] })),
  fc.constantFrom("alcohol", "promo", "deposit").map((t): Scope => ({ type: "tags", tags: [t] })),
  fc.constant<Scope>({ type: "deposit" }),
  fc.integer({ min: 0, max: 6 }).map((n): Scope => ({ type: "products", product_ids: [`P${n}`] })),
);

const arbRule = (i: number) =>
  fc
    .record({
      kind: fc.constantFrom("fee", "discount"),
      calc: fc.constantFrom("percent", "fixed_per_order", "fixed_per_unit"),
      pct: fc.integer({ min: 1, max: 10_000 }),
      amt: fc.integer({ min: 1, max: 5000 }),
      level: fc.constantFrom("line", "order"),
      scope: arbScope,
      cap: fc.option(fc.integer({ min: 0, max: 3000 }), { nil: null }),
      priority: fc.integer({ min: 0, max: 200 }),
      stacking: fc.constantFrom("exclusive", "stackable"),
      taxClass: fc.constantFrom(...TAX_CLASSES, null),
      minSpend: fc.option(fc.integer({ min: 0, max: 20_000 }), { nil: null }),
    })
    .map((r): PricingRuleInput => {
      const level = r.calc === "fixed_per_order" ? "order" : r.calc === "fixed_per_unit" ? "line" : r.level;
      return {
        id: `R${i}`,
        kind: r.kind,
        name: `rule ${i}`,
        calc: r.calc,
        value: { type: "fixed", amount: r.calc === "percent" ? r.pct : r.amt },
        level: r.kind === "discount" ? level : undefined,
        scope: r.scope,
        cap: r.cap,
        priority: r.priority,
        stacking: r.stacking,
        application: "auto",
        tax_class_id: r.kind === "fee" ? r.taxClass : undefined,
        report_class: r.kind === "fee" ? "service_charge" : "promo",
        conditions: r.minSpend != null ? { min_spend: { amount: r.minSpend, basis: "order" } } : {},
      };
    });

const arbScenario = fc
  .record({
    lines: fc.integer({ min: 1, max: 8 }).chain((n) => fc.tuple(...Array.from({ length: n }, (_, i) => arbLine(i)))),
    rules: fc.integer({ min: 0, max: 8 }).chain((n) => fc.tuple(...Array.from({ length: n }, (_, i) => arbRule(i)))),
    taxMode: fc.constantFrom("inclusive", "exclusive"),
    rounding: fc.constantFrom<TaxRounding>("per_line", "per_rate"),
    orderType: fc.constantFrom("dine_in", "takeaway", "pickup", "delivery"),
  })
  .map((s) => ({
    order: order([...s.lines], { order_type: s.orderType }),
    rules: [...s.rules] as PricingRuleInput[],
    context: ctx(s.taxMode, s.rounding, MIXED_TAX_RATES),
  }));

describe("properties", () => {
  it("every adjustment's line amounts sum to its total; caps are never exceeded; nets never go below zero; line totals sum to the order total", () => {
    fc.assert(
      fc.property(arbScenario, ({ order: o, rules, context }) => {
        const r = price(o, rules, context);
        for (const a of r.adjustments) {
          expect(sumCents(a.lines.map((l) => l.amount))).toBe(a.total);
          expect(sumCents(a.lines.map((l) => l.tax_amount))).toBe(a.tax_total);
          const rule = rules.find((x) => x.id === a.rule_id)!;
          if (rule.cap != null) expect(Math.abs(a.total)).toBeLessThanOrEqual(rule.cap);
          if (a.kind === "discount") expect(a.total).toBeLessThanOrEqual(0);
          else expect(a.total).toBeGreaterThanOrEqual(0);
          if (a.kind === "discount") for (const l of a.lines) expect(l.tax_amount).toBe(0);
        }
        for (const l of r.lines) {
          expect(l.net_amount).toBeGreaterThanOrEqual(0);
          expect(l.net_amount).toBe(l.base_amount + l.discount_amount);
          expect(l.discount_amount).toBe(sumCents(r.adjustments.filter((a) => a.kind === "discount").flatMap((a) => a.lines.filter((x) => x.line_id === l.line_id).map((x) => x.amount))));
          expect(l.fee_amount).toBe(sumCents(r.adjustments.filter((a) => a.kind === "fee").flatMap((a) => a.lines.filter((x) => x.line_id === l.line_id).map((x) => x.amount))));
        }
        expect(sumCents(r.lines.map((l) => l.total))).toBe(r.totals.total);
        expect(r.totals.net_subtotal).toBe(r.totals.subtotal + r.totals.discount_total);
        if (context.tax_mode === "inclusive") expect(r.totals.total).toBe(r.totals.net_subtotal + r.totals.fee_total);
        else expect(r.totals.total).toBe(r.totals.net_subtotal + r.totals.fee_total + r.totals.tax_total);
      }),
      { numRuns: 400 },
    );
  });

  it("per component, the lines' tax adds up to the order's tax; every line's components add up to its tax", () => {
    fc.assert(
      fc.property(arbScenario, ({ order: o, rules, context }) => {
        const r = price(o, rules, context);
        const key = (t: { name: string; bps: number }) => `${t.bps}|${t.name}`;
        const fromLines = new Map<string, number>();
        for (const l of r.lines) {
          expect(sumCents(l.taxes.map((t) => t.amount))).toBe(l.tax_on_net + l.tax_on_fees);
          for (const t of l.taxes) fromLines.set(key(t), (fromLines.get(key(t)) ?? 0) + t.amount);
        }
        expect(Object.fromEntries(fromLines)).toEqual(Object.fromEntries(r.totals.taxes.map((t) => [key(t), t.amount])));
        expect(sumCents(r.totals.taxes.map((t) => t.amount))).toBe(r.totals.tax_total);
        // Exempt lines carry no component at all; zero-rated lines carry one of 0.
        for (const l of r.lines) {
          const cls = o.lines.find((x) => x.line_id === l.line_id)!.tax_class_id;
          if (cls === "zero") expect(l.taxes.find((t) => t.name === "VAT 0%")?.amount).toBe(0);
        }
        // Fee tax on each adjustment line is part of the line's tax_on_fees.
        for (const l of r.lines) expect(l.tax_on_fees).toBe(sumCents(r.adjustments.flatMap((a) => a.lines.filter((x) => x.line_id === l.line_id).map((x) => x.tax_amount))));
      }),
      { numRuns: 400 },
    );
  });

  it("split bills add up to the order: totals, and tax per component", () => {
    fc.assert(
      fc.property(arbScenario, fc.integer({ min: 1, max: 5 }), ({ order: o, rules, context }, n) => {
        const r = price(o, rules, context);
        const parts = r.lines.map((l) => allocateLine({ base: l.base_amount, discount: l.discount_amount, fee: l.fee_amount, taxes: l.taxes, adjustments: {} }, evenShares(n), { taxAddsToTotal: context.tax_mode === "exclusive" }));
        const bills = Array.from({ length: n }, (_, i) => parts.map((p) => p[i]!));
        expect(sumCents(bills.map((b) => sumCents(b.map((x) => x.total))))).toBe(r.totals.total);
        const billTaxes = sumTaxes(bills.map((b) => sumTaxes(b.map((x) => x.taxes))));
        expect(Object.fromEntries(billTaxes.map((t) => [`${t.bps}|${t.name}`, t.amount]))).toEqual(Object.fromEntries(r.totals.taxes.map((t) => [`${t.bps}|${t.name}`, t.amount])));
        for (const b of bills) for (const x of b) expect(x.tax).toBe(sumCents(x.taxes.map((t) => t.amount)));
      }),
      { numRuns: 300 },
    );
  });

  it("per-rate rounding: each rate's order tax is the whole rate rounded once on its taxed amounts, split across its components", () => {
    fc.assert(
      fc.property(arbScenario, ({ order: o, rules, context }) => {
        const r = price(o, rules, { ...context, tax_rounding: "per_rate", tax_mode: "exclusive" });
        // Every rate in the table has component names of its own, so the order's rows can be grouped back by rate.
        for (const rate of MIXED_TAX_RATES) {
          const rows = r.totals.taxes.filter((t) => rate.components.some((c) => c.name === t.name && c.bps === t.bps));
          if (rows.length === 0) continue;
          expect(rows).toHaveLength(rate.components.length);
          expect(new Set(rows.map((t) => t.taxable)).size).toBe(1);
          expect(sumCents(rows.map((t) => t.amount))).toBe(percentOfCents(rows[0]!.taxable, sumCents(rate.components.map((c) => c.bps))));
        }
      }),
      { numRuns: 300 },
    );
  });

  it("fees never compound: an uncapped percent fee equals the percentage of the discounted amounts of its lines", () => {
    fc.assert(
      fc.property(arbScenario, ({ order: o, rules, context }) => {
        const r = price(o, rules, context);
        for (const a of r.adjustments.filter((x) => x.kind === "fee")) {
          const rule = rules.find((x) => x.id === a.rule_id)!;
          if (rule.calc !== "percent" || rule.cap != null) continue;
          const bps = (rule.value as { amount: number }).amount;
          for (const al of a.lines) {
            const net = r.lines.find((l) => l.line_id === al.line_id)!.net_amount;
            expect(al.amount).toBe(percentOfCents(net, bps));
          }
        }
      }),
      { numRuns: 300 },
    );
  });

  it("the result is independent of rule order and identical for identical inputs", () => {
    fc.assert(
      fc.property(arbScenario, fc.nat(), ({ order: o, rules, context }, seed) => {
        const shuffled = [...rules].sort((a, b) => ((a.id.charCodeAt(1) * 31 + seed) % 7) - ((b.id.charCodeAt(1) * 31 + seed) % 7));
        expect(price(o, shuffled, context)).toEqual(price(o, rules, context));
        expect(price(o, rules, context)).toEqual(price(o, rules, context));
      }),
      { numRuns: 200 },
    );
  });

  it("freezing then re-pricing with the same lines reproduces the same totals", () => {
    fc.assert(
      fc.property(arbScenario, ({ order: o, rules, context }) => {
        const live = price(o, rules, context);
        const frozen = freezeFrom(live, rules);
        const again = price(o, rules, { ...context, frozen: { frozen_at: NOW, adjustments: frozen } });
        expect(again.totals).toEqual(live.totals);
        expect(again.lines).toEqual(live.lines);
      }),
      { numRuns: 200 },
    );
  });

  it("after the freeze, quantity cuts, comps, item discounts and removed lines never take a line, a total or a tax component below zero", () => {
    const comp = SG_SEED_RULES.find((r) => r.id === SEED_RULE_IDS.managerComp)!;
    const pctItem = SG_SEED_RULES.find((r) => r.id === SEED_RULE_IDS.percentOffItem)!;
    // What happens to each line between the first payment and the re-price. A line moved to a paid bill
    // is no longer given to the engine (the server prices it apart), which is the same as removing it here.
    const arbChange = fc.record({ kind: fc.constantFrom("keep", "cut", "remove", "comp", "item"), quantity: fc.integer({ min: 0, max: 5 }), bps: fc.integer({ min: 1, max: 10_000 }) });
    fc.assert(
      fc.property(arbScenario, fc.array(arbChange, { minLength: 8, maxLength: 8 }), ({ order: o, rules, context }, changes) => {
        const all = [...rules, comp, pctItem];
        const live = price(o, all, context);
        const frozen = freezeFrom(live, all);
        const lines: PricingLineInput[] = [];
        const apps: { application_id: string; rule_id: string; line_ids: string[]; entered_value?: number }[] = [];
        o.lines.forEach((l, i) => {
          const c = changes[i]!;
          if (c.kind === "remove") return;
          lines.push(c.kind === "cut" ? { ...l, quantity: Math.min(c.quantity, l.quantity) } : l);
          if (c.kind === "comp") apps.push({ application_id: `a${i}`, rule_id: comp.id, line_ids: [l.line_id] });
          if (c.kind === "item") apps.push({ application_id: `a${i}`, rule_id: pctItem.id, line_ids: [l.line_id], entered_value: Math.min(c.bps, 5000) });
        });
        const r = price({ ...o, lines, manual_applications: apps }, all, { ...context, frozen: { frozen_at: NOW, adjustments: frozen } });
        for (const l of r.lines) {
          expect(l.net_amount).toBeGreaterThanOrEqual(0);
          expect(l.total).toBeGreaterThanOrEqual(0);
          for (const t of l.taxes) expect(t.amount).toBeGreaterThanOrEqual(0);
        }
        expect(r.totals.total).toBeGreaterThanOrEqual(0);
        for (const t of r.totals.taxes) expect(t.amount).toBeGreaterThanOrEqual(0);
        // A frozen amount is at most what was stored at the freeze, line by line.
        for (const a of r.adjustments.filter((x) => x.frozen)) {
          const f = frozen.find((x) => x.rule_id === a.rule_id && x.manual_application_id === a.manual_application_id)!;
          for (const al of a.lines) expect(Math.abs(al.amount)).toBeLessThanOrEqual(Math.abs(f.lines.find((x) => x.line_id === al.line_id)!.amount));
        }
      }),
      { numRuns: 500 },
    );
  });

  it("sortRules is a total order on (priority, id)", () => {
    const s = sortRules([{ id: "b", priority: 1 }, { id: "a", priority: 1 }, { id: "z", priority: 0 }]);
    expect(s.map((r) => r.id)).toEqual(["z", "a", "b"]);
  });
});
