import type { OpenAPIHono } from "@hono/zod-openapi";
import { and, asc, eq, isNull, ne, sql } from "drizzle-orm";
import { OrderTypeSchema, registerOperations, TaxComponentSchema, type OperationSpec } from "@sail/shared";
import { db } from "../db/client.js";
import { outlets, products, taxClasses, taxRates } from "../db/schema/index.js";
import { AppError } from "../lib/errors.js";
import type { AppEnv } from "../lib/context.js";
import { defineOp, errorResponses, jsonBody, jsonResponse, listResponse, mutationResponse, z } from "../lib/openapi.js";
import { appendEvent } from "../lib/events.js";
import { recordAudit } from "../lib/audit.js";
import { activeRules } from "../services/pricing-rules.js";

const EDIT: Pick<OperationSpec, "tier" | "minRole" | "overrideAllowed" | "reasonRequired" | "dryRun" | "principals" | "mcp"> = { tier: "T3", minRole: "admin", overrideAllowed: false, reasonRequired: false, dryRun: false, principals: ["staff"], mcp: { expose: false, toolsets: [] } };
registerOperations({
  "tax_classes.list": { op: "tax_classes.list", summary: "List tax classes and their rates", description: "Every tax class of the merchant with its rates: the default rate (no outlet, no order type) and any outlet or order-type rate. A rate is a list of named components in basis points; an empty list is tax-exempt.", tier: "T0", minRole: "server", overrideAllowed: false, reasonRequired: false, dryRun: false, principals: ["staff", "station", "agent"], emits: [], mcp: { expose: true, toolsets: ["pos.read", "config.author"] } },
  "tax_classes.create": { op: "tax_classes.create", summary: "Create a tax class", description: "Creates a tax class with its default rate. Products, open items and fees name a class; orders opened afterwards use it. Admin only.", ...EDIT, emits: ["tax_class.created"] },
  "tax_classes.update": { op: "tax_classes.update", summary: "Update a tax class", description: "Renames a class, makes it the merchant default, or archives it (refused while products or fees use it, and for the default). Admin only.", ...EDIT, emits: ["tax_class.updated"] },
  "tax_rates.set": { op: "tax_rates.set", summary: "Set a tax rate", description: "Sets the components of a class's rate for every outlet and order type, for one outlet, for one order type, or for both. Orders already open keep the rates they were opened with. Admin only.", ...EDIT, emits: ["tax_rate.set"] },
  "tax_rates.delete": { op: "tax_rates.delete", summary: "Remove a tax rate", description: "Removes an outlet or order-type rate, so the class's less specific rate applies again. The default rate cannot be removed. Admin only.", ...EDIT, emits: ["tax_rate.deleted"] },
});

const Components = z.array(TaxComponentSchema).max(8).refine((cs) => new Set(cs.map((c) => c.name)).size === cs.length, "component names must be unique within a rate");
const TaxRateSchema = z.object({ id: z.string(), outlet_id: z.string().nullable(), order_type: OrderTypeSchema.nullable(), components: z.array(TaxComponentSchema) });
export const TaxClassSchema = z.object({ id: z.string(), name: z.string(), is_default: z.boolean(), archived: z.boolean(), rates: z.array(TaxRateSchema) });

async function classWithRates(merchantId: string, id: string) {
  const [c] = await db().select().from(taxClasses).where(and(eq(taxClasses.id, id), eq(taxClasses.merchantId, merchantId))).limit(1);
  if (!c) throw AppError.notFound("tax class", id);
  const rates = await db().select().from(taxRates).where(eq(taxRates.taxClassId, id)).orderBy(asc(taxRates.createdAt));
  return toClass(c, rates);
}

const toClass = (c: typeof taxClasses.$inferSelect, rates: (typeof taxRates.$inferSelect)[]) => ({
  id: c.id,
  name: c.name,
  is_default: c.isDefault,
  archived: c.archivedAt != null,
  rates: rates.map((r) => ({ id: r.id, outlet_id: r.outletId, order_type: OrderTypeSchema.nullable().parse(r.orderType), components: r.components })),
});

export function taxRoutes(app: OpenAPIHono<AppEnv>) {
  defineOp(app, { op: "tax_classes.list", method: "get", path: "/v1/tax-classes", tags: ["tax"], request: { query: z.object({ include_archived: z.enum(["true", "false"]).optional() }) }, responses: { 200: jsonResponse(listResponse(TaxClassSchema)), ...errorResponses } }, async (c) => {
    const p = c.get("principal");
    const q = c.req.valid("query");
    const where = q.include_archived === "true" ? eq(taxClasses.merchantId, p.merchantId) : and(eq(taxClasses.merchantId, p.merchantId), isNull(taxClasses.archivedAt));
    const [classes, rates] = await Promise.all([db().select().from(taxClasses).where(where).orderBy(asc(taxClasses.name)), db().select().from(taxRates).where(eq(taxRates.merchantId, p.merchantId)).orderBy(asc(taxRates.createdAt))]);
    return c.json({ data: classes.map((k) => toClass(k, rates.filter((r) => r.taxClassId === k.id))), next_cursor: null }, 200);
  });

  defineOp(app, { op: "tax_classes.create", method: "post", path: "/v1/tax-classes", tags: ["tax"], request: { body: jsonBody(z.object({ id: z.uuid().optional(), name: z.string().min(1).max(80), components: Components, is_default: z.boolean().optional() })) }, responses: { 201: jsonResponse(mutationResponse(TaxClassSchema)), ...errorResponses } }, async (c) => {
    const p = c.get("principal");
    const b = c.req.valid("json");
    if (b.is_default) await db().update(taxClasses).set({ isDefault: false }).where(and(eq(taxClasses.merchantId, p.merchantId), eq(taxClasses.isDefault, true)));
    const [row] = await db().insert(taxClasses).values({ id: b.id, merchantId: p.merchantId, name: b.name, isDefault: b.is_default ?? false }).returning();
    await db().insert(taxRates).values({ merchantId: p.merchantId, taxClassId: row!.id, components: b.components });
    const data = await classWithRates(p.merchantId, row!.id);
    const ev = await appendEvent({ merchantId: p.merchantId, outletId: null, type: "tax_class.created", aggregate: { kind: "tax_class", id: row!.id }, operationId: "tax_classes.create", payload: data, correlationId: c.get("correlationId"), idempotencyKey: c.get("idempotencyKey") }, p);
    await recordAudit(p, { action: "tax_classes.create", targetKind: "tax_class", targetId: row!.id, details: { name: b.name, components: b.components } });
    return c.json({ data, events: [ev], warnings: [] }, 201);
  });

  defineOp(app, { op: "tax_classes.update", method: "patch", path: "/v1/tax-classes/{id}", tags: ["tax"], request: { params: z.object({ id: z.uuid() }), body: jsonBody(z.object({ name: z.string().min(1).max(80).optional(), is_default: z.literal(true).optional(), archived: z.boolean().optional() })) }, responses: { 200: jsonResponse(mutationResponse(TaxClassSchema)), ...errorResponses } }, async (c) => {
    const p = c.get("principal");
    const { id } = c.req.valid("param");
    const b = c.req.valid("json");
    const current = await classWithRates(p.merchantId, id);
    if (b.archived) {
      if (current.is_default || b.is_default) throw AppError.state("The default tax class cannot be archived", ["make another class the default first"], "Make another class the default, then archive this one.");
      const [used] = await db().select({ n: sql<number>`count(*)::int` }).from(products).where(and(eq(products.taxClassId, id), isNull(products.archivedAt)));
      const fees = (await activeRules(p.merchantId, new Date())).filter((r) => r.kind === "fee" && r.tax_class_id === id);
      if ((used?.n ?? 0) > 0 || fees.length > 0) throw AppError.state(`${current.name} is still used by ${used?.n ?? 0} product(s) and ${fees.length} fee(s)`, ["move them to another class first"], "Give those products and fees another tax class, then archive this one.");
    }
    if (b.is_default && current.archived && b.archived !== false) throw AppError.state(`${current.name} is archived`, ["restore it first"], "Restore the class (archived: false) before making it the default.");
    if (b.is_default) await db().update(taxClasses).set({ isDefault: false }).where(and(eq(taxClasses.merchantId, p.merchantId), eq(taxClasses.isDefault, true), ne(taxClasses.id, id)));
    await db()
      .update(taxClasses)
      .set({ ...(b.name !== undefined && { name: b.name }), ...(b.is_default && { isDefault: true }), ...(b.archived !== undefined && { archivedAt: b.archived ? new Date() : null }) })
      .where(eq(taxClasses.id, id));
    const data = await classWithRates(p.merchantId, id);
    const ev = await appendEvent({ merchantId: p.merchantId, outletId: null, type: "tax_class.updated", aggregate: { kind: "tax_class", id }, operationId: "tax_classes.update", payload: b, correlationId: c.get("correlationId"), idempotencyKey: c.get("idempotencyKey") }, p);
    await recordAudit(p, { action: "tax_classes.update", targetKind: "tax_class", targetId: id, details: b });
    return c.json({ data, events: [ev], warnings: [] }, 200);
  });

  defineOp(app, { op: "tax_rates.set", method: "put", path: "/v1/tax-classes/{id}/rates", tags: ["tax"], request: { params: z.object({ id: z.uuid() }), body: jsonBody(z.object({ outlet_id: z.uuid().nullable(), order_type: OrderTypeSchema.nullable(), components: Components })) }, responses: { 200: jsonResponse(mutationResponse(TaxClassSchema)), ...errorResponses } }, async (c) => {
    const p = c.get("principal");
    const { id } = c.req.valid("param");
    const b = c.req.valid("json");
    await classWithRates(p.merchantId, id);
    if (b.outlet_id) {
      const [o] = await db().select({ id: outlets.id }).from(outlets).where(and(eq(outlets.id, b.outlet_id), eq(outlets.merchantId, p.merchantId))).limit(1);
      if (!o) throw AppError.notFound("outlet", b.outlet_id);
    }
    await db()
      .insert(taxRates)
      .values({ merchantId: p.merchantId, taxClassId: id, outletId: b.outlet_id, orderType: b.order_type, components: b.components })
      .onConflictDoUpdate({ target: [taxRates.taxClassId, taxRates.outletId, taxRates.orderType], set: { components: b.components, updatedAt: new Date() } });
    const data = await classWithRates(p.merchantId, id);
    const ev = await appendEvent({ merchantId: p.merchantId, outletId: null, type: "tax_rate.set", aggregate: { kind: "tax_class", id }, operationId: "tax_rates.set", payload: b, correlationId: c.get("correlationId"), idempotencyKey: c.get("idempotencyKey") }, p);
    await recordAudit(p, { action: "tax_rates.set", targetKind: "tax_class", targetId: id, details: b });
    return c.json({ data, events: [ev], warnings: [] }, 200);
  });

  defineOp(app, { op: "tax_rates.delete", method: "delete", path: "/v1/tax-classes/{id}/rates/{rate_id}", tags: ["tax"], request: { params: z.object({ id: z.uuid(), rate_id: z.uuid() }) }, responses: { 200: jsonResponse(mutationResponse(TaxClassSchema)), ...errorResponses } }, async (c) => {
    const p = c.get("principal");
    const { id, rate_id } = c.req.valid("param");
    const current = await classWithRates(p.merchantId, id);
    const rate = current.rates.find((r) => r.id === rate_id);
    if (!rate) throw AppError.notFound("tax rate", rate_id);
    if (rate.outlet_id == null && rate.order_type == null) throw AppError.state("A class's default rate cannot be removed", ["set its components instead"], "Set the default rate's components (an empty list makes the class exempt).");
    await db().delete(taxRates).where(eq(taxRates.id, rate_id));
    const data = await classWithRates(p.merchantId, id);
    const ev = await appendEvent({ merchantId: p.merchantId, outletId: null, type: "tax_rate.deleted", aggregate: { kind: "tax_class", id }, operationId: "tax_rates.delete", payload: { rate_id }, correlationId: c.get("correlationId"), idempotencyKey: c.get("idempotencyKey") }, p);
    await recordAudit(p, { action: "tax_rates.delete", targetKind: "tax_class", targetId: id, details: { rate_id } });
    return c.json({ data, events: [ev], warnings: [] }, 200);
  });
}
