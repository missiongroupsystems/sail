import type { OpenAPIHono } from "@hono/zod-openapi";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { registerOperations, type OperationSpec } from "@sail/shared";
import { db, settleInvariants, tx, withTransaction, type RequestTx } from "../db/client.js";
import { channelLinks, guestRounds, guestSessions, orderLines, orders, outlets, printers, serviceRequests, tables } from "../db/schema/index.js";
import { AppError } from "../lib/errors.js";
import type { AppEnv } from "../lib/context.js";
import { dataResponse, defineOp, errorResponses, jsonBody, jsonResponse, listResponse, mutationResponse, z } from "../lib/openapi.js";
import { appendEvent, type AppendedEvent } from "../lib/events.js";
import { recordAudit } from "../lib/audit.js";
import { principalCanSeeOutlet, type Principal } from "../auth/principal.js";
import { registerGuestResolver } from "../auth/resolve.js";
import { verifySailToken } from "../auth/tokens.js";
import { applyRls } from "../middleware/pipeline.js";
import { serveStream } from "../sse/stream.js";
import { compileMenu } from "../services/menu.js";
import { buildLines, type LineInput } from "../services/lines.js";
import { bumpVersion, loadSnapshot, lockOrder, nextOrderNo, registerOrderClosedHook, repriceOrder } from "../services/orders.js";
import { orderTaxSettings } from "../services/tax.js";
import { createKitchenJobs, insertJob } from "../services/printing.js";
import { releaseDailyCap } from "./catalogue.js";
import { registerFloorExtra } from "./orders.js";
import { businessDayInputs, printLocale } from "../services/business-day.js";
import { businessDateFor } from "../lib/time.js";
import { asSystem, bindSessionToTableOrder, checkLimit, createGuestSession, enforceLimit, guestOrderView, openOrderIdForTable, qrSheetPdf, RATE, recordHit, revokeSessionsForOrder, rotateTableToken, toRequest, toRound } from "../services/guest.js";

const op = (o: Partial<OperationSpec> & { op: string; summary: string; description: string }): OperationSpec => ({ tier: "T1", minRole: null, overrideAllowed: false, reasonRequired: false, dryRun: false, principals: ["guest"], emits: [], mcp: { expose: true, toolsets: ["guest"] }, ...o });

registerOperations({
  "guest_sessions.create": op({ op: "guest_sessions.create", summary: "Start a guest session from a table QR code", description: "Exchanges the table token for a short-lived guest token scoped to the table and its open order. Rate-limited per device and per table. Ordering is possible only while the table has an open order, unless the channel allows opening on first scan.", tier: "T0", principals: [], mcp: { expose: false, toolsets: [] } }),
  "guest.order": op({ op: "guest.order", summary: "What the table has ordered", description: "The table's lines (menu prices only, no fees or totals), round statuses, the guest's requests, and whether ordering is possible (`can_order`). A session started before the table was seated is bound to the table's order here, so no new session is needed.", tier: "T0" }),
  "rounds.submit": op({ op: "rounds.submit", summary: "Send a round to the table's order", description: "Lines in the same shape as lines.add, validated against the channel menu, availability and caps. With hold orders on, the round waits for staff acceptance; otherwise it fires and prints straight away. Never takes payment.", emits: ["round.submitted", "line.added", "order.repriced", "order.fired"] }),
  "service_requests.create": op({ op: "service_requests.create", summary: "Call staff", description: "One of the channel's configured requests or `call_for_bill`, which also marks the table as bill requested. Rate-limited.", emits: ["service_request.created", "order.bill_requested"] }),
  "guest.stream": op({ op: "guest.stream", summary: "Guest live-update stream (SSE)", description: "Signals changes to the table's order (round accepted, order ready). Poll guest.order when there is no order yet.", tier: "T0", mcp: { expose: false, toolsets: [] } }),
  "rounds.list": op({ op: "rounds.list", summary: "QR rounds of an outlet", description: "Pending rounds waiting for acceptance, and recent decided ones.", tier: "T0", minRole: "server", principals: ["staff", "station", "agent"], mcp: { expose: true, toolsets: ["pos.read"] } }),
  "rounds.accept": op({ op: "rounds.accept", summary: "Accept a held QR round", description: "Fires the round's lines and prints kitchen tickets.", tier: "T2", minRole: "server", dryRun: true, principals: ["staff", "agent"], emits: ["round.accepted", "order.fired", "print_job.created"], mcp: { expose: true, toolsets: ["pos.order"] } }),
  "rounds.reject": op({ op: "rounds.reject", summary: "Reject a held QR round", description: "Removes the round's lines with the given reason and releases daily caps.", tier: "T2", minRole: "server", reasonRequired: true, dryRun: true, principals: ["staff", "agent"], emits: ["round.rejected", "line.voided"], mcp: { expose: true, toolsets: ["pos.order"] } }),
  "service_requests.list": op({ op: "service_requests.list", summary: "Table requests of an outlet", description: "Open and recently acknowledged requests.", tier: "T0", minRole: "server", principals: ["staff", "station", "agent"], mcp: { expose: true, toolsets: ["pos.read"] } }),
  "service_requests.acknowledge": op({ op: "service_requests.acknowledge", summary: "Acknowledge a table request", description: "Marks the request done.", minRole: "server", principals: ["staff", "agent"], emits: ["service_request.acknowledged"], mcp: { expose: true, toolsets: ["pos.order"] } }),
  "tables.rotate_qr_token": op({ op: "tables.rotate_qr_token", summary: "Rotate a table's QR token", description: "Old QR codes for the table stop working. Admin.", tier: "T3", minRole: "admin", principals: ["staff"], emits: ["table.qr_rotated"], mcp: { expose: false, toolsets: [] } }),
  "tables.qr_sheet": op({ op: "tables.qr_sheet", summary: "Printable QR sheet (PDF)", description: "Rotates every table token at the outlet and returns a PDF of QR cards for ordinary printers. Admin.", tier: "T3", minRole: "admin", principals: ["staff"], emits: ["table.qr_rotated"], mcp: { expose: false, toolsets: [] } }),
});

/* ---- Guest principal ---- */
registerGuestResolver(async (token: string, t: RequestTx) => {
  const claims = await verifySailToken(token, "guest");
  const [s] = await t.db.select().from(guestSessions).where(eq(guestSessions.id, claims.session_id!)).limit(1);
  if (!s || s.revokedAt || s.expiresAt.getTime() < Date.now()) throw new AppError("unauthenticated", "This table session has ended", { remedy: "Scan the table's QR code again." });
  await t.db.update(guestSessions).set({ lastSeenAt: new Date() }).where(eq(guestSessions.id, s.id));
  return { type: "guest", id: s.id, merchantId: s.merchantId, outletId: s.outletId, brandId: s.brandId, tableId: s.tableId, orderId: s.orderId, channelLinkId: s.channelLinkId, sessionId: s.id };
});

registerFloorExtra(async (outletId) => {
  const pending = await db().select({ orderId: guestRounds.orderId, n: sql<number>`count(*)::int` }).from(guestRounds).where(and(eq(guestRounds.outletId, outletId), eq(guestRounds.status, "pending"))).groupBy(guestRounds.orderId);
  const reqs = await db().select({ tableId: serviceRequests.tableId, n: sql<number>`count(*)::int` }).from(serviceRequests).where(and(eq(serviceRequests.outletId, outletId), eq(serviceRequests.status, "open"))).groupBy(serviceRequests.tableId);
  return { pending_rounds_by_order: Object.fromEntries(pending.map((p) => [p.orderId, p.n])), requests_by_table: Object.fromEntries(reqs.map((r) => [r.tableId, r.n])) };
});

registerOrderClosedHook(async (orderId) => {
  await revokeSessionsForOrder(orderId);
});

const LineInputSchema = z.object({ line_id: z.uuid(), product_id: z.uuid(), quantity: z.number().int().min(1).max(50), modifiers: z.array(z.object({ group_id: z.uuid(), product_id: z.uuid(), quantity: z.number().int().min(1).max(20).optional() })).max(40).optional(), notes: z.string().max(200).nullable().optional(), seat_no: z.number().int().min(1).max(99).nullable().optional() });

function guestOnly(p: Principal): Extract<Principal, { type: "guest" }> {
  if (p.type !== "guest") throw new AppError("permission_denied", "Guest endpoints need a table session", { remedy: "Scan the table's QR code." });
  return p;
}

export function guestRoutes(app: OpenAPIHono<AppEnv>) {
  defineOp(app, { op: "guest_sessions.create", method: "post", path: "/v1/guest/sessions", tags: ["guest"], request: { body: jsonBody(z.object({ token: z.string().min(10).max(200), device_id: z.string().min(8).max(120), guest_name: z.string().max(40).optional() })) }, responses: { 201: jsonResponse(dataResponse(z.object({ guest_token: z.string(), session_id: z.string(), table: z.object({ id: z.string(), name: z.string() }), outlet: z.object({ id: z.string(), name: z.string() }), brand_id: z.string(), channel_link_id: z.string(), order_open: z.boolean(), can_order: z.boolean(), hold_orders: z.boolean(), service_requests: z.array(z.string()), expires_at: z.string() }))), ...errorResponses } }, async (c) => {
    const b = c.req.valid("json");
    const result = await withTransaction(async (t) => {
      const r = await createGuestSession({ token: b.token, deviceId: b.device_id, guestName: b.guest_name ?? null });
      const [outlet] = await t.db.select({ id: outlets.id, name: outlets.name }).from(outlets).where(eq(outlets.id, r.table.outletId)).limit(1);
      await appendEvent({ merchantId: r.session.merchantId, outletId: r.session.outletId, type: "guest_session.started", aggregate: { kind: "table", id: r.table.id }, operationId: "guest_sessions.create", payload: { session_id: r.session.id, order_id: r.session.orderId }, actor: { principal_type: "guest", principal_id: r.session.id, role: null }, correlationId: c.get("correlationId") });
      return { ...r, outlet: outlet! };
    });
    return c.json({ data: { guest_token: result.sessionToken, session_id: result.session.id, table: { id: result.table.id, name: result.table.name }, outlet: result.outlet, brand_id: result.link.brandId, channel_link_id: result.link.id, order_open: result.orderOpen, can_order: result.orderOpen || result.link.openOnFirstScan, hold_orders: result.link.holdOrders, service_requests: result.link.serviceRequests, expires_at: result.session.expiresAt.toISOString() } }, 201);
  });

  defineOp(app, { op: "guest.order", method: "get", path: "/v1/guest/order", tags: ["guest"], responses: { 200: jsonResponse(dataResponse(z.record(z.string(), z.unknown()))), ...errorResponses } }, async (c) => {
    const p = guestOnly(c.get("principal"));
    return c.json({ data: await guestOrderView(p) }, 200);
  });

  defineOp(app, { op: "rounds.submit", method: "post", path: "/v1/guest/rounds", tags: ["guest"], request: { body: jsonBody(z.object({ round_id: z.uuid(), lines: z.array(LineInputSchema).min(1).max(30), guest_name: z.string().max(40).optional(), notes: z.string().max(200).optional() })) }, responses: { 201: jsonResponse(dataResponse(z.record(z.string(), z.unknown()))), ...errorResponses } }, async (c) => {
    const p = guestOnly(c.get("principal"));
    const b = c.req.valid("json");
    checkLimit(`round:sess:${p.sessionId}`, RATE.roundsPerSession, "orders from this phone");
    enforceLimit(`round:table:${p.tableId}`, RATE.roundsPerTable, "orders at this table");
    const [link] = await db().select().from(channelLinks).where(eq(channelLinks.id, p.channelLinkId)).limit(1);
    if (!link?.enabled) throw new AppError("unavailable", "Ordering from your phone is switched off", { remedy: "Please order with a member of staff." });
    const [session] = await db().select().from(guestSessions).where(eq(guestSessions.id, p.sessionId)).limit(1);
    const menu = await compileMenu(link.id, new Date());
    const bd = await businessDayInputs(p.merchantId, p.outletId);
    const today = businessDateFor(new Date(), bd.cutoff, bd.timeZone);

    const result = await asSystem(async () => {
      let orderId = session!.orderId ?? (await openOrderIdForTable(p.tableId));
      let openedNow = false;
      if (!orderId) {
        if (!link.openOnFirstScan) throw new AppError("state_conflict", "Your table isn't ready for ordering yet", { remedy: "Ask a member of staff to seat you.", details: { table_not_open: true } });
        const tax = await orderTaxSettings(p.merchantId, p.outletId);
        const now = new Date();
        const [row] = await db().insert(orders).values({ id: crypto.randomUUID(), merchantId: p.merchantId, outletId: p.outletId, brandId: link.brandId, channelLinkId: link.id, channel: "scan_to_order", orderType: "dine_in", orderNo: await nextOrderNo(p.outletId, p.merchantId, "scan_to_order"), tableId: p.tableId, businessDate: today, taxMode: tax.taxMode, taxRounding: tax.taxRounding, taxRates: tax.taxRates, openedAt: now, openedByName: b.guest_name ?? "Guest" }).returning();
        orderId = row!.id;
        openedNow = true;
        await appendEvent({ merchantId: p.merchantId, outletId: p.outletId, type: "order.opened", aggregate: { kind: "order", id: orderId, version: 1 }, operationId: "rounds.submit", payload: { order_no: row!.orderNo, order_type: "dine_in", table_id: p.tableId, source: "guest" }, correlationId: c.get("correlationId"), businessDay: bd }, p);
      }
      if (session!.orderId !== orderId) await db().update(guestSessions).set({ orderId }).where(eq(guestSessions.id, p.sessionId));
      const order = await lockOrder(orderId);
      if (!["open", "fired", "ready"].includes(order.status)) throw new AppError("state_conflict", "This table's order is closed", { remedy: "Ask a member of staff." });
      const [maxRow] = await db().select({ max: sql<number>`coalesce(max(${orderLines.sort}), -1)` }).from(orderLines).where(eq(orderLines.orderId, orderId));
      const built = await buildLines(menu, b.lines as LineInput[], { orderType: order.orderType, outletId: p.outletId, today, source: "guest", addedBy: null, addedByName: b.guest_name ?? session!.guestName ?? "Guest", allowOpenPrice: false, startSort: Number(maxRow?.max ?? -1) + 1 });
      const hold = link.holdOrders;
      await db().insert(orderLines).values(built.map((l) => ({ ...l, orderId, merchantId: p.merchantId, outletId: p.outletId, roundId: b.round_id, status: (hold ? "held" : "pending") as "held" | "pending" })));
      await db().insert(guestRounds).values({ id: b.round_id, merchantId: p.merchantId, outletId: p.outletId, orderId, guestSessionId: p.sessionId, tableId: p.tableId, status: hold ? "pending" : "accepted", lineIds: built.map((l) => l.id!), guestName: b.guest_name ?? session!.guestName ?? null, notes: b.notes ?? null });
      // Price first, append events last (the first append locks the outlet's sequence counter until commit).
      await repriceOrder(orderId);
      const version = await bumpVersion(orderId);
      await settleInvariants();
      const events: AppendedEvent[] = [];
      events.push(await appendEvent({ merchantId: p.merchantId, outletId: p.outletId, type: "round.submitted", aggregate: { kind: "order", id: orderId, version: order.version }, operationId: "rounds.submit", payload: { round_id: b.round_id, line_ids: built.map((l) => l.id), held: hold, guest_name: b.guest_name ?? null }, correlationId: c.get("correlationId"), idempotencyKey: c.get("idempotencyKey"), businessDay: bd }, p));
      let warnings: string[] = [];
      if (!hold) warnings = await fireRound(c.get("correlationId"), p, order, b.round_id, bd);
      events.push(await appendEvent({ merchantId: p.merchantId, outletId: p.outletId, type: "order.repriced", aggregate: { kind: "order", id: orderId, version }, operationId: "rounds.submit", payload: { source: "guest" }, correlationId: c.get("correlationId"), businessDay: bd }, p));
      return { orderId, openedNow, hold, warnings };
    });
    recordHit(`round:sess:${p.sessionId}`);
    // The guest's RLS scope was set at request start; the order may have been opened in this request.
    await tx()`select set_config('app.current_order', ${result.orderId}, true)`;
    const view = await guestOrderView({ ...p, orderId: result.orderId });
    return c.json({ data: { round_id: b.round_id, status: result.hold ? "pending" : "accepted", order_opened: result.openedNow, ...view } }, 201);
  });

  defineOp(app, { op: "service_requests.create", method: "post", path: "/v1/guest/requests", tags: ["guest"], request: { body: jsonBody(z.object({ type: z.string().min(1).max(40), guest_name: z.string().max(40).optional() })) }, responses: { 201: jsonResponse(dataResponse(z.record(z.string(), z.unknown()))), ...errorResponses } }, async (c) => {
    const p = guestOnly(c.get("principal"));
    const b = c.req.valid("json");
    const [link] = await db().select().from(channelLinks).where(eq(channelLinks.id, p.channelLinkId)).limit(1);
    if (!link) throw AppError.notFound("channel");
    if (b.type !== "call_for_bill" && !link.serviceRequests.includes(b.type)) throw AppError.validation(`"${b.type}" is not a request this table can make`, { remedy: `Choose one of: ${[...link.serviceRequests, "call_for_bill"].join(", ")}.` });
    enforceLimit(`req:${p.tableId}:${b.type}`, RATE.requestsPerTableType, "requests of this kind");
    const bd = await businessDayInputs(p.merchantId, p.outletId);
    const data = await asSystem(async () => {
      const orderId = (await db().select({ id: guestSessions.orderId }).from(guestSessions).where(eq(guestSessions.id, p.sessionId)).limit(1))[0]?.id ?? null;
      const [row] = await db().insert(serviceRequests).values({ merchantId: p.merchantId, outletId: p.outletId, tableId: p.tableId, orderId, guestSessionId: p.sessionId, type: b.type, guestName: b.guest_name ?? null }).returning();
      if (b.type === "call_for_bill" && orderId) await db().update(orders).set({ billRequestedAt: new Date() }).where(and(eq(orders.id, orderId), isNull(orders.billRequestedAt)));
      await appendEvent({ merchantId: p.merchantId, outletId: p.outletId, type: "service_request.created", aggregate: { kind: "table", id: p.tableId }, operationId: "service_requests.create", payload: { request_id: row!.id, type: b.type, order_id: orderId }, correlationId: c.get("correlationId"), idempotencyKey: c.get("idempotencyKey"), businessDay: bd }, p);
      if (b.type === "call_for_bill" && orderId) await appendEvent({ merchantId: p.merchantId, outletId: p.outletId, type: "order.bill_requested", aggregate: { kind: "order", id: orderId }, operationId: "service_requests.create", payload: { source: "guest" }, correlationId: c.get("correlationId"), businessDay: bd }, p);
      if (link.serviceRequestPrinterId) {
        const [printer] = await db().select().from(printers).where(and(eq(printers.id, link.serviceRequestPrinterId), isNull(printers.archivedAt))).limit(1);
        const [table] = await db().select({ name: tables.name }).from(tables).where(eq(tables.id, p.tableId)).limit(1);
        const [outlet] = await db().select({ name: outlets.name }).from(outlets).where(eq(outlets.id, p.outletId)).limit(1);
        if (printer) {
          const job = await insertJob({ merchantId: p.merchantId, outletId: p.outletId, printer, kind: "service_slip", payload: { template: "service_slip", data: { header: { outlet_name: outlet?.name ?? "Outlet", brand_name: "Table request", order_no: orderId ? "QR" : "—", order_type: "dine_in", table_name: table?.name, printed_at: new Date().toISOString(), job_id: "pending", ...(await printLocale(p.merchantId)) }, request_type: b.type === "call_for_bill" ? "Call for bill" : b.type, guest_name: b.guest_name ?? undefined } }, orderId, principal: p, correlationId: c.get("correlationId") });
          await db().update(serviceRequests).set({ printJobId: job.id }).where(eq(serviceRequests.id, row!.id));
        }
      }
      return toRequest(row!);
    });
    return c.json({ data }, 201);
  });

  defineOp(app, { op: "guest.stream", method: "get", path: "/v1/guest/stream", tags: ["guest"], responses: { 200: { description: "text/event-stream: hello, change, resync for the table's order", content: { "text/event-stream": { schema: z.string() } } }, ...errorResponses } }, async (c) => {
    const p = guestOnly(c.get("principal"));
    const orderId = await withTransaction(async (t) => {
      await applyRls(t, p);
      return bindSessionToTableOrder(p);
    });
    if (!orderId) throw AppError.state("No order yet for this table", [], "Ask staff to seat you, then try again.");
    return serveStream(c, [`order:${orderId}`], { order_id: orderId }, (n) => n.kind === "resync" || (n.kind === "event" && n.aggregate_id === orderId));
  });

  /* ---- Staff side ---- */

  defineOp(app, { op: "rounds.list", method: "get", path: "/v1/outlets/{id}/rounds", tags: ["guest"], request: { params: z.object({ id: z.uuid() }), query: z.object({ status: z.enum(["pending", "accepted", "rejected", "fired"]).optional() }) }, responses: { 200: jsonResponse(listResponse(z.record(z.string(), z.unknown()))), ...errorResponses } }, async (c) => {
    const p = c.get("principal");
    const { id } = c.req.valid("param");
    const q = c.req.valid("query");
    if (!principalCanSeeOutlet(p, id)) throw AppError.notFound("outlet", id);
    const rows = await db().select().from(guestRounds).where(and(eq(guestRounds.outletId, id), q.status ? eq(guestRounds.status, q.status) : sql`true`)).orderBy(asc(guestRounds.submittedAt)).limit(200);
    const lineIds = rows.flatMap((r) => r.lineIds);
    const lines = lineIds.length ? await db().select().from(orderLines).where(inArray(orderLines.id, lineIds)) : [];
    const tableRows = rows.length ? await db().select({ id: tables.id, name: tables.name }).from(tables).where(inArray(tables.id, rows.map((r) => r.tableId))) : [];
    return c.json({ data: rows.map((r) => ({ ...toRound(r), table_name: tableRows.find((t) => t.id === r.tableId)?.name ?? null, lines: lines.filter((l) => r.lineIds.includes(l.id)).map((l) => ({ id: l.id, name: l.name, quantity: l.quantity, modifiers: l.modifiers.map((m) => m.name), notes: l.notes, status: l.status })) })), next_cursor: null }, 200);
  });

  const decide = async (c: Parameters<Parameters<typeof defineOp>[2]>[0], roundId: string, action: "accept" | "reject", reason?: string) => {
    const p = c.get("principal");
    const [round] = await db().select().from(guestRounds).where(eq(guestRounds.id, roundId)).limit(1);
    if (!round) throw AppError.notFound("QR order", roundId);
    if (round.status !== "pending") throw AppError.state(`This QR order is already ${round.status}`, []);
    const order = await lockOrder(round.orderId);
    const bd = await businessDayInputs(order.merchantId, order.outletId);
    const now = new Date();
    const events: AppendedEvent[] = [];
    let warnings: string[] = [];
    if (action === "accept") {
      await db().update(guestRounds).set({ status: "accepted", decidedAt: now, decidedBy: p.type === "staff" ? p.id : null, decidedByName: "name" in p ? p.name : null }).where(eq(guestRounds.id, roundId));
    } else {
      const lines = await db().select().from(orderLines).where(and(inArray(orderLines.id, round.lineIds), sql`${orderLines.status} <> 'voided'`));
      const today = businessDateFor(now, bd.cutoff, bd.timeZone);
      for (const l of lines) {
        await releaseDailyCap(order.outletId, l.productId, l.quantity, today);
        await db().update(orderLines).set({ status: "voided", voidedAt: now, voidReason: `QR order rejected: ${reason}`, voidedBy: p.type === "staff" ? p.id : null, baseAmount: 0, discountAmount: 0, netAmount: 0, feeAmount: 0, taxAmount: 0, taxes: [], total: 0 }).where(eq(orderLines.id, l.id));
      }
      await db().update(guestRounds).set({ status: "rejected", decidedAt: now, decidedBy: p.type === "staff" ? p.id : null, decidedByName: "name" in p ? p.name : null, rejectReason: reason ?? null }).where(eq(guestRounds.id, roundId));
    }
    await recordAudit(p, { action: `rounds.${action}`, targetKind: "order", targetId: order.id, outletId: order.outletId, reason: reason ?? null, details: { round_id: roundId } });
    // Price and check first; events (and the kitchen tickets of an accepted round) last, so the outlet's sequence lock is held briefly.
    await repriceOrder(order.id);
    const version = await bumpVersion(order.id);
    await settleInvariants();
    if (action === "accept") {
      events.push(await appendEvent({ merchantId: order.merchantId, outletId: order.outletId, type: "round.accepted", aggregate: { kind: "order", id: order.id, version: order.version }, operationId: "rounds.accept", payload: { round_id: roundId }, correlationId: c.get("correlationId"), idempotencyKey: c.get("idempotencyKey"), businessDay: bd }, p));
      warnings = await fireRound(c.get("correlationId"), p, order, roundId, bd); // statuses only, no amounts
    } else {
      events.push(await appendEvent({ merchantId: order.merchantId, outletId: order.outletId, type: "round.rejected", aggregate: { kind: "order", id: order.id, version: order.version }, operationId: "rounds.reject", payload: { round_id: roundId, line_ids: round.lineIds }, reason: { text: reason }, correlationId: c.get("correlationId"), idempotencyKey: c.get("idempotencyKey"), businessDay: bd }, p));
    }
    return c.json({ data: { ...(await loadSnapshot(order.id)), version }, events, warnings }, 200);
  };
  defineOp(app, { op: "rounds.accept", method: "post", path: "/v1/rounds/{id}/accept", tags: ["guest"], request: { params: z.object({ id: z.uuid() }), body: jsonBody(z.object({}).passthrough()) }, responses: { 200: jsonResponse(mutationResponse(z.record(z.string(), z.unknown()))), ...errorResponses } }, (c) => decide(c, c.req.valid("param").id, "accept"));
  defineOp(app, { op: "rounds.reject", method: "post", path: "/v1/rounds/{id}/reject", tags: ["guest"], request: { params: z.object({ id: z.uuid() }), body: jsonBody(z.object({ reason: z.string().min(1).max(200) })) }, responses: { 200: jsonResponse(mutationResponse(z.record(z.string(), z.unknown()))), ...errorResponses } }, (c) => decide(c, c.req.valid("param").id, "reject", c.req.valid("json").reason));

  defineOp(app, { op: "service_requests.list", method: "get", path: "/v1/outlets/{id}/service-requests", tags: ["guest"], request: { params: z.object({ id: z.uuid() }), query: z.object({ status: z.enum(["open", "acknowledged"]).optional() }) }, responses: { 200: jsonResponse(listResponse(z.record(z.string(), z.unknown()))), ...errorResponses } }, async (c) => {
    const p = c.get("principal");
    const { id } = c.req.valid("param");
    const q = c.req.valid("query");
    if (!principalCanSeeOutlet(p, id)) throw AppError.notFound("outlet", id);
    const rows = await db().select().from(serviceRequests).where(and(eq(serviceRequests.outletId, id), q.status ? eq(serviceRequests.status, q.status) : sql`true`)).orderBy(asc(serviceRequests.createdAt)).limit(200);
    const tableRows = rows.length ? await db().select({ id: tables.id, name: tables.name }).from(tables).where(inArray(tables.id, rows.map((r) => r.tableId))) : [];
    return c.json({ data: rows.map((r) => ({ ...toRequest(r), table_name: tableRows.find((t) => t.id === r.tableId)?.name ?? null })), next_cursor: null }, 200);
  });

  defineOp(app, { op: "service_requests.acknowledge", method: "post", path: "/v1/service-requests/{id}/acknowledge", tags: ["guest"], request: { params: z.object({ id: z.uuid() }), body: jsonBody(z.object({}).passthrough()) }, responses: { 200: jsonResponse(mutationResponse(z.record(z.string(), z.unknown()))), ...errorResponses } }, async (c) => {
    const p = c.get("principal");
    const { id } = c.req.valid("param");
    const [row] = await db().update(serviceRequests).set({ status: "acknowledged", acknowledgedAt: new Date(), acknowledgedBy: p.type === "staff" ? p.id : null, acknowledgedByName: "name" in p ? p.name : null }).where(and(eq(serviceRequests.id, id), eq(serviceRequests.status, "open"))).returning();
    if (!row) throw AppError.notFound("open table request", id);
    const ev = await appendEvent({ merchantId: p.merchantId, outletId: row.outletId, type: "service_request.acknowledged", aggregate: { kind: "table", id: row.tableId }, operationId: "service_requests.acknowledge", payload: { request_id: id, type: row.type }, correlationId: c.get("correlationId"), idempotencyKey: c.get("idempotencyKey"), businessDay: await businessDayInputs(p.merchantId, row.outletId) }, p);
    return c.json({ data: toRequest(row), events: [ev], warnings: [] }, 200);
  });

  defineOp(app, { op: "tables.rotate_qr_token", method: "post", path: "/v1/tables/{id}/qr/rotate", tags: ["guest"], request: { params: z.object({ id: z.uuid() }), body: jsonBody(z.object({}).passthrough()) }, responses: { 201: jsonResponse(mutationResponse(z.object({ url: z.string() }))), ...errorResponses } }, async (c) => {
    const p = c.get("principal");
    const { id } = c.req.valid("param");
    const [table] = await db().select().from(tables).where(and(eq(tables.id, id), isNull(tables.archivedAt))).limit(1);
    if (!table) throw AppError.notFound("table", id);
    const { url } = await rotateTableToken({ id: table.id, merchantId: table.merchantId, outletId: table.outletId });
    const ev = await appendEvent({ merchantId: p.merchantId, outletId: table.outletId, type: "table.qr_rotated", aggregate: { kind: "table", id }, operationId: "tables.rotate_qr_token", payload: {}, correlationId: c.get("correlationId"), idempotencyKey: c.get("idempotencyKey"), businessDay: await businessDayInputs(p.merchantId, table.outletId) }, p);
    await recordAudit(p, { action: "tables.rotate_qr_token", targetKind: "table", targetId: id, outletId: table.outletId });
    return c.json({ data: { url }, events: [ev], warnings: [] }, 201);
  });

  defineOp(app, { op: "tables.qr_sheet", method: "get", path: "/v1/outlets/{id}/qr-sheet.pdf", tags: ["guest"], request: { params: z.object({ id: z.uuid() }) }, responses: { 200: { description: "PDF of QR cards", content: { "application/pdf": { schema: z.string() } } }, ...errorResponses } }, async (c) => {
    const p = c.get("principal");
    const { id } = c.req.valid("param");
    if (!principalCanSeeOutlet(p, id)) throw AppError.notFound("outlet", id);
    const pdf = await qrSheetPdf(id, p.merchantId);
    await recordAudit(p, { action: "tables.qr_sheet", targetKind: "outlet", targetId: id, outletId: id });
    return c.body(pdf as unknown as ArrayBuffer, 200, { "content-type": "application/pdf", "content-disposition": 'inline; filename="qr-sheet.pdf"' });
  });
}

/** Fire a round's lines and print kitchen tickets (used by immediate rounds and by acceptance). */
async function fireRound(correlationId: string, p: Principal, order: typeof orders.$inferSelect, roundId: string, bd: { cutoff: string; timeZone: string }): Promise<string[]> {
  const lines = await db().select().from(orderLines).where(and(eq(orderLines.roundId, roundId), inArray(orderLines.status, ["pending", "held"])));
  if (lines.length === 0) return [];
  const now = new Date();
  const round = order.roundCount + 1;
  await db().update(orderLines).set({ status: "fired", firedAt: now, fireRound: round, updatedAt: now }).where(inArray(orderLines.id, lines.map((l) => l.id)));
  await db().update(orders).set({ roundCount: round, status: order.status === "open" ? "fired" : order.status, firstFiredAt: order.firstFiredAt ?? now }).where(eq(orders.id, order.id));
  await db().update(guestRounds).set({ status: "fired" }).where(eq(guestRounds.id, roundId));
  await appendEvent({ merchantId: order.merchantId, outletId: order.outletId, type: "order.fired", aggregate: { kind: "order", id: order.id, version: order.version }, operationId: "rounds.submit", payload: { round, line_ids: lines.map((l) => l.id), source: "guest", round_id: roundId }, correlationId, businessDay: bd }, p);
  const { warnings } = await createKitchenJobs({ order: { ...order, roundCount: round }, lines: lines.map((l) => ({ ...l, status: "fired" as const })), round, stationId: null, principal: p, correlationId });
  return warnings;
}
