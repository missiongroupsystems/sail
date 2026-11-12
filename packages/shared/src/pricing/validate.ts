import { PricingRuleSchema, type PricingRule, type PricingRuleInput } from "./schemas.js";

/**
 * Pure validation over a rule set and a catalogue snapshot (scope doc 4.8,
 * "Validation flags likely mistakes"). Returns warnings; it never throws for
 * business problems, only for malformed input.
 */

export type CatalogueProduct = {
  product_id: string;
  category_id: string | null;
  parent_category_id?: string | null;
  tags: string[];
  has_deposit?: boolean;
  archived?: boolean;
};

export type RuleWarning = {
  code: "overlapping_exclusive" | "uncovered_products" | "cap_below_minimum" | "open_range_zero" | "disables_nothing" | "fee_min_spend";
  severity: "blocking" | "advisory";
  message: string;
  rule_ids: string[];
  product_ids?: string[];
};

export function validateRuleSet(rulesIn: readonly PricingRuleInput[], catalogue: readonly CatalogueProduct[] = []): RuleWarning[] {
  const rules = rulesIn.map((r) => PricingRuleSchema.parse(r));
  const warnings: RuleWarning[] = [];

  // 1. Overlapping exclusive automatic discounts whose scopes could meet on one line
  //    and whose conditions can hold at the same time.
  const exclusiveAuto = rules.filter((r) => r.kind === "discount" && r.application === "auto" && r.stacking === "exclusive");
  for (let i = 0; i < exclusiveAuto.length; i++) {
    for (let j = i + 1; j < exclusiveAuto.length; j++) {
      const a = exclusiveAuto[i]!;
      const b = exclusiveAuto[j]!;
      if (scopesMayOverlap(a, b, catalogue) && conditionsMayCoincide(a, b)) {
        warnings.push({
          code: "overlapping_exclusive",
          severity: "advisory",
          message: `"${a.name}" and "${b.name}" are both exclusive and can apply to the same lines; only the higher-priority one (${a.priority <= b.priority ? a.name : b.name}) will apply.`,
          rule_ids: [a.id, b.id],
        });
      }
    }
  }

  // 2. Products no fee covers (only meaningful when a catalogue is supplied).
  if (catalogue.length > 0) {
    const fees = rules.filter((r) => r.kind === "fee" && r.application === "auto");
    const uncovered = catalogue.filter((p) => !p.archived && !fees.some((f) => productInScope(f, p)));
    if (uncovered.length > 0 && fees.length > 0) {
      warnings.push({
        code: "uncovered_products",
        severity: "advisory",
        message: `${uncovered.length} product${uncovered.length === 1 ? "" : "s"} are covered by no fee.`,
        rule_ids: fees.map((f) => f.id),
        product_ids: uncovered.map((p) => p.product_id),
      });
    }
  }

  for (const r of rules) {
    // 3. Caps below the minimum value the rule can produce.
    if (r.cap != null) {
      const minValue = r.value.type === "fixed" ? r.value.amount : r.value.min;
      if (r.calc === "fixed_per_order" && r.cap < minValue) {
        warnings.push({ code: "cap_below_minimum", severity: "blocking", message: `"${r.name}" has a cap (${r.cap}) below its minimum value (${minValue}); the cap always wins.`, rule_ids: [r.id] });
      }
      if (r.calc === "fixed_per_unit" && r.cap < minValue) {
        warnings.push({ code: "cap_below_minimum", severity: "blocking", message: `"${r.name}" has a cap (${r.cap}) below one unit's value (${minValue}).`, rule_ids: [r.id] });
      }
    }
    if (r.value.type === "open" && r.value.min === 0 && r.value.max === 0) {
      warnings.push({ code: "open_range_zero", severity: "blocking", message: `"${r.name}" has an open value with a range of 0 to 0.`, rule_ids: [r.id] });
    }
    if (r.application === "manual" && (r.disables.rule_ids.length > 0 || r.disables.report_classes.length > 0)) {
      const targets = rules.filter((t) => r.disables.rule_ids.includes(t.id) || r.disables.report_classes.includes(t.report_class));
      if (targets.length === 0) {
        warnings.push({ code: "disables_nothing", severity: "advisory", message: `"${r.name}" switches off rules that do not exist in this set.`, rule_ids: [r.id] });
      }
    }
    if (r.kind === "fee" && r.conditions.min_spend) {
      warnings.push({ code: "fee_min_spend", severity: "advisory", message: `"${r.name}" is a fee with a minimum spend; it freezes at the first payment like an order-level discount.`, rule_ids: [r.id] });
    }
  }
  return warnings;
}

export function productInScope(rule: PricingRule, p: CatalogueProduct): boolean {
  const s = rule.scope;
  let inScope: boolean;
  switch (s.type) {
    case "all":
      inScope = true;
      break;
    case "categories":
      inScope = (p.category_id != null && s.category_ids.includes(p.category_id)) || (p.parent_category_id != null && s.category_ids.includes(p.parent_category_id));
      break;
    case "products":
      inScope = s.product_ids.includes(p.product_id);
      break;
    case "tags":
      inScope = p.tags.some((t) => s.tags.includes(t));
      break;
    case "deposit":
      inScope = p.has_deposit === true;
      break;
  }
  if (!inScope) return false;
  const x = rule.exclusions;
  if (x.product_ids.includes(p.product_id)) return false;
  if (p.category_id != null && x.category_ids.includes(p.category_id)) return false;
  if (p.parent_category_id != null && x.category_ids.includes(p.parent_category_id)) return false;
  if (p.tags.some((t) => x.tags.includes(t))) return false;
  return true;
}

function scopesMayOverlap(a: PricingRule, b: PricingRule, catalogue: readonly CatalogueProduct[]): boolean {
  if (catalogue.length > 0) return catalogue.some((p) => productInScope(a, p) && productInScope(b, p));
  // Without a catalogue, reason structurally.
  if (a.scope.type === "all" || b.scope.type === "all") return true;
  if (a.scope.type !== b.scope.type) return true; // a category and a tag could meet on one product
  switch (a.scope.type) {
    case "categories":
      return a.scope.category_ids.some((id) => (b.scope as { category_ids: string[] }).category_ids.includes(id));
    case "products":
      return a.scope.product_ids.some((id) => (b.scope as { product_ids: string[] }).product_ids.includes(id));
    case "tags":
      return a.scope.tags.some((t) => (b.scope as { tags: string[] }).tags.includes(t));
    case "deposit":
      return true;
  }
}

function conditionsMayCoincide(a: PricingRule, b: PricingRule): boolean {
  const ca = a.conditions;
  const cb = b.conditions;
  const disjoint = <T>(x?: T[], y?: T[]) => x && y && !x.some((v) => y.includes(v));
  if (disjoint(ca.order_types, cb.order_types)) return false;
  if (disjoint(ca.channels, cb.channels)) return false;
  if (disjoint(ca.outlet_ids, cb.outlet_ids)) return false;
  if (disjoint(ca.brand_ids, cb.brand_ids)) return false;
  if (ca.active_to && cb.active_from && Date.parse(ca.active_to) <= Date.parse(cb.active_from)) return false;
  if (cb.active_to && ca.active_from && Date.parse(cb.active_to) <= Date.parse(ca.active_from)) return false;
  return true;
}
