import type { OpenAPIHono } from "@hono/zod-openapi";
import { and, asc, desc, eq, ilike, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import { AmountSchema, ORDER_TYPES, OrderTypeSchema, registerOperations, type OperationSpec } from "@sail/shared";
import { db, tx } from "../db/client.js";
import { availabilityRules, menuItems, menuSections, menus, modifierGroups, modifierOptions, productModifierGroups, productPrices, products, reportCategories, stockStatus } from "../db/schema/index.js";
import { AppError } from "../lib/errors.js";
import { assertTaxClass } from "../services/tax.js";
import type { AppEnv } from "../lib/context.js";
import { dataResponse, defineOp, errorResponses, jsonBody, jsonResponse, listResponse, mutationResponse, z } from "../lib/openapi.js";
import { appendEvent } from "../lib/events.js";
import { recordAudit } from "../lib/audit.js";
import { compact, defineCrud } from "../lib/crud.js";
import { outletVisible } from "../auth/principal.js";
import { compileMenu } from "../services/menu.js";
import { businessToday } from "../services/business-day.js";
import { nextCutoff } from "../lib/time.js";

const ops = (specs: Record<string, Partial<OperationSpec> & { op: string; summary: string }>) => {
  const out: Record<string, OperationSpec> = {};
  for (const [k, s] of Object.entries(specs)) {
    out[k] = { description: s.summary, tier: "T3", minRole: "admin", overrideAllowed: false, reasonRequired: false, dryRun: false, principals: ["staff", "agent"], emits: [], mcp: { expose: false, toolsets: [] }, ...s };
  }
  registerOperations(out);
};

ops({
  "products.list": { op: "products.list", summary: "Search products", description: "Products and components of the merchant, searchable by name, SKU or tag; paginated. Use menu.get for what a station or guest may order.", tier: "T0", minRole: "server", principals: ["staff", "station", "agent"], mcp: { expose: true, toolsets: ["pos.read", "config.author"] } },
  "products.get": { op: "products.get", summary: "Get a product", tier: "T0", minRole: "server", principals: ["staff", "station", "agent"], mcp: { expose: true, toolsets: ["pos.read", "config.author"] } },
  "products.create": { op: "products.create", summary: "Create a product", emits: ["product.created"] },
  "products.update": { op: "products.update", summary: "Update a product", description: "Changes a product, its prices per order type, tags, tax class, deposit flag or attached modifier groups; archive by setting archived.", emits: ["product.updated"] },
  "products.bulk_price": { op: "products.bulk_price", summary: "Bulk price edit", description: "Sets base prices for many products at once. Prices are integers in the currency's minor units.", emits: ["product.updated"] },
  "modifier_groups.list": { op: "modifier_groups.list", summary: "List modifier groups", tier: "T0", minRole: "server", principals: ["staff", "station", "agent"], mcp: { expose: true, toolsets: ["pos.read", "config.author"] } },
  "modifier_groups.get": { op: "modifier_groups.get", summary: "Get a modifier group with its options", tier: "T0", minRole: "server", principals: ["staff", "station", "agent"], mcp: { expose: true, toolsets: ["pos.read", "config.author"] } },
  "modifier_groups.create": { op: "modifier_groups.create", summary: "Create a modifier group", emits: ["modifier_group.created"] },
  "modifier_groups.update": { op: "modifier_groups.update", summary: "Update a modifier group and replace its options", emits: ["modifier_group.updated"] },
  "menus.list": { op: "menus.list", summary: "List menus", tier: "T0", minRole: "server", principals: ["staff", "station", "agent"], mcp: { expose: true, toolsets: ["pos.read", "config.author"] } },
  "menus.get": { op: "menus.get", summary: "Get a menu with sections and items", tier: "T0", minRole: "server", principals: ["staff", "station", "agent"], mcp: { expose: true, toolsets: ["pos.read", "config.author"] } },
  "menus.create": { op: "menus.create", summary: "Create a menu", emits: ["menu.created"] },
  "menus.update": { op: "menus.update", summary: "Update a menu", description: "Renames or archives a menu, and replaces its sections and item placements when `sections` is given (drag-and-drop ordering saves through this).", emits: ["menu.updated"] },
  "menu.get": { op: "menu.get", summary: "Compiled menu for a channel link", description: "Everything a station or guest needs to order from one channel link: sections, products with resolved prices and modifier groups, availability and sold-out status. Cache it by `version`. Never computes order totals.", tier: "T0", minRole: null, principals: ["staff", "station", "guest", "agent"], mcp: { expose: true, toolsets: ["pos.read", "guest"] } },
  "stock.mark_sold_out": { op: "stock.mark_sold_out", summary: "Mark a product sold out at an outlet", description: "Today, until a date, or indefinitely. Enforced by lines.add and rounds.submit. An agent may mark at most 20 an hour.", tier: "T1", agentPerHour: 20, minRole: "cashier", principals: ["staff", "agent"], emits: ["stock.sold_out"], mcp: { expose: true, toolsets: ["kitchen"] } },
  "stock.restore": { op: "stock.restore", summary: "Restore a sold-out product", tier: "T1", minRole: "cashier", principals: ["staff", "agent"], emits: ["stock.restored"], mcp: { expose: true, toolsets: ["kitchen"] } },
  "stock.set_daily_cap": { op: "stock.set_daily_cap", summary: "Set a daily quantity cap", description: "Counts down with sales and blocks at 0. Null removes the cap.", tier: "T2", minRole: "manager", principals: ["staff", "agent"], emits: ["stock.cap_set"], mcp: { expose: true, toolsets: ["kitchen"] } },
  "stock.list": { op: "stock.list", summary: "Sold-out and capped products at an outlet", tier: "T0", minRole: "server", principals: ["staff", "station", "agent"], mcp: { expose: true, toolsets: ["pos.read", "kitchen"] } },
});

/* ---- Schemas ----------------------------------------------------------- */

const CategorySchema = z.object({ id: z.string(), name: z.string(), parent_id: z.string().nullable(), sort: z.number().int(), legacy_id: z.string().nullable(), archived: z.boolean() });
const CategoryCreate = z.object({ id: z.uuid().optional(), name: z.string().min(1), parent_id: z.uuid().nullable().optional(), sort: z.number().int().optional(), legacy_id: z.string().nullable().optional() });
const CategoryPatch = CategoryCreate.omit({ id: true }).partial();

export const ProductSchema = z.object({
  id: z.string(),
  brand_id: z.string().nullable(),
  kind: z.enum(["product", "component"]),
  name: z.string(),
  kitchen_name: z.string().nullable(),
  sku: z.string().nullable(),
  description: z.string().nullable(),
  price: z.number().int(),
  prices_by_order_type: z.partialRecord(OrderTypeSchema, z.number().int()),
  category_id: z.string().nullable(),
  tags: z.array(z.string()),
  /** The product carries a deposit (the scope of deposit fees). */
  has_deposit: z.boolean(),
  /** Null = the merchant's default tax class. */
  tax_class_id: z.string().nullable(),
  open_price: z.boolean(),
  modifier_group_ids: z.array(z.string()),
  legacy_id: z.string().nullable(),
  archived: z.boolean(),
  updated_at: z.string(),
});
const ProductCreate = z.object({
  id: z.uuid().optional(),
  brand_id: z.uuid().nullable().optional(),
  kind: z.enum(["product", "component"]).optional(),
  name: z.string().min(1),
  kitchen_name: z.string().nullable().optional(),
  sku: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  price: AmountSchema,
  prices_by_order_type: z.partialRecord(OrderTypeSchema, AmountSchema).optional(),
  category_id: z.uuid().nullable().optional(),
  tags: z.array(z.string().min(1)).optional(),
  has_deposit: z.boolean().optional(),
  tax_class_id: z.uuid().nullable().optional(),
  open_price: z.boolean().optional(),
  modifier_group_ids: z.array(z.uuid()).optional(),
  legacy_id: z.string().nullable().optional(),
});
const ProductPatch = ProductCreate.omit({ id: true }).partial().extend({ archived: z.boolean().optional() });

const OptionSchema = z.object({ product_id: z.string(), price_override: z.number().int().nullable(), child_group_id: z.string().nullable(), is_default: z.boolean(), sort: z.number().int() });
const OptionInput = z.object({ product_id: z.uuid(), price_override: AmountSchema.nullable().optional(), child_group_id: z.uuid().nullable().optional(), is_default: z.boolean().optional(), sort: z.number().int().optional() });
const GroupSchema = z.object({ id: z.string(), name: z.string(), min_select: z.number().int(), max_select: z.number().int().nullable(), max_per_modifier: z.number().int(), options: z.array(OptionSchema), legacy_id: z.string().nullable(), archived: z.boolean() });
const GroupCreate = z.object({ id: z.uuid().optional(), name: z.string().min(1), min_select: z.number().int().min(0).optional(), max_select: z.number().int().min(1).nullable().optional(), max_per_modifier: z.number().int().min(1).optional(), options: z.array(OptionInput).optional(), legacy_id: z.string().nullable().optional() });
const GroupPatch = GroupCreate.omit({ id: true }).partial().extend({ archived: z.boolean().optional() });

const SectionSchema = z.object({ id: z.string(), name: z.string(), parent_id: z.string().nullable(), sort: z.number().int(), legacy_id: z.string().nullable(), items: z.array(z.object({ product_id: z.string(), sort: z.number().int() })) });
const SectionInput = z.object({ id: z.uuid().optional(), name: z.string().min(1), parent_id: z.uuid().nullable().optional(), sort: z.number().int().optional(), legacy_id: z.string().nullable().optional(), items: z.array(z.object({ product_id: z.uuid(), sort: z.number().int().optional() })).optional() });
const MenuSchema = z.object({ id: z.string(), brand_id: z.string(), name: z.string(), legacy_id: z.string().nullable(), archived: z.boolean(), sections: z.array(SectionSchema) });
const MenuCreate = z.object({ id: z.uuid().optional(), brand_id: z.uuid(), name: z.string().min(1), legacy_id: z.string().nullable().optional(), sections: z.array(SectionInput).optional() });
const MenuPatch = z.object({ name: z.string().min(1).optional(), archived: z.boolean().optional(), sections: z.array(SectionInput).optional() });

const AvailabilitySchema = z.object({ id: z.string(), target_kind: z.enum(["product", "section"]), target_id: z.string(), outlet_ids: z.array(z.string()), channels: z.array(z.string()), days_of_week: z.array(z.number().int()), start_time: z.string().nullable(), end_time: z.string().nullable() });
const AvailabilityCreate = z.object({ id: z.uuid().optional(), target_kind: z.enum(["product", "section"]), target_id: z.uuid(), outlet_ids: z.array(z.uuid()).optional(), channels: z.array(z.enum(["pos", "scan_to_order"])).optional(), days_of_week: z.array(z.number().int().min(0).max(6)).optional(), start_time: z.string().regex(/^\d{2}:\d{2}$/).nullable().optional(), end_time: z.string().regex(/^\d{2}:\d{2}$/).nullable().optional() });
const AvailabilityPatch = AvailabilityCreate.omit({ id: true, target_kind: true, target_id: true }).partial();

const StockSchema = z.object({ outlet_id: z.string(), product_id: z.string(), sold_out: z.boolean(), sold_out_until: z.string().nullable(), daily_cap: z.number().int().nullable(), cap_remaining: z.number().int().nullable(), cap_date: z.string().nullable() });

/* ---- Mappers ------------------------------------------------------------ */

const toProduct = (p: typeof products.$inferSelect, prices: (typeof productPrices.$inferSelect)[], groups: (typeof productModifierGroups.$inferSelect)[]) => ({
  id: p.id,
  brand_id: p.brandId,
  kind: p.kind,
  name: p.name,
  kitchen_name: p.kitchenName,
  sku: p.sku,
  description: p.description,
  price: p.price,
  prices_by_order_type: Object.fromEntries(prices.filter((x) => x.productId === p.id).map((x) => [x.orderType, x.price])),
  category_id: p.categoryId,
  tags: p.tags,
  has_deposit: p.hasDeposit,
  tax_class_id: p.taxClassId,
  open_price: p.openPrice,
  modifier_group_ids: groups.filter((g) => g.productId === p.id).sort((a, b) => a.sort - b.sort).map((g) => g.groupId),
  legacy_id: p.legacyId,
  archived: p.archivedAt != null,
  updated_at: p.updatedAt.toISOString(),
});
const toStock = (s: typeof stockStatus.$inferSelect, today: string) => ({
  outlet_id: s.outletId,
  product_id: s.productId,
  sold_out: !!s.soldOutUntil && s.soldOutUntil.getTime() > Date.now(),
  sold_out_until: s.soldOutUntil ? (s.soldOutUntil.getTime() > 4e12 ? "indefinite" : s.soldOutUntil.toISOString()) : null,
  daily_cap: s.dailyCap,
  cap_remaining: s.dailyCap == null ? null : s.capDate === today ? (s.capRemaining ?? 0) : s.dailyCap,
  cap_date: s.capDate,
});

async function loadProducts(rows: (typeof products.$inferSelect)[]) {
  const ids = rows.map((r) => r.id);
  const prices = ids.length ? await db().select().from(productPrices).where(inArray(productPrices.productId, ids)) : [];
  const groups = ids.length ? await db().select().from(productModifierGroups).where(inArray(productModifierGroups.productId, ids)) : [];
  return rows.map((r) => toProduct(r, prices, groups));
}

async function writePricesAndGroups(merchantId: string, productId: string, prices?: Partial<Record<string, number>>, groupIds?: string[]) {
  if (prices) {
    await db().delete(productPrices).where(eq(productPrices.productId, productId));
    const values = Object.entries(prices)
      .filter(([, v]) => v != null)
      .map(([orderType, price]) => ({ merchantId, productId, orderType: orderType as (typeof ORDER_TYPES)[number], price: price! }));
    if (values.length) await db().insert(productPrices).values(values);
  }
  if (groupIds) {
    await db().delete(productModifierGroups).where(eq(productModifierGroups.productId, productId));
    if (groupIds.length) await db().insert(productModifierGroups).values(groupIds.map((groupId, i) => ({ merchantId, productId, groupId, sort: i })));
  }
}

async function loadGroup(row: typeof modifierGroups.$inferSelect) {
  const opts = await db().select().from(modifierOptions).where(eq(modifierOptions.groupId, row.id)).orderBy(asc(modifierOptions.sort));
  return { id: row.id, name: row.name, min_select: row.minSelect, max_select: row.maxSelect, max_per_modifier: row.maxPerModifier, options: opts.map((o) => ({ product_id: o.productId, price_override: o.priceOverride, child_group_id: o.childGroupId, is_default: o.isDefault, sort: o.sort })), legacy_id: row.legacyId, archived: row.archivedAt != null };
}

async function loadMenu(row: typeof menus.$inferSelect) {
  const sections = await db().select().from(menuSections).where(eq(menuSections.menuId, row.id)).orderBy(asc(menuSections.sort), asc(menuSections.name));
  const items = await db().select().from(menuItems).where(eq(menuItems.menuId, row.id)).orderBy(asc(menuItems.sort));
  return {
    id: row.id,
    brand_id: row.brandId,
    name: row.name,
    legacy_id: row.legacyId,
    archived: row.archivedAt != null,
    sections: sections.map((s) => ({ id: s.id, name: s.name, parent_id: s.parentId, sort: s.sort, legacy_id: s.legacyId, items: items.filter((i) => i.sectionId === s.id).map((i) => ({ product_id: i.productId, sort: i.sort })) })),
  };
}

/** Replace a menu's sections and item placements. Section IDs that are reused keep their identity. */
export async function writeMenuSections(merchantId: string, menuId: string, sections: z.infer<typeof SectionInput>[]) {
  const existing = await db().select({ id: menuSections.id }).from(menuSections).where(eq(menuSections.menuId, menuId));
  const keep = new Set(sections.map((s) => s.id).filter((x): x is string => !!x));
  const drop = existing.map((e) => e.id).filter((id) => !keep.has(id));
  if (drop.length) await db().delete(menuSections).where(inArray(menuSections.id, drop));
  const idByIndex: string[] = [];
  for (let i = 0; i < sections.length; i++) {
    const s = sections[i]!;
    const parentId = s.parent_id ?? null;
    const [row] = await db()
      .insert(menuSections)
      .values({ id: s.id, merchantId, menuId, parentId, name: s.name, sort: s.sort ?? i, legacyId: s.legacy_id ?? null })
      .onConflictDoUpdate({ target: menuSections.id, set: { name: s.name, parentId, sort: s.sort ?? i, legacyId: s.legacy_id ?? null } })
      .returning({ id: menuSections.id });
    idByIndex.push(row!.id);
  }
  await db().delete(menuItems).where(eq(menuItems.menuId, menuId));
  const itemValues = sections.flatMap((s, i) => (s.items ?? []).map((it, j) => ({ merchantId, menuId, sectionId: idByIndex[i]!, productId: it.product_id, sort: it.sort ?? j })));
  if (itemValues.length) await db().insert(menuItems).values(itemValues).onConflictDoNothing();
  await db().update(menus).set({ updatedAt: new Date() }).where(eq(menus.id, menuId));
}

/* ---- Routes -------------------------------------------------------------- */

export function catalogueRoutes(app: OpenAPIHono<AppEnv>) {
  defineCrud(app, {
    group: "categories",
    path: "/v1/categories",
    tag: "catalogue",
    noun: "report category",
    table: reportCategories,
    columns: { id: reportCategories.id, merchantId: reportCategories.merchantId, archivedAt: reportCategories.archivedAt, sort: reportCategories.sort, name: reportCategories.name },
    api: CategorySchema,
    create: CategoryCreate,
    patch: CategoryPatch,
    aggregateKind: "report_category",
    toApi: (r) => ({ id: r.id, name: r.name, parent_id: r.parentId, sort: r.sort, legacy_id: r.legacyId, archived: r.archivedAt != null }),
    fromCreate: (b) => ({ id: b.id, merchantId: "", name: b.name, parentId: b.parent_id ?? null, sort: b.sort ?? 0, legacyId: b.legacy_id ?? null }),
    fromPatch: (b) => compact({ name: b.name, parentId: b.parent_id, sort: b.sort, legacyId: b.legacy_id }),
  });

  /* Products */
  defineOp(
    app,
    {
      op: "products.list",
      method: "get",
      path: "/v1/products",
      tags: ["catalogue"],
      request: {
        query: z.object({
          q: z.string().optional(),
          brand_id: z.uuid().optional(),
          category_id: z.uuid().optional(),
          tag: z.string().optional(),
          kind: z.enum(["product", "component"]).optional(),
          include_archived: z.enum(["true", "false"]).optional(),
          limit: z.coerce.number().int().min(1).max(500).default(100),
          cursor: z.string().optional(),
        }),
      },
      responses: { 200: jsonResponse(listResponse(ProductSchema).extend({ total: z.number().int() })), ...errorResponses },
    },
    async (c) => {
      const p = c.get("principal");
      const q = c.req.valid("query");
      const conds: SQL[] = [eq(products.merchantId, p.merchantId)];
      if (q.include_archived !== "true") conds.push(isNull(products.archivedAt));
      if (q.brand_id) conds.push(or(eq(products.brandId, q.brand_id), isNull(products.brandId))!);
      if (q.category_id) conds.push(eq(products.categoryId, q.category_id));
      if (q.kind) conds.push(eq(products.kind, q.kind));
      if (q.tag) conds.push(sql`${q.tag} = any(${products.tags})`);
      if (q.q) conds.push(or(ilike(products.name, `%${q.q}%`), ilike(products.sku, `%${q.q}%`))!);
      if (q.cursor) conds.push(sql`(${products.name}, ${products.id}) > (${q.cursor.split("|")[0]}, ${q.cursor.split("|")[1]}::uuid)`);
      const [count] = await db().select({ n: sql<number>`count(*)::int` }).from(products).where(and(...conds.filter((x) => !q.cursor || x !== conds[conds.length - 1])));
      const rows = await db()
        .select()
        .from(products)
        .where(and(...conds))
        .orderBy(asc(products.name), asc(products.id))
        .limit(q.limit + 1);
      const page = rows.slice(0, q.limit);
      const last = page[page.length - 1];
      return c.json({ data: await loadProducts(page), next_cursor: rows.length > q.limit && last ? `${last.name}|${last.id}` : null, total: count?.n ?? 0 }, 200);
    },
  );

  defineOp(app, { op: "products.get", method: "get", path: "/v1/products/{id}", tags: ["catalogue"], request: { params: z.object({ id: z.uuid() }) }, responses: { 200: jsonResponse(dataResponse(ProductSchema)), ...errorResponses } }, async (c) => {
    const { id } = c.req.valid("param");
    const [row] = await db().select().from(products).where(eq(products.id, id)).limit(1);
    if (!row) throw AppError.notFound("product", id);
    return c.json({ data: (await loadProducts([row]))[0]! }, 200);
  });

  defineOp(app, { op: "products.create", method: "post", path: "/v1/products", tags: ["catalogue"], request: { body: jsonBody(ProductCreate) }, responses: { 201: jsonResponse(mutationResponse(ProductSchema)), ...errorResponses } }, async (c) => {
    const p = c.get("principal");
    const b = c.req.valid("json");
    if (b.tax_class_id) await assertTaxClass(p.merchantId, b.tax_class_id, "tax_class_id");
    const [row] = await db()
      .insert(products)
      .values({ id: b.id, merchantId: p.merchantId, brandId: b.brand_id ?? null, kind: b.kind ?? "product", name: b.name, kitchenName: b.kitchen_name ?? null, sku: b.sku ?? null, description: b.description ?? null, price: b.price, categoryId: b.category_id ?? null, tags: b.tags ?? [], hasDeposit: b.has_deposit ?? false, taxClassId: b.tax_class_id ?? null, openPrice: b.open_price ?? false, legacyId: b.legacy_id ?? null })
      .returning();
    await writePricesAndGroups(p.merchantId, row!.id, b.prices_by_order_type, b.modifier_group_ids);
    const data = (await loadProducts([row!]))[0]!;
    const ev = await appendEvent({ merchantId: p.merchantId, outletId: null, type: "product.created", aggregate: { kind: "product", id: row!.id }, operationId: "products.create", payload: data, correlationId: c.get("correlationId"), idempotencyKey: c.get("idempotencyKey") }, p);
    await recordAudit(p, { action: "products.create", targetKind: "product", targetId: row!.id, details: { name: data.name, price: data.price } });
    return c.json({ data, events: [ev], warnings: [] }, 201);
  });

  defineOp(app, { op: "products.update", method: "patch", path: "/v1/products/{id}", tags: ["catalogue"], request: { params: z.object({ id: z.uuid() }), body: jsonBody(ProductPatch) }, responses: { 200: jsonResponse(mutationResponse(ProductSchema)), ...errorResponses } }, async (c) => {
    const p = c.get("principal");
    const { id } = c.req.valid("param");
    const b = c.req.valid("json");
    if (b.tax_class_id) await assertTaxClass(p.merchantId, b.tax_class_id, "tax_class_id");
    if (b.archived === false && b.tax_class_id === undefined) {
      // A product restored onto a class archived since would make every order with it fail to price.
      const [cur] = await db().select({ taxClassId: products.taxClassId }).from(products).where(and(eq(products.id, id), eq(products.merchantId, p.merchantId))).limit(1);
      if (cur?.taxClassId) await assertTaxClass(p.merchantId, cur.taxClassId, "tax_class_id");
    }
    const set = compact({ brandId: b.brand_id, kind: b.kind, name: b.name, kitchenName: b.kitchen_name, sku: b.sku, description: b.description, price: b.price, categoryId: b.category_id, tags: b.tags, hasDeposit: b.has_deposit, taxClassId: b.tax_class_id, openPrice: b.open_price, legacyId: b.legacy_id, archivedAt: b.archived === undefined ? undefined : b.archived ? new Date() : null });
    const [row] = await db()
      .update(products)
      .set({ ...set, updatedAt: new Date() })
      .where(and(eq(products.id, id), eq(products.merchantId, p.merchantId)))
      .returning();
    if (!row) throw AppError.notFound("product", id);
    await writePricesAndGroups(p.merchantId, id, b.prices_by_order_type, b.modifier_group_ids);
    const data = (await loadProducts([row]))[0]!;
    const ev = await appendEvent({ merchantId: p.merchantId, outletId: null, type: "product.updated", aggregate: { kind: "product", id }, operationId: "products.update", payload: b, correlationId: c.get("correlationId"), idempotencyKey: c.get("idempotencyKey") }, p);
    await recordAudit(p, { action: "products.update", targetKind: "product", targetId: id, details: b });
    return c.json({ data, events: [ev], warnings: [] }, 200);
  });

  defineOp(
    app,
    { op: "products.bulk_price", method: "post", path: "/v1/products/bulk-price", tags: ["catalogue"], request: { body: jsonBody(z.object({ changes: z.array(z.object({ product_id: z.uuid(), price: AmountSchema, prices_by_order_type: z.partialRecord(OrderTypeSchema, AmountSchema).optional() })).min(1).max(5000) })) }, responses: { 200: jsonResponse(mutationResponse(z.object({ updated: z.number().int() }))), ...errorResponses } },
    async (c) => {
      const p = c.get("principal");
      const { changes } = c.req.valid("json");
      let updated = 0;
      for (const ch of changes) {
        const rows = await db()
          .update(products)
          .set({ price: ch.price, updatedAt: new Date() })
          .where(and(eq(products.id, ch.product_id), eq(products.merchantId, p.merchantId)))
          .returning({ id: products.id });
        if (rows.length) {
          updated++;
          if (ch.prices_by_order_type) await writePricesAndGroups(p.merchantId, ch.product_id, ch.prices_by_order_type);
        }
      }
      const ev = await appendEvent({ merchantId: p.merchantId, outletId: null, type: "product.updated", aggregate: { kind: "catalogue", id: p.merchantId }, operationId: "products.bulk_price", payload: { count: updated }, correlationId: c.get("correlationId"), idempotencyKey: c.get("idempotencyKey") }, p);
      await recordAudit(p, { action: "products.bulk_price", targetKind: "catalogue", targetId: p.merchantId, details: { count: updated } });
      return c.json({ data: { updated }, events: [ev], warnings: [] }, 200);
    },
  );

  /* Modifier groups */
  defineOp(app, { op: "modifier_groups.list", method: "get", path: "/v1/modifier-groups", tags: ["catalogue"], request: { query: z.object({ q: z.string().optional(), include_archived: z.enum(["true", "false"]).optional(), limit: z.coerce.number().int().min(1).max(500).default(200) }) }, responses: { 200: jsonResponse(listResponse(GroupSchema)), ...errorResponses } }, async (c) => {
    const p = c.get("principal");
    const q = c.req.valid("query");
    const conds: SQL[] = [eq(modifierGroups.merchantId, p.merchantId)];
    if (q.include_archived !== "true") conds.push(isNull(modifierGroups.archivedAt));
    if (q.q) conds.push(ilike(modifierGroups.name, `%${q.q}%`));
    const rows = await db()
      .select()
      .from(modifierGroups)
      .where(and(...conds))
      .orderBy(asc(modifierGroups.name))
      .limit(q.limit);
    const ids = rows.map((r) => r.id);
    const opts = ids.length ? await db().select().from(modifierOptions).where(inArray(modifierOptions.groupId, ids)).orderBy(asc(modifierOptions.sort)) : [];
    return c.json({ data: rows.map((r) => ({ id: r.id, name: r.name, min_select: r.minSelect, max_select: r.maxSelect, max_per_modifier: r.maxPerModifier, options: opts.filter((o) => o.groupId === r.id).map((o) => ({ product_id: o.productId, price_override: o.priceOverride, child_group_id: o.childGroupId, is_default: o.isDefault, sort: o.sort })), legacy_id: r.legacyId, archived: r.archivedAt != null })), next_cursor: null }, 200);
  });

  defineOp(app, { op: "modifier_groups.get", method: "get", path: "/v1/modifier-groups/{id}", tags: ["catalogue"], request: { params: z.object({ id: z.uuid() }) }, responses: { 200: jsonResponse(dataResponse(GroupSchema)), ...errorResponses } }, async (c) => {
    const { id } = c.req.valid("param");
    const [row] = await db().select().from(modifierGroups).where(eq(modifierGroups.id, id)).limit(1);
    if (!row) throw AppError.notFound("modifier group", id);
    return c.json({ data: await loadGroup(row) }, 200);
  });

  const writeOptions = async (merchantId: string, groupId: string, options: z.infer<typeof OptionInput>[]) => {
    await db().delete(modifierOptions).where(eq(modifierOptions.groupId, groupId));
    if (options.length) await db().insert(modifierOptions).values(options.map((o, i) => ({ merchantId, groupId, productId: o.product_id, priceOverride: o.price_override ?? null, childGroupId: o.child_group_id ?? null, isDefault: o.is_default ?? false, sort: o.sort ?? i })));
  };

  defineOp(app, { op: "modifier_groups.create", method: "post", path: "/v1/modifier-groups", tags: ["catalogue"], request: { body: jsonBody(GroupCreate) }, responses: { 201: jsonResponse(mutationResponse(GroupSchema)), ...errorResponses } }, async (c) => {
    const p = c.get("principal");
    const b = c.req.valid("json");
    if (b.max_select != null && (b.min_select ?? 0) > b.max_select) throw AppError.validation("min_select cannot exceed max_select");
    const [row] = await db().insert(modifierGroups).values({ id: b.id, merchantId: p.merchantId, name: b.name, minSelect: b.min_select ?? 0, maxSelect: b.max_select ?? null, maxPerModifier: b.max_per_modifier ?? 1, legacyId: b.legacy_id ?? null }).returning();
    await writeOptions(p.merchantId, row!.id, b.options ?? []);
    const data = await loadGroup(row!);
    const ev = await appendEvent({ merchantId: p.merchantId, outletId: null, type: "modifier_group.created", aggregate: { kind: "modifier_group", id: row!.id }, operationId: "modifier_groups.create", payload: data, correlationId: c.get("correlationId"), idempotencyKey: c.get("idempotencyKey") }, p);
    await recordAudit(p, { action: "modifier_groups.create", targetKind: "modifier_group", targetId: row!.id, details: { name: data.name } });
    return c.json({ data, events: [ev], warnings: [] }, 201);
  });

  defineOp(app, { op: "modifier_groups.update", method: "patch", path: "/v1/modifier-groups/{id}", tags: ["catalogue"], request: { params: z.object({ id: z.uuid() }), body: jsonBody(GroupPatch) }, responses: { 200: jsonResponse(mutationResponse(GroupSchema)), ...errorResponses } }, async (c) => {
    const p = c.get("principal");
    const { id } = c.req.valid("param");
    const b = c.req.valid("json");
    const set = compact({ name: b.name, minSelect: b.min_select, maxSelect: b.max_select, maxPerModifier: b.max_per_modifier, legacyId: b.legacy_id, archivedAt: b.archived === undefined ? undefined : b.archived ? new Date() : null });
    if (Object.keys(set).length === 0 && !b.options) throw AppError.validation("Nothing to update");
    // Options alone change no column of the group itself: look it up instead of updating nothing.
    const [row] = Object.keys(set).length
      ? await db().update(modifierGroups).set(set).where(and(eq(modifierGroups.id, id), eq(modifierGroups.merchantId, p.merchantId))).returning()
      : await db().select().from(modifierGroups).where(and(eq(modifierGroups.id, id), eq(modifierGroups.merchantId, p.merchantId))).limit(1);
    if (!row) throw AppError.notFound("modifier group", id);
    if (row.maxSelect != null && row.minSelect > row.maxSelect) throw AppError.validation("min_select cannot exceed max_select");
    if (b.options) await writeOptions(p.merchantId, id, b.options);
    const data = await loadGroup(row);
    const ev = await appendEvent({ merchantId: p.merchantId, outletId: null, type: "modifier_group.updated", aggregate: { kind: "modifier_group", id }, operationId: "modifier_groups.update", payload: b, correlationId: c.get("correlationId"), idempotencyKey: c.get("idempotencyKey") }, p);
    await recordAudit(p, { action: "modifier_groups.update", targetKind: "modifier_group", targetId: id, details: { name: row.name } });
    return c.json({ data, events: [ev], warnings: [] }, 200);
  });

  /* Menus */
  defineOp(app, { op: "menus.list", method: "get", path: "/v1/menus", tags: ["catalogue"], request: { query: z.object({ brand_id: z.uuid().optional(), include_archived: z.enum(["true", "false"]).optional() }) }, responses: { 200: jsonResponse(listResponse(MenuSchema.omit({ sections: true }))), ...errorResponses } }, async (c) => {
    const p = c.get("principal");
    const q = c.req.valid("query");
    const conds: SQL[] = [eq(menus.merchantId, p.merchantId)];
    if (q.include_archived !== "true") conds.push(isNull(menus.archivedAt));
    if (q.brand_id) conds.push(eq(menus.brandId, q.brand_id));
    const rows = await db()
      .select()
      .from(menus)
      .where(and(...conds))
      .orderBy(asc(menus.name));
    return c.json({ data: rows.map((m) => ({ id: m.id, brand_id: m.brandId, name: m.name, legacy_id: m.legacyId, archived: m.archivedAt != null })), next_cursor: null }, 200);
  });

  defineOp(app, { op: "menus.get", method: "get", path: "/v1/menus/{id}", tags: ["catalogue"], request: { params: z.object({ id: z.uuid() }) }, responses: { 200: jsonResponse(dataResponse(MenuSchema)), ...errorResponses } }, async (c) => {
    const { id } = c.req.valid("param");
    const [row] = await db().select().from(menus).where(eq(menus.id, id)).limit(1);
    if (!row) throw AppError.notFound("menu", id);
    return c.json({ data: await loadMenu(row) }, 200);
  });

  defineOp(app, { op: "menus.create", method: "post", path: "/v1/menus", tags: ["catalogue"], request: { body: jsonBody(MenuCreate) }, responses: { 201: jsonResponse(mutationResponse(MenuSchema)), ...errorResponses } }, async (c) => {
    const p = c.get("principal");
    const b = c.req.valid("json");
    const [row] = await db().insert(menus).values({ id: b.id, merchantId: p.merchantId, brandId: b.brand_id, name: b.name, legacyId: b.legacy_id ?? null }).returning();
    if (b.sections) await writeMenuSections(p.merchantId, row!.id, b.sections);
    const data = await loadMenu(row!);
    const ev = await appendEvent({ merchantId: p.merchantId, outletId: null, type: "menu.created", aggregate: { kind: "menu", id: row!.id }, operationId: "menus.create", payload: { name: data.name, brand_id: data.brand_id }, correlationId: c.get("correlationId"), idempotencyKey: c.get("idempotencyKey") }, p);
    await recordAudit(p, { action: "menus.create", targetKind: "menu", targetId: row!.id, details: { name: data.name } });
    return c.json({ data, events: [ev], warnings: [] }, 201);
  });

  defineOp(app, { op: "menus.update", method: "patch", path: "/v1/menus/{id}", tags: ["catalogue"], request: { params: z.object({ id: z.uuid() }), body: jsonBody(MenuPatch) }, responses: { 200: jsonResponse(mutationResponse(MenuSchema)), ...errorResponses } }, async (c) => {
    const p = c.get("principal");
    const { id } = c.req.valid("param");
    const b = c.req.valid("json");
    const [row] = await db()
      .update(menus)
      .set({ ...compact({ name: b.name, archivedAt: b.archived === undefined ? undefined : b.archived ? new Date() : null }), updatedAt: new Date() })
      .where(and(eq(menus.id, id), eq(menus.merchantId, p.merchantId)))
      .returning();
    if (!row) throw AppError.notFound("menu", id);
    if (b.sections) await writeMenuSections(p.merchantId, id, b.sections);
    const data = await loadMenu(row);
    const ev = await appendEvent({ merchantId: p.merchantId, outletId: null, type: "menu.updated", aggregate: { kind: "menu", id }, operationId: "menus.update", payload: { name: b.name, archived: b.archived, sections_replaced: !!b.sections }, correlationId: c.get("correlationId"), idempotencyKey: c.get("idempotencyKey") }, p);
    await recordAudit(p, { action: "menus.update", targetKind: "menu", targetId: id, details: { name: row.name, sections_replaced: !!b.sections } });
    return c.json({ data, events: [ev], warnings: [] }, 200);
  });

  /* Availability rules */
  defineCrud(app, {
    group: "availability",
    path: "/v1/availability-rules",
    tag: "catalogue",
    noun: "availability rule",
    table: availabilityRules,
    columns: { id: availabilityRules.id, merchantId: availabilityRules.merchantId },
    api: AvailabilitySchema,
    create: AvailabilityCreate,
    patch: AvailabilityPatch,
    aggregateKind: "availability_rule",
    listQuery: z.object({ target_id: z.uuid().optional() }),
    listWhere: (q) => (q.target_id ? [eq(availabilityRules.targetId, q.target_id as string)] : []),
    toApi: (r) => ({ id: r.id, target_kind: r.targetKind, target_id: r.targetId, outlet_ids: r.outletIds, channels: r.channels, days_of_week: r.daysOfWeek, start_time: r.startTime, end_time: r.endTime }),
    fromCreate: (b) => ({ id: b.id, merchantId: "", targetKind: b.target_kind, targetId: b.target_id, outletIds: b.outlet_ids ?? [], channels: b.channels ?? [], daysOfWeek: b.days_of_week ?? [], startTime: b.start_time ?? null, endTime: b.end_time ?? null }),
    fromPatch: (b) => compact({ outletIds: b.outlet_ids, channels: b.channels, daysOfWeek: b.days_of_week, startTime: b.start_time, endTime: b.end_time }),
  });

  /* Compiled menu */
  defineOp(app, { op: "menu.get", method: "get", path: "/v1/channel-links/{id}/menu", tags: ["catalogue"], request: { params: z.object({ id: z.uuid() }) }, responses: { 200: jsonResponse(z.object({ data: z.record(z.string(), z.unknown()) })), ...errorResponses } }, async (c) => {
    const p = c.get("principal");
    const { id } = c.req.valid("param");
    const menu = await compileMenu(id, new Date());
    if (!(await outletVisible(p, menu.channel_link.outlet_id))) throw AppError.notFound("channel link", id);
    c.header("etag", `"${menu.version}"`);
    return c.json({ data: menu }, 200);
  });

  /* Stock primitives */
  const stockBody = z.object({ outlet_id: z.uuid(), product_id: z.uuid() });
  // Caps and "sold out for today" are per business day (the outlet's cutoff), the same date lines.add and rounds.submit use.
  const todayFor = (merchantId: string, outletId: string) => businessToday(merchantId, outletId);

  defineOp(app, { op: "stock.list", method: "get", path: "/v1/outlets/{id}/stock", tags: ["stock"], request: { params: z.object({ id: z.uuid() }) }, responses: { 200: jsonResponse(listResponse(StockSchema)), ...errorResponses } }, async (c) => {
    const p = c.get("principal");
    const { id } = c.req.valid("param");
    if (!(await outletVisible(p, id))) throw AppError.notFound("outlet", id);
    const { today } = await todayFor(p.merchantId, id);
    const rows = await db().select().from(stockStatus).where(eq(stockStatus.outletId, id)).orderBy(desc(stockStatus.updatedAt));
    return c.json({ data: rows.map((s) => toStock(s, today)).filter((s) => s.sold_out || s.daily_cap != null), next_cursor: null }, 200);
  });

  defineOp(
    app,
    { op: "stock.mark_sold_out", method: "post", path: "/v1/stock/sold-out", tags: ["stock"], request: { body: jsonBody(stockBody.extend({ until: z.union([z.literal("today"), z.literal("indefinite"), z.iso.datetime()]) })) }, responses: { 200: jsonResponse(mutationResponse(StockSchema)), ...errorResponses } },
    async (c) => {
      const p = c.get("principal");
      const b = c.req.valid("json");
      if (!(await outletVisible(p, b.outlet_id))) throw AppError.notFound("outlet", b.outlet_id);
      const { bd, today } = await todayFor(p.merchantId, b.outlet_id);
      let until: Date;
      if (b.until === "indefinite") until = new Date("9999-12-31T00:00:00Z");
      else if (b.until === "today") until = nextCutoff(new Date(), bd.cutoff, bd.timeZone); // until the next business-day cutoff at the outlet
      else until = new Date(b.until);
      const [row] = await db()
        .insert(stockStatus)
        .values({ merchantId: p.merchantId, outletId: b.outlet_id, productId: b.product_id, soldOutUntil: until })
        .onConflictDoUpdate({ target: [stockStatus.outletId, stockStatus.productId], set: { soldOutUntil: until, updatedAt: new Date() } })
        .returning();
      const data = toStock(row!, today);
      const ev = await appendEvent({ merchantId: p.merchantId, outletId: b.outlet_id, type: "stock.sold_out", aggregate: { kind: "product", id: b.product_id }, operationId: "stock.mark_sold_out", payload: data, correlationId: c.get("correlationId"), idempotencyKey: c.get("idempotencyKey"), businessDay: bd }, p);
      await recordAudit(p, { action: "stock.mark_sold_out", targetKind: "product", targetId: b.product_id, outletId: b.outlet_id, details: { until: b.until } });
      return c.json({ data, events: [ev], warnings: [] }, 200);
    },
  );

  defineOp(app, { op: "stock.restore", method: "post", path: "/v1/stock/restore", tags: ["stock"], request: { body: jsonBody(stockBody) }, responses: { 200: jsonResponse(mutationResponse(StockSchema)), ...errorResponses } }, async (c) => {
    const p = c.get("principal");
    const b = c.req.valid("json");
    if (!(await outletVisible(p, b.outlet_id))) throw AppError.notFound("outlet", b.outlet_id);
    const { bd, today } = await todayFor(p.merchantId, b.outlet_id);
    const [row] = await db()
      .insert(stockStatus)
      .values({ merchantId: p.merchantId, outletId: b.outlet_id, productId: b.product_id, soldOutUntil: null })
      .onConflictDoUpdate({ target: [stockStatus.outletId, stockStatus.productId], set: { soldOutUntil: null, updatedAt: new Date() } })
      .returning();
    const data = toStock(row!, today);
    const ev = await appendEvent({ merchantId: p.merchantId, outletId: b.outlet_id, type: "stock.restored", aggregate: { kind: "product", id: b.product_id }, operationId: "stock.restore", payload: data, correlationId: c.get("correlationId"), idempotencyKey: c.get("idempotencyKey"), businessDay: bd }, p);
    await recordAudit(p, { action: "stock.restore", targetKind: "product", targetId: b.product_id, outletId: b.outlet_id });
    return c.json({ data, events: [ev], warnings: [] }, 200);
  });

  defineOp(app, { op: "stock.set_daily_cap", method: "post", path: "/v1/stock/daily-cap", tags: ["stock"], request: { body: jsonBody(stockBody.extend({ quantity: z.number().int().min(0).nullable() })) }, responses: { 200: jsonResponse(mutationResponse(StockSchema)), ...errorResponses } }, async (c) => {
    const p = c.get("principal");
    const b = c.req.valid("json");
    if (!(await outletVisible(p, b.outlet_id))) throw AppError.notFound("outlet", b.outlet_id);
    const { bd, today } = await todayFor(p.merchantId, b.outlet_id);
    const [row] = await db()
      .insert(stockStatus)
      .values({ merchantId: p.merchantId, outletId: b.outlet_id, productId: b.product_id, dailyCap: b.quantity, capRemaining: b.quantity, capDate: today })
      .onConflictDoUpdate({ target: [stockStatus.outletId, stockStatus.productId], set: { dailyCap: b.quantity, capRemaining: b.quantity, capDate: today, updatedAt: new Date() } })
      .returning();
    const data = toStock(row!, today);
    const ev = await appendEvent({ merchantId: p.merchantId, outletId: b.outlet_id, type: "stock.cap_set", aggregate: { kind: "product", id: b.product_id }, operationId: "stock.set_daily_cap", payload: data, correlationId: c.get("correlationId"), idempotencyKey: c.get("idempotencyKey"), businessDay: bd }, p);
    await recordAudit(p, { action: "stock.set_daily_cap", targetKind: "product", targetId: b.product_id, outletId: b.outlet_id, details: { quantity: b.quantity } });
    return c.json({ data, events: [ev], warnings: [] }, 200);
  });
}

/**
 * Decrement a daily cap by `qty` for today, atomically. Returns false when the
 * remaining cap is insufficient (the CHECK constraint also guards it).
 */
export async function consumeDailyCap(outletId: string, productId: string, qty: number, today: string): Promise<{ ok: boolean; remaining: number | null }> {
  const rows = await tx()<{ cap_remaining: number | null; daily_cap: number | null }[]>`
    update stock_status
    set cap_remaining = (case when cap_date = ${today} then cap_remaining else daily_cap end) - ${qty}, cap_date = ${today}, updated_at = now()
    where outlet_id = ${outletId} and product_id = ${productId} and daily_cap is not null
      and (case when cap_date = ${today} then cap_remaining else daily_cap end) >= ${qty}
    returning cap_remaining, daily_cap`;
  if (rows.length) return { ok: true, remaining: rows[0]!.cap_remaining };
  const [st] = await tx()<{ cap_remaining: number | null; daily_cap: number | null; cap_date: string | null }[]>`select cap_remaining, daily_cap, cap_date from stock_status where outlet_id = ${outletId} and product_id = ${productId}`;
  if (!st || st.daily_cap == null) return { ok: true, remaining: null };
  return { ok: false, remaining: st.cap_date === today ? (st.cap_remaining ?? 0) : st.daily_cap };
}

/** Release cap units (void before firing). */
export async function releaseDailyCap(outletId: string, productId: string, qty: number, today: string) {
  await tx()`update stock_status set cap_remaining = least(daily_cap, coalesce(cap_remaining, 0) + ${qty}), updated_at = now() where outlet_id = ${outletId} and product_id = ${productId} and daily_cap is not null and cap_date = ${today}`;
}

registerOperations({
  "availability.delete": { op: "availability.delete", summary: "Delete an availability rule", description: "Removes the rule; the product or section becomes always available again when no rules remain.", tier: "T3", minRole: "admin", overrideAllowed: false, reasonRequired: false, dryRun: false, principals: ["staff", "agent"], emits: ["availability_rule.deleted"], mcp: { expose: false, toolsets: [] } },
});
export function availabilityDeleteRoute(app: OpenAPIHono<AppEnv>) {
  defineOp(app, { op: "availability.delete", method: "delete", path: "/v1/availability-rules/{id}", tags: ["catalogue"], request: { params: z.object({ id: z.uuid() }), body: jsonBody(z.object({}).passthrough()) }, responses: { 200: jsonResponse(mutationResponse(z.object({ id: z.string() }))), ...errorResponses } }, async (c) => {
    const p = c.get("principal");
    const { id } = c.req.valid("param");
    const rows = await db().delete(availabilityRules).where(and(eq(availabilityRules.id, id), eq(availabilityRules.merchantId, p.merchantId))).returning({ id: availabilityRules.id, targetId: availabilityRules.targetId });
    if (!rows.length) throw AppError.notFound("availability rule", id);
    const ev = await appendEvent({ merchantId: p.merchantId, outletId: null, type: "availability_rule.deleted", aggregate: { kind: "availability_rule", id }, operationId: "availability.delete", payload: { target_id: rows[0]!.targetId }, correlationId: c.get("correlationId"), idempotencyKey: c.get("idempotencyKey") }, p);
    await recordAudit(p, { action: "availability.delete", targetKind: "availability_rule", targetId: id });
    return c.json({ data: { id }, events: [ev], warnings: [] }, 200);
  });
}
