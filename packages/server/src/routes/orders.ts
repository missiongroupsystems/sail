import type { OpenAPIHono } from "@hono/zod-openapi";
import { and, asc, desc, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import { ORDER_STATUSES, OrderTypeSchema, PERMISSIONS, PricingRuleSchema, isFreezable, price, PricingContextSchema, registerOperations, roleAtLeast, validateManualApplication, type OrderType, type OperationSpec, type Role } from "@sail/shared";
import { db, markDryRun, settleInvariants, tx } from "../db/client.js";
import { areas, channelLinks, customerGroupMembers, customers, merchantSettings, orderLines, orderManualApplications, orders, stations, tables, voidReasons } from "../db/schema/index.js";
import { AppError } from "../lib/errors.js";
import type { AppContext, AppEnv } from "../lib/context.js";
import { dataResponse, defineOp, errorResponses, jsonBody, jsonResponse, listResponse, mutationResponse, z } from "../lib/openapi.js";
import { appendEvent, type AppendedEvent } from "../lib/events.js";
import { recordAudit } from "../lib/audit.js";
import { principalCanSeeOutlet, principalRole, type Principal } from "../auth/principal.js";
import { compileMenu } from "../services/menu.js";
import { buildLines, resolveModifiers, type LineInput } from "../services/lines.js";
import { bumpVersion, getOrderRow, loadSnapshot, lockOrder, nextOrderNo, OPEN_STATUSES, openOrderForTable, orderClosed, paidTotal, repriceOrder, resolveUnitPrice, tableExists, type OrderSnapshot } from "../services/orders.js";
import { assertAdjustmentUnlocked, assertLineUnlocked } from "../services/checks.js";
import { requireRoleOrOverride } from "../services/overrides.js";
import { activeRules } from "../services/pricing-rules.js";
import { releaseDailyCap } from "./catalogue.js";
import { businessDayInputs } from "./org.js";
import { businessDateFor, localParts } from "../lib/time.js";

const op = (o: Partial<OperationSpec> & { op: string; summary: string; description: string }): OperationSpec => ({ tier: "T1", minRole: "server", overrideAllowed: false, reasonRequired: false, dryRun: true, principals: ["staff", "agent"], emits: [], mcp: { expose: true, toolsets: ["pos.order"] }, ...o });

registerOperations({
  "orders.open": op({ op: "orders.open", summary: "Open an order", description: "Opens an order of one type (dine-in with a table and pax; takeaway with an optional name; pickup with a customer reference and ready-by; delivery with address). Returns the priced snapshot. At most one open dine-in order per table.", emits: ["order.opened"] }),
  "orders.get": op({ op: "orders.get", summary: "Get an order snapshot", description: "The priced order: lines, adjustments, totals, checks, payments and balance. Amounts come from the register; never recompute them.", tier: "T0", principals: ["staff", "station", "agent"], mcp: { expose: true, toolsets: ["pos.read"] } }),
  "orders.list": op({ op: "orders.list", summary: "List orders", description: "Orders of an outlet by status, type, table, business date or search; takeaway/pickup/delivery sorted by ready-by.", tier: "T0", principals: ["staff", "station", "agent"], mcp: { expose: true, toolsets: ["pos.read", "reports"] } }),
  "orders.quote": op({ op: "orders.quote", summary: "Quote an order with the full pricing trace", description: "Re-runs the pricing pipeline on the order's current lines (optionally with hypothetical extra lines) and returns totals with every step. Pure: writes nothing.", tier: "T0", dryRun: false, principals: ["staff", "station", "agent"], mcp: { expose: true, toolsets: ["pos.read"] } }),
  "orders.update_details": op({ op: "orders.update_details", summary: "Update order details", description: "Pax, customer reference, ready-by, delivery address, notes. Fields must be valid for the order type.", emits: ["order.details_updated"] }),
  "orders.change_type": op({ op: "orders.change_type", summary: "Change the order type", description: "Re-prices with the new type's prices and fees. Blocked after the first payment.", emits: ["order.type_changed", "order.repriced"] }),
  "orders.attach_customer": op({ op: "orders.attach_customer", summary: "Attach a customer", description: "Customer-group conditions re-evaluate; frozen order-level results stay frozen.", emits: ["order.customer_attached", "order.repriced"] }),
  "orders.detach_customer": op({ op: "orders.detach_customer", summary: "Detach the customer", description: "Removes the customer; group discounts re-evaluate.", emits: ["order.customer_detached", "order.repriced"] }),
  "orders.move_table": op({ op: "orders.move_table", summary: "Move an order to another table", description: "The target table must have no open order.", emits: ["order.moved"] }),
  "orders.fire": op({ op: "orders.fire", summary: "Send lines to the kitchen", description: "Fires the given lines (default: every pending, unheld line). Creates one print job per target printer in the same transaction. On a pay-before-firing station, blocked until the balance is 0.", tier: "T2", emits: ["order.fired", "print_job.created"], mcp: { expose: true, toolsets: ["pos.order", "kitchen"] } }),
  "orders.mark_ready": op({ op: "orders.mark_ready", summary: "Mark an order ready", description: "From fired to ready (pickup and delivery lists).", emits: ["order.status_changed"], mcp: { expose: true, toolsets: ["pos.order", "kitchen"] } }),
  "orders.mark_out_for_delivery": op({ op: "orders.mark_out_for_delivery", summary: "Mark a delivery order out for delivery", description: "Delivery orders only, from ready.", emits: ["order.status_changed"] }),
  "orders.cancel": op({ op: "orders.cancel", summary: "Cancel an order", description: "Only with no payments and no fired lines (void fired lines first, which needs Manager+). Releases daily caps.", tier: "T2", reasonRequired: true, emits: ["order.cancelled"] }),
  "lines.add": op({ op: "lines.add", summary: "Add lines to an order", description: "All-or-nothing: every line must be on the channel's menu, available, not sold out, within its daily cap, and have valid modifiers (min/max, nesting to 2 levels). Open prices need Manager+ (or an override). Returns the re-priced snapshot.", emits: ["line.added", "order.repriced"] }),
  "lines.update": op({ op: "lines.update", summary: "Update an unsent line", description: "Quantity, notes, seat, hold/unhold or modifiers on a line that has not been sent to the kitchen. Caps are re-checked on a quantity increase.", emits: ["line.updated", "order.repriced"] }),
  "lines.void": op({ op: "lines.void", summary: "Remove or void a line", description: "A reason is required. Before sending: Server+ and the daily cap is released. After sending: Manager+ or a manager override, and a void ticket prints to the printers that got the item. Not on a line whose bill has a payment.", tier: "T1", overrideAllowed: true, reasonRequired: true, emits: ["line.voided", "order.repriced", "print_job.created"] }),
  "adjustments.apply_manual": op({ op: "adjustments.apply_manual", summary: "Apply a manual pricing rule", description: "Applies a manual discount or waiver (for example staff meal, % off item, service-charge waiver) with its entered value and lines. The rule's own minimum role, override and reason settings apply. Automatic rules never need applying.", tier: "T2", overrideAllowed: true, emits: ["adjustment.applied", "order.repriced"] }),
  "adjustments.remove": op({ op: "adjustments.remove", summary: "Remove a manual pricing rule from an order", description: "Blocked when the adjustment is frozen by a payment.", tier: "T2", emits: ["adjustment.removed", "order.repriced"] }),
  "floor.snapshot": op({ op: "floor.snapshot", summary: "Floor plan snapshot", description: "Areas and tables with live status (free, seated, sent, bill requested, paid), pax, elapsed time, pending QR rounds and table requests.", tier: "T0", dryRun: false, principals: ["staff", "station", "agent"], mcp: { expose: true, toolsets: ["pos.read"] } }),
});

/* ---- Schemas ----------------------------------------------------------- */

const CustomerRef = z.object({ name: z.string().max(80).optional(), mobile: z.string().max(30).optional() });
const Mutation = z.object({ expected_version: z.number().int().optional(), dry_run: z.boolean().optional(), override_id: z.uuid().optional() });
const OpenBody = Mutation.extend({
  order_id: z.uuid(),
  order_type: OrderTypeSchema,
  outlet_id: z.uuid().optional(),
  brand_id: z.uuid().optional(),
  table_id: z.uuid().optional(),
  pax: z.number().int().min(1).max(99).optional(),
  customer_id: z.uuid().optional(),
  customer_ref: CustomerRef.optional(),
  delivery_address: z.string().max(400).optional(),
  delivery_notes: z.string().max(400).optional(),
  ready_by: z.iso.datetime().optional(),
  notes: z.string().max(400).optional(),
  takeaway_ref: z.string().max(40).optional(),
});
const DetailsBody = Mutation.extend({ pax: z.number().int().min(1).max(99).nullable().optional(), customer_ref: CustomerRef.nullable().optional(), delivery_address: z.string().max(400).nullable().optional(), delivery_notes: z.string().max(400).nullable().optional(), ready_by: z.iso.datetime().nullable().optional(), notes: z.string().max(400).nullable().optional() });
const LineInputSchema = z.object({
  line_id: z.uuid(),
  product_id: z.uuid(),
  quantity: z.number().int().min(1).max(999),
  modifiers: z.array(z.object({ group_id: z.uuid(), product_id: z.uuid(), quantity: z.number().int().min(1).max(99).optional() })).max(40).optional(),
  notes: z.string().max(200).nullable().optional(),
  seat_no: z.number().int().min(1).max(99).nullable().optional(),
  hold: z.boolean().optional(),
  open_price: z.number().int().min(0).nullable().optional(),
});
const SnapshotSchema = z.record(z.string(), z.unknown());
const OrderMutationResponse = z.object({ data: SnapshotSchema, events: z.array(z.object({ id: z.string(), seq: z.number().int(), type: z.string(), occurredAt: z.string(), businessDate: z.string() })), warnings: z.array(z.string()) });

/* ---- Helpers ------------------------------------------------------------ */

type Ctx = AppContext;

async function outletContext(p: Principal, body: { outlet_id?: string; brand_id?: string }) {
  if (p.type === "station" || (p.type === "staff" && p.stationId)) {
    const stationId = p.type === "station" ? p.stationId : p.stationId!;
    const [st] = await db().select().from(stations).where(eq(stations.id, stationId)).limit(1);
    if (!st) throw AppError.notFound("station", stationId);
    const brandId = body.brand_id ?? st.brandId;
    if (!brandId) throw AppError.validation("The station has no brand; set one in the back office or pass brand_id");
    return { outletId: st.outletId, brandId, stationId: st.id, station: st };
  }
  if (!body.outlet_id || !body.brand_id) throw AppError.validation("outlet_id and brand_id are required when not on a station");
  if (!principalCanSeeOutlet(p, body.outlet_id)) throw AppError.notFound("outlet", body.outlet_id);
  return { outletId: body.outlet_id, brandId: body.brand_id, stationId: null, station: null };
}

function validateTypeFields(orderType: OrderType, o: { tableId?: string | null; pax?: number | null; customerRef?: { name?: string; mobile?: string } | null; deliveryAddress?: string | null; readyBy?: Date | null }) {
  if (orderType === "dine_in" && !o.tableId) throw AppError.validation("Dine-in orders need a table", { remedy: "Choose a table on the floor plan." });
  if (orderType !== "dine_in" && o.tableId) throw AppError.validation(`${orderType} orders cannot have a table`);
  if ((orderType === "pickup" || orderType === "delivery") && !(o.customerRef?.name || o.customerRef?.mobile)) throw AppError.validation(`${orderType} orders need a customer name or mobile`, { remedy: "Enter the customer's name or mobile number." });
  if (orderType === "delivery" && !o.deliveryAddress) throw AppError.validation("Delivery orders need a delivery address");
}

async function emit(c: Ctx, p: Principal, order: { merchantId: string; outletId: string; id: string; version: number }, type: string, payload: unknown, extra: { approval?: { override_id?: string; approver_id: string; approver_name?: string } | null; reason?: { id?: string; text?: string } | null } = {}): Promise<AppendedEvent> {
  return appendEvent({ merchantId: order.merchantId, outletId: order.outletId, type, aggregate: { kind: "order", id: order.id, version: order.version }, operationId: c.get("operationId"), payload, approval: extra.approval ?? null, reason: extra.reason ?? null, correlationId: c.get("correlationId"), idempotencyKey: c.get("idempotencyKey"), businessDay: await businessDayInputs(order.merchantId, order.outletId) }, p);
}

/** An event to append once the heavy work is done (see `finish`); a thunk may also run side work (print jobs) and return null. */
type PendingEvent = () => Promise<AppendedEvent | null>;

/**
 * Reprice, bump the version, load the snapshot, then append the mutation's
 * events and `order.repriced`. Events go last on purpose: the first event of a
 * transaction locks the outlet's sequence counter until commit, and every other
 * writer at the outlet waits on it, so the critical section is kept to the
 * appends themselves rather than the whole re-price and snapshot.
 */
async function finish(c: Ctx, p: Principal, orderId: string, pending: PendingEvent[], warnings: string[] = []): Promise<Response> {
  const result = await repriceOrder(orderId);
  const version = await bumpVersion(orderId);
  const o = { ...(await loadSnapshot(orderId)), version };
  await settleInvariants();
  const events: AppendedEvent[] = [];
  for (const fn of pending) {
    const ev = await fn();
    if (ev) events.push(ev);
  }
  events.push(await emit(c, p, { merchantId: p.merchantId, outletId: o.outlet_id, id: orderId, version }, "order.repriced", { totals: result.totals, adjustments: result.adjustments.map((a) => ({ rule_key: a.rule_id, total: a.total })) }));
  const payload = { data: o, events, warnings: [...warnings, ...result.warnings] };
  return c.json(payload, 200);
}

function dryRunFrom(c: Ctx, body: { dry_run?: boolean }) {
  if (body.dry_run) {
    markDryRun();
    c.set("dryRun", true);
  }
}

async function todayFor(merchantId: string, outletId: string) {
  const bd = await businessDayInputs(merchantId, outletId);
  return businessDateFor(new Date(), bd.cutoff, bd.timeZone);
}

/* ---- Routes -------------------------------------------------------------- */

export function orderRoutes(app: OpenAPIHono<AppEnv>) {
  defineOp(app, { op: "orders.open", method: "post", path: "/v1/orders", tags: ["orders"], request: { body: jsonBody(OpenBody) }, responses: { 201: jsonResponse(OrderMutationResponse), ...errorResponses } }, async (c) => {
    const p = c.get("principal");
    const b = c.req.valid("json");
    dryRunFrom(c, b);
    const ctx = await outletContext(p, b);
    const [link] = await db().select().from(channelLinks).where(and(eq(channelLinks.channel, "pos"), eq(channelLinks.outletId, ctx.outletId), eq(channelLinks.brandId, ctx.brandId), eq(channelLinks.enabled, true))).limit(1);
    if (!link) throw AppError.invariant("channel_link_missing", "This outlet has no POS menu for the brand", "Add a POS channel link for the outlet and brand in the back office.");
    const readyBy = b.ready_by ? new Date(b.ready_by) : null;
    const customerRef = b.customer_ref ?? (b.takeaway_ref ? { name: b.takeaway_ref } : null);
    validateTypeFields(b.order_type, { tableId: b.table_id, pax: b.pax, customerRef, deliveryAddress: b.delivery_address, readyBy });
    if (b.table_id) {
      if (!(await tableExists(b.table_id, ctx.outletId))) throw AppError.notFound("table", b.table_id);
      const existing = await openOrderForTable(b.table_id);
      if (existing) throw AppError.state("This table already has an open order", ["open the existing order"], "Tap the table to open its order, or move that order first.");
    }
    let customerId = b.customer_id ?? null;
    if (!customerId && customerRef?.mobile) {
      // Pickup and delivery orders create or match a customer from their reference (scope doc 4.9).
      const mobile = customerRef.mobile.replace(/\s+/g, "");
      const [cust] = await db()
        .insert(customers)
        .values({ merchantId: p.merchantId, name: customerRef.name ?? mobile, mobile })
        .onConflictDoUpdate({ target: [customers.merchantId, customers.mobile], set: { updatedAt: new Date() } })
        .returning({ id: customers.id });
      customerId = cust?.id ?? null;
    }
    const [settings] = await db().select().from(merchantSettings).where(eq(merchantSettings.merchantId, p.merchantId)).limit(1);
    const bd = await businessDayInputs(p.merchantId, ctx.outletId);
    const now = new Date();
    const orderNo = await nextOrderNo(ctx.outletId, p.merchantId, "pos");
    const [row] = await db()
      .insert(orders)
      .values({
        id: b.order_id,
        merchantId: p.merchantId,
        outletId: ctx.outletId,
        brandId: ctx.brandId,
        channelLinkId: link.id,
        channel: "pos",
        orderType: b.order_type,
        orderNo,
        tableId: b.table_id ?? null,
        pax: b.pax ?? null,
        customerId,
        customerRef,
        deliveryAddress: b.delivery_address ?? null,
        deliveryNotes: b.delivery_notes ?? null,
        readyBy,
        notes: b.notes ?? null,
        stationId: ctx.stationId,
        openedBy: p.type === "staff" ? p.id : null,
        openedByName: "name" in p ? p.name : null,
        businessDate: businessDateFor(now, bd.cutoff, bd.timeZone),
        taxMode: settings?.taxMode ?? "exclusive",
        gstBps: settings?.gstBps ?? 900,
        openedAt: now,
      })
      .returning();
    await recordAudit(p, { action: "orders.open", targetKind: "order", targetId: row!.id, outletId: ctx.outletId, details: { order_no: orderNo, order_type: b.order_type } });
    const res = await finish(c, p, row!.id, [() => emit(c, p, row!, "order.opened", { order_no: orderNo, order_type: b.order_type, table_id: b.table_id ?? null, pax: b.pax ?? null, customer_ref: customerRef })]);
    return new Response(res.body, { status: 201, headers: res.headers });
  });

  defineOp(app, { op: "orders.get", method: "get", path: "/v1/orders/{id}", tags: ["orders"], request: { params: z.object({ id: z.uuid() }) }, responses: { 200: jsonResponse(dataResponse(SnapshotSchema)), ...errorResponses } }, async (c) => {
    const { id } = c.req.valid("param");
    const snap = await loadSnapshot(id);
    c.header("etag", `"${snap.version}"`);
    return c.json({ data: snap }, 200);
  });

  defineOp(
    app,
    {
      op: "orders.list",
      method: "get",
      path: "/v1/outlets/{id}/orders",
      tags: ["orders"],
      request: { params: z.object({ id: z.uuid() }), query: z.object({ status: z.string().optional(), order_type: OrderTypeSchema.optional(), business_date: z.string().optional(), table_id: z.uuid().optional(), open_only: z.enum(["true", "false"]).optional(), q: z.string().optional(), limit: z.coerce.number().int().min(1).max(500).default(200) }) },
      responses: { 200: jsonResponse(listResponse(SnapshotSchema)), ...errorResponses },
    },
    async (c) => {
      const p = c.get("principal");
      const { id } = c.req.valid("param");
      const q = c.req.valid("query");
      if (!principalCanSeeOutlet(p, id)) throw AppError.notFound("outlet", id);
      const conds: SQL[] = [eq(orders.outletId, id)];
      if (q.status) conds.push(inArray(orders.status, q.status.split(",").filter((s) => (ORDER_STATUSES as readonly string[]).includes(s)) as (typeof ORDER_STATUSES)[number][]));
      if (q.open_only === "true") conds.push(inArray(orders.status, [...OPEN_STATUSES]));
      if (q.order_type) conds.push(eq(orders.orderType, q.order_type));
      if (q.business_date) conds.push(eq(orders.businessDate, q.business_date));
      if (q.table_id) conds.push(eq(orders.tableId, q.table_id));
      if (q.q) conds.push(sql`(${orders.orderNo} ilike ${"%" + q.q + "%"} or ${orders.customerRef}::text ilike ${"%" + q.q + "%"})`);
      const rows = await db()
        .select({ id: orders.id })
        .from(orders)
        .where(and(...conds))
        .orderBy(sql`${orders.readyBy} asc nulls last`, desc(orders.openedAt))
        .limit(q.limit);
      const snaps: OrderSnapshot[] = [];
      for (const r of rows) snaps.push(await loadSnapshot(r.id));
      return c.json({ data: snaps, next_cursor: null }, 200);
    },
  );

  defineOp(app, { op: "orders.quote", method: "post", path: "/v1/orders/{id}/quote", tags: ["orders"], request: { params: z.object({ id: z.uuid() }), body: jsonBody(z.object({ extra_lines: z.array(LineInputSchema).optional() })) }, responses: { 200: jsonResponse(dataResponse(z.object({ snapshot: SnapshotSchema, pricing: z.record(z.string(), z.unknown()) }))), ...errorResponses } }, async (c) => {
    const { id } = c.req.valid("param");
    const b = c.req.valid("json");
    // A quote is a read: it must not take the order's row lock and hold up the stations editing it.
    const snap = await loadSnapshot(id);
    const o = await getOrderRow(id);
    const lines = await db().select().from(orderLines).where(and(eq(orderLines.orderId, id), sql`${orderLines.status} <> 'voided'`));
    const extra = b.extra_lines?.length ? await buildLines(await compileMenu(o.channelLinkId, new Date()), b.extra_lines as LineInput[], { orderType: o.orderType, outletId: o.outletId, today: await todayFor(o.merchantId, o.outletId), source: "pos", addedBy: null, addedByName: null, allowOpenPrice: true, startSort: 0 }) : [];
    const apps = await db().select().from(orderManualApplications).where(and(eq(orderManualApplications.orderId, id), isNull(orderManualApplications.removedAt)));
    const groupIds = o.customerId ? (await db().select({ g: customerGroupMembers.groupId }).from(customerGroupMembers).where(eq(customerGroupMembers.customerId, o.customerId))).map((x) => x.g) : [];
    const result = price(
      {
        order_type: o.orderType as OrderType,
        channel: o.channel as "pos",
        outlet_id: o.outletId,
        brand_id: o.brandId,
        customer_group_ids: groupIds,
        lines: [...lines, ...extra.map((e) => ({ ...e, orderId: id, merchantId: o.merchantId, outletId: o.outletId }))].map((l) => ({ line_id: l.id!, product_id: l.productId, category_id: l.categoryId ?? null, parent_category_id: l.parentCategoryId ?? null, tags: l.tags ?? [], is_bcrs: l.isBcrs ?? false, quantity: l.quantity, prices: { base: l.basePrice, by_order_type: (l.pricesByOrderType ?? {}) as Partial<Record<OrderType, number>> }, open_price: l.openPrice ?? null, modifiers: (l.modifiers ?? []).map((m) => ({ modifier_id: m.modifier_id, product_id: m.product_id, quantity: m.quantity, price: m.price, name: m.name })), name: l.name })),
        manual_applications: apps.map((a) => ({ application_id: a.id, rule_id: a.ruleKey, entered_value: a.enteredValue, line_ids: a.lineIds, applied_by: a.appliedBy, approved_by: a.approvedBy, override_id: a.overrideId, reason: a.reason })),
      },
      await activeRules(o.merchantId, new Date()),
      PricingContextSchema.parse({ tax_mode: o.taxMode, gst_bps: o.gstBps, now: new Date().toISOString(), frozen: o.pricingFrozenAt ? { frozen_at: o.pricingFrozenAt.toISOString(), adjustments: o.frozenAdjustments ?? [] } : null }),
    );
    // The quote consumed nothing: extra lines were only built in memory, and daily caps are rolled back with a dry run.
    if (extra.length) {
      markDryRun();
      c.set("dryRun", true);
    }
    return c.json({ data: { snapshot: snap, pricing: result } }, 200);
  });

  defineOp(app, { op: "orders.update_details", method: "patch", path: "/v1/orders/{id}", tags: ["orders"], request: { params: z.object({ id: z.uuid() }), body: jsonBody(DetailsBody) }, responses: { 200: jsonResponse(OrderMutationResponse), ...errorResponses } }, async (c) => {
    const p = c.get("principal");
    const { id } = c.req.valid("param");
    const b = c.req.valid("json");
    dryRunFrom(c, b);
    const o = await lockOrder(id, b.expected_version);
    assertOpen(o);
    const next = { tableId: o.tableId, pax: b.pax === undefined ? o.pax : b.pax, customerRef: b.customer_ref === undefined ? o.customerRef : b.customer_ref, deliveryAddress: b.delivery_address === undefined ? o.deliveryAddress : b.delivery_address, readyBy: b.ready_by === undefined ? o.readyBy : b.ready_by ? new Date(b.ready_by) : null };
    validateTypeFields(o.orderType as OrderType, next);
    await db()
      .update(orders)
      .set({ pax: next.pax, customerRef: next.customerRef, deliveryAddress: next.deliveryAddress, deliveryNotes: b.delivery_notes === undefined ? o.deliveryNotes : b.delivery_notes, readyBy: next.readyBy, notes: b.notes === undefined ? o.notes : b.notes })
      .where(eq(orders.id, id));
    return finish(c, p, id, [() => emit(c, p, o, "order.details_updated", b)]);
  });

  defineOp(app, { op: "orders.change_type", method: "post", path: "/v1/orders/{id}/change-type", tags: ["orders"], request: { params: z.object({ id: z.uuid() }), body: jsonBody(Mutation.extend({ order_type: OrderTypeSchema, table_id: z.uuid().nullable().optional(), pax: z.number().int().min(1).nullable().optional(), customer_ref: CustomerRef.nullable().optional(), delivery_address: z.string().nullable().optional(), ready_by: z.iso.datetime().nullable().optional() })) }, responses: { 200: jsonResponse(OrderMutationResponse), ...errorResponses } }, async (c) => {
    const p = c.get("principal");
    const { id } = c.req.valid("param");
    const b = c.req.valid("json");
    dryRunFrom(c, b);
    const o = await lockOrder(id, b.expected_version);
    assertOpen(o);
    if ((await paidTotal(id)) > 0) throw AppError.invariant("order_type_locked_by_payment", "The order type cannot change after a payment", "Refund the payment first, or open a new order.");
    const next = { tableId: b.table_id === undefined ? (b.order_type === "dine_in" ? o.tableId : null) : b.table_id, pax: b.pax === undefined ? o.pax : b.pax, customerRef: b.customer_ref === undefined ? o.customerRef : b.customer_ref, deliveryAddress: b.delivery_address === undefined ? o.deliveryAddress : b.delivery_address, readyBy: b.ready_by === undefined ? o.readyBy : b.ready_by ? new Date(b.ready_by) : null };
    validateTypeFields(b.order_type, next);
    if (next.tableId && next.tableId !== o.tableId) {
      if (!(await tableExists(next.tableId, o.outletId))) throw AppError.notFound("table", next.tableId);
      if (await openOrderForTable(next.tableId)) throw AppError.state("That table already has an open order", ["choose a free table"]);
    }
    await db().update(orders).set({ orderType: b.order_type, tableId: next.tableId, pax: next.pax, customerRef: next.customerRef, deliveryAddress: next.deliveryAddress, readyBy: next.readyBy }).where(eq(orders.id, id));
    // Unit prices follow the order type (open prices stay).
    const lines = await db().select().from(orderLines).where(and(eq(orderLines.orderId, id), sql`${orderLines.status} <> 'voided'`));
    for (const l of lines) await db().update(orderLines).set({ unitPrice: resolveUnitPrice(l, b.order_type) }).where(eq(orderLines.id, l.id));
    await recordAudit(p, { action: "orders.change_type", targetKind: "order", targetId: id, outletId: o.outletId, details: { from: o.orderType, to: b.order_type } });
    return finish(c, p, id, [() => emit(c, p, o, "order.type_changed", { from: o.orderType, to: b.order_type })]);
  });

  defineOp(app, { op: "orders.attach_customer", method: "post", path: "/v1/orders/{id}/customer", tags: ["orders"], request: { params: z.object({ id: z.uuid() }), body: jsonBody(Mutation.extend({ customer_id: z.uuid() })) }, responses: { 200: jsonResponse(OrderMutationResponse), ...errorResponses } }, async (c) => {
    const p = c.get("principal");
    const { id } = c.req.valid("param");
    const b = c.req.valid("json");
    dryRunFrom(c, b);
    const o = await lockOrder(id, b.expected_version);
    assertOpen(o);
    const [cust] = await db().select({ id: customers.id, name: customers.name }).from(customers).where(and(eq(customers.id, b.customer_id), isNull(customers.archivedAt))).limit(1);
    if (!cust) throw AppError.notFound("customer", b.customer_id);
    await db().update(orders).set({ customerId: cust.id }).where(eq(orders.id, id));
    return finish(c, p, id, [() => emit(c, p, o, "order.customer_attached", { customer_id: cust.id })]);
  });

  defineOp(app, { op: "orders.detach_customer", method: "delete", path: "/v1/orders/{id}/customer", tags: ["orders"], request: { params: z.object({ id: z.uuid() }), body: jsonBody(Mutation) }, responses: { 200: jsonResponse(OrderMutationResponse), ...errorResponses } }, async (c) => {
    const p = c.get("principal");
    const { id } = c.req.valid("param");
    const b = c.req.valid("json");
    dryRunFrom(c, b);
    const o = await lockOrder(id, b.expected_version);
    assertOpen(o);
    await db().update(orders).set({ customerId: null }).where(eq(orders.id, id));
    return finish(c, p, id, [() => emit(c, p, o, "order.customer_detached", { customer_id: o.customerId })]);
  });

  defineOp(app, { op: "orders.move_table", method: "post", path: "/v1/orders/{id}/move-table", tags: ["orders"], request: { params: z.object({ id: z.uuid() }), body: jsonBody(Mutation.extend({ table_id: z.uuid() })) }, responses: { 200: jsonResponse(OrderMutationResponse), ...errorResponses } }, async (c) => {
    const p = c.get("principal");
    const { id } = c.req.valid("param");
    const b = c.req.valid("json");
    dryRunFrom(c, b);
    const o = await lockOrder(id, b.expected_version);
    assertOpen(o);
    if (o.orderType !== "dine_in") throw AppError.state("Only dine-in orders have a table", ["change the order type to dine-in first"]);
    if (!(await tableExists(b.table_id, o.outletId))) throw AppError.notFound("table", b.table_id);
    if (await openOrderForTable(b.table_id)) throw AppError.state("That table already has an open order", ["choose a free table"], "Choose a table without an open order.");
    await db().update(orders).set({ tableId: b.table_id }).where(eq(orders.id, id));
    await recordAudit(p, { action: "orders.move_table", targetKind: "order", targetId: id, outletId: o.outletId, details: { from: o.tableId, to: b.table_id } });
    return finish(c, p, id, [() => emit(c, p, o, "order.moved", { from_table_id: o.tableId, to_table_id: b.table_id })]);
  });

  defineOp(app, { op: "lines.add", method: "post", path: "/v1/orders/{id}/lines", tags: ["orders"], request: { params: z.object({ id: z.uuid() }), body: jsonBody(Mutation.extend({ lines: z.array(LineInputSchema).min(1).max(100) })) }, responses: { 200: jsonResponse(OrderMutationResponse), ...errorResponses } }, async (c) => {
    const p = c.get("principal");
    const { id } = c.req.valid("param");
    const b = c.req.valid("json");
    dryRunFrom(c, b);
    const o = await lockOrder(id, b.expected_version);
    assertOpen(o);
    const role = principalRole(p);
    const wantsOpenPrice = b.lines.some((l) => l.open_price != null);
    let approval: { id: string; name: string | null } | null = null;
    if (wantsOpenPrice) {
      const perm = PERMISSIONS["lines.add_open_price"];
      approval = await requireRoleOrOverride(p, role, perm.minRole, { action: "lines.add_open_price", targetId: id, overrideId: b.override_id, overrideAllowed: perm.overrideAllowed });
    }
    const menu = await compileMenu(o.channelLinkId, new Date());
    const [maxRow] = await db().select({ max: sql<number>`coalesce(max(${orderLines.sort}), -1)` }).from(orderLines).where(eq(orderLines.orderId, id));
    const max = Number(maxRow?.max ?? -1);
    const built = await buildLines(menu, b.lines as LineInput[], { orderType: o.orderType, outletId: o.outletId, today: await todayFor(o.merchantId, o.outletId), source: "pos", addedBy: p.type === "staff" ? p.id : null, addedByName: "name" in p ? p.name : null, allowOpenPrice: true, startSort: Number(max) + 1 });
    await db().insert(orderLines).values(built.map((l) => ({ ...l, orderId: id, merchantId: o.merchantId, outletId: o.outletId })));
    if (approval) await recordAudit(p, { action: "lines.add_open_price", targetKind: "order", targetId: id, outletId: o.outletId, approver: approval, overrideId: b.override_id ?? null, details: { lines: built.filter((l) => l.openPrice != null).map((l) => ({ id: l.id, open_price: l.openPrice })) } });
    const pending: PendingEvent[] = built.map((l) => () => emit(c, p, o, "line.added", { line_id: l.id, product_id: l.productId, name: l.name, quantity: l.quantity, seat_no: l.seatNo, held: l.status === "held", open_price: l.openPrice }, approval ? { approval: { override_id: b.override_id, approver_id: approval.id, approver_name: approval.name ?? undefined } } : {}));
    return finish(c, p, id, pending);
  });

  defineOp(app, { op: "lines.update", method: "patch", path: "/v1/orders/{id}/lines/{line_id}", tags: ["orders"], request: { params: z.object({ id: z.uuid(), line_id: z.uuid() }), body: jsonBody(Mutation.extend({ quantity: z.number().int().min(1).max(999).optional(), notes: z.string().max(200).nullable().optional(), seat_no: z.number().int().min(1).max(99).nullable().optional(), hold: z.boolean().optional(), modifiers: z.array(z.object({ group_id: z.uuid(), product_id: z.uuid(), quantity: z.number().int().min(1).optional() })).optional() })) }, responses: { 200: jsonResponse(OrderMutationResponse), ...errorResponses } }, async (c) => {
    const p = c.get("principal");
    const { id, line_id } = c.req.valid("param");
    const b = c.req.valid("json");
    dryRunFrom(c, b);
    const o = await lockOrder(id, b.expected_version);
    assertOpen(o);
    const [line] = await db().select().from(orderLines).where(and(eq(orderLines.id, line_id), eq(orderLines.orderId, id))).limit(1);
    if (!line) throw AppError.notFound("line", line_id);
    if (line.status === "fired" || line.status === "voided") throw AppError.state(`A ${line.status === "fired" ? "sent" : "removed"} line cannot be changed`, line.status === "fired" ? ["lines.void (Manager approval)"] : [], line.status === "fired" ? "Void the line with manager approval and add it again." : undefined);
    // Quantity and modifiers change the amount of a line; on a paid bill that is a refund, not an edit (a pay-before-sending station pays pending lines).
    if ((b.quantity != null && b.quantity !== line.quantity) || b.modifiers) await assertLineUnlocked(line_id);
    const today = await todayFor(o.merchantId, o.outletId);
    if (b.quantity != null && b.quantity !== line.quantity) {
      const { consumeDailyCap } = await import("./catalogue.js");
      if (b.quantity > line.quantity) {
        const cap = await consumeDailyCap(o.outletId, line.productId, b.quantity - line.quantity, today);
        if (!cap.ok) throw new AppError("unavailable", `${line.name}: only ${cap.remaining} more available today`, { details: { cap_remaining: cap.remaining } });
      } else await releaseDailyCap(o.outletId, line.productId, line.quantity - b.quantity, today);
    }
    let modifiers = line.modifiers;
    if (b.modifiers) {
      const menu = await compileMenu(o.channelLinkId, new Date());
      const product = menu.products[line.productId];
      if (!product) throw AppError.notFound("product on this menu", line.productId);
      modifiers = resolveModifiers(menu, product, b.modifiers);
    }
    await db()
      .update(orderLines)
      .set({ quantity: b.quantity ?? line.quantity, notes: b.notes === undefined ? line.notes : b.notes, seatNo: b.seat_no === undefined ? line.seatNo : b.seat_no, status: b.hold === undefined ? line.status : b.hold ? "held" : "pending", modifiers, updatedAt: new Date() })
      .where(eq(orderLines.id, line_id));
    return finish(c, p, id, [() => emit(c, p, o, "line.updated", { line_id, ...b })]);
  });

  defineOp(app, { op: "lines.void", method: "post", path: "/v1/orders/{id}/lines/{line_id}/void", tags: ["orders"], request: { params: z.object({ id: z.uuid(), line_id: z.uuid() }), body: jsonBody(Mutation.extend({ quantity: z.number().int().min(1).optional(), reason_id: z.uuid().optional(), reason_text: z.string().max(200).optional() })) }, responses: { 200: jsonResponse(OrderMutationResponse), ...errorResponses } }, async (c) => {
    const p = c.get("principal");
    const { id, line_id } = c.req.valid("param");
    const b = c.req.valid("json");
    dryRunFrom(c, b);
    const o = await lockOrder(id, b.expected_version);
    assertOpen(o);
    const [line] = await db().select().from(orderLines).where(and(eq(orderLines.id, line_id), eq(orderLines.orderId, id))).limit(1);
    if (!line) throw AppError.notFound("line", line_id);
    if (line.status === "voided") throw AppError.state("The line is already removed", []);
    let reasonText = b.reason_text ?? null;
    if (b.reason_id) {
      const [r] = await db().select().from(voidReasons).where(eq(voidReasons.id, b.reason_id)).limit(1);
      if (!r) throw AppError.notFound("void reason", b.reason_id);
      reasonText = reasonText ?? r.name;
    }
    if (!reasonText) throw AppError.validation("A reason is required to remove a line", { remedy: "Pick a reason from the list." });
    const fired = line.status === "fired";
    let approval: { id: string; name: string | null } | null = null;
    if (fired) {
      const perm = PERMISSIONS["lines.void_fired"];
      approval = await requireRoleOrOverride(p, principalRole(p), perm.minRole, { action: "lines.void_fired", targetId: line_id, overrideId: b.override_id, overrideAllowed: perm.overrideAllowed });
    }
    await assertLineUnlocked(line_id);
    const qty = Math.min(b.quantity ?? line.quantity, line.quantity);
    const now = new Date();
    if (qty < line.quantity) {
      // Partial void: keep the remainder on the original line; record the voided quantity on a new line.
      await db().update(orderLines).set({ quantity: line.quantity - qty, updatedAt: now }).where(eq(orderLines.id, line_id));
      await db().insert(orderLines).values({ ...line, id: crypto.randomUUID(), quantity: qty, status: "voided", voidedAt: now, voidReasonId: b.reason_id ?? null, voidReason: reasonText, voidedBy: p.type === "staff" ? p.id : null, voidApprovedBy: approval?.id ?? null, voidOverrideId: b.override_id ?? null, baseAmount: 0, discountAmount: 0, netAmount: 0, feeAmount: 0, gstAmount: 0, total: 0, createdAt: now, updatedAt: now });
    } else {
      await db().update(orderLines).set({ status: "voided", voidedAt: now, voidReasonId: b.reason_id ?? null, voidReason: reasonText, voidedBy: p.type === "staff" ? p.id : null, voidApprovedBy: approval?.id ?? null, voidOverrideId: b.override_id ?? null, baseAmount: 0, discountAmount: 0, netAmount: 0, feeAmount: 0, gstAmount: 0, total: 0, updatedAt: now }).where(eq(orderLines.id, line_id));
    }
    if (!fired) await releaseDailyCap(o.outletId, line.productId, qty, await todayFor(o.merchantId, o.outletId));
    await recordAudit(p, { action: fired ? "lines.void_fired" : "lines.void", targetKind: "order_line", targetId: line_id, outletId: o.outletId, reason: reasonText, approver: approval, overrideId: b.override_id ?? null, details: { order_id: id, quantity: qty, name: line.name } });
    const pending: PendingEvent[] = [() => emit(c, p, o, "line.voided", { line_id, quantity: qty, after_firing: fired, name: line.name }, { reason: { id: b.reason_id, text: reasonText }, approval: approval ? { override_id: b.override_id, approver_id: approval.id, approver_name: approval.name ?? undefined } : null })];
    // Void tickets (v0.5) are print jobs: created after the event so the ticket follows the void in the log.
    pending.push(async () => {
      for (const hook of voidHooks) await hook({ order: o, line, quantity: qty, fired, principal: p, correlationId: c.get("correlationId") });
      return null;
    });
    return finish(c, p, id, pending);
  });

  defineOp(app, { op: "orders.fire", method: "post", path: "/v1/orders/{id}/fire", tags: ["orders"], request: { params: z.object({ id: z.uuid() }), body: jsonBody(Mutation.extend({ line_ids: z.array(z.uuid()).optional(), include_held: z.boolean().optional() })) }, responses: { 200: jsonResponse(OrderMutationResponse), ...errorResponses } }, async (c) => {
    const p = c.get("principal");
    const { id } = c.req.valid("param");
    const b = c.req.valid("json");
    dryRunFrom(c, b);
    const o = await lockOrder(id, b.expected_version);
    assertOpen(o);
    const station = (p.type === "staff" && p.stationId ? (await db().select().from(stations).where(eq(stations.id, p.stationId)).limit(1))[0] : null) ?? null;
    if (station?.payBeforeFiring) {
      const paid = await paidTotal(id);
      if (paid < o.total) throw AppError.invariant("pay_before_firing", "This station takes payment before sending to the kitchen", "Take the payment, then send.", );
    }
    const statuses: ("pending" | "held")[] = b.line_ids || b.include_held ? ["pending", "held"] : ["pending"];
    const conds: SQL[] = [eq(orderLines.orderId, id), inArray(orderLines.status, statuses)];
    if (b.line_ids) conds.push(inArray(orderLines.id, b.line_ids));
    const toFire = await db()
      .select()
      .from(orderLines)
      .where(and(...conds));
    if (toFire.length === 0) throw AppError.state("Nothing to send", ["add lines first"], "Add items, or release held items, then send.");
    const round = o.roundCount + 1;
    const now = new Date();
    await db()
      .update(orderLines)
      .set({ status: "fired", firedAt: now, fireRound: round, firedBy: p.type === "staff" ? p.id : null, firedFromStationId: station?.id ?? null, updatedAt: now })
      .where(inArray(orderLines.id, toFire.map((l) => l.id)));
    await db().update(orders).set({ roundCount: round, status: o.status === "open" ? "fired" : o.status, firstFiredAt: o.firstFiredAt ?? now }).where(eq(orders.id, id));
    const warnings: string[] = [];
    const pending: PendingEvent[] = [
      () => emit(c, p, o, "order.fired", { round, line_ids: toFire.map((l) => l.id), station_id: station?.id ?? null }),
      // Kitchen tickets are created in the same transaction as the fire (scope doc 4.7); each job appends its own event.
      async () => {
        for (const hook of fireHooks) warnings.push(...(await hook({ order: { ...o, roundCount: round }, lines: toFire, round, station, principal: p, correlationId: c.get("correlationId") })));
        return null;
      },
    ];
    return finish(c, p, id, pending, warnings);
  });

  const transition = (opId: string, path: string, from: string[], to: "ready" | "out_for_delivery", onlyType?: OrderType) =>
    defineOp(app, { op: opId, method: "post", path, tags: ["orders"], request: { params: z.object({ id: z.uuid() }), body: jsonBody(Mutation.extend({ note: z.string().max(200).optional() })) }, responses: { 200: jsonResponse(OrderMutationResponse), ...errorResponses } }, async (c) => {
      const p = c.get("principal");
      const { id } = c.req.valid("param");
      const b = c.req.valid("json");
      dryRunFrom(c, b);
      const o = await lockOrder(id, b.expected_version);
      if (onlyType && o.orderType !== onlyType) throw AppError.state(`Only ${onlyType} orders can be ${to.replace(/_/g, " ")}`, []);
      if (!from.includes(o.status)) throw AppError.state(`The order is ${o.status}`, from.map((f) => `${f} → ${to}`));
      await db().update(orders).set({ status: to, readyAt: to === "ready" ? new Date() : o.readyAt }).where(eq(orders.id, id));
      return finish(c, p, id, [() => emit(c, p, o, "order.status_changed", { from: o.status, to, note: b.note ?? null })]);
    });
  transition("orders.mark_ready", "/v1/orders/{id}/ready", ["fired", "open"], "ready");
  transition("orders.mark_out_for_delivery", "/v1/orders/{id}/out-for-delivery", ["ready"], "out_for_delivery", "delivery");

  defineOp(app, { op: "orders.cancel", method: "post", path: "/v1/orders/{id}/cancel", tags: ["orders"], request: { params: z.object({ id: z.uuid() }), body: jsonBody(Mutation.extend({ reason: z.string().min(1).max(200) })) }, responses: { 200: jsonResponse(OrderMutationResponse), ...errorResponses } }, async (c) => {
    const p = c.get("principal");
    const { id } = c.req.valid("param");
    const b = c.req.valid("json");
    dryRunFrom(c, b);
    const o = await lockOrder(id, b.expected_version);
    assertOpen(o);
    if ((await paidTotal(id)) > 0) throw AppError.invariant("order_has_payments", "An order with payments cannot be cancelled", "Refund the payments, or reopen and correct the order.");
    const lines = await db().select().from(orderLines).where(and(eq(orderLines.orderId, id), sql`${orderLines.status} <> 'voided'`));
    if (lines.some((l) => l.status === "fired")) throw AppError.invariant("fired_lines_present", "Sent items must be voided before the order is cancelled", "Void the sent items (Manager approval), then cancel.");
    const today = await todayFor(o.merchantId, o.outletId);
    const now = new Date();
    for (const l of lines) {
      await releaseDailyCap(o.outletId, l.productId, l.quantity, today);
      await db().update(orderLines).set({ status: "voided", voidedAt: now, voidReason: `Order cancelled: ${b.reason}`, voidedBy: p.type === "staff" ? p.id : null, baseAmount: 0, discountAmount: 0, netAmount: 0, feeAmount: 0, gstAmount: 0, total: 0 }).where(eq(orderLines.id, l.id));
    }
    await db().update(orders).set({ status: "cancelled", cancelledAt: now, cancelReason: b.reason }).where(eq(orders.id, id));
    await orderClosed(id);
    await recordAudit(p, { action: "orders.cancel", targetKind: "order", targetId: id, outletId: o.outletId, reason: b.reason });
    return finish(c, p, id, [() => emit(c, p, o, "order.cancelled", { reason: b.reason }, { reason: { text: b.reason } })]);
  });

  defineOp(app, { op: "adjustments.apply_manual", method: "post", path: "/v1/orders/{id}/adjustments", tags: ["orders"], request: { params: z.object({ id: z.uuid() }), body: jsonBody(Mutation.extend({ application_id: z.uuid(), rule_key: z.string().min(1), entered_value: z.number().int().min(0).nullable().optional(), line_ids: z.array(z.uuid()).min(1).nullable().optional(), reason: z.string().max(200).nullable().optional() })) }, responses: { 200: jsonResponse(OrderMutationResponse), ...errorResponses } }, async (c) => {
    const p = c.get("principal");
    const { id } = c.req.valid("param");
    const b = c.req.valid("json");
    dryRunFrom(c, b);
    const o = await lockOrder(id, b.expected_version);
    assertOpen(o);
    const rules = await activeRules(o.merchantId, new Date());
    const rule = rules.find((r) => r.id === b.rule_key);
    if (!rule) throw AppError.notFound("pricing rule", b.rule_key);
    const check = validateManualApplication(rule, { entered_value: b.entered_value ?? null, line_ids: b.line_ids ?? null });
    if (!check.ok) throw new AppError("validation", check.message, { remedy: check.remedy });
    if (rule.reason_required && !b.reason) throw AppError.validation(`${rule.name} needs a reason`, { remedy: "Pick a reason." });
    if (o.pricingFrozenAt && isFreezable(rule)) throw AppError.invariant("pricing_frozen", `${rule.name} is an order-level rule and the order already has a payment`, "Order-level discounts are frozen once a bill is paid. Refund the payment first, or apply an item-level discount to the unpaid items.");
    const approval = await requireRoleOrOverride(p, principalRole(p), (rule.min_role ?? "server") as Role, { action: "adjustments.apply_manual", targetId: id, overrideId: b.override_id, overrideAllowed: rule.override_allowed });
    if (b.line_ids) {
      const found = await db().select({ id: orderLines.id }).from(orderLines).where(and(eq(orderLines.orderId, id), inArray(orderLines.id, b.line_ids), sql`${orderLines.status} <> 'voided'`));
      if (found.length !== b.line_ids.length) throw AppError.notFound("line on this order");
      // A discount aimed at an item on a paid bill cannot land: the bill is settled (without line_ids the rule simply prices the unpaid items).
      for (const lineId of b.line_ids) await assertLineUnlocked(lineId);
    }
    await db().insert(orderManualApplications).values({ id: b.application_id, merchantId: o.merchantId, outletId: o.outletId, orderId: id, ruleKey: rule.id, enteredValue: b.entered_value ?? null, lineIds: b.line_ids ?? null, appliedBy: p.type === "staff" ? p.id : null, appliedByName: "name" in p ? p.name : null, approvedBy: approval?.id ?? null, approvedByName: approval?.name ?? null, overrideId: b.override_id ?? null, reason: b.reason ?? null });
    await recordAudit(p, { action: "adjustments.apply_manual", targetKind: "order", targetId: id, outletId: o.outletId, reason: b.reason ?? null, approver: approval, overrideId: b.override_id ?? null, details: { rule_key: rule.id, rule_name: rule.name, entered_value: b.entered_value ?? null } });
    return finish(c, p, id, [() => emit(c, p, o, "adjustment.applied", { application_id: b.application_id, rule_key: rule.id, rule_name: rule.name, entered_value: b.entered_value ?? null, line_ids: b.line_ids ?? null }, { reason: b.reason ? { text: b.reason } : null, approval: approval ? { override_id: b.override_id, approver_id: approval.id, approver_name: approval.name ?? undefined } : null })]);
  });

  defineOp(app, { op: "adjustments.remove", method: "delete", path: "/v1/orders/{id}/adjustments/{application_id}", tags: ["orders"], request: { params: z.object({ id: z.uuid(), application_id: z.uuid() }), body: jsonBody(Mutation.extend({ reason: z.string().max(200).optional() })) }, responses: { 200: jsonResponse(OrderMutationResponse), ...errorResponses } }, async (c) => {
    const p = c.get("principal");
    const { id, application_id } = c.req.valid("param");
    const b = c.req.valid("json");
    dryRunFrom(c, b);
    const o = await lockOrder(id, b.expected_version);
    assertOpen(o);
    const [appRow] = await db().select().from(orderManualApplications).where(and(eq(orderManualApplications.id, application_id), eq(orderManualApplications.orderId, id), isNull(orderManualApplications.removedAt))).limit(1);
    if (!appRow) throw AppError.notFound("adjustment", application_id);
    if (o.pricingFrozenAt && (o.frozenAdjustments ?? []).some((f) => (f as { manual_application_id?: string }).manual_application_id === application_id)) throw AppError.invariant("adjustment_frozen", "This discount is frozen by a payment", "Refund the payment to change it.");
    await assertAdjustmentUnlocked(id, application_id);
    const rules = await activeRules(o.merchantId, new Date());
    const rule = rules.find((r) => r.id === appRow.ruleKey);
    if (rule) await requireRoleOrOverride(p, principalRole(p), (rule.min_role ?? "server") as Role, { action: "adjustments.remove", targetId: id, overrideId: b.override_id, overrideAllowed: rule.override_allowed });
    await db().update(orderManualApplications).set({ removedAt: new Date(), removedBy: p.id }).where(eq(orderManualApplications.id, application_id));
    await recordAudit(p, { action: "adjustments.remove", targetKind: "order", targetId: id, outletId: o.outletId, reason: b.reason ?? null, details: { rule_key: appRow.ruleKey } });
    return finish(c, p, id, [() => emit(c, p, o, "adjustment.removed", { application_id, rule_key: appRow.ruleKey }, { reason: b.reason ? { text: b.reason } : null })]);
  });

  defineOp(app, { op: "floor.snapshot", method: "get", path: "/v1/outlets/{id}/floor", tags: ["orders"], request: { params: z.object({ id: z.uuid() }) }, responses: { 200: jsonResponse(dataResponse(z.record(z.string(), z.unknown()))), ...errorResponses } }, async (c) => {
    const p = c.get("principal");
    const { id } = c.req.valid("param");
    if (!principalCanSeeOutlet(p, id)) throw AppError.notFound("outlet", id);
    const areaRows = await db().select().from(areas).where(eq(areas.outletId, id)).orderBy(asc(areas.sort), asc(areas.name));
    const tableRows = await db().select().from(tables).where(and(eq(tables.outletId, id), isNull(tables.archivedAt))).orderBy(asc(tables.name));
    const open = await db().select().from(orders).where(and(eq(orders.outletId, id), inArray(orders.status, [...OPEN_STATUSES])));
    const byTable = new Map(open.filter((o) => o.tableId).map((o) => [o.tableId!, o]));
    const extras = await Promise.all(floorExtras.map((f) => f(id)));
    const pendingByOrder = new Map<string, number>();
    const requestsByTable = new Map<string, number>();
    for (const e of extras) {
      for (const [k, v] of Object.entries(e.pending_rounds_by_order ?? {})) pendingByOrder.set(k, (pendingByOrder.get(k) ?? 0) + v);
      for (const [k, v] of Object.entries(e.requests_by_table ?? {})) requestsByTable.set(k, (requestsByTable.get(k) ?? 0) + v);
    }
    const now = Date.now();
    const data = {
      outlet_id: id,
      as_of: new Date(now).toISOString(),
      areas: areaRows.map((a) => ({ id: a.id, name: a.name, sort: a.sort })),
      tables: tableRows.map((t) => {
        const o = byTable.get(t.id);
        const status = !o ? "free" : o.billRequestedAt ? "bill_requested" : o.status === "fired" || o.status === "ready" ? "sent" : "seated";
        const order = o
          ? {
              id: o.id,
              order_no: o.orderNo,
              status: o.status,
              pax: o.pax,
              opened_at: o.openedAt.toISOString(),
              elapsed_seconds: Math.floor((now - o.openedAt.getTime()) / 1000),
              total: o.total,
              version: o.version,
              pending_rounds: pendingByOrder.get(o.id) ?? 0,
            }
          : null;
        return { id: t.id, area_id: t.areaId, name: t.name, seats: t.seats, shape: t.shape, x: t.x, y: t.y, w: t.w, h: t.h, status, order, requests_waiting: requestsByTable.get(t.id) ?? 0 };
      }),
      open_orders: open.length,
      other_orders: open.filter((o) => !o.tableId).map((o) => ({ id: o.id, order_no: o.orderNo, order_type: o.orderType, status: o.status, ready_by: o.readyBy?.toISOString() ?? null, customer_ref: o.customerRef, total: o.total })),
      ...Object.assign({}, ...extras.map((e) => e.extra ?? {})),
    };
    return c.json({ data }, 200);
  });
}

function assertOpen(o: { status: string }) {
  if (!(OPEN_STATUSES as readonly string[]).includes(o.status)) throw AppError.state(`The order is ${o.status}`, o.status === "completed" ? ["orders.reopen (Manager approval, same business day)"] : [], o.status === "completed" ? "Reopen the order to change it." : undefined);
}

/* ---- Extension points for later phases ----------------------------------- */

export type FireHook = (input: { order: typeof orders.$inferSelect; lines: (typeof orderLines.$inferSelect)[]; round: number; station: typeof stations.$inferSelect | null; principal: Principal; correlationId: string }) => Promise<string[]>;
export type VoidHook = (input: { order: typeof orders.$inferSelect; line: typeof orderLines.$inferSelect; quantity: number; fired: boolean; principal: Principal; correlationId: string }) => Promise<void>;
const fireHooks: FireHook[] = [];
const voidHooks: VoidHook[] = [];
export function onFire(hook: FireHook) {
  fireHooks.push(hook);
}
export function onVoid(hook: VoidHook) {
  voidHooks.push(hook);
}
type FloorExtra = (outletId: string) => Promise<{ pending_rounds_by_order?: Record<string, number>; requests_by_table?: Record<string, number>; extra?: Record<string, unknown> }>;
const floorExtras: FloorExtra[] = [];
export function registerFloorExtra(fn: FloorExtra) {
  floorExtras.push(fn);
}

export { roleAtLeast, localParts, tx, PricingRuleSchema };
