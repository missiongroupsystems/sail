import { allocateLargestRemainder, percentOfCents, sumCents, type Cents } from "../money.js";
import type { OrderType } from "../domain.js";
import {
  PricingContextSchema,
  PricingOrderSchema,
  PricingRuleSchema,
  ruleLevel,
  type Adjustment,
  type FrozenAdjustment,
  type ManualApplication,
  type PricedLine,
  type PricingContext,
  type PricingContextInput,
  type PricingLine,
  type PricingOrder,
  type PricingOrderInput,
  type PricingResult,
  type PricingRule,
  type PricingRuleInput,
  type TaxBreakdown,
  type TaxComponent,
  type TaxRate,
  type TraceStep,
} from "./schemas.js";

/**
 * The pricing pipeline: one pure function shared by the server,
 * the POS preview, the back-office simulator and refunds.
 *
 *   price(order, rules, context) → adjustments, per-line amounts, totals, trace
 *
 * It performs no I/O and reads no clock: the evaluation time is `context.now`.
 * Every amount is an integer number of minor units. Rounding uses the
 * largest-remainder method per rule, so each rule's line amounts add up to its
 * total; tax is rounded per line or once per rate (`context.tax_rounding`).
 * See docs/pricing-semantics.md for every interpretation decision.
 */
export function price(orderIn: PricingOrderInput, rulesIn: readonly PricingRuleInput[], contextIn: PricingContextInput): PricingResult {
  const order = PricingOrderSchema.parse(orderIn);
  const context = PricingContextSchema.parse(contextIn);
  const rules = sortRules(rulesIn.map((r) => PricingRuleSchema.parse(r)));
  assertUniqueLineIds(order.lines);

  const warnings: string[] = [];
  const trace: TraceStep[] = [];
  const nowMs = Date.parse(context.now);

  /* ---- Step 1: base prices --------------------------------------------- */
  const states: LineState[] = order.lines.map((line) => {
    const unit = line.open_price ?? line.prices.by_order_type?.[order.order_type] ?? line.prices.base;
    const mods = sumCents(line.modifiers.map((m) => m.price * m.quantity));
    const base = (unit + mods) * line.quantity;
    return {
      line,
      unitPrice: unit,
      modifiersPerUnit: mods,
      base,
      running: base,
      blocked: false,
      discount: 0,
      fee: 0,
    };
  });
  trace.push({
    step: 1,
    title: "Base prices",
    entries: states.map((s) => ({
      outcome: "info",
      detail: `${s.line.name ?? s.line.line_id}: (${s.unitPrice} + ${s.modifiersPerUnit} modifiers) × ${s.line.quantity}${
        s.line.open_price != null ? " (open price)" : s.line.prices.by_order_type?.[order.order_type] != null ? ` (${order.order_type} price)` : ""
      }`,
      amount: s.base,
    })),
  });

  const byId = new Map(rules.map((r) => [r.id, r]));
  const manualApps = sortApplications(order.manual_applications);
  const appsByRule = new Map<string, ManualApplication[]>();
  for (const app of manualApps) {
    const rule = byId.get(app.rule_id);
    if (!rule) {
      warnings.push(`manual application ${app.application_id} references unknown rule ${app.rule_id}`);
      continue;
    }
    if (rule.application !== "manual") {
      warnings.push(`manual application ${app.application_id} references automatic rule ${rule.id}; ignored`);
      continue;
    }
    const list = appsByRule.get(rule.id) ?? [];
    list.push(app);
    appsByRule.set(rule.id, list);
  }

  // Rules switched off for this order by an applied manual rule.
  const disabledRuleIds = new Set<string>();
  const disabledClasses = new Set<string>();
  for (const ruleId of appsByRule.keys()) {
    const rule = byId.get(ruleId)!;
    for (const id of rule.disables.rule_ids) disabledRuleIds.add(id);
    for (const c of rule.disables.report_classes) disabledClasses.add(c);
  }

  const frozen = context.frozen;
  const frozenByKey = new Map<string, FrozenAdjustment>();
  if (frozen) for (const f of frozen.adjustments) frozenByKey.set(frozenKey(f.rule_id, f.rule_version, f.manual_application_id), f);

  const adjustments: Adjustment[] = [];

  const evalRule = (rule: PricingRule, stepEntries: TraceStep["entries"]) => {
    if (rule.kind === "fee" && (disabledRuleIds.has(rule.id) || disabledClasses.has(rule.report_class))) {
      stepEntries.push({ rule_id: rule.id, rule_name: rule.name, outcome: "skipped", detail: "switched off for this order by a manual rule" });
      return;
    }
    if (rule.kind === "discount" && disabledRuleIds.has(rule.id)) {
      stepEntries.push({ rule_id: rule.id, rule_name: rule.name, outcome: "skipped", detail: "switched off for this order by a manual rule" });
      return;
    }
    const freezable = isFreezable(rule);
    const applications: (ManualApplication | null)[] = rule.application === "manual" ? (appsByRule.get(rule.id) ?? []) : [null];
    if (rule.application === "manual" && applications.length === 0) {
      stepEntries.push({ rule_id: rule.id, rule_name: rule.name, outcome: "skipped", detail: "manual rule not applied" });
      return;
    }
    for (const app of applications) {
      if (frozen && freezable) {
        const f = frozenByKey.get(frozenKey(rule.id, rule.version, app?.application_id ?? null));
        if (!f) {
          stepEntries.push({ rule_id: rule.id, rule_name: rule.name, outcome: "skipped", detail: "frozen at first payment: was not applied then" });
          continue;
        }
        const adj = applyFrozen(rule, app, f, states);
        adjustments.push(adj);
        stepEntries.push({ rule_id: rule.id, rule_name: rule.name, outcome: "frozen", detail: "frozen at first payment", amount: adj.total });
        continue;
      }
      const cond = conditionsHold(rule, order, states, nowMs);
      if (!cond.ok) {
        stepEntries.push({ rule_id: rule.id, rule_name: rule.name, outcome: "skipped", detail: cond.reason });
        continue;
      }
      const value = resolveValue(rule, app);
      if (value === null) {
        const msg = `entered value for ${rule.name} is missing or outside its range`;
        warnings.push(msg);
        stepEntries.push({ rule_id: rule.id, rule_name: rule.name, outcome: "skipped", detail: msg });
        continue;
      }
      const eligible = states.filter((s) => s.line.quantity > 0 && inScope(rule, s.line) && !excluded(rule, s.line) && (!app?.line_ids || app.line_ids.includes(s.line.line_id)));
      const discountEligible = rule.kind === "discount" ? eligible.filter((s) => !s.blocked) : eligible;
      if (discountEligible.length === 0) {
        stepEntries.push({ rule_id: rule.id, rule_name: rule.name, outcome: "skipped", detail: eligible.length === 0 ? "no lines in scope" : "every line in scope is blocked by an exclusive rule" });
        if (app) adjustments.push(emptyAdjustment(rule, app));
        continue;
      }
      const { amounts, capped } = computeAmounts(rule, value, discountEligible);
      const total = sumCents(amounts);
      if (total === 0 && !app) {
        stepEntries.push({ rule_id: rule.id, rule_name: rule.name, outcome: "skipped", detail: "amount is zero" });
        continue;
      }
      const adj = buildAdjustment(rule, app, discountEligible, amounts, capped, false);
      applyToStates(rule, discountEligible, amounts);
      adjustments.push(adj);
      stepEntries.push({
        rule_id: rule.id,
        rule_name: rule.name,
        outcome: "applied",
        detail: `${describeValue(rule, value)} on ${discountEligible.length} line${discountEligible.length === 1 ? "" : "s"}${capped ? ` (capped at ${rule.cap})` : ""}${
          rule.stacking === "exclusive" && rule.kind === "discount" ? "; exclusive" : ""
        }`,
        amount: adj.total,
      });
    }
  };

  /* ---- Step 2: line-level discounts ------------------------------------ */
  const s2: TraceStep = { step: 2, title: "Line-level discounts", entries: [] };
  for (const rule of rules) if (rule.kind === "discount" && ruleLevel(rule) === "line") evalRule(rule, s2.entries);
  trace.push(s2);

  /* ---- Step 3: order-level discounts ----------------------------------- */
  const s3: TraceStep = { step: 3, title: "Order-level discounts", entries: [] };
  for (const rule of rules) if (rule.kind === "discount" && ruleLevel(rule) === "order") evalRule(rule, s3.entries);
  trace.push(s3);

  /* ---- Step 4: fees ------------------------------------------------------ */
  const s4: TraceStep = { step: 4, title: "Fees (never compounding)", entries: [] };
  for (const rule of rules) if (rule.kind === "fee") evalRule(rule, s4.entries);
  trace.push(s4);

  /* ---- Step 5: tax -------------------------------------------------------- */
  const tax = computeTax(order, states, adjustments, context);
  const lines: PricedLine[] = states.map((s, i) => {
    const t = tax.lines[i]!;
    const total = context.tax_mode === "exclusive" ? s.running + s.fee + t.onNet + t.onFees : s.running + s.fee;
    return {
      line_id: s.line.line_id,
      quantity: s.line.quantity,
      unit_price: s.unitPrice,
      modifiers_per_unit: s.modifiersPerUnit,
      base_amount: s.base,
      discount_amount: s.discount,
      net_amount: s.running,
      fee_amount: s.fee,
      tax_on_net: t.onNet,
      tax_on_fees: t.onFees,
      taxes: t.taxes,
      total,
    };
  });
  trace.push({
    step: 5,
    title: `Tax (${context.tax_mode}, rounded ${context.tax_rounding === "per_line" ? "per line" : "once per rate"})`,
    entries: [
      ...lines.map((l) => ({ outcome: "info" as const, detail: `${l.line_id}: on net ${l.net_amount} → ${l.tax_on_net}; on fees ${l.fee_amount} → ${l.tax_on_fees}`, amount: l.tax_on_net + l.tax_on_fees })),
      ...tax.breakdown.map((b) => ({ outcome: "info" as const, detail: `${b.name}: ${b.bps / 100}% on ${b.taxable}`, amount: b.amount })),
    ],
  });

  const subtotal = sumCents(lines.map((l) => l.base_amount));
  const discountTotal = sumCents(lines.map((l) => l.discount_amount));
  const netSubtotal = sumCents(lines.map((l) => l.net_amount));
  const feeTotal = sumCents(lines.map((l) => l.fee_amount));
  const taxTotal = sumCents(lines.map((l) => l.tax_on_net + l.tax_on_fees));
  const total = sumCents(lines.map((l) => l.total));

  trace.push({
    step: 6,
    title: "Caps and rounding",
    entries: [{ outcome: "info", detail: "caps were applied inside each rule and spread back across its lines; every rule's line amounts add up to its total (largest remainder)" }],
  });

  return {
    lines,
    adjustments,
    totals: { tax_mode: context.tax_mode, subtotal, discount_total: discountTotal, net_subtotal: netSubtotal, fee_total: feeTotal, tax_total: taxTotal, taxes: tax.breakdown, total },
    trace,
    warnings,
    pricing_status: frozen ? "frozen" : "live",
  };
}

/* ====================================================================== */

type LineState = {
  line: PricingLine;
  unitPrice: Cents;
  modifiersPerUnit: Cents;
  base: Cents;
  running: Cents;
  blocked: boolean;
  discount: Cents;
  fee: Cents;
};

export function sortRules<T extends { priority: number; id: string }>(rules: readonly T[]): T[] {
  return [...rules].sort((a, b) => a.priority - b.priority || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function sortApplications(apps: readonly ManualApplication[]): ManualApplication[] {
  return [...apps].sort((a, b) => (a.application_id < b.application_id ? -1 : a.application_id > b.application_id ? 1 : 0));
}

function assertUniqueLineIds(lines: readonly PricingLine[]) {
  const seen = new Set<string>();
  for (const l of lines) {
    if (seen.has(l.line_id)) throw new RangeError(`duplicate line_id ${l.line_id}`);
    seen.add(l.line_id);
  }
}

function frozenKey(ruleId: string, version: number, appId: string | null): string {
  return `${ruleId}@${version}|${appId ?? ""}`;
}

/**
 * Rules whose result depends on the whole order freeze at the first payment:
 * order-level discounts, any rule with a minimum-spend condition, and
 * fixed-per-order fees (a per-order amount spread across lines would otherwise
 * move onto paid lines when a line is added later).
 */
export function isFreezable(rule: PricingRule): boolean {
  return ruleLevel(rule) === "order" || rule.conditions.min_spend != null || (rule.kind === "fee" && rule.calc === "fixed_per_order");
}

export function inScope(rule: PricingRule, line: PricingLine): boolean {
  const s = rule.scope;
  switch (s.type) {
    case "all":
      return true;
    case "categories":
      return (line.category_id != null && s.category_ids.includes(line.category_id)) || (line.parent_category_id != null && s.category_ids.includes(line.parent_category_id));
    case "products":
      return s.product_ids.includes(line.product_id);
    case "tags":
      return line.tags.some((t) => s.tags.includes(t));
    case "deposit":
      return line.has_deposit;
  }
}

export function excluded(rule: PricingRule, line: PricingLine): boolean {
  const x = rule.exclusions;
  if (x.product_ids.includes(line.product_id)) return true;
  if (line.category_id != null && x.category_ids.includes(line.category_id)) return true;
  if (line.parent_category_id != null && x.category_ids.includes(line.parent_category_id)) return true;
  if (line.tags.some((t) => x.tags.includes(t))) return true;
  return false;
}

export function conditionsHold(rule: PricingRule, order: PricingOrder, states: readonly LineState[], nowMs: number): { ok: true } | { ok: false; reason: string } {
  const c = rule.conditions;
  if (c.order_types && !c.order_types.includes(order.order_type)) return { ok: false, reason: `order type ${order.order_type} not in [${c.order_types.join(", ")}]` };
  if (c.channels && !c.channels.includes(order.channel)) return { ok: false, reason: `channel ${order.channel} not in [${c.channels.join(", ")}]` };
  if (c.outlet_ids && !c.outlet_ids.includes(order.outlet_id)) return { ok: false, reason: "outlet not in the rule's outlets" };
  if (c.excluded_outlet_ids && c.excluded_outlet_ids.includes(order.outlet_id)) return { ok: false, reason: "outlet is excluded" };
  if (c.brand_ids && !c.brand_ids.includes(order.brand_id)) return { ok: false, reason: "brand not in the rule's brands" };
  if (c.active_from && nowMs < Date.parse(c.active_from)) return { ok: false, reason: `not active until ${c.active_from}` };
  if (c.active_to && nowMs >= Date.parse(c.active_to)) return { ok: false, reason: `no longer active after ${c.active_to}` };
  if (c.customer_group_ids && c.customer_group_ids.length > 0) {
    if (!order.customer_group_ids.some((g) => c.customer_group_ids!.includes(g))) return { ok: false, reason: "customer is not in a qualifying group" };
  }
  if (c.min_spend) {
    // Minimum spend is measured on UNDISCOUNTED base amounts (see semantics note).
    const basis = c.min_spend.basis === "order" ? states.filter((s) => s.line.quantity > 0) : states.filter((s) => s.line.quantity > 0 && inScope(rule, s.line) && !excluded(rule, s.line));
    const spend = sumCents(basis.map((s) => s.base));
    if (spend < c.min_spend.amount) return { ok: false, reason: `minimum spend ${c.min_spend.amount} (${c.min_spend.basis}) not met: ${spend}` };
  }
  return { ok: true };
}

/** Returns bps for percent rules, cents otherwise; null when an open value is missing or out of range. */
export function resolveValue(rule: PricingRule, app: ManualApplication | null): number | null {
  if (rule.value.type === "fixed") return rule.value.amount;
  const v = app?.entered_value;
  if (v == null) return null;
  if (v < rule.value.min || v > rule.value.max) return null;
  return v;
}

function describeValue(rule: PricingRule, value: number): string {
  if (rule.calc === "percent") return `${value / 100}%`;
  if (rule.calc === "fixed_per_unit") return `${value} per unit`;
  return `${value} per order`;
}

/** Per-line magnitudes (always >= 0) for the rule, after its cap. */
function computeAmounts(rule: PricingRule, value: number, eligible: readonly LineState[]): { amounts: Cents[]; capped: boolean } {
  let amounts: Cents[];
  const level = ruleLevel(rule);
  if (rule.kind === "discount" && level === "order") {
    const pool = sumCents(eligible.map((s) => s.running));
    const total = rule.calc === "percent" ? percentOfCents(pool, value) : Math.min(value, pool);
    amounts = allocateLargestRemainder(total, eligible.map((s) => s.running));
  } else if (rule.calc === "percent") {
    amounts = eligible.map((s) => percentOfCents(s.running, value));
  } else if (rule.calc === "fixed_per_unit") {
    amounts = eligible.map((s) => (rule.kind === "discount" ? Math.min(value * s.line.quantity, s.running) : value * s.line.quantity));
  } else {
    // fixed_per_order fee: spread by discounted amounts (even if all are zero).
    amounts = allocateLargestRemainder(value, eligible.map((s) => s.running));
  }
  let capped = false;
  const total = sumCents(amounts);
  if (rule.cap != null && total > rule.cap) {
    amounts = allocateLargestRemainder(rule.cap, amounts);
    capped = true;
  }
  return { amounts, capped };
}

/**
 * The rate for a tax class at this outlet and order type. The most specific
 * match wins: outlet and order type, then outlet, then order type, then the
 * class's default (neither). Throws when the class has no rate at all, because
 * the caller must pass every class its lines and fees use.
 */
export function resolveTaxRate(rates: readonly TaxRate[], taxClassId: string, outletId: string, orderType: OrderType): TaxRate {
  let best: TaxRate | undefined;
  let bestScore = -1;
  for (const r of rates) {
    if (r.tax_class_id !== taxClassId) continue;
    if (r.outlet_id != null && r.outlet_id !== outletId) continue;
    if (r.order_type != null && r.order_type !== orderType) continue;
    const score = (r.outlet_id != null ? 2 : 0) + (r.order_type != null ? 1 : 0);
    if (score > bestScore) {
      best = r;
      bestScore = score;
    }
  }
  if (!best) throw new RangeError(`no tax rate for tax class ${taxClassId} at outlet ${outletId} (${orderType})`);
  return best;
}

/**
 * Tax on an amount at a rate, by component. The rate is rounded once, half up,
 * at its combined bps (exclusive: a share of the amount; inclusive: the part of
 * a tax-inclusive amount), then split across the components by largest
 * remainder weighted by their bps, so a two-part rate never rounds twice.
 */
function rateTax(amount: Cents, components: readonly TaxComponent[], context: PricingContext): Cents[] {
  const combined = sumCents(components.map((c) => c.bps));
  if (combined === 0) return components.map(() => 0);
  let total: Cents;
  if (context.tax_mode === "exclusive") total = percentOfCents(amount, combined);
  else {
    const sign = amount < 0 ? -1 : 1;
    const num = Math.abs(amount) * combined;
    const den = 10_000 + combined;
    const q = Math.floor(num / den);
    const r = num - q * den;
    total = sign * (r * 2 >= den ? q + 1 : q);
  }
  return components.length === 1 ? [total] : allocateLargestRemainder(total, components.map((c) => c.bps));
}

/** One amount that carries tax: a line's net amount, or one fee's amount on one line. */
type TaxItem = { lineIndex: number; adjLine: Adjustment["lines"][number] | null; amount: Cents; components: TaxComponent[]; taxes: Cents[] };

const componentKey = (c: TaxComponent) => `${c.bps}|${c.name}`;

/**
 * Step 5. Every taxed amount is an item with its resolved rate. In `per_line`
 * mode each item's tax is rounded on its own. In `per_rate` mode the items are
 * grouped by their rate (the same list of components), the rate is rounded
 * once on the group's total, and each component is spread back across the
 * items by largest remainder.
 * Fee adjustment lines receive their tax here.
 */
function computeTax(order: PricingOrder, states: readonly LineState[], adjustments: Adjustment[], context: PricingContext) {
  const rate = (classId: string) => resolveTaxRate(context.tax_rates, classId, order.outlet_id, order.order_type).components;
  const lineIndex = new Map(states.map((s, i) => [s.line.line_id, i]));
  const items: TaxItem[] = states.map((s, i) => ({ lineIndex: i, adjLine: null, amount: s.running, components: rate(s.line.tax_class_id), taxes: [] }));
  for (const adj of adjustments) {
    if (adj.kind !== "fee" || adj.tax_class_id == null) continue;
    const components = rate(adj.tax_class_id);
    for (const l of adj.lines) items.push({ lineIndex: lineIndex.get(l.line_id)!, adjLine: l, amount: l.amount, components, taxes: [] });
  }

  if (context.tax_rounding === "per_line") {
    for (const item of items) item.taxes = rateTax(item.amount, item.components, context);
  } else {
    const groups = new Map<string, TaxItem[]>();
    for (const item of items) {
      const key = item.components.map(componentKey).join("+");
      const g = groups.get(key) ?? [];
      g.push(item);
      groups.set(key, g);
    }
    for (const group of groups.values()) {
      const base = sumCents(group.map((i) => i.amount));
      const weights = group.map((i) => i.amount);
      const perComponent = rateTax(base, group[0]!.components, context).map((t) => allocateLargestRemainder(t, weights));
      group.forEach((item, k) => (item.taxes = perComponent.map((parts) => parts[k]!)));
    }
  }

  const lines = states.map(() => ({ onNet: 0, onFees: 0, byKey: new Map<string, TaxBreakdown>() }));
  for (const item of items) {
    const itemTax = sumCents(item.taxes);
    const t = lines[item.lineIndex]!;
    if (item.adjLine) {
      item.adjLine.tax_amount = itemTax;
      t.onFees += itemTax;
    } else {
      t.onNet += itemTax;
    }
    const taxable = context.tax_mode === "exclusive" ? item.amount : item.amount - itemTax;
    item.components.forEach((c, k) => {
      const key = componentKey(c);
      const onLine = t.byKey.get(key) ?? { name: c.name, bps: c.bps, taxable: 0, amount: 0 };
      onLine.amount += item.taxes[k]!;
      onLine.taxable += taxable;
      t.byKey.set(key, onLine);
    });
  }
  for (const adj of adjustments) adj.tax_total = sumCents(adj.lines.map((l) => l.tax_amount));
  const perLine = lines.map((l) => ({ onNet: l.onNet, onFees: l.onFees, taxes: [...l.byKey.values()] }));
  return { lines: perLine, breakdown: sumTaxBreakdowns(perLine.map((l) => l.taxes)) };
}

/** Add tax breakdowns up by component (name and rate), in first-seen order: the order's breakdown is the sum of its lines'. */
export function sumTaxBreakdowns(lists: readonly (readonly TaxBreakdown[])[]): TaxBreakdown[] {
  const byKey = new Map<string, TaxBreakdown>();
  for (const list of lists) {
    for (const t of list) {
      const key = componentKey(t);
      const cur = byKey.get(key) ?? { name: t.name, bps: t.bps, taxable: 0, amount: 0 };
      cur.taxable += t.taxable;
      cur.amount += t.amount;
      byKey.set(key, cur);
    }
  }
  return [...byKey.values()];
}

/** Tax on fee lines is filled in by step 5 (`computeTax`); until then it is 0. */
function buildAdjustment(rule: PricingRule, app: ManualApplication | null, eligible: readonly LineState[], magnitudes: readonly Cents[], capped: boolean, frozen: boolean): Adjustment {
  const sign = rule.kind === "discount" ? -1 : 1;
  const lines = eligible.map((s, i) => {
    const amount = sign * magnitudes[i]! || 0; // `|| 0` normalises -0 to 0
    return { line_id: s.line.line_id, amount, tax_amount: 0 };
  });
  return {
    rule_id: rule.id,
    rule_version: rule.version,
    rule_name: rule.name,
    kind: rule.kind,
    level: ruleLevel(rule),
    report_class: rule.report_class,
    tax_class_id: rule.kind === "fee" ? (rule.tax_class_id ?? null) : null,
    total: sumCents(lines.map((l) => l.amount)),
    tax_total: 0,
    lines,
    capped,
    frozen,
    manual_application_id: app?.application_id ?? null,
    entered_value: app?.entered_value ?? null,
    applied_by: app?.applied_by ?? null,
    approved_by: app?.approved_by ?? null,
    override_id: app?.override_id ?? null,
    reason: app?.reason ?? null,
    rule_snapshot: rule,
  };
}

function emptyAdjustment(rule: PricingRule, app: ManualApplication): Adjustment {
  return {
    rule_id: rule.id,
    rule_version: rule.version,
    rule_name: rule.name,
    kind: rule.kind,
    level: ruleLevel(rule),
    report_class: rule.report_class,
    tax_class_id: rule.kind === "fee" ? (rule.tax_class_id ?? null) : null,
    total: 0,
    tax_total: 0,
    lines: [],
    capped: false,
    frozen: false,
    manual_application_id: app.application_id,
    entered_value: app.entered_value,
    applied_by: app.applied_by,
    approved_by: app.approved_by,
    override_id: app.override_id,
    reason: app.reason,
    rule_snapshot: rule,
  };
}

function applyToStates(rule: PricingRule, eligible: readonly LineState[], magnitudes: readonly Cents[]) {
  eligible.forEach((s, i) => {
    const m = magnitudes[i]!;
    if (rule.kind === "discount") {
      s.running -= m;
      s.discount -= m;
      if (rule.stacking === "exclusive") s.blocked = true;
    } else {
      s.fee += m;
    }
  });
}

/**
 * Re-emit a frozen adjustment with its stored per-line amounts. A frozen
 * discount takes at most what the line is now worth: a line cut in quantity or
 * discounted since the freeze keeps its share only up to its running amount,
 * so no line goes below zero, and a line an exclusive discount has taken since
 * the freeze gets none of it (exclusive blocks every later discount, frozen or not).
 */
function applyFrozen(rule: PricingRule, app: ManualApplication | null, f: FrozenAdjustment, states: LineState[]): Adjustment {
  const byLine = new Map(states.map((s) => [s.line.line_id, s]));
  const present = f.lines.filter((l) => byLine.has(l.line_id));
  const eligible = present.map((l) => byLine.get(l.line_id)!);
  const magnitudes = present.map((l, i) => (rule.kind !== "discount" ? Math.abs(l.amount) : eligible[i]!.blocked ? 0 : Math.min(Math.abs(l.amount), eligible[i]!.running)));
  const adj = buildAdjustment(rule, app, eligible, magnitudes, false, true);
  applyToStates(rule, eligible, magnitudes);
  return adj;
}

/** Extract the frozen set from a live result, to store at the first payment. */
export function freezeFrom(result: PricingResult, rules: readonly PricingRuleInput[]): FrozenAdjustment[] {
  const parsed = new Map(rules.map((r) => PricingRuleSchema.parse(r)).map((r) => [r.id, r]));
  return result.adjustments
    .filter((a) => {
      const rule = parsed.get(a.rule_id);
      return rule ? isFreezable(rule) : a.level === "order";
    })
    .map((a) => ({ rule_id: a.rule_id, rule_version: a.rule_version, manual_application_id: a.manual_application_id, lines: a.lines.map((l) => ({ line_id: l.line_id, amount: l.amount })) }));
}

/** Validate a manual application against its rule before accepting it (the server calls this; the engine only warns). */
export function validateManualApplication(rule: PricingRuleInput, app: { entered_value?: number | null; line_ids?: string[] | null }): { ok: true } | { ok: false; message: string; remedy: string } {
  const r = PricingRuleSchema.parse(rule);
  if (r.application !== "manual") return { ok: false, message: `${r.name} is an automatic rule`, remedy: "Automatic rules apply on their own when their conditions hold." };
  if (r.value.type === "open") {
    if (app.entered_value == null) return { ok: false, message: `${r.name} needs a value`, remedy: `Enter a value between ${r.value.min} and ${r.value.max}.` };
    if (app.entered_value < r.value.min || app.entered_value > r.value.max)
      return { ok: false, message: `value ${app.entered_value} is outside the allowed range`, remedy: `Enter a value between ${r.value.min} and ${r.value.max}.` };
  } else if (app.entered_value != null && app.entered_value !== r.value.amount) {
    return { ok: false, message: `${r.name} has a fixed value`, remedy: "Leave the value empty." };
  }
  if (app.line_ids && app.line_ids.length === 0) return { ok: false, message: "line_ids must not be empty", remedy: "Pass the lines to discount, or omit line_ids." };
  return { ok: true };
}
