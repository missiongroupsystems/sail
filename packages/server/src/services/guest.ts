import { createHmac, randomUUID } from "node:crypto";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import QRCode from "qrcode";
import { and, asc, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { db, tx, withOwnTransaction } from "../db/client.js";
import { brands, channelLinks, guestRounds, guestSessions, orderAdjustments, orderLines, orders, outlets, serviceRequests, tableQrTokens, tables } from "../db/schema/index.js";
import { AppError } from "../lib/errors.js";
import { sha256, signSailToken } from "../auth/tokens.js";
import { config } from "../config.js";
import type { Principal } from "../auth/principal.js";

/**
 * Scan to Order services. Guests never pay. Sessions are bound
 * to one table and its open order; rate limits apply per device and per table.
 */
export const GUEST_SESSION_HOURS = 4;

/* ---- Rate limits (sliding windows in Postgres, shared by every API machine; the admission gate still protects the database) ---- */
/**
 * Look at a key's hits inside the window, under a row lock so concurrent
 * attempts count one after another, and keep only those. With `record`, add
 * this attempt when it is allowed. Returns the seconds to wait when the window
 * is full. Commits on its own, so a hit recorded before a refusal still counts.
 * Times come from the database clock, so every API machine agrees.
 */
async function hitWindow(merchantId: string, key: string, [max, windowMs]: readonly [number, number], record: boolean): Promise<number | null> {
  return withOwnTransaction(async (sql) => {
    // An upsert that touches the row also locks it, so the worker's prune cannot delete it before the select below.
    if (record) await sql`insert into guest_rate_hits (merchant_id, key) values (${merchantId}, ${key}) on conflict (merchant_id, key) do update set key = excluded.key`;
    const [row] = await sql<{ hits: number[]; now: number }[]>`select (select coalesce(json_agg(floor(extract(epoch from h) * 1000)::bigint order by h), '[]'::json) from unnest(g.hits) h) as hits, floor(extract(epoch from clock_timestamp()) * 1000)::float8 as now from guest_rate_hits g where merchant_id = ${merchantId} and key = ${key} for update`;
    if (!row) return null;
    const hits = row.hits.filter((t) => row.now - t < windowMs);
    const retry = hits.length >= max ? Math.ceil((hits[0]! + windowMs - row.now) / 1000) : null;
    if (record && retry == null) hits.push(row.now);
    await sql`update guest_rate_hits set hits = array(select to_timestamp(t::float8 / 1000) from jsonb_array_elements_text(${JSON.stringify(hits)}::jsonb) t) where merchant_id = ${merchantId} and key = ${key}`;
    return retry;
  });
}
/** Worker: drop keys with no hit inside the longest window. */
export async function pruneGuestRateHits(): Promise<void> {
  const longest = Math.max(...Object.values(RATE).map(([, ms]) => ms));
  await withOwnTransaction((sql) => sql`delete from guest_rate_hits where not exists (select 1 from unnest(hits) h where h > clock_timestamp() - make_interval(secs => ${longest / 1000}))`);
}
function limitedError(what: string, retry: number): AppError {
  return new AppError("rate_limited", `Too many ${what}; please wait`, { remedy: `Try again in ${retry} seconds.`, details: { retry_after_seconds: retry } });
}
export async function resetGuestRateLimitsForTests() {
  await withOwnTransaction((sql) => sql`delete from guest_rate_hits`);
}
export const RATE = { sessionsPerDevice: [10, 3_600_000], sessionsPerTable: [30, 3_600_000], roundsPerSession: [1, 10_000], roundsPerTable: [40, 3_600_000], requestsPerTableType: [1, 60_000] } as const;

export async function enforceLimit(merchantId: string, key: string, limit: readonly [number, number], what: string) {
  const retry = await hitWindow(merchantId, key, limit, true);
  if (retry != null) throw limitedError(what, retry);
}

/** Check without recording (record with `recordHit` once the request succeeded), so a rejected attempt does not count. */
export async function checkLimit(merchantId: string, key: string, limit: readonly [number, number], what: string) {
  const retry = await hitWindow(merchantId, key, limit, false);
  if (retry != null) throw limitedError(what, retry);
}
export async function recordHit(merchantId: string, key: string, limit: readonly [number, number]) {
  await hitWindow(merchantId, key, [Number.MAX_SAFE_INTEGER, limit[1]], true);
}

/** Run `fn` as the register (app_authenticated) inside a guest or agent request, then drop back to the caller's role. */
export async function asSystem<T>(fn: () => Promise<T>): Promise<T> {
  const [me] = await tx()<{ role: string }[]>`select current_user as role`;
  await tx().unsafe("set local role app_authenticated");
  try {
    return await fn();
  } finally {
    await tx().unsafe(`set local role "${me!.role}"`);
  }
}

/* ---- Table QR tokens ---- */

/**
 * A table's QR token, derived from its row id and the guest secret. The database keeps only the hash, as before, yet a
 * QR sheet can print the live code again without replacing it.
 */
function tableToken(rowId: string): string {
  const secret = config().GUEST_TOKEN_SECRET;
  if (!secret) throw new Error("GUEST_TOKEN_SECRET is required for table QR codes");
  return createHmac("sha256", secret).update(`table-qr:${rowId}`).digest().subarray(0, 24).toString("base64url");
}

export async function rotateTableToken(table: { id: string; merchantId: string; outletId: string }): Promise<{ token: string; url: string }> {
  const id = randomUUID();
  const token = tableToken(id);
  // One instant for both: a session ended at exactly the moment its table's code was replaced was ended by the rotation.
  const now = new Date();
  await db().update(tableQrTokens).set({ rotatedAt: now }).where(and(eq(tableQrTokens.tableId, table.id), isNull(tableQrTokens.rotatedAt)));
  await db().insert(tableQrTokens).values({ id, merchantId: table.merchantId, outletId: table.outletId, tableId: table.id, tokenHash: sha256(token) });
  // Phones that scanned the old code lose their sessions too: a rotation stops the old card working at once.
  await db().update(guestSessions).set({ revokedAt: now }).where(and(eq(guestSessions.tableId, table.id), isNull(guestSessions.revokedAt)));
  return { token, url: guestUrl(token) };
}

export function guestUrl(token: string) {
  return `${config().GUEST_APP_URL.replace(/\/$/, "")}/t/${token}`;
}

/**
 * The live code of each table at the outlet, as it is printed on the table now; a table with no code gets its first
 * one. A code that cannot be printed again (made before codes were derived, or under another GUEST_TOKEN_SECRET) is
 * never replaced here: the sheet is refused with those tables named, and rotating them is the Admin's own choice.
 */
export async function currentTableTokens(outletId: string, merchantId: string): Promise<{ table: typeof tables.$inferSelect; token: string }[]> {
  const rows = await db().select().from(tables).where(and(eq(tables.outletId, outletId), isNull(tables.archivedAt))).orderBy(tables.name);
  const out: { table: typeof tables.$inferSelect; token: string }[] = [];
  const unprintable: string[] = [];
  for (const t of rows) {
    const [live] = await db().select().from(tableQrTokens).where(and(eq(tableQrTokens.tableId, t.id), isNull(tableQrTokens.rotatedAt))).limit(1);
    if (live && sha256(tableToken(live.id)) !== live.tokenHash) unprintable.push(t.name);
    else out.push({ table: t, token: live ? tableToken(live.id) : (await rotateTableToken({ id: t.id, merchantId, outletId })).token });
  }
  if (unprintable.length) throw new AppError("state_conflict", `The codes on ${unprintable.join(", ")} cannot be printed again`, { remedy: "They were made before codes could be reprinted. Rotate every code at this outlet, then download the sheet and replace those cards.", details: { tables: unprintable } });
  return out;
}

export async function qrSheetPdf(outletId: string, merchantId: string): Promise<Uint8Array> {
  const [outlet] = await db().select().from(outlets).where(eq(outlets.id, outletId)).limit(1);
  const links = await db().select().from(channelLinks).where(and(eq(channelLinks.outletId, outletId), eq(channelLinks.channel, "scan_to_order"), eq(channelLinks.enabled, true)));
  const brandName = links[0] ? (await db().select({ name: brands.name }).from(brands).where(eq(brands.id, links[0].brandId)).limit(1))[0]?.name : null;
  const entries = await currentTableTokens(outletId, merchantId);
  const pdf = await PDFDocument.create();
  pdf.setTitle(`Scan to order · ${outlet?.name ?? ""}`);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const perPage = 6; // 2 × 3 cards on A4
  for (let i = 0; i < entries.length; i += perPage) {
    const page = pdf.addPage([595.28, 841.89]);
    const batch = entries.slice(i, i + perPage);
    for (let j = 0; j < batch.length; j++) {
      const { table, token } = batch[j]!;
      const col = j % 2;
      const row = Math.floor(j / 2);
      const x = 40 + col * 270;
      const y = 841.89 - 40 - (row + 1) * 255;
      page.drawRectangle({ x, y, width: 250, height: 245, borderColor: rgb(0.85, 0.83, 0.8), borderWidth: 0.5 });
      const png = await QRCode.toBuffer(guestUrl(token), { type: "png", margin: 1, width: 400, errorCorrectionLevel: "M" });
      const img = await pdf.embedPng(png);
      page.drawImage(img, { x: x + 55, y: y + 70, width: 140, height: 140 });
      page.drawText(brandName ?? outlet?.name ?? "", { x: x + 16, y: y + 220, size: 12, font: bold, color: rgb(0.11, 0.11, 0.12) });
      page.drawText(`Table ${table.name}`, { x: x + 16, y: y + 48, size: 18, font: bold, color: rgb(0.11, 0.11, 0.12) });
      page.drawText("Scan to order from your phone", { x: x + 16, y: y + 30, size: 9, font, color: rgb(0.37, 0.35, 0.33) });
      page.drawText("Pay at the counter or ask your server for the bill", { x: x + 16, y: y + 16, size: 8, font, color: rgb(0.37, 0.35, 0.33) });
    }
  }
  return pdf.save({ useObjectStreams: false });
}

/* ---- Sessions ---- */

export async function openOrderIdForTable(tableId: string): Promise<string | null> {
  const [o] = await db().select({ id: orders.id }).from(orders).where(and(eq(orders.tableId, tableId), inArray(orders.status, ["open", "fired", "ready", "out_for_delivery"]))).limit(1);
  return o?.id ?? null;
}

export async function createGuestSession(input: { token: string; deviceId: string; guestName?: string | null }): Promise<{ sessionToken: string; session: typeof guestSessions.$inferSelect; link: typeof channelLinks.$inferSelect; table: typeof tables.$inferSelect; orderOpen: boolean }> {
  const [tok] = await db().select().from(tableQrTokens).where(and(eq(tableQrTokens.tokenHash, sha256(input.token)), isNull(tableQrTokens.rotatedAt))).limit(1);
  if (!tok) {
    // A code replaced by "Rotate code" is not a typo: the guest is told the table has a new one to scan (D-N1).
    const [old] = await db().select({ id: tableQrTokens.id }).from(tableQrTokens).where(eq(tableQrTokens.tokenHash, sha256(input.token))).limit(1);
    if (old) throw new AppError("not_found", "This table has a new QR code", { remedy: "Scan the code on the table again to keep ordering.", details: { reason: "code_rotated" } });
    throw AppError.notFound("table code", undefined);
  }
  const [table] = await db().select().from(tables).where(and(eq(tables.id, tok.tableId), isNull(tables.archivedAt))).limit(1);
  if (!table) throw AppError.notFound("table");
  const deviceHash = sha256(`${tok.merchantId}:${input.deviceId}`);
  await enforceLimit(tok.merchantId, `sess:dev:${deviceHash}`, RATE.sessionsPerDevice, "sign-ins from this device");
  await enforceLimit(tok.merchantId, `sess:table:${table.id}`, RATE.sessionsPerTable, "sign-ins at this table");
  const [link] = await db().select().from(channelLinks).where(and(eq(channelLinks.outletId, table.outletId), eq(channelLinks.channel, "scan_to_order"), eq(channelLinks.enabled, true))).limit(1);
  if (!link) throw new AppError("unavailable", "Ordering from your phone is not available at this outlet", { remedy: "Please order with a member of staff." });
  const orderId = await openOrderIdForTable(table.id);
  const expiresAt = new Date(Date.now() + GUEST_SESSION_HOURS * 3600 * 1000);
  const [session] = await db().insert(guestSessions).values({ merchantId: tok.merchantId, outletId: table.outletId, brandId: link.brandId, tableId: table.id, channelLinkId: link.id, orderId, deviceHash, guestName: input.guestName ?? null, expiresAt }).returning();
  const sessionToken = await signSailToken({ typ: "guest", merchant_id: tok.merchantId, outlet_id: table.outletId, brand_id: link.brandId, table_id: table.id, channel_link_id: link.id, session_id: session!.id }, GUEST_SESSION_HOURS * 3600);
  return { sessionToken, session: session!, link, table, orderOpen: orderId != null };
}

/** Revoke every guest session on an order (when it closes). */
export async function revokeSessionsForOrder(orderId: string) {
  await db().update(guestSessions).set({ revokedAt: new Date() }).where(and(eq(guestSessions.orderId, orderId), isNull(guestSessions.revokedAt)));
}

/**
 * With hold orders off, whether a phone's round goes straight to the kitchen: it is the first phone to order at this
 * seating, or staff have accepted a round from it. Keyed on the order and the device, so it follows the order to another
 * table, outlasts the session (a fresh scan from the same phone), and ends when the order closes. A rejected round counts
 * for nobody. Call with the order locked, so two first phones cannot both be first.
 */
export async function phoneAdmitted(orderId: string, deviceHash: string): Promise<boolean> {
  const [r] = await tx()<{ any: boolean; mine: boolean }[]>`
    select count(*) > 0 as any, coalesce(bool_or(s.device_hash = ${deviceHash}), false) as mine
    from guest_rounds r join guest_sessions s on s.id = r.guest_session_id
    where r.order_id = ${orderId} and r.status in ('accepted', 'fired')`;
  return !r!.any || r!.mine;
}

/** Worker safety net: revoke sessions whose order has closed, and expired ones. */
export async function revokeStaleSessions(): Promise<number> {
  const rows = await tx()<{ id: string }[]>`
    update guest_sessions s set revoked_at = now()
    where s.revoked_at is null and (s.expires_at < now() or exists (select 1 from orders o where o.id = s.order_id and o.status in ('completed','cancelled')))
    returning s.id`;
  return rows.length;
}

/* ---- Guest view ---- */

/**
 * Bind a session that was started before the table was seated to the table's
 * order once one exists, so a guest who scanned early can order without
 * starting another (rate-limited) session. Runs as the register for the write,
 * then widens the guest's RLS scope to the order for the rest of the request.
 */
export async function bindSessionToTableOrder(p: Extract<Principal, { type: "guest" }>): Promise<string | null> {
  const [session] = await db().select({ orderId: guestSessions.orderId, tableId: guestSessions.tableId }).from(guestSessions).where(eq(guestSessions.id, p.sessionId)).limit(1);
  if (!session) return null;
  if (session.orderId) return session.orderId;
  const orderId = await asSystem(async () => {
    const id = await openOrderIdForTable(session.tableId);
    if (id) await db().update(guestSessions).set({ orderId: id }).where(eq(guestSessions.id, p.sessionId));
    return id;
  });
  if (orderId) await tx()`select set_config('app.current_order', ${orderId}, true)`;
  return orderId;
}

export async function guestOrderView(p: Extract<Principal, { type: "guest" }>) {
  const orderId = await bindSessionToTableOrder(p);
  const [link] = await db().select({ openOnFirstScan: channelLinks.openOnFirstScan, holdOrders: channelLinks.holdOrders, enabled: channelLinks.enabled }).from(channelLinks).where(eq(channelLinks.id, p.channelLinkId)).limit(1);
  const rounds = await db().select().from(guestRounds).where(eq(guestRounds.guestSessionId, p.sessionId)).orderBy(guestRounds.submittedAt);
  const requests = await db().select().from(serviceRequests).where(eq(serviceRequests.guestSessionId, p.sessionId)).orderBy(serviceRequests.createdAt);
  const canOrder = !!link?.enabled && (orderId != null || !!link.openOnFirstScan);
  if (!orderId) return { order: null, order_open: false, can_order: canOrder, hold_orders: link?.holdOrders ?? true, lines: [], rounds: rounds.map(toRound), requests: requests.map(toRequest), table_id: p.tableId };
  const [order] = await db().select().from(orders).where(eq(orders.id, orderId)).limit(1);
  const allRounds = order ? await db().select().from(guestRounds).where(eq(guestRounds.orderId, orderId)).orderBy(guestRounds.submittedAt) : [];
  // Voided lines stay out, except those of a round staff turned down: it still shows what it held, struck through
  // (live-test D-8). A line voided after its round was accepted is the POS's business and stays out.
  const rejectedRounds = allRounds.filter((r) => r.status === "rejected").map((r) => r.id);
  const lines = order
    ? await db()
        .select()
        .from(orderLines)
        .where(and(eq(orderLines.orderId, orderId), rejectedRounds.length ? or(ne(orderLines.status, "voided"), inArray(orderLines.roundId, rejectedRounds)) : ne(orderLines.status, "voided")))
        .orderBy(orderLines.sort)
    : [];
  return {
    table_id: p.tableId,
    order_open: !!order,
    can_order: canOrder,
    hold_orders: link?.holdOrders ?? true,
    order: order ? { id: order.id, order_no: order.orderNo, status: order.status, opened_at: order.openedAt.toISOString(), bill_requested: order.billRequestedAt != null } : null,
    // Each line's amount (menu price and choices, before discounts) and the table's totals as the register priced them,
    // so the phone shows them without adding anything up. Payments and balances stay at the POS.
    lines: lines.map((l) => ({ id: l.id, name: l.name, quantity: l.quantity, modifiers: l.modifiers.map((m) => m.name), notes: l.notes, seat_no: l.seatNo, status: l.status, source: l.source, round_id: l.roundId, mine: rounds.some((r) => r.lineIds.includes(l.id)), amount: l.baseAmount })),
    totals: order ? await guestTotals(order) : null,
    rounds: allRounds.map((r) => ({ ...toRound(r), mine: r.guestSessionId === p.sessionId })),
    requests: requests.map(toRequest),
  };
}

/** The order's totals as the register stored them on its last pricing: subtotal, each fee and discount, tax, total. */
async function guestTotals(order: typeof orders.$inferSelect) {
  // The guest role reads no adjustments; the order is the one this session is bound to, so read its rows as the register.
  const adjs = await asSystem(() => db().select({ name: orderAdjustments.name, total: orderAdjustments.total }).from(orderAdjustments).where(and(eq(orderAdjustments.orderId, order.id), eq(orderAdjustments.merchantId, order.merchantId))).orderBy(asc(orderAdjustments.sort)));
  return {
    tax_mode: order.taxMode,
    subtotal: order.subtotal,
    adjustments: adjs.filter((a) => a.total !== 0).map((a) => ({ name: a.name, total: a.total })),
    taxes: order.taxes.map((t) => ({ name: t.name, bps: t.bps, amount: t.amount })),
    total: order.total,
  };
}

export const toRound = (r: typeof guestRounds.$inferSelect) => ({ id: r.id, order_id: r.orderId, table_id: r.tableId, status: r.status, line_ids: r.lineIds, guest_name: r.guestName, notes: r.notes, submitted_at: r.submittedAt.toISOString(), decided_at: r.decidedAt?.toISOString() ?? null, decided_by: r.decidedByName, reject_reason: r.rejectReason });
export const toRequest = (r: typeof serviceRequests.$inferSelect) => ({ id: r.id, table_id: r.tableId, order_id: r.orderId, type: r.type, status: r.status, guest_name: r.guestName, created_at: r.createdAt.toISOString(), acknowledged_at: r.acknowledgedAt?.toISOString() ?? null, acknowledged_by: r.acknowledgedByName });

export { randomUUID };
