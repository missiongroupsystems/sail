import { randomUUID } from "node:crypto";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import QRCode from "qrcode";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { db, tx } from "../db/client.js";
import { brands, channelLinks, guestRounds, guestSessions, orderLines, orders, outlets, serviceRequests, tableQrTokens, tables } from "../db/schema/index.js";
import { AppError } from "../lib/errors.js";
import { randomToken, sha256, signSailToken } from "../auth/tokens.js";
import { config } from "../config.js";
import type { Principal } from "../auth/principal.js";

/**
 * Scan to Order services (scope doc 4.6). Guests never pay. Sessions are bound
 * to one table and its open order; rate limits apply per device and per table.
 */
export const GUEST_SESSION_HOURS = 4;

/* ---- Rate limits (in-memory, per process; the admission gate still protects the database) ---- */
type Bucket = { hits: number[] };
const buckets = new Map<string, Bucket>();
function limited(key: string, max: number, windowMs: number): number | null {
  const now = Date.now();
  const b = buckets.get(key) ?? { hits: [] };
  b.hits = b.hits.filter((t) => now - t < windowMs);
  if (b.hits.length >= max) {
    buckets.set(key, b);
    return Math.ceil((b.hits[0]! + windowMs - now) / 1000);
  }
  b.hits.push(now);
  buckets.set(key, b);
  return null;
}
export function resetGuestRateLimitsForTests() {
  buckets.clear();
}
export const RATE = { sessionsPerDevice: [10, 3_600_000], sessionsPerTable: [30, 3_600_000], roundsPerSession: [1, 10_000], roundsPerTable: [40, 3_600_000], requestsPerTableType: [1, 60_000] } as const;

export function enforceLimit(key: string, [max, windowMs]: readonly [number, number], what: string) {
  const retry = limited(key, max, windowMs);
  if (retry != null) throw new AppError("rate_limited", `Too many ${what}; please wait`, { remedy: `Try again in ${retry} seconds.`, details: { retry_after_seconds: retry } });
}

/** Check without recording (record with `recordHit` once the request succeeded), so a rejected attempt does not count. */
export function checkLimit(key: string, [max, windowMs]: readonly [number, number], what: string) {
  const now = Date.now();
  const b = buckets.get(key);
  const hits = (b?.hits ?? []).filter((t) => now - t < windowMs);
  if (hits.length >= max) {
    const retry = Math.ceil((hits[0]! + windowMs - now) / 1000);
    throw new AppError("rate_limited", `Too many ${what}; please wait`, { remedy: `Try again in ${retry} seconds.`, details: { retry_after_seconds: retry } });
  }
}
export function recordHit(key: string) {
  const b = buckets.get(key) ?? { hits: [] };
  b.hits.push(Date.now());
  buckets.set(key, b);
}

/** Run `fn` as the register (app_authenticated) inside a guest request, then drop back to app_guest. */
export async function asSystem<T>(fn: () => Promise<T>): Promise<T> {
  await tx().unsafe("set local role app_authenticated");
  try {
    return await fn();
  } finally {
    await tx().unsafe("set local role app_guest");
  }
}

/* ---- Table QR tokens ---- */

export async function rotateTableToken(table: { id: string; merchantId: string; outletId: string }): Promise<{ token: string; url: string }> {
  const token = randomToken(24);
  await db().update(tableQrTokens).set({ rotatedAt: new Date() }).where(and(eq(tableQrTokens.tableId, table.id), isNull(tableQrTokens.rotatedAt)));
  await db().insert(tableQrTokens).values({ merchantId: table.merchantId, outletId: table.outletId, tableId: table.id, tokenHash: sha256(token) });
  return { token, url: guestUrl(token) };
}

export function guestUrl(token: string) {
  return `${config().GUEST_APP_URL.replace(/\/$/, "")}/t/${token}`;
}

/** Current tokens for an outlet's tables, creating missing ones. Returns the raw token only when newly created (otherwise the hash is all we have). */
export async function ensureTableTokens(outletId: string, merchantId: string): Promise<{ table: typeof tables.$inferSelect; token: string }[]> {
  const rows = await db().select().from(tables).where(and(eq(tables.outletId, outletId), isNull(tables.archivedAt))).orderBy(tables.name);
  const out: { table: typeof tables.$inferSelect; token: string }[] = [];
  for (const t of rows) {
    // Tokens are stored hashed; a sheet always rotates so the printed codes are the live ones.
    const { token } = await rotateTableToken({ id: t.id, merchantId, outletId });
    out.push({ table: t, token });
  }
  return out;
}

export async function qrSheetPdf(outletId: string, merchantId: string): Promise<Uint8Array> {
  const [outlet] = await db().select().from(outlets).where(eq(outlets.id, outletId)).limit(1);
  const links = await db().select().from(channelLinks).where(and(eq(channelLinks.outletId, outletId), eq(channelLinks.channel, "scan_to_order"), eq(channelLinks.enabled, true)));
  const brandName = links[0] ? (await db().select({ name: brands.name }).from(brands).where(eq(brands.id, links[0].brandId)).limit(1))[0]?.name : null;
  const entries = await ensureTableTokens(outletId, merchantId);
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
  if (!tok) throw AppError.notFound("table code", undefined);
  const [table] = await db().select().from(tables).where(and(eq(tables.id, tok.tableId), isNull(tables.archivedAt))).limit(1);
  if (!table) throw AppError.notFound("table");
  const deviceHash = sha256(`${tok.merchantId}:${input.deviceId}`);
  enforceLimit(`sess:dev:${deviceHash}`, RATE.sessionsPerDevice, "sign-ins from this device");
  enforceLimit(`sess:table:${table.id}`, RATE.sessionsPerTable, "sign-ins at this table");
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

/** Worker safety net: revoke sessions whose order has closed, and expired ones. */
export async function revokeStaleSessions(): Promise<number> {
  const rows = await tx()<{ id: string }[]>`
    update guest_sessions s set revoked_at = now()
    where s.revoked_at is null and (s.expires_at < now() or exists (select 1 from orders o where o.id = s.order_id and o.status in ('completed','cancelled')))
    returning s.id`;
  return rows.length;
}

/* ---- Guest view ---- */

export async function guestOrderView(p: Extract<Principal, { type: "guest" }>) {
  const [session] = await db().select().from(guestSessions).where(eq(guestSessions.id, p.sessionId)).limit(1);
  const orderId = session?.orderId ?? null;
  const rounds = await db().select().from(guestRounds).where(eq(guestRounds.guestSessionId, p.sessionId)).orderBy(guestRounds.submittedAt);
  const requests = await db().select().from(serviceRequests).where(eq(serviceRequests.guestSessionId, p.sessionId)).orderBy(serviceRequests.createdAt);
  if (!orderId) return { order: null, lines: [], rounds: rounds.map(toRound), requests: requests.map(toRequest), table_id: p.tableId };
  const [order] = await db().select().from(orders).where(eq(orders.id, orderId)).limit(1);
  const lines = order ? await db().select().from(orderLines).where(and(eq(orderLines.orderId, orderId), sql`${orderLines.status} <> 'voided'`)).orderBy(orderLines.sort) : [];
  const allRounds = order ? await db().select().from(guestRounds).where(eq(guestRounds.orderId, orderId)).orderBy(guestRounds.submittedAt) : [];
  return {
    table_id: p.tableId,
    order: order ? { id: order.id, order_no: order.orderNo, status: order.status, opened_at: order.openedAt.toISOString(), bill_requested: order.billRequestedAt != null } : null,
    // Prices are menu prices only; fees and discounts are shown on the bill at the POS (scope doc 4.6).
    lines: lines.map((l) => ({ id: l.id, name: l.name, quantity: l.quantity, modifiers: l.modifiers.map((m) => m.name), notes: l.notes, seat_no: l.seatNo, status: l.status, source: l.source, round_id: l.roundId, mine: rounds.some((r) => r.lineIds.includes(l.id)) })),
    rounds: allRounds.map((r) => ({ ...toRound(r), mine: r.guestSessionId === p.sessionId })),
    requests: requests.map(toRequest),
  };
}

export const toRound = (r: typeof guestRounds.$inferSelect) => ({ id: r.id, order_id: r.orderId, table_id: r.tableId, status: r.status, line_ids: r.lineIds, guest_name: r.guestName, notes: r.notes, submitted_at: r.submittedAt.toISOString(), decided_at: r.decidedAt?.toISOString() ?? null, decided_by: r.decidedByName, reject_reason: r.rejectReason });
export const toRequest = (r: typeof serviceRequests.$inferSelect) => ({ id: r.id, table_id: r.tableId, order_id: r.orderId, type: r.type, status: r.status, guest_name: r.guestName, created_at: r.createdAt.toISOString(), acknowledged_at: r.acknowledgedAt?.toISOString() ?? null, acknowledged_by: r.acknowledgedByName });

export { randomUUID };
