import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { freezeFrom, price, sortRules } from "./engine.js";
import type { PricingLineInput, PricingOrderInput, PricingRuleInput } from "./schemas.js";
import { SEED_RULES, SEED_RULE_IDS } from "./seed.js";
import { percentOfCents, sumCents } from "../money.js";

const NOW = "2026-11-04T12:00:00.000Z";
const ctx = (tax_mode: "inclusive" | "exclusive" = "exclusive") => ({ tax_mode, gst_bps: 900, now: NOW });

export function line(id: string, base: number, opts: Partial<PricingLineInput> = {}): PricingLineInput {
  return { line_id: id, product_id: opts.product_id ?? `prod-${id}`, quantity: 1, prices: { base }, ...opts };
}

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
const serviceCharge = SEED_RULES.find((r) => r.id === SEED_RULE_IDS.serviceCharge)!;

describe("worked example from the scope doc (4.8)", () => {
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
    expect(food.gst_on_net).toBe(540);
    expect(wine.gst_on_net).toBe(972);
    expect(food.fee_amount).toBe(600);
    expect(wine.fee_amount).toBe(1080);
    expect(food.gst_on_fees).toBe(54);
    expect(wine.gst_on_fees).toBe(97); // 97.2 → 97
    expect(r.totals.gst_total).toBe(540 + 972 + 54 + 97);
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
    const delivery: PricingRuleInput = { id: "del", kind: "fee", name: "Delivery fee", calc: "fixed_per_order", value: { type: "fixed", amount: 500 }, scope: { type: "all" }, conditions: { order_types: ["delivery"] }, priority: 90, application: "auto", gst_applicable: true, report_class: "delivery_fee" };
    const scAll: PricingRuleInput = { ...serviceCharge, id: "sc-any", conditions: {} };
    const r = price(order([line("a", 2000), line("b", 2000)], { order_type: "delivery" }), [delivery, scAll, ruleA], ctx());
    const sc = r.adjustments.find((a) => a.rule_id === "sc-any")!;
    expect(sc.total).toBe(400); // 10% of 4000, not of 4500
    expect(r.adjustments.find((a) => a.rule_id === "del")!.lines.map((l) => l.amount)).toEqual([250, 250]);
  });

  it("container deposit is per unit on BCRS products, not GST-applicable, with outlet exclusions", () => {
    const deposit = { ...SEED_RULES.find((r) => r.id === SEED_RULE_IDS.containerDeposit)!, conditions: { excluded_outlet_ids: ["outlet-9"] } };
    const o = order([line("can", 250, { is_bcrs: true, quantity: 6 }), line("plate", 1000)]);
    const r = price(o, [deposit], ctx());
    const d = r.adjustments[0]!;
    expect(d.total).toBe(60);
    expect(d.gst_total).toBe(0);
    expect(r.lines[0]!.fee_amount).toBe(60);
    expect(price({ ...o, outlet_id: "outlet-9" }, [deposit], ctx()).adjustments).toEqual([]);
  });

  it("inclusive tax mode reports the GST inside the amounts and does not add it", () => {
    const r = price(order([line("a", 1090)]), [serviceCharge], ctx("inclusive"));
    expect(r.lines[0]!.gst_on_net).toBe(90);
    expect(r.lines[0]!.fee_amount).toBe(109);
    expect(r.lines[0]!.gst_on_fees).toBe(9); // 109 × 9/109 = 9
    expect(r.totals.total).toBe(1090 + 109);
    expect(r.totals.gst_total).toBe(99);
  });

  it("exclusive tax mode adds GST per line, rounded half up", () => {
    const r = price(order([line("a", 1005), line("b", 1004)], { order_type: "takeaway" }), [], ctx());
    expect(r.lines.map((l) => l.gst_on_net)).toEqual([90, 90]); // 90.45 → 90; 90.36 → 90
    expect(r.totals.total).toBe(2009 + 180);
  });

  it("manual rules apply only when an application exists, with their entered value and lines", () => {
    const o = order([line("a", 2000), line("b", 1000)], {
      manual_applications: [{ application_id: "app-1", rule_id: SEED_RULE_IDS.percentOffItem, entered_value: 2000, line_ids: ["a"], applied_by: "staff-1" }],
    });
    const r = price(o, SEED_RULES, ctx());
    const adj = r.adjustments.find((a) => a.rule_id === SEED_RULE_IDS.percentOffItem)!;
    expect(adj.total).toBe(-400);
    expect(adj.lines).toEqual([{ line_id: "a", amount: -400, gst_amount: 0 }]);
    expect(adj.manual_application_id).toBe("app-1");
    expect(adj.applied_by).toBe("staff-1");
    const none = price(order([line("a", 2000)]), SEED_RULES, ctx());
    expect(none.adjustments.map((a) => a.rule_id)).toEqual([SEED_RULE_IDS.serviceCharge]);
  });

  it("an open value outside the range is skipped with a warning", () => {
    const o = order([line("a", 2000)], { manual_applications: [{ application_id: "app-1", rule_id: SEED_RULE_IDS.percentOffItem, entered_value: 9000 }] });
    const r = price(o, SEED_RULES, ctx());
    expect(r.adjustments.find((a) => a.rule_id === SEED_RULE_IDS.percentOffItem)).toBeUndefined();
    expect(r.warnings).toHaveLength(1);
  });

  it("the service-charge waiver switches off the service charge and is recorded as a zero adjustment", () => {
    const o = order([line("a", 2000)], { manual_applications: [{ application_id: "w", rule_id: SEED_RULE_IDS.serviceChargeWaiver, reason: "kitchen 40 min late", applied_by: "m1" }] });
    const r = price(o, SEED_RULES, ctx());
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
    const r = price(o, SEED_RULES, ctx());
    expect(r.adjustments.find((a) => a.rule_id === SEED_RULE_IDS.managerComp)!.total).toBe(-2000);
    expect(r.adjustments.find((a) => a.rule_id === SEED_RULE_IDS.percentOffItem)!.lines).toEqual([{ line_id: "b", amount: -100, gst_amount: 0 }]);
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
    tag: fc.constantFrom("alcohol", "promo", "bcrs", null),
    bcrs: fc.boolean(),
    mods: fc.array(fc.integer({ min: 0, max: 500 }), { maxLength: 3 }),
  }).map(
    (l): PricingLineInput => ({
      line_id: `L${i}`,
      product_id: `P${i % 7}`,
      category_id: l.category,
      tags: l.tag ? [l.tag] : [],
      is_bcrs: l.bcrs,
      quantity: l.quantity,
      prices: { base: l.base },
      modifiers: l.mods.map((p, k) => ({ modifier_id: `M${i}-${k}`, product_id: `PM${k}`, quantity: 1, price: p })),
    }),
  );

type Scope = PricingRuleInput["scope"];
const arbScope: fc.Arbitrary<Scope> = fc.oneof(
  fc.constant<Scope>({ type: "all" }),
  fc.constantFrom("food", "drink", "alcohol").map((c): Scope => ({ type: "categories", category_ids: [c] })),
  fc.constantFrom("alcohol", "promo", "bcrs").map((t): Scope => ({ type: "tags", tags: [t] })),
  fc.constant<Scope>({ type: "bcrs" }),
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
      gst: fc.boolean(),
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
        gst_applicable: r.gst,
        report_class: r.kind === "fee" ? "service_charge" : "promo",
        conditions: r.minSpend != null ? { min_spend: { amount: r.minSpend, basis: "order" } } : {},
      };
    });

const arbScenario = fc
  .record({
    lines: fc.integer({ min: 1, max: 8 }).chain((n) => fc.tuple(...Array.from({ length: n }, (_, i) => arbLine(i)))),
    rules: fc.integer({ min: 0, max: 8 }).chain((n) => fc.tuple(...Array.from({ length: n }, (_, i) => arbRule(i)))),
    taxMode: fc.constantFrom("inclusive", "exclusive"),
    orderType: fc.constantFrom("dine_in", "takeaway", "pickup", "delivery"),
  })
  .map((s) => ({
    order: order([...s.lines], { order_type: s.orderType }),
    rules: [...s.rules] as PricingRuleInput[],
    context: ctx(s.taxMode),
  }));

describe("properties", () => {
  it("every adjustment's line amounts sum to its total; caps are never exceeded; nets never go below zero; line totals sum to the order total", () => {
    fc.assert(
      fc.property(arbScenario, ({ order: o, rules, context }) => {
        const r = price(o, rules, context);
        for (const a of r.adjustments) {
          expect(sumCents(a.lines.map((l) => l.amount))).toBe(a.total);
          expect(sumCents(a.lines.map((l) => l.gst_amount))).toBe(a.gst_total);
          const rule = rules.find((x) => x.id === a.rule_id)!;
          if (rule.cap != null) expect(Math.abs(a.total)).toBeLessThanOrEqual(rule.cap);
          if (a.kind === "discount") expect(a.total).toBeLessThanOrEqual(0);
          else expect(a.total).toBeGreaterThanOrEqual(0);
          if (a.kind === "discount") for (const l of a.lines) expect(l.gst_amount).toBe(0);
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
        else expect(r.totals.total).toBe(r.totals.net_subtotal + r.totals.fee_total + r.totals.gst_total);
      }),
      { numRuns: 400 },
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

  it("sortRules is a total order on (priority, id)", () => {
    const s = sortRules([{ id: "b", priority: 1 }, { id: "a", priority: 1 }, { id: "z", priority: 0 }]);
    expect(s.map((r) => r.id)).toEqual(["z", "a", "b"]);
  });
});
