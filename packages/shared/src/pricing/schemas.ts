import { z } from "zod";
import { CentsSchema, ChannelTypeSchema, NonNegativeCentsSchema, OrderTypeSchema, TaxModeSchema } from "../domain.js";
import { RoleSchema } from "../roles.js";

/**
 * Pricing rules (scope doc 4.8). One record type covers fees and discounts.
 * The condition set is FIXED: anything outside this schema needs a decision.
 *
 * Values: percentages are basis points (1000 = 10%); fixed amounts are cents.
 */

export const RULE_KINDS = ["fee", "discount"] as const;
export const RuleKindSchema = z.enum(RULE_KINDS);

export const RULE_CALCS = ["percent", "fixed_per_order", "fixed_per_unit"] as const;
export const RuleCalcSchema = z.enum(RULE_CALCS);

export const RULE_LEVELS = ["line", "order"] as const;
export const RuleLevelSchema = z.enum(RULE_LEVELS);

export const STACKING = ["exclusive", "stackable"] as const;
export const StackingSchema = z.enum(STACKING);

export const APPLICATIONS = ["auto", "manual"] as const;
export const ApplicationSchema = z.enum(APPLICATIONS);

export const REPORT_CLASSES = [
  "service_charge",
  "deposit",
  "delivery_fee",
  "packaging_fee",
  "promo",
  "comp",
  "staff_meal",
  "ent",
  "other",
] as const;
export const ReportClassSchema = z.enum(REPORT_CLASSES);

export const RuleValueSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("fixed"), amount: z.number().int().min(0) }),
  z.object({ type: z.literal("open"), min: z.number().int().min(0), max: z.number().int().min(0) }),
]);
export type RuleValue = z.infer<typeof RuleValueSchema>;

export const RuleScopeSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("all") }),
  z.object({ type: z.literal("categories"), category_ids: z.array(z.string()).min(1) }),
  z.object({ type: z.literal("products"), product_ids: z.array(z.string()).min(1) }),
  z.object({ type: z.literal("tags"), tags: z.array(z.string()).min(1) }),
  /** Products flagged for the container deposit scheme (BCRS). */
  z.object({ type: z.literal("bcrs") }),
]);
export type RuleScope = z.infer<typeof RuleScopeSchema>;

export const RuleExclusionsSchema = z.object({
  product_ids: z.array(z.string()).default([]),
  category_ids: z.array(z.string()).default([]),
  tags: z.array(z.string()).default([]),
});

export const MinSpendSchema = z.object({
  amount: NonNegativeCentsSchema,
  /** `scoped`: the undiscounted total of the lines in this rule's scope. `order`: the undiscounted order subtotal. */
  basis: z.enum(["scoped", "order"]),
});

export const RuleConditionsSchema = z.object({
  order_types: z.array(OrderTypeSchema).optional(),
  channels: z.array(ChannelTypeSchema).optional(),
  outlet_ids: z.array(z.string()).optional(),
  excluded_outlet_ids: z.array(z.string()).optional(),
  brand_ids: z.array(z.string()).optional(),
  min_spend: MinSpendSchema.optional(),
  customer_group_ids: z.array(z.string()).optional(),
  active_from: z.iso.datetime().optional(),
  active_to: z.iso.datetime().optional(),
});
export type RuleConditions = z.infer<typeof RuleConditionsSchema>;

export const PricingRuleSchema = z
  .object({
    id: z.string().min(1),
    version: z.number().int().min(1).default(1),
    kind: RuleKindSchema,
    name: z.string().min(1).max(80),
    calc: RuleCalcSchema,
    value: RuleValueSchema,
    /**
     * Discounts only. `line`: applied to each scoped line's running amount.
     * `order`: computed on the eligible subtotal and spread across eligible lines in proportion.
     * `fixed_per_order` must be `order`; `fixed_per_unit` must be `line`; `percent` may be either.
     */
    level: RuleLevelSchema.optional(),
    scope: RuleScopeSchema,
    exclusions: RuleExclusionsSchema.default({ product_ids: [], category_ids: [], tags: [] }),
    conditions: RuleConditionsSchema.default({}),
    /** Maximum amount for this rule on one order, in cents. */
    cap: NonNegativeCentsSchema.nullable().default(null),
    priority: z.number().int(),
    stacking: StackingSchema.default("stackable"),
    application: ApplicationSchema,
    min_role: RoleSchema.optional(),
    override_allowed: z.boolean().default(false),
    reason_required: z.boolean().default(false),
    gst_applicable: z.boolean().default(true),
    report_class: ReportClassSchema,
    /** A manual rule may switch off other rules for the order (the service-charge waiver). */
    disables: z
      .object({
        rule_ids: z.array(z.string()).default([]),
        report_classes: z.array(ReportClassSchema).default([]),
      })
      .default({ rule_ids: [], report_classes: [] }),
    seeded: z.boolean().default(false),
  })
  .superRefine((r, ctx) => {
    if (r.kind === "discount") {
      const level = r.level ?? (r.calc === "fixed_per_order" ? "order" : "line");
      if (r.calc === "fixed_per_order" && level !== "order")
        ctx.addIssue({ code: "custom", message: "fixed_per_order discounts must be order-level", path: ["level"] });
      if (r.calc === "fixed_per_unit" && level !== "line")
        ctx.addIssue({ code: "custom", message: "fixed_per_unit discounts must be line-level", path: ["level"] });
    }
    if (r.value.type === "open" && r.value.min > r.value.max)
      ctx.addIssue({ code: "custom", message: "open value min must not exceed max", path: ["value"] });
    if (r.calc === "percent") {
      const max = r.value.type === "fixed" ? r.value.amount : r.value.max;
      if (max > 10_000) ctx.addIssue({ code: "custom", message: "percent values are basis points and cannot exceed 10000", path: ["value"] });
    }
    if (r.application === "manual" && !r.min_role)
      ctx.addIssue({ code: "custom", message: "manual rules need a min_role", path: ["min_role"] });
  });
export type PricingRuleInput = z.input<typeof PricingRuleSchema>;
export type PricingRule = z.infer<typeof PricingRuleSchema>;

export function ruleLevel(rule: PricingRule): "line" | "order" {
  if (rule.kind === "fee") return "line";
  return rule.level ?? (rule.calc === "fixed_per_order" ? "order" : "line");
}

/* ------------------------------------------------------------------ */
/* Pricing input                                                        */
/* ------------------------------------------------------------------ */

export const PricingModifierSchema = z.object({
  modifier_id: z.string().min(1),
  product_id: z.string().min(1),
  quantity: z.number().int().min(1).default(1),
  /** Resolved unit price in cents: the modifier group's price override, or the modifier product's price. */
  price: NonNegativeCentsSchema,
  name: z.string().optional(),
});
export type PricingModifier = z.infer<typeof PricingModifierSchema>;

export const PricingLineSchema = z.object({
  line_id: z.string().min(1),
  product_id: z.string().min(1),
  category_id: z.string().nullable().default(null),
  /** The two-level category tree: a line matches a category scope on either its category or its parent. */
  parent_category_id: z.string().nullable().default(null),
  tags: z.array(z.string()).default([]),
  is_bcrs: z.boolean().default(false),
  quantity: z.number().int().min(0),
  /** The product's base price and optional prices per order type. */
  prices: z.object({
    base: NonNegativeCentsSchema,
    by_order_type: z.partialRecord(OrderTypeSchema, NonNegativeCentsSchema).optional(),
  }),
  /** Open-price items: this replaces the product price entirely. */
  open_price: NonNegativeCentsSchema.nullable().default(null),
  modifiers: z.array(PricingModifierSchema).default([]),
  name: z.string().optional(),
});
export type PricingLineInput = z.input<typeof PricingLineSchema>;
export type PricingLine = z.infer<typeof PricingLineSchema>;

export const ManualApplicationSchema = z.object({
  application_id: z.string().min(1),
  rule_id: z.string().min(1),
  /** For open-value rules: bps for percent rules, cents for fixed rules. */
  entered_value: z.number().int().min(0).nullable().default(null),
  /** For item-scoped manual rules: restrict to these lines. Null means every scoped line. */
  line_ids: z.array(z.string()).nullable().default(null),
  applied_by: z.string().nullable().default(null),
  approved_by: z.string().nullable().default(null),
  override_id: z.string().nullable().default(null),
  reason: z.string().nullable().default(null),
});
export type ManualApplication = z.infer<typeof ManualApplicationSchema>;

export const PricingOrderSchema = z.object({
  order_type: OrderTypeSchema,
  channel: ChannelTypeSchema,
  outlet_id: z.string().min(1),
  brand_id: z.string().min(1),
  customer_group_ids: z.array(z.string()).default([]),
  lines: z.array(PricingLineSchema),
  manual_applications: z.array(ManualApplicationSchema).default([]),
});
export type PricingOrderInput = z.input<typeof PricingOrderSchema>;
export type PricingOrder = z.infer<typeof PricingOrderSchema>;

/** A frozen adjustment: the stored result of an order-level or minimum-spend rule at the first payment. */
export const FrozenAdjustmentSchema = z.object({
  rule_id: z.string(),
  rule_version: z.number().int(),
  manual_application_id: z.string().nullable().default(null),
  lines: z.array(z.object({ line_id: z.string(), amount: CentsSchema })),
});
export type FrozenAdjustment = z.infer<typeof FrozenAdjustmentSchema>;

export const PricingContextSchema = z.object({
  tax_mode: TaxModeSchema,
  /** GST rate in basis points (900 = 9%). */
  gst_bps: z.number().int().min(0).max(10_000).default(900),
  /** Evaluation time, passed in explicitly. The engine never reads the clock. */
  now: z.iso.datetime(),
  /**
   * When set, the order has a payment: order-level and minimum-spend rules are
   * frozen to these results, and lines not covered by them are priced with
   * line-level rules only.
   */
  frozen: z
    .object({
      frozen_at: z.iso.datetime(),
      adjustments: z.array(FrozenAdjustmentSchema),
    })
    .nullable()
    .default(null),
});
export type PricingContextInput = z.input<typeof PricingContextSchema>;
export type PricingContext = z.infer<typeof PricingContextSchema>;

/* ------------------------------------------------------------------ */
/* Pricing output                                                       */
/* ------------------------------------------------------------------ */

export const AdjustmentLineSchema = z.object({
  line_id: z.string(),
  /** Signed cents: negative for discounts, positive for fees. */
  amount: CentsSchema,
  /** GST attributable to this amount (0 for discounts; see semantics note). */
  gst_amount: CentsSchema,
});
export type AdjustmentLine = z.infer<typeof AdjustmentLineSchema>;

export const AdjustmentSchema = z.object({
  rule_id: z.string(),
  rule_version: z.number().int(),
  rule_name: z.string(),
  kind: RuleKindSchema,
  level: RuleLevelSchema,
  report_class: ReportClassSchema,
  gst_applicable: z.boolean(),
  /** Signed total: negative for discounts, positive for fees. */
  total: CentsSchema,
  gst_total: CentsSchema,
  lines: z.array(AdjustmentLineSchema),
  capped: z.boolean(),
  frozen: z.boolean(),
  manual_application_id: z.string().nullable(),
  entered_value: z.number().int().nullable(),
  applied_by: z.string().nullable(),
  approved_by: z.string().nullable(),
  override_id: z.string().nullable(),
  reason: z.string().nullable(),
  /** Snapshot of the rule as it was when applied. */
  rule_snapshot: z.unknown(),
});
export type Adjustment = z.infer<typeof AdjustmentSchema>;

export const PricedLineSchema = z.object({
  line_id: z.string(),
  quantity: z.number().int(),
  unit_price: CentsSchema,
  modifiers_per_unit: CentsSchema,
  /** (unit_price + modifiers_per_unit) × quantity */
  base_amount: CentsSchema,
  /** Sum of discount amounts on this line (negative or zero). */
  discount_amount: CentsSchema,
  /** base_amount + discount_amount */
  net_amount: CentsSchema,
  /** Sum of fee amounts attached to this line. */
  fee_amount: CentsSchema,
  /** GST on the net amount (both modes). */
  gst_on_net: CentsSchema,
  /** GST on GST-applicable fees attached to this line. */
  gst_on_fees: CentsSchema,
  /** Everything the customer pays for this line, including GST in both modes. */
  total: CentsSchema,
});
export type PricedLine = z.infer<typeof PricedLineSchema>;

export const PricingTotalsSchema = z.object({
  tax_mode: TaxModeSchema,
  /** Sum of base amounts. */
  subtotal: CentsSchema,
  /** Sum of discounts (negative or zero). */
  discount_total: CentsSchema,
  /** subtotal + discount_total */
  net_subtotal: CentsSchema,
  fee_total: CentsSchema,
  gst_total: CentsSchema,
  /** Amount payable before any cash rounding. */
  total: CentsSchema,
});
export type PricingTotals = z.infer<typeof PricingTotalsSchema>;

export const TraceStepSchema = z.object({
  step: z.number().int(),
  title: z.string(),
  entries: z.array(
    z.object({
      rule_id: z.string().optional(),
      rule_name: z.string().optional(),
      outcome: z.enum(["applied", "skipped", "info", "frozen"]),
      detail: z.string(),
      amount: CentsSchema.optional(),
    }),
  ),
});
export type TraceStep = z.infer<typeof TraceStepSchema>;

export const PricingResultSchema = z.object({
  lines: z.array(PricedLineSchema),
  adjustments: z.array(AdjustmentSchema),
  totals: PricingTotalsSchema,
  trace: z.array(TraceStepSchema),
  warnings: z.array(z.string()),
  pricing_status: z.enum(["live", "frozen"]),
});
export type PricingResult = z.infer<typeof PricingResultSchema>;
