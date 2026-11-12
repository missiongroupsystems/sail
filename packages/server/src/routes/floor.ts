import type { OpenAPIHono } from "@hono/zod-openapi";
import { and, asc, eq, isNull, type SQL } from "drizzle-orm";
import { AccessLevelSchema, ChannelTypeSchema, registerOperations } from "@sail/shared";
import { db } from "../db/client.js";
import { areas, channelLinks, posLayouts, tables, tenderTypes, voidReasons, type LayoutPage, type LayoutTile } from "../db/schema/index.js";
import { AppError } from "../lib/errors.js";
import type { AppEnv } from "../lib/context.js";
import { dataResponse, defineOp, errorResponses, jsonBody, jsonResponse, listResponse, mutationResponse, z } from "../lib/openapi.js";
import { appendEvent } from "../lib/events.js";
import { recordAudit } from "../lib/audit.js";
import { compact, defineCrud } from "../lib/crud.js";

/** The 12 curated tile colours (design 7.3); the importer maps legacy colours to the nearest one. */
export const TILE_COLOURS = ["slate", "stone", "brass", "amber", "olive", "sage", "teal", "sky", "indigo", "plum", "rose", "brick"] as const;

registerOperations({
  "layouts.list": { op: "layouts.list", summary: "List POS layouts", description: "Layouts per brand: pages > folders > tiles with colour and access level.", tier: "T0", minRole: null, overrideAllowed: false, reasonRequired: false, dryRun: false, principals: ["staff", "station", "agent"], emits: [], mcp: { expose: true, toolsets: ["pos.read", "config.author"] } },
  "layouts.get": { op: "layouts.get", summary: "Get a POS layout", tier: "T0", minRole: null, overrideAllowed: false, reasonRequired: false, dryRun: false, principals: ["staff", "station", "agent"], emits: [], description: "Pages, folders and tiles for one layout. Stations cache it with the menu.", mcp: { expose: true, toolsets: ["pos.read", "config.author"] } },
  "layouts.create": { op: "layouts.create", summary: "Create a POS layout", description: "Creates a layout for a brand.", tier: "T3", minRole: "admin", overrideAllowed: false, reasonRequired: false, dryRun: false, principals: ["staff", "agent"], emits: ["layout.created"], mcp: { expose: false, toolsets: [] } },
  "layouts.update": { op: "layouts.update", summary: "Update a POS layout", description: "Replaces the pages and tiles (the grid editor saves through this) or renames/archives the layout.", tier: "T3", minRole: "admin", overrideAllowed: false, reasonRequired: false, dryRun: false, principals: ["staff", "agent"], emits: ["layout.updated"], mcp: { expose: false, toolsets: [] } },
});

const tileBase = { id: z.string().min(1), label: z.string().min(1), color: z.enum(TILE_COLOURS), access_level: AccessLevelSchema };
const ProductTileSchema = z.object({ ...tileBase, kind: z.literal("product"), product_id: z.string().min(1) });
/** Folders hold product tiles only: pages > folders > tiles, never deeper. */
const FolderTileSchema = z.object({ ...tileBase, kind: z.literal("folder"), tiles: z.array(ProductTileSchema) });
const TileSchema = z.union([ProductTileSchema, FolderTileSchema]) as unknown as z.ZodType<LayoutTile>;
const PageSchema: z.ZodType<LayoutPage> = z.object({ id: z.string().min(1), name: z.string().min(1), tiles: z.array(TileSchema) });
const LayoutSchema = z.object({ id: z.string(), brand_id: z.string(), name: z.string(), pages: z.array(PageSchema), version: z.number().int(), legacy_id: z.string().nullable(), archived: z.boolean(), updated_at: z.string() });
const LayoutCreate = z.object({ id: z.uuid().optional(), brand_id: z.uuid(), name: z.string().min(1), pages: z.array(PageSchema).optional(), legacy_id: z.string().nullable().optional() });
const LayoutPatch = z.object({ name: z.string().min(1).optional(), pages: z.array(PageSchema).optional(), archived: z.boolean().optional() });

const toLayout = (l: typeof posLayouts.$inferSelect) => ({ id: l.id, brand_id: l.brandId, name: l.name, pages: l.pages, version: l.version, legacy_id: l.legacyId, archived: l.archivedAt != null, updated_at: l.updatedAt.toISOString() });

function validatePages(pages: LayoutPage[]) {
  const walk = (tiles: LayoutTile[], depth: number) => {
    for (const t of tiles) {
      if (t.kind === "product" && !t.product_id) throw AppError.validation(`tile "${t.label}" needs a product_id`);
      if (t.kind === "folder") {
        if (depth >= 1) throw AppError.validation(`folder "${t.label}" is nested too deep: pages > folders > tiles only`);
        walk(t.tiles ?? [], depth + 1);
      }
    }
  };
  for (const p of pages) walk(p.tiles, 0);
}

export function floorRoutes(app: OpenAPIHono<AppEnv>) {
  const AreaSchema = z.object({ id: z.string(), outlet_id: z.string(), name: z.string(), sort: z.number().int(), legacy_id: z.string().nullable() });
  defineCrud(app, {
    group: "areas",
    path: "/v1/areas",
    tag: "floor",
    noun: "area",
    table: areas,
    columns: { id: areas.id, merchantId: areas.merchantId, outletId: areas.outletId, sort: areas.sort, name: areas.name },
    api: AreaSchema,
    create: z.object({ id: z.uuid().optional(), outlet_id: z.uuid(), name: z.string().min(1), sort: z.number().int().optional(), legacy_id: z.string().nullable().optional() }),
    patch: z.object({ name: z.string().min(1).optional(), sort: z.number().int().optional() }),
    aggregateKind: "area",
    toApi: (r) => ({ id: r.id, outlet_id: r.outletId, name: r.name, sort: r.sort, legacy_id: r.legacyId }),
    fromCreate: (b) => ({ id: b.id, merchantId: "", outletId: b.outlet_id, name: b.name, sort: b.sort ?? 0, legacyId: b.legacy_id ?? null }),
    fromPatch: (b) => compact({ name: b.name, sort: b.sort }),
  });

  const TableSchema = z.object({ id: z.string(), outlet_id: z.string(), area_id: z.string(), name: z.string(), seats: z.number().int(), shape: z.string(), x: z.number().int(), y: z.number().int(), w: z.number().int(), h: z.number().int(), legacy_id: z.string().nullable(), archived: z.boolean() });
  const TableCreate = z.object({ id: z.uuid().optional(), outlet_id: z.uuid(), area_id: z.uuid(), name: z.string().min(1), seats: z.number().int().min(1).optional(), shape: z.enum(["rect", "round", "square"]).optional(), x: z.number().int().min(0).optional(), y: z.number().int().min(0).optional(), w: z.number().int().min(1).optional(), h: z.number().int().min(1).optional(), legacy_id: z.string().nullable().optional() });
  defineCrud(app, {
    group: "tables",
    path: "/v1/tables",
    tag: "floor",
    noun: "table",
    table: tables,
    columns: { id: tables.id, merchantId: tables.merchantId, outletId: tables.outletId, archivedAt: tables.archivedAt, name: tables.name },
    api: TableSchema,
    create: TableCreate,
    patch: TableCreate.omit({ id: true, outlet_id: true }).partial(),
    aggregateKind: "table",
    toApi: (r) => ({ id: r.id, outlet_id: r.outletId, area_id: r.areaId, name: r.name, seats: r.seats, shape: r.shape, x: r.x, y: r.y, w: r.w, h: r.h, legacy_id: r.legacyId, archived: r.archivedAt != null }),
    fromCreate: (b) => ({ id: b.id, merchantId: "", outletId: b.outlet_id, areaId: b.area_id, name: b.name, seats: b.seats ?? 4, shape: b.shape ?? "rect", x: b.x ?? 0, y: b.y ?? 0, w: b.w ?? 2, h: b.h ?? 2, legacyId: b.legacy_id ?? null }),
    fromPatch: (b) => compact({ areaId: b.area_id, name: b.name, seats: b.seats, shape: b.shape, x: b.x, y: b.y, w: b.w, h: b.h, legacyId: b.legacy_id }),
    listQuery: z.object({ area_id: z.uuid().optional() }),
    listWhere: (q) => (q.area_id ? [eq(tables.areaId, q.area_id as string)] : []),
  });

  const TenderSchema = z.object({ id: z.string(), name: z.string(), is_cash: z.boolean(), opens_drawer: z.boolean(), is_terminal: z.boolean(), requires_approval: z.boolean(), requires_reference: z.boolean(), sort: z.number().int(), legacy_id: z.string().nullable(), archived: z.boolean() });
  // requires_approval defaults to on for a tender that is neither cash nor a card terminal (a house account).
  const TenderCreate = z.object({ id: z.uuid().optional(), name: z.string().min(1), is_cash: z.boolean().optional(), opens_drawer: z.boolean().optional(), is_terminal: z.boolean().optional(), requires_approval: z.boolean().optional(), requires_reference: z.boolean().optional(), sort: z.number().int().optional(), legacy_id: z.string().nullable().optional() });
  defineCrud(app, {
    group: "tender_types",
    path: "/v1/tender-types",
    tag: "reference",
    noun: "tender type",
    table: tenderTypes,
    columns: { id: tenderTypes.id, merchantId: tenderTypes.merchantId, archivedAt: tenderTypes.archivedAt, sort: tenderTypes.sort, name: tenderTypes.name },
    api: TenderSchema,
    create: TenderCreate,
    patch: TenderCreate.omit({ id: true }).partial(),
    aggregateKind: "tender_type",
    toApi: (r) => ({ id: r.id, name: r.name, is_cash: r.isCash, opens_drawer: r.opensDrawer, is_terminal: r.isTerminal, requires_approval: r.requiresApproval, requires_reference: r.requiresReference, sort: r.sort, legacy_id: r.legacyId, archived: r.archivedAt != null }),
    fromCreate: (b) => ({ id: b.id, merchantId: "", name: b.name, isCash: b.is_cash ?? false, opensDrawer: b.opens_drawer ?? b.is_cash ?? false, isTerminal: b.is_terminal ?? false, requiresApproval: b.requires_approval ?? (!b.is_cash && !b.is_terminal), requiresReference: b.requires_reference ?? false, sort: b.sort ?? 0, legacyId: b.legacy_id ?? null }),
    fromPatch: (b) => compact({ name: b.name, isCash: b.is_cash, opensDrawer: b.opens_drawer, isTerminal: b.is_terminal, requiresApproval: b.requires_approval, requiresReference: b.requires_reference, sort: b.sort, legacyId: b.legacy_id }),
  });

  const ReasonSchema = z.object({ id: z.string(), name: z.string(), for_refunds: z.boolean(), sort: z.number().int(), legacy_id: z.string().nullable(), archived: z.boolean() });
  const ReasonCreate = z.object({ id: z.uuid().optional(), name: z.string().min(1), for_refunds: z.boolean().optional(), sort: z.number().int().optional(), legacy_id: z.string().nullable().optional() });
  defineCrud(app, {
    group: "void_reasons",
    path: "/v1/void-reasons",
    tag: "reference",
    noun: "void reason",
    table: voidReasons,
    columns: { id: voidReasons.id, merchantId: voidReasons.merchantId, archivedAt: voidReasons.archivedAt, sort: voidReasons.sort, name: voidReasons.name },
    api: ReasonSchema,
    create: ReasonCreate,
    patch: ReasonCreate.omit({ id: true }).partial(),
    aggregateKind: "void_reason",
    toApi: (r) => ({ id: r.id, name: r.name, for_refunds: r.forRefunds, sort: r.sort, legacy_id: r.legacyId, archived: r.archivedAt != null }),
    fromCreate: (b) => ({ id: b.id, merchantId: "", name: b.name, forRefunds: b.for_refunds ?? true, sort: b.sort ?? 0, legacyId: b.legacy_id ?? null }),
    fromPatch: (b) => compact({ name: b.name, forRefunds: b.for_refunds, sort: b.sort, legacyId: b.legacy_id }),
  });

  const LinkSchema = z.object({ id: z.string(), channel: ChannelTypeSchema, outlet_id: z.string(), brand_id: z.string(), menu_id: z.string(), enabled: z.boolean(), hold_orders: z.boolean(), open_on_first_scan: z.boolean(), service_requests: z.array(z.string()), service_request_printer_id: z.string().nullable() });
  const LinkCreate = z.object({ id: z.uuid().optional(), channel: ChannelTypeSchema, outlet_id: z.uuid(), brand_id: z.uuid(), menu_id: z.uuid(), enabled: z.boolean().optional(), hold_orders: z.boolean().optional(), open_on_first_scan: z.boolean().optional(), service_requests: z.array(z.string().min(1)).max(5).optional(), service_request_printer_id: z.uuid().nullable().optional() });
  defineCrud(app, {
    group: "channel_links",
    path: "/v1/channel-links",
    tag: "channels",
    noun: "channel link",
    table: channelLinks,
    columns: { id: channelLinks.id, merchantId: channelLinks.merchantId, outletId: channelLinks.outletId },
    api: LinkSchema,
    create: LinkCreate,
    patch: LinkCreate.omit({ id: true, channel: true, outlet_id: true, brand_id: true }).partial(),
    aggregateKind: "channel_link",
    // A paired station reads its POS link before anyone signs in, to warm the menu on the lock screen.
    roles: { read: null },
    principals: { read: ["staff", "station", "agent"] },
    listQuery: z.object({ channel: ChannelTypeSchema.optional(), brand_id: z.uuid().optional() }),
    listWhere: (q) => {
      const c: SQL[] = [];
      if (q.channel) c.push(eq(channelLinks.channel, q.channel as "pos"));
      if (q.brand_id) c.push(eq(channelLinks.brandId, q.brand_id as string));
      return c;
    },
    toApi: (r) => ({ id: r.id, channel: r.channel, outlet_id: r.outletId, brand_id: r.brandId, menu_id: r.menuId, enabled: r.enabled, hold_orders: r.holdOrders, open_on_first_scan: r.openOnFirstScan, service_requests: r.serviceRequests, service_request_printer_id: r.serviceRequestPrinterId }),
    fromCreate: (b) => ({ id: b.id, merchantId: "", channel: b.channel, outletId: b.outlet_id, brandId: b.brand_id, menuId: b.menu_id, enabled: b.enabled ?? true, holdOrders: b.hold_orders ?? true, openOnFirstScan: b.open_on_first_scan ?? false, serviceRequests: b.service_requests ?? [], serviceRequestPrinterId: b.service_request_printer_id ?? null }),
    fromPatch: (b) => compact({ menuId: b.menu_id, enabled: b.enabled, holdOrders: b.hold_orders, openOnFirstScan: b.open_on_first_scan, serviceRequests: b.service_requests, serviceRequestPrinterId: b.service_request_printer_id }),
  });

  /* Layouts */
  defineOp(app, { op: "layouts.list", method: "get", path: "/v1/layouts", tags: ["layouts"], request: { query: z.object({ brand_id: z.uuid().optional(), include_archived: z.enum(["true", "false"]).optional() }) }, responses: { 200: jsonResponse(listResponse(LayoutSchema.omit({ pages: true }))), ...errorResponses } }, async (c) => {
    const p = c.get("principal");
    const q = c.req.valid("query");
    const conds: SQL[] = [eq(posLayouts.merchantId, p.merchantId)];
    if (q.include_archived !== "true") conds.push(isNull(posLayouts.archivedAt));
    if (q.brand_id) conds.push(eq(posLayouts.brandId, q.brand_id));
    const rows = await db()
      .select()
      .from(posLayouts)
      .where(and(...conds))
      .orderBy(asc(posLayouts.name));
    return c.json({ data: rows.map((l) => ({ id: l.id, brand_id: l.brandId, name: l.name, version: l.version, legacy_id: l.legacyId, archived: l.archivedAt != null, updated_at: l.updatedAt.toISOString() })), next_cursor: null }, 200);
  });

  defineOp(app, { op: "layouts.get", method: "get", path: "/v1/layouts/{id}", tags: ["layouts"], request: { params: z.object({ id: z.uuid() }) }, responses: { 200: jsonResponse(dataResponse(LayoutSchema)), ...errorResponses } }, async (c) => {
    const { id } = c.req.valid("param");
    const [row] = await db().select().from(posLayouts).where(eq(posLayouts.id, id)).limit(1);
    if (!row) throw AppError.notFound("layout", id);
    c.header("etag", `"${row.version}"`);
    return c.json({ data: toLayout(row) }, 200);
  });

  defineOp(app, { op: "layouts.create", method: "post", path: "/v1/layouts", tags: ["layouts"], request: { body: jsonBody(LayoutCreate) }, responses: { 201: jsonResponse(mutationResponse(LayoutSchema)), ...errorResponses } }, async (c) => {
    const p = c.get("principal");
    const b = c.req.valid("json");
    validatePages(b.pages ?? []);
    const [row] = await db().insert(posLayouts).values({ id: b.id, merchantId: p.merchantId, brandId: b.brand_id, name: b.name, pages: b.pages ?? [], legacyId: b.legacy_id ?? null }).returning();
    const ev = await appendEvent({ merchantId: p.merchantId, outletId: null, type: "layout.created", aggregate: { kind: "layout", id: row!.id, version: 1 }, operationId: "layouts.create", payload: { name: b.name, brand_id: b.brand_id }, correlationId: c.get("correlationId"), idempotencyKey: c.get("idempotencyKey") }, p);
    await recordAudit(p, { action: "layouts.create", targetKind: "layout", targetId: row!.id, details: { name: b.name } });
    return c.json({ data: toLayout(row!), events: [ev], warnings: [] }, 201);
  });

  defineOp(app, { op: "layouts.update", method: "patch", path: "/v1/layouts/{id}", tags: ["layouts"], request: { params: z.object({ id: z.uuid() }), body: jsonBody(LayoutPatch) }, responses: { 200: jsonResponse(mutationResponse(LayoutSchema)), ...errorResponses } }, async (c) => {
    const p = c.get("principal");
    const { id } = c.req.valid("param");
    const b = c.req.valid("json");
    if (b.pages) validatePages(b.pages);
    const [cur] = await db().select({ version: posLayouts.version }).from(posLayouts).where(and(eq(posLayouts.id, id), eq(posLayouts.merchantId, p.merchantId))).limit(1);
    if (!cur) throw AppError.notFound("layout", id);
    const [row] = await db()
      .update(posLayouts)
      .set({ ...compact({ name: b.name, pages: b.pages, archivedAt: b.archived === undefined ? undefined : b.archived ? new Date() : null }), version: cur.version + 1, updatedAt: new Date() })
      .where(eq(posLayouts.id, id))
      .returning();
    const ev = await appendEvent({ merchantId: p.merchantId, outletId: null, type: "layout.updated", aggregate: { kind: "layout", id, version: row!.version }, operationId: "layouts.update", payload: { name: b.name, pages_replaced: !!b.pages, archived: b.archived }, correlationId: c.get("correlationId"), idempotencyKey: c.get("idempotencyKey") }, p);
    await recordAudit(p, { action: "layouts.update", targetKind: "layout", targetId: id, details: { pages_replaced: !!b.pages } });
    return c.json({ data: toLayout(row!), events: [ev], warnings: [] }, 200);
  });
}
