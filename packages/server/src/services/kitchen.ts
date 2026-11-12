import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, isNotNull, isNull, ne, sql, type SQL } from "drizzle-orm";
import { db, isDryRun, tx } from "../db/client.js";
import { displayDestinations, kitchenTicketLines, kitchenTickets, merchantSettings, orderLines, orders, outlets, stations } from "../db/schema/index.js";
import { AppError } from "../lib/errors.js";
import { appendEvent, type AppendedEvent } from "../lib/events.js";
import type { Principal } from "../auth/principal.js";
import type { BusinessDayInputs } from "./business-day.js";

/**
 * Kitchen display tickets. Tickets are created by the fire that sends the
 * lines (see createKitchenJobs), one per display destination the routing picks,
 * and later events change them rather than editing them silently: a void
 * strikes the line and flags the ticket changed, an order cancel cancels its
 * tickets. Start, bump and recall are conditional updates, so a double tap or
 * two displays bumping the same ticket change it once.
 */

export type DestinationRow = typeof displayDestinations.$inferSelect;
export type TicketRow = typeof kitchenTickets.$inferSelect;
type OrderRow = typeof orders.$inferSelect;
type LineRow = typeof orderLines.$inferSelect;

/** A destination in the shape the printer routing reads, so displays route by exactly the same rules. */
export function asRouteTarget(d: DestinationRow) {
  return { ...d, role: "kitchen" as const, stationId: null, isDefaultKitchen: d.isDefault };
}

/** The outlet's live destinations as route targets. Issued alongside the printer read, so it adds no round trip. */
export function activeDestinations(outletId: string) {
  return db()
    .select()
    .from(displayDestinations)
    .where(and(eq(displayDestinations.outletId, outletId), isNull(displayDestinations.archivedAt)))
    .then((rows) => rows.map(asRouteTarget));
}

/** Business-day inputs in one read (merchant cutoff, outlet override, zone), for stamping the ticket events. */
export function ticketBusinessDay(outletId: string): Promise<BusinessDayInputs> {
  return db()
    .select({ cutoff: merchantSettings.businessDayCutoff, outletCutoff: outlets.businessDayCutoff, timeZone: merchantSettings.timezone })
    .from(outlets)
    .innerJoin(merchantSettings, eq(merchantSettings.merchantId, outlets.merchantId))
    .where(eq(outlets.id, outletId))
    .limit(1)
    .then(([r]) => {
      if (!r) throw AppError.notFound("outlet", outletId);
      return { cutoff: r.outletCutoff ?? r.cutoff, timeZone: r.timeZone };
    });
}

/**
 * One `kitchen_ticket.*` event. A change made by an order event (a fire, a void, a cancel) is one event on the order
 * listing every ticket it touched, so the fire path appends one event however many displays it reaches; a display's own
 * action is an event on its ticket.
 */
function event(at: { merchantId: string; outletId: string }, type: string, aggregate: { kind: "order" | "kitchen_ticket"; id: string }, payload: Record<string, unknown>, ctx: { principal: Principal; correlationId: string; operationId: string; idempotencyKey?: string | null; bd: BusinessDayInputs }): Promise<AppendedEvent> {
  return appendEvent({ merchantId: at.merchantId, outletId: at.outletId, type, aggregate, operationId: ctx.operationId, payload, correlationId: ctx.correlationId, idempotencyKey: ctx.idempotencyKey ?? null, businessDay: ctx.bd }, ctx.principal);
}

/** Insert one ticket per routed destination with its lines (two statements, pipelined) and emit one `kitchen_ticket.created` for the fire. */
export async function createKitchenTickets(input: { order: OrderRow; tableName: string | null; routed: { printer: DestinationRow; lines: LineRow[] }[]; round: number; principal: Principal; correlationId: string; operationId: string; bd: BusinessDayInputs }): Promise<string[]> {
  if (input.routed.length === 0) return [];
  const firedAt = new Date();
  const serverName = "name" in input.principal ? input.principal.name : null;
  const tickets = input.routed.map((r) => ({ id: randomUUID(), destination: r.printer, lines: r.lines }));
  if (!isDryRun()) {
    const o = input.order;
    const ticketRows = tickets.map((t) => ({ id: t.id, merchantId: o.merchantId, outletId: o.outletId, destinationId: t.destination.id, orderId: o.id, roundNo: input.round, orderNo: o.orderNo, orderType: o.orderType, tableName: input.tableName, pax: o.pax, customerName: o.customerRef?.name ?? null, serverName, firedAt }));
    const lineRows = tickets.flatMap((t) =>
      t.lines.map((l) => ({
        merchantId: input.order.merchantId,
        outletId: input.order.outletId,
        ticketId: t.id,
        orderLineId: l.id,
        productId: l.productId,
        name: l.kitchenName ?? l.name,
        quantity: l.quantity,
        modifiers: l.modifiers.map((m) => (m.quantity > 1 ? `${m.quantity}× ${m.name}` : m.name)),
        notes: l.notes ?? null,
        seatNo: l.seatNo ?? null,
        source: l.source,
        sort: l.sort,
      })),
    );
    // Pipelined on the transaction's connection: the lines follow the tickets in order, in one round trip.
    await Promise.all([db().insert(kitchenTickets).values(ticketRows), db().insert(kitchenTicketLines).values(lineRows)]);
  }
  await event(input.order, "kitchen_ticket.created", { kind: "order", id: input.order.id }, { order_id: input.order.id, round_no: input.round, tickets: tickets.map((t) => ({ ticket_id: t.id, destination_id: t.destination.id, line_ids: t.lines.map((l) => l.id) })) }, input);
  return tickets.map((t) => t.id);
}

/** A void after the fire: strike the quantity on every ticket that carries the line and flag those tickets changed. */
export async function strikeVoidedLine(input: { order: OrderRow; lineId: string; quantity: number; principal: Principal; correlationId: string; operationId: string; idempotencyKey?: string | null }): Promise<void> {
  if (isDryRun()) return;
  // One statement: the line update and the ticket flag together, so the void path gains a single round trip.
  const [changed, bd] = await Promise.all([
    tx()<{ id: string; destination_id: string }[]>`
    with struck as (
      update kitchen_ticket_lines set voided_quantity = least(quantity, voided_quantity + ${input.quantity})
      where order_line_id = ${input.lineId} and voided_quantity < quantity
      returning ticket_id
    )
    update kitchen_tickets set changed = true, changed_at = now()
    where id in (select ticket_id from struck)
    returning id, destination_id`,
    ticketBusinessDay(input.order.outletId),
  ]);
  if (changed.length === 0) return;
  await event(input.order, "kitchen_ticket.changed", { kind: "order", id: input.order.id }, { order_id: input.order.id, line_id: input.lineId, voided_quantity: input.quantity, tickets: changed.map((t) => ({ ticket_id: t.id, destination_id: t.destination_id })) }, { ...input, bd });
}

/** The order was cancelled: every ticket of it that is not already cancelled is. */
export async function cancelOrderTickets(input: { order: OrderRow; principal: Principal; correlationId: string; operationId: string; idempotencyKey?: string | null }): Promise<void> {
  if (isDryRun()) return;
  const [rows, bd] = await Promise.all([
    db()
      .update(kitchenTickets)
      .set({ status: "cancelled", cancelledAt: new Date() })
      .where(and(eq(kitchenTickets.orderId, input.order.id), ne(kitchenTickets.status, "cancelled")))
      .returning({ id: kitchenTickets.id, destinationId: kitchenTickets.destinationId }),
    ticketBusinessDay(input.order.outletId),
  ]);
  if (rows.length === 0) return;
  await event(input.order, "kitchen_ticket.cancelled", { kind: "order", id: input.order.id }, { order_id: input.order.id, tickets: rows.map((t) => ({ ticket_id: t.id, destination_id: t.destinationId })) }, { ...input, bd });
}

/* ---- Reading and acting from a display ------------------------------------ */

/**
 * The destinations a caller may see: a display station sees only the ones it is
 * assigned, and so does anyone signed in on it; other staff and agents see every
 * destination their outlet scope (RLS) allows. A POS station without a PIN
 * session sees none.
 */
export async function destinationScope(p: Principal): Promise<string[] | null> {
  const stationId = p.type === "station" ? p.stationId : p.type === "staff" ? (p.stationId ?? null) : null;
  if (!stationId) return null;
  const [st] = await db().select({ kind: stations.kind, ids: stations.displayDestinationIds }).from(stations).where(eq(stations.id, stationId)).limit(1);
  if (p.type === "staff") return st?.kind === "display" ? st.ids : null;
  if (!st || st.kind !== "display") throw new AppError("permission_denied", "Only a kitchen display station reads tickets without a PIN", { remedy: "Pair this screen to a display station, or sign in with a PIN." });
  return st.ids;
}

function scopeConds(scope: string[] | null, destinationId?: string): SQL[] {
  const conds: SQL[] = [];
  if (destinationId) conds.push(eq(kitchenTickets.destinationId, destinationId));
  if (scope) conds.push(scope.length ? inArray(kitchenTickets.destinationId, scope) : sql`false`);
  return conds;
}

export type TicketView = Awaited<ReturnType<typeof loadTickets>>[number];

/** Tickets with their destination and lines, oldest fire first (or the latest bump first); every open ticket unless limited. */
async function loadTickets(where: SQL[], order: "fired" | "bumped" = "fired", limit?: number) {
  const query = db()
    .select({ t: kitchenTickets, destinationName: displayDestinations.name })
    .from(kitchenTickets)
    .innerJoin(displayDestinations, eq(displayDestinations.id, kitchenTickets.destinationId))
    .where(and(...where))
    .orderBy(...(order === "fired" ? [asc(kitchenTickets.firedAt), asc(kitchenTickets.id)] : [desc(kitchenTickets.bumpedAt)]));
  const rows = limit ? await query.limit(limit) : await query;
  const lines = rows.length ? await db().select().from(kitchenTicketLines).where(inArray(kitchenTicketLines.ticketId, rows.map((r) => r.t.id))).orderBy(asc(kitchenTicketLines.sort)) : [];
  return rows.map((r) => ({
    id: r.t.id,
    outlet_id: r.t.outletId,
    destination_id: r.t.destinationId,
    destination_name: r.destinationName,
    order_id: r.t.orderId,
    order_no: r.t.orderNo,
    order_type: r.t.orderType,
    table_name: r.t.tableName,
    customer_name: r.t.customerName,
    pax: r.t.pax,
    round_no: r.t.roundNo,
    server_name: r.t.serverName,
    status: r.t.status,
    changed: r.t.changed,
    fired_at: r.t.firedAt.toISOString(),
    started_at: r.t.startedAt?.toISOString() ?? null,
    bumped_at: r.t.bumpedAt?.toISOString() ?? null,
    recalled_at: r.t.recalledAt?.toISOString() ?? null,
    cancelled_at: r.t.cancelledAt?.toISOString() ?? null,
    lines: lines
      .filter((l) => l.ticketId === r.t.id)
      .map((l) => ({ id: l.id, order_line_id: l.orderLineId, product_id: l.productId, name: l.name, quantity: l.quantity, voided_quantity: l.voidedQuantity, modifiers: l.modifiers, notes: l.notes, seat_no: l.seatNo, source: l.source })),
  }));
}

/** Open tickets (not bumped) of an outlet in fired order, and the most recent bumped one for Recall. */
export async function openTickets(outletId: string, scope: string[] | null, destinationId?: string) {
  const base = [eq(kitchenTickets.outletId, outletId), ...scopeConds(scope, destinationId)];
  const [open, last] = await Promise.all([loadTickets([...base, isNull(kitchenTickets.bumpedAt)]), loadTickets([...base, eq(kitchenTickets.status, "ready")], "bumped", 1)]);
  return { open, lastBumped: last[0] ?? null };
}

/** Every ticket of one order (any state), for the POS's ready marks. */
export function orderTickets(outletId: string, orderId: string, scope: string[] | null) {
  return loadTickets([eq(kitchenTickets.outletId, outletId), eq(kitchenTickets.orderId, orderId), ...scopeConds(scope)]);
}

/** Items still to make on the open tickets, by product: the "all day" count. */
export async function allDay(outletId: string, scope: string[] | null, destinationId?: string) {
  const rows = await db()
    .select({ productId: kitchenTicketLines.productId, name: kitchenTicketLines.name, quantity: sql<number>`sum(${kitchenTicketLines.quantity} - ${kitchenTicketLines.voidedQuantity})::int` })
    .from(kitchenTicketLines)
    .innerJoin(kitchenTickets, eq(kitchenTickets.id, kitchenTicketLines.ticketId))
    .where(and(eq(kitchenTickets.outletId, outletId), isNull(kitchenTickets.bumpedAt), ne(kitchenTickets.status, "cancelled"), ...scopeConds(scope, destinationId)))
    .groupBy(kitchenTicketLines.productId, kitchenTicketLines.name)
    .having(sql`sum(${kitchenTicketLines.quantity} - ${kitchenTicketLines.voidedQuantity}) > 0`)
    .orderBy(desc(sql`sum(${kitchenTicketLines.quantity} - ${kitchenTicketLines.voidedQuantity})`), asc(kitchenTicketLines.name));
  return rows.map((r) => ({ product_id: r.productId, name: r.name, quantity: r.quantity }));
}

export type TicketAction = "start" | "bump" | "recall";

/**
 * Start, bump or recall one ticket. The update is conditional on the state it
 * leaves, so of two taps (or two displays) racing on one ticket the first moves
 * it and the second finds it already moved and returns it unchanged, with no
 * event. Returns whether this call changed the ticket.
 */
export async function actOnTicket(action: TicketAction, ticketId: string, p: Principal, ctx: { correlationId: string; idempotencyKey: string | null }): Promise<{ ticket: TicketView; changed: boolean; events: AppendedEvent[] }> {
  const scope = await destinationScope(p);
  const visible = [eq(kitchenTickets.id, ticketId), ...scopeConds(scope)];
  const now = new Date();
  const [row] =
    action === "start"
      ? await db().update(kitchenTickets).set({ status: "in_progress", startedAt: now }).where(and(...visible, inArray(kitchenTickets.status, ["new", "recalled"]))).returning()
      : action === "bump"
        ? // A cancelled ticket stays cancelled; bumping it only takes it off the display.
          await db().update(kitchenTickets).set({ status: sql`case when ${kitchenTickets.status} = 'cancelled' then 'cancelled'::kitchen_ticket_status else 'ready'::kitchen_ticket_status end`, bumpedAt: now }).where(and(...visible, isNull(kitchenTickets.bumpedAt))).returning()
        : // Only the last ticket bumped at its destination comes back; recalling again walks back one at a time.
          await db()
            .update(kitchenTickets)
            .set({ status: "recalled", bumpedAt: null, recalledAt: now })
            .where(and(...visible, eq(kitchenTickets.status, "ready"), isNotNull(kitchenTickets.bumpedAt), sql`not exists (select 1 from kitchen_tickets later where later.destination_id = ${kitchenTickets.destinationId} and later.status = 'ready' and later.bumped_at > ${kitchenTickets.bumpedAt})`))
            .returning();
  if (!row) {
    const [current] = await loadTickets(visible);
    if (!current) throw AppError.notFound("kitchen ticket", ticketId);
    // Already where the action leaves it: a double tap or the other display got there first.
    const settled = action === "start" ? current.status === "in_progress" : action === "bump" ? current.bumped_at !== null : current.bumped_at === null && current.status !== "cancelled";
    if (settled) return { ticket: current, changed: false, events: [] };
    if (action === "recall" && current.status === "ready") throw AppError.state("A ticket bumped later at this destination comes back first", ["kitchen_tickets.recall on the last bumped ticket"], "Recall the last bumped ticket.");
    const allowed = current.status === "cancelled" ? ["kitchen_tickets.bump"] : current.status === "ready" ? ["kitchen_tickets.recall"] : ["kitchen_tickets.bump"];
    throw AppError.state(`The ticket is ${current.status.replace("_", " ")}`, allowed);
  }
  const type = action === "start" ? "kitchen_ticket.started" : action === "bump" ? "kitchen_ticket.bumped" : "kitchen_ticket.recalled";
  const ev = await event(row, type, { kind: "kitchen_ticket", id: row.id }, { ticket_id: row.id, destination_id: row.destinationId, order_id: row.orderId, status: row.status }, { principal: p, correlationId: ctx.correlationId, idempotencyKey: ctx.idempotencyKey, operationId: `kitchen_tickets.${action}`, bd: await ticketBusinessDay(row.outletId) });
  const [ticket] = await loadTickets([eq(kitchenTickets.id, row.id)]);
  return { ticket: ticket!, changed: true, events: [ev] };
}
