import { z } from "zod";
import type { PricingRuleVersion } from "@/lib/api/types";

/**
 * The rule editor's form shape, one field per PricingRuleSchema field
 * (packages/shared/src/pricing/schemas.ts), flattened so react-hook-form can
 * address each one. `toBody` rebuilds the nested rule the register validates.
 */

export const NONE = "__none__";
const cents = z.number().int().min(0, "Cannot be negative");
const KEY_RE = /^[a-z0-9:_-]+$/i;

export const RuleFormSchema = z
  .object({
    rule_key: z.string().trim().min(1, "Enter a key").max(80).regex(KEY_RE, "Letters, digits, : _ and - only"),
    name: z.string().trim().min(1, "Enter a name").max(80, "Up to 80 characters"),
    kind: z.enum(["fee", "discount"]),
    calc: z.enum(["percent", "fixed_per_order", "fixed_per_unit"]),
    value_type: z.enum(["fixed", "open"]),
    amount: cents.nullable(),
    min: cents.nullable(),
    max: cents.nullable(),
    level: z.enum(["line", "order"]),
    scope_type: z.enum(["all", "categories", "products", "tags", "deposit"]),
    scope_category_ids: z.array(z.string()),
    scope_product_ids: z.array(z.string()),
    scope_tags: z.array(z.string()),
    excl_product_ids: z.array(z.string()),
    excl_category_ids: z.array(z.string()),
    excl_tags: z.array(z.string()),
    cond_order_types: z.array(z.string()),
    cond_channels: z.array(z.string()),
    cond_outlet_ids: z.array(z.string()),
    cond_excluded_outlet_ids: z.array(z.string()),
    cond_brand_ids: z.array(z.string()),
    cond_customer_group_ids: z.array(z.string()),
    min_spend_amount: cents.nullable(),
    min_spend_basis: z.enum(["scoped", "order"]),
    active_from: z.string(),
    active_to: z.string(),
    cap: cents.nullable(),
    priority: z.string().regex(/^-?\d+$/, "A whole number; lower runs first"),
    stacking: z.enum(["exclusive", "stackable"]),
    application: z.enum(["auto", "manual"]),
    min_role: z.string(),
    override_allowed: z.boolean(),
    reason_required: z.boolean(),
    /** Fees: a class id, or NONE for an untaxed fee; "" until chosen. Discounts carry none. */
    tax_class_id: z.string(),
    report_class: z.enum(["service_charge", "deposit", "delivery_fee", "packaging_fee", "promo", "comp", "staff_meal", "ent", "other"]),
    disables_rule_ids: z.array(z.string()),
    disables_report_classes: z.array(z.string()),
    effective: z.enum(["now", "at"]),
    effective_at: z.string(),
    note: z.string(),
  })
  .superRefine((v, ctx) => {
    if (v.value_type === "fixed") {
      if (v.amount === null) ctx.addIssue({ code: "custom", path: ["amount"], message: v.calc === "percent" ? "Enter a percentage" : "Enter an amount" });
      if (v.calc === "percent" && (v.amount ?? 0) > 10_000) ctx.addIssue({ code: "custom", path: ["amount"], message: "At most 100%" });
    } else {
      if (v.min === null) ctx.addIssue({ code: "custom", path: ["min"], message: "Enter the minimum" });
      if (v.max === null) ctx.addIssue({ code: "custom", path: ["max"], message: "Enter the maximum" });
      if (v.min !== null && v.max !== null && v.min > v.max) ctx.addIssue({ code: "custom", path: ["max"], message: "The maximum cannot be below the minimum" });
      if (v.calc === "percent" && (v.max ?? 0) > 10_000) ctx.addIssue({ code: "custom", path: ["max"], message: "At most 100%" });
    }
    if (v.kind === "discount" && v.calc === "fixed_per_order" && v.level !== "order") ctx.addIssue({ code: "custom", path: ["level"], message: "A fixed amount per order is spread across the order" });
    if (v.kind === "discount" && v.calc === "fixed_per_unit" && v.level !== "line") ctx.addIssue({ code: "custom", path: ["level"], message: "A fixed amount per unit applies to each line" });
    if (v.kind === "fee" && v.tax_class_id === "") ctx.addIssue({ code: "custom", path: ["tax_class_id"], message: "Choose a tax class, or Not taxed" });
    if (v.application === "manual" && v.min_role === NONE) ctx.addIssue({ code: "custom", path: ["min_role"], message: "Choose who may apply it" });
    if (v.scope_type === "categories" && v.scope_category_ids.length === 0) ctx.addIssue({ code: "custom", path: ["scope_category_ids"], message: "Choose at least one category" });
    if (v.scope_type === "products" && v.scope_product_ids.length === 0) ctx.addIssue({ code: "custom", path: ["scope_product_ids"], message: "Add at least one product" });
    if (v.scope_type === "tags" && v.scope_tags.length === 0) ctx.addIssue({ code: "custom", path: ["scope_tags"], message: "Add at least one tag" });
    if (v.effective === "at" && !v.effective_at) ctx.addIssue({ code: "custom", path: ["effective_at"], message: "Choose when the version takes effect" });
  });
export type RuleForm = z.infer<typeof RuleFormSchema>;

/** The rule as stored in a version's `body` (PricingRule). Typed loosely here; the register validates. */
export type RuleBody = {
  id?: string;
  version?: number;
  kind: "fee" | "discount";
  name: string;
  calc: "percent" | "fixed_per_order" | "fixed_per_unit";
  value: { type: "fixed"; amount: number } | { type: "open"; min: number; max: number };
  level?: "line" | "order";
  scope: { type: "all" } | { type: "categories"; category_ids: string[] } | { type: "products"; product_ids: string[] } | { type: "tags"; tags: string[] } | { type: "deposit" };
  exclusions?: { product_ids?: string[]; category_ids?: string[]; tags?: string[] };
  conditions?: {
    order_types?: string[];
    channels?: string[];
    outlet_ids?: string[];
    excluded_outlet_ids?: string[];
    brand_ids?: string[];
    min_spend?: { amount: number; basis: "scoped" | "order" };
    customer_group_ids?: string[];
    active_from?: string;
    active_to?: string;
  };
  cap?: number | null;
  priority: number;
  stacking?: "exclusive" | "stackable";
  application: "auto" | "manual";
  min_role?: string;
  override_allowed?: boolean;
  reason_required?: boolean;
  /** Fees only: the class the fee is taxed at, null when untaxed. */
  tax_class_id?: string | null;
  report_class: RuleForm["report_class"];
  disables?: { rule_ids?: string[]; report_classes?: string[] };
  seeded?: boolean;
};

export function bodyOf(v: PricingRuleVersion): RuleBody {
  return v.body as unknown as RuleBody;
}

/** ISO -> value for <input type="datetime-local"> in the browser's zone. */
export function toLocalInput(iso: string | undefined | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fromLocalInput(local: string): string | undefined {
  if (!local) return undefined;
  const d = new Date(local);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

export function emptyForm(kind: "fee" | "discount"): RuleForm {
  return {
    rule_key: "",
    name: "",
    kind,
    calc: "percent",
    value_type: "fixed",
    amount: null,
    min: null,
    max: null,
    level: "line",
    scope_type: "all",
    scope_category_ids: [],
    scope_product_ids: [],
    scope_tags: [],
    excl_product_ids: [],
    excl_category_ids: [],
    excl_tags: [],
    cond_order_types: [],
    cond_channels: [],
    cond_outlet_ids: [],
    cond_excluded_outlet_ids: [],
    cond_brand_ids: [],
    cond_customer_group_ids: [],
    min_spend_amount: null,
    min_spend_basis: "order",
    active_from: "",
    active_to: "",
    cap: null,
    priority: kind === "fee" ? "100" : "50",
    stacking: "stackable",
    application: "auto",
    min_role: NONE,
    override_allowed: false,
    reason_required: false,
    tax_class_id: "",
    report_class: kind === "fee" ? "service_charge" : "promo",
    disables_rule_ids: [],
    disables_report_classes: [],
    effective: "now",
    effective_at: "",
    note: "",
  };
}

export function formFrom(version: PricingRuleVersion): RuleForm {
  const b = bodyOf(version);
  const base = emptyForm(b.kind);
  const c = b.conditions ?? {};
  return {
    ...base,
    rule_key: version.rule_key,
    name: b.name,
    calc: b.calc,
    value_type: b.value.type,
    amount: b.value.type === "fixed" ? b.value.amount : null,
    min: b.value.type === "open" ? b.value.min : null,
    max: b.value.type === "open" ? b.value.max : null,
    level: b.level ?? (b.calc === "fixed_per_order" ? "order" : "line"),
    scope_type: b.scope.type,
    scope_category_ids: b.scope.type === "categories" ? b.scope.category_ids : [],
    scope_product_ids: b.scope.type === "products" ? b.scope.product_ids : [],
    scope_tags: b.scope.type === "tags" ? b.scope.tags : [],
    excl_product_ids: b.exclusions?.product_ids ?? [],
    excl_category_ids: b.exclusions?.category_ids ?? [],
    excl_tags: b.exclusions?.tags ?? [],
    cond_order_types: c.order_types ?? [],
    cond_channels: c.channels ?? [],
    cond_outlet_ids: c.outlet_ids ?? [],
    cond_excluded_outlet_ids: c.excluded_outlet_ids ?? [],
    cond_brand_ids: c.brand_ids ?? [],
    cond_customer_group_ids: c.customer_group_ids ?? [],
    min_spend_amount: c.min_spend?.amount ?? null,
    min_spend_basis: c.min_spend?.basis ?? "order",
    active_from: toLocalInput(c.active_from),
    active_to: toLocalInput(c.active_to),
    cap: b.cap ?? null,
    priority: String(b.priority),
    stacking: b.stacking ?? "stackable",
    application: b.application,
    min_role: b.min_role ?? NONE,
    override_allowed: b.override_allowed ?? false,
    reason_required: b.reason_required ?? false,
    tax_class_id: b.kind === "fee" ? (b.tax_class_id ?? NONE) : "",
    report_class: b.report_class,
    disables_rule_ids: b.disables?.rule_ids ?? [],
    disables_report_classes: b.disables?.report_classes ?? [],
  };
}

export function toBody(v: RuleForm): RuleBody {
  const conditions: NonNullable<RuleBody["conditions"]> = {};
  if (v.cond_order_types.length) conditions.order_types = v.cond_order_types;
  if (v.cond_channels.length) conditions.channels = v.cond_channels;
  if (v.cond_outlet_ids.length) conditions.outlet_ids = v.cond_outlet_ids;
  if (v.cond_excluded_outlet_ids.length) conditions.excluded_outlet_ids = v.cond_excluded_outlet_ids;
  if (v.cond_brand_ids.length) conditions.brand_ids = v.cond_brand_ids;
  if (v.cond_customer_group_ids.length) conditions.customer_group_ids = v.cond_customer_group_ids;
  if (v.min_spend_amount !== null && v.min_spend_amount > 0) conditions.min_spend = { amount: v.min_spend_amount, basis: v.min_spend_basis };
  const from = fromLocalInput(v.active_from);
  const to = fromLocalInput(v.active_to);
  if (from) conditions.active_from = from;
  if (to) conditions.active_to = to;

  const scope: RuleBody["scope"] =
    v.scope_type === "categories"
      ? { type: "categories", category_ids: v.scope_category_ids }
      : v.scope_type === "products"
        ? { type: "products", product_ids: v.scope_product_ids }
        : v.scope_type === "tags"
          ? { type: "tags", tags: v.scope_tags }
          : v.scope_type === "deposit"
            ? { type: "deposit" }
            : { type: "all" };

  const body: RuleBody = {
    kind: v.kind,
    name: v.name.trim(),
    calc: v.calc,
    value: v.value_type === "fixed" ? { type: "fixed", amount: v.amount ?? 0 } : { type: "open", min: v.min ?? 0, max: v.max ?? 0 },
    scope,
    exclusions: { product_ids: v.excl_product_ids, category_ids: v.excl_category_ids, tags: v.excl_tags },
    conditions,
    cap: v.cap,
    priority: Number(v.priority),
    stacking: v.stacking,
    application: v.application,
    override_allowed: v.override_allowed,
    reason_required: v.reason_required,
    report_class: v.report_class,
    disables: { rule_ids: v.disables_rule_ids, report_classes: v.disables_report_classes },
  };
  if (v.kind === "discount") body.level = v.level;
  if (v.kind === "fee") body.tax_class_id = v.tax_class_id === NONE ? null : v.tax_class_id;
  if (v.min_role !== NONE) body.min_role = v.min_role;
  return body;
}
