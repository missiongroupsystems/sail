import type { OpenAPIHono } from "@hono/zod-openapi";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { AmountSchema, ChannelTypeSchema, formatMoney, OrderTypeSchema, PricingContextSchema, PricingLineSchema, PricingResultSchema, PricingRuleSchema, ManualApplicationSchema, MAX_AMOUNT, price, registerOperations, sumCents, validateRuleSet, type PricingRuleInput } from "@sail/shared";
import { db, tx } from "../db/client.js";
import { merchantSettings, products, reportCategories } from "../db/schema/index.js";
import { AppError } from "../lib/errors.js";
import type { AppEnv } from "../lib/context.js";
import { dataResponse, defineOp, errorResponses, jsonBody, jsonResponse, listResponse, mutationResponse, plainIssue, z, untrusted } from "../lib/openapi.js";
import { appendEvent } from "../lib/events.js";
import { recordAudit } from "../lib/audit.js";
import { activeRules, archiveRule, createRuleVersion, ruleVersions } from "../services/pricing-rules.js";
import { assertTaxClass, defaultTaxClassId, orderTaxSettings } from "../services/tax.js";

registerOperations({
  "pricing_rules.list": { op: "pricing_rules.list", summary: "List pricing rules", description: "Every rule with its versions, or only the set active at a given time (`active_at`). Fees and discounts share one shape.", tier: "T0", minRole: "server", overrideAllowed: false, reasonRequired: false, dryRun: false, principals: ["staff", "station", "agent"], emits: [], mcp: { expose: true, toolsets: ["pos.read", "config.author", "reports"] } },
  "pricing_rules.create_version": { op: "pricing_rules.create_version", summary: "Create a pricing rule version", description: "Creates a new rule, or a new version of an existing rule key, effective from a given time. Earlier orders keep their snapshot. Admin only.", tier: "T3", minRole: "admin", overrideAllowed: false, reasonRequired: false, dryRun: false, principals: ["staff"], emits: ["pricing_rule.version_created"], mcp: { expose: false, toolsets: [] } },
  "pricing_rules.archive": { op: "pricing_rules.archive", summary: "Archive a pricing rule", description: "Stops every version of a rule from applying to new orders. Admin only.", tier: "T3", minRole: "admin", overrideAllowed: false, reasonRequired: false, dryRun: false, principals: ["staff"], emits: ["pricing_rule.archived"], mcp: { expose: false, toolsets: [] } },
  "pricing.simulate": { op: "pricing.simulate", summary: "Simulate the pricing pipeline", description: "Prices a sample basket for an outlet, order type, channel and customer groups with the active rules (or a supplied rule set) and returns the full step-by-step trace. Pure: writes nothing. Totals come from the register, never from the caller.", tier: "T0", minRole: "manager", overrideAllowed: false, reasonRequired: false, dryRun: false, principals: ["staff", "agent"], emits: [], mcp: { expose: true, toolsets: ["config.author", "reports"] } },
  "pricing_rules.validate": { op: "pricing_rules.validate", summary: "Validate the rule set", description: "Warnings for likely mistakes: overlapping exclusive rules, products no fee covers, caps below the minimum. Optionally validates a proposed rule set instead of the active one.", tier: "T0", minRole: "manager", overrideAllowed: false, reasonRequired: false, dryRun: false, principals: ["staff", "agent"], emits: [], mcp: { expose: true, toolsets: ["config.author"] } },
});

const RuleBodySchema = z.record(z.string(), z.unknown());
const VersionSchema = z.object({ id: z.string(), rule_key: z.string(), version: z.number().int(), status: z.enum(["scheduled", "active", "superseded", "archived"]), effective_from: z.string(), body: RuleBodySchema, note: untrusted(z.string().nullable()), created_by: z.string().nullable(), created_at: z.string(), archived: z.boolean() });

const SimulateBody = z.object({
  outlet_id: z.uuid(),
  brand_id: z.uuid(),
  order_type: OrderTypeSchema,
  channel: ChannelTypeSchema.default("pos"),
  customer_group_ids: z.array(z.string()).default([]),
  /** Either full pricing lines, or product references the server expands from the catalogue. */
  lines: z.array(z.union([PricingLineSchema, z.object({ product_id: z.uuid(), quantity: z.number().int().min(1).max(999).default(1), open_price: AmountSchema.nullable().optional(), line_id: z.string().optional() })])),
  manual_applications: z.array(ManualApplicationSchema).default([]),
  /** Evaluate the rules active at this time (default now), or supply a rule set to try. */
  at: z.iso.datetime().optional(),
  rules: z.array(z.record(z.string(), z.unknown())).optional(),
  tax_mode: z.enum(["inclusive", "exclusive"]).optional(),
});

export function pricingRoutes(app: OpenAPIHono<AppEnv>) {
  defineOp(app, { op: "pricing_rules.list", method: "get", path: "/v1/pricing-rules", tags: ["pricing"], request: { query: z.object({ rule_key: z.string().optional(), active_at: z.iso.datetime().optional() }) }, responses: { 200: jsonResponse(listResponse(VersionSchema)), ...errorResponses } }, async (c) => {
    const p = c.get("principal");
    const q = c.req.valid("query");
    if (q.active_at) {
      const rules = await activeRules(p.merchantId, new Date(q.active_at));
      return c.json({ data: rules.map((r) => ({ id: `${r.id}@${r.version}`, rule_key: r.id, version: r.version, status: "active" as const, effective_from: q.active_at!, body: r as unknown as Record<string, unknown>, note: null, created_by: null, created_at: q.active_at!, archived: false })), next_cursor: null }, 200);
    }
    const rows = await ruleVersions(p.merchantId, q.rule_key);
    return c.json({ data: rows.map((r) => ({ id: r.id, rule_key: r.ruleKey, version: r.version, status: r.status, effective_from: r.effectiveFrom.toISOString(), body: r.body, note: r.note, created_by: r.createdBy, created_at: r.createdAt.toISOString(), archived: r.archivedAt != null })), next_cursor: null }, 200);
  });

  defineOp(
    app,
    { op: "pricing_rules.create_version", method: "post", path: "/v1/pricing-rules", tags: ["pricing"], request: { body: jsonBody(z.object({ rule_key: z.string().min(1).max(80).regex(/^[a-z0-9:_-]+$/i), body: RuleBodySchema, effective_from: z.iso.datetime().optional(), note: untrusted(z.string().max(500).nullable().optional()) })) }, responses: { 201: jsonResponse(mutationResponse(VersionSchema)), ...errorResponses } },
    async (c) => {
      const p = c.get("principal");
      const b = c.req.valid("json");
      const parsed = PricingRuleSchema.safeParse({ ...b.body, id: b.rule_key, version: 1 });
      if (!parsed.success) throw AppError.validation(`The rule is not valid: ${plainIssue(parsed.error.issues[0]!)}`, { issues: parsed.error.issues });
      if (parsed.data.tax_class_id) await assertTaxClass(p.merchantId, parsed.data.tax_class_id, "body.tax_class_id");
      await assertRuleRefs(p.merchantId, parsed.data);
      const effectiveFrom = b.effective_from ? new Date(b.effective_from) : new Date();
      const row = await createRuleVersion(p.merchantId, { rule_key: b.rule_key, body: parsed.data as PricingRuleInput, effective_from: effectiveFrom, note: b.note ?? null, created_by: p.id });
      // Validation warnings for the resulting set (advisory; the version is still created).
      const current = await activeRules(p.merchantId, new Date(Math.max(Date.now(), effectiveFrom.getTime())));
      const warnings = validateRuleSet(current).map((w) => `${w.severity}: ${w.message}`);
      const ev = await appendEvent({ merchantId: p.merchantId, outletId: null, type: "pricing_rule.version_created", aggregate: { kind: "pricing_rule", id: row.id, version: row.version }, operationId: "pricing_rules.create_version", payload: { rule_key: row.ruleKey, version: row.version, effective_from: row.effectiveFrom.toISOString(), status: row.status }, correlationId: c.get("correlationId"), idempotencyKey: c.get("idempotencyKey") }, p);
      await recordAudit(p, { action: "pricing_rules.create_version", targetKind: "pricing_rule", targetId: row.ruleKey, details: { version: row.version, effective_from: row.effectiveFrom.toISOString(), name: (row.body as { name?: string }).name } });
      return c.json({ data: { id: row.id, rule_key: row.ruleKey, version: row.version, status: row.status, effective_from: row.effectiveFrom.toISOString(), body: row.body, note: row.note, created_by: row.createdBy, created_at: row.createdAt.toISOString(), archived: false }, events: [ev], warnings }, 201);
    },
  );

  defineOp(app, { op: "pricing_rules.archive", method: "post", path: "/v1/pricing-rules/{rule_key}/archive", tags: ["pricing"], request: { params: z.object({ rule_key: z.string() }), body: jsonBody(z.object({ reason: untrusted(z.string().max(500).optional()) })) }, responses: { 200: jsonResponse(mutationResponse(z.object({ rule_key: z.string(), versions_archived: z.number().int() }))), ...errorResponses } }, async (c) => {
    const p = c.get("principal");
    const { rule_key } = c.req.valid("param");
    const { reason } = c.req.valid("json");
    const n = await archiveRule(p.merchantId, rule_key);
    const ev = await appendEvent({ merchantId: p.merchantId, outletId: null, type: "pricing_rule.archived", aggregate: { kind: "pricing_rule", id: p.merchantId }, operationId: "pricing_rules.archive", payload: { rule_key, versions: n }, reason: reason ? { text: reason } : null, correlationId: c.get("correlationId"), idempotencyKey: c.get("idempotencyKey") }, p);
    await recordAudit(p, { action: "pricing_rules.archive", targetKind: "pricing_rule", targetId: rule_key, reason: reason ?? null });
    return c.json({ data: { rule_key, versions_archived: n }, events: [ev], warnings: [] }, 200);
  });

  defineOp(app, { op: "pricing.simulate", method: "post", path: "/v1/pricing/simulate", tags: ["pricing"], request: { body: jsonBody(SimulateBody) }, responses: { 200: jsonResponse(dataResponse(PricingResultSchema)), ...errorResponses } }, async (c) => {
    const p = c.get("principal");
    const b = c.req.valid("json");
    const at = b.at ? new Date(b.at) : new Date();
    const tax = await orderTaxSettings(p.merchantId, b.outlet_id);
    const rules = b.rules ? b.rules.map((r) => PricingRuleSchema.parse(r)) : await activeRules(p.merchantId, at);
    const lines = await expandLines(p.merchantId, b.lines);
    // The bound an order gets before pricing (assertWithinMaxAmount): each line and the subtotal within MAX_AMOUNT.
    let subtotal = 0;
    for (const l of lines) {
      const base = ((l.open_price ?? l.prices.by_order_type?.[b.order_type] ?? l.prices.base) + sumCents(l.modifiers.map((m) => m.price * m.quantity))) * l.quantity;
      subtotal += base;
      if (base > MAX_AMOUNT || subtotal > MAX_AMOUNT) throw AppError.validation("The lines come to more than the largest amount the register accepts", { remedy: "Lower the quantity or the price.", limit: MAX_AMOUNT });
    }
    const result = price(
      { order_type: b.order_type, channel: b.channel, outlet_id: b.outlet_id, brand_id: b.brand_id, customer_group_ids: b.customer_group_ids, lines, manual_applications: b.manual_applications },
      rules,
      PricingContextSchema.parse({ tax_mode: b.tax_mode ?? tax.taxMode, tax_rounding: tax.taxRounding, tax_rates: tax.taxRates, now: at.toISOString() }),
      { money: await moneyWords(p.merchantId) },
    );
    return c.json({ data: result }, 200);
  });

  defineOp(app, { op: "pricing_rules.validate", method: "post", path: "/v1/pricing-rules/validate", tags: ["pricing"], request: { body: jsonBody(z.object({ rules: z.array(z.record(z.string(), z.unknown())).optional(), at: z.iso.datetime().optional() })) }, responses: { 200: jsonResponse(dataResponse(z.object({ warnings: z.array(z.object({ code: z.string(), severity: z.enum(["blocking", "advisory"]), message: z.string(), rule_ids: z.array(z.string()), product_ids: z.array(z.string()).optional() })) }))), ...errorResponses } }, async (c) => {
    const p = c.get("principal");
    const b = c.req.valid("json");
    const rules = b.rules ? b.rules.map((r) => PricingRuleSchema.parse(r)) : await activeRules(p.merchantId, b.at ? new Date(b.at) : new Date());
    const cats = await db().select().from(reportCategories).where(eq(reportCategories.merchantId, p.merchantId));
    const parent = new Map(cats.map((x) => [x.id, x.parentId]));
    const prods = await db().select({ id: products.id, categoryId: products.categoryId, tags: products.tags, hasDeposit: products.hasDeposit }).from(products).where(and(eq(products.merchantId, p.merchantId), isNull(products.archivedAt), eq(products.kind, "product")));
    const catalogue = prods.map((x) => ({ product_id: x.id, category_id: x.categoryId, parent_category_id: x.categoryId ? (parent.get(x.categoryId) ?? null) : null, tags: x.tags, has_deposit: x.hasDeposit }));
    return c.json({ data: { warnings: validateRuleSet(rules, catalogue) } }, 200);
  });
}

/**
 * Every record a rule names (scope, exclusions, conditions) is one of this merchant's. An unknown id and another
 * merchant's id are refused alike, so a rule can neither point across merchants nor confirm that an id exists.
 */
async function assertRuleRefs(merchantId: string, r: z.infer<typeof PricingRuleSchema>) {
  const refs: [field: string, table: string, ids: string[] | undefined][] = [
    ["body.scope.product_ids", "products", r.scope.type === "products" ? r.scope.product_ids : undefined],
    ["body.scope.category_ids", "report_categories", r.scope.type === "categories" ? r.scope.category_ids : undefined],
    ["body.exclusions.product_ids", "products", r.exclusions.product_ids],
    ["body.exclusions.category_ids", "report_categories", r.exclusions.category_ids],
    ["body.conditions.outlet_ids", "outlets", r.conditions.outlet_ids],
    ["body.conditions.excluded_outlet_ids", "outlets", r.conditions.excluded_outlet_ids],
    ["body.conditions.brand_ids", "brands", r.conditions.brand_ids],
    ["body.conditions.customer_group_ids", "customer_groups", r.conditions.customer_group_ids],
  ];
  for (const [field, table, ids] of refs) {
    const want = [...new Set(ids ?? [])];
    if (!want.length) continue;
    const found = await tx().unsafe<{ id: string }[]>(`select id::text as id from ${table} where merchant_id = $1 and id::text = any($2::text[])`, [merchantId, want]);
    if (found.length !== want.length) throw AppError.validation(`${field} names a record this business does not have`, { remedy: "Pick the records from this business's own lists.", details: { field } });
  }
}

/** Expand `{product_id, quantity}` references into full pricing lines from the catalogue. */
export async function expandLines(merchantId: string, lines: z.infer<typeof SimulateBody>["lines"]) {
  const refs = lines.filter((l): l is { product_id: string; quantity: number; open_price?: number | null; line_id?: string } => !("prices" in l));
  const full = lines.filter((l) => "prices" in l) as z.infer<typeof PricingLineSchema>[];
  if (refs.length === 0) return full;
  const ids = [...new Set(refs.map((r) => r.product_id))];
  const prods = await db().select().from(products).where(inArray(products.id, ids));
  const byId = new Map(prods.map((p) => [p.id, p]));
  const cats = await db().select().from(reportCategories);
  const parent = new Map(cats.map((x) => [x.id, x.parentId]));
  const { productPrices } = await import("../db/schema/index.js");
  const prices = await db().select().from(productPrices).where(inArray(productPrices.productId, ids));
  const defaultClass = await defaultTaxClassId(merchantId);
  const expanded = refs.map((r, i) => {
    const prod = byId.get(r.product_id);
    if (!prod) throw AppError.notFound("product", r.product_id);
    return PricingLineSchema.parse({
      line_id: r.line_id ?? `sim-${i + 1}`,
      product_id: prod.id,
      category_id: prod.categoryId,
      parent_category_id: prod.categoryId ? (parent.get(prod.categoryId) ?? null) : null,
      tags: prod.tags,
      has_deposit: prod.hasDeposit,
      tax_class_id: prod.taxClassId ?? defaultClass,
      quantity: r.quantity,
      prices: { base: prod.price, by_order_type: Object.fromEntries(prices.filter((x) => x.productId === prod.id).map((x) => [x.orderType, x.price])) },
      open_price: r.open_price ?? null,
      name: prod.name,
    });
  });
  return [...full, ...expanded];
}

/** The trace's amounts in the merchant's currency, as people read them. */
async function moneyWords(merchantId: string): Promise<((cents: number) => string) | undefined> {
  const [m] = await db().select({ currency: merchantSettings.currency, locale: merchantSettings.locale }).from(merchantSettings).where(eq(merchantSettings.merchantId, merchantId)).limit(1);
  return m ? (cents: number) => formatMoney(cents, m) : undefined;
}
