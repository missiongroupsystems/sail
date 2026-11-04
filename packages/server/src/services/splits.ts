import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { evenShares, sharedAmong, type Share } from "@sail/shared";
import { db } from "../db/client.js";
import { checkAllocations, checks, orderLines } from "../db/schema/index.js";
import { AppError } from "../lib/errors.js";
import { checksFor, syncAllocations, type CheckRow } from "./checks.js";

/**
 * Bill splitting (scope doc 4.4): evenly by N, by seat, or by item with equal
 * shares for shared lines. Every mode ends in `syncAllocations` with an explicit
 * share vector per line, so the allocator is the only place amounts are split.
 * Splits are free until the first payment; a paid bill's allocations are fixed.
 */

async function assertNoLockedChecks(orderId: string) {
  const [locked] = await db().select({ label: checks.label }).from(checks).where(and(eq(checks.orderId, orderId), isNotNull(checks.lockedAt))).limit(1);
  if (locked) throw AppError.invariant("check_locked_by_payment", `${locked.label} is paid`, `Refund ${locked.label} to change the split.`);
}

async function liveLines(orderId: string) {
  return db().select().from(orderLines).where(and(eq(orderLines.orderId, orderId), sql`${orderLines.status} <> 'voided'`));
}

/** Replace the order's checks with `n` fresh ones (labels Bill 1..n, optional seat numbers). */
async function resetChecks(order: { id: string; merchantId: string; outletId: string }, n: number, seats: (number | null)[] = []): Promise<CheckRow[]> {
  await assertNoLockedChecks(order.id);
  await db().delete(checks).where(eq(checks.orderId, order.id));
  const rows: CheckRow[] = [];
  for (let i = 1; i <= n; i++) {
    const seatNo = seats[i - 1] ?? null;
    const [row] = await db().insert(checks).values({ id: randomUUID(), merchantId: order.merchantId, outletId: order.outletId, orderId: order.id, index: i, label: seatNo != null ? `Bill ${i} · Seat ${seatNo}` : `Bill ${i}`, seatNo }).returning();
    rows.push(row!);
  }
  return rows;
}

export async function splitEven(order: { id: string; merchantId: string; outletId: string }, n: number): Promise<CheckRow[]> {
  if (!Number.isInteger(n) || n < 1 || n > 20) throw AppError.validation("Split between 1 and 20 bills");
  await resetChecks(order, n);
  const lines = await liveLines(order.id);
  const shares = new Map<string, Share[]>(lines.map((l) => [l.id, evenShares(n)]));
  return syncAllocations(order.id, { sharesByLine: shares });
}

/** One bill per seat; shared lines (no seat) split evenly across the seats, or left on a separate "Shared" bill when `shared` is `manual`. */
export async function splitBySeat(order: { id: string; merchantId: string; outletId: string }, shared: "even" | "manual"): Promise<CheckRow[]> {
  const lines = await liveLines(order.id);
  const seats = [...new Set(lines.map((l) => l.seatNo).filter((s): s is number => s != null))].sort((a, b) => a - b);
  if (seats.length === 0) throw AppError.invariant("no_seats", "No items have a seat number", "Assign seats to the items first, or split evenly.");
  const hasShared = lines.some((l) => l.seatNo == null);
  const n = seats.length + (hasShared && shared === "manual" ? 1 : 0);
  const chks = await resetChecks(order, n, [...seats, ...(hasShared && shared === "manual" ? [null] : [])]);
  if (hasShared && shared === "manual") await db().update(checks).set({ label: "Shared" }).where(eq(checks.id, chks[n - 1]!.id));
  const sharesByLine = new Map<string, Share[]>();
  for (const l of lines) {
    if (l.seatNo != null) sharesByLine.set(l.id, sharedAmong(n, [seats.indexOf(l.seatNo)]));
    else if (shared === "even") sharesByLine.set(l.id, sharedAmong(n, seats.map((_, i) => i)));
    else sharesByLine.set(l.id, sharedAmong(n, [n - 1]));
  }
  return syncAllocations(order.id, { sharesByLine });
}

export type AllocationMove = { line_id: string; check_ids: string[] };

/**
 * By item: put each listed line wholly on one bill, or share it equally between
 * the listed bills (a bottle three ways). Unlisted lines keep their allocation.
 * `add_checks` appends empty bills first. Lines on a paid bill cannot move.
 */
export async function allocateLines(order: { id: string; merchantId: string; outletId: string }, moves: AllocationMove[], addChecks = 0): Promise<CheckRow[]> {
  let chks = await checksFor(order.id);
  for (let i = 0; i < addChecks; i++) {
    const index = chks.length + 1;
    const [row] = await db().insert(checks).values({ id: randomUUID(), merchantId: order.merchantId, outletId: order.outletId, orderId: order.id, index, label: `Bill ${index}` }).returning();
    chks = [...chks, row!];
  }
  const locked = new Set(chks.filter((c) => c.lockedAt).map((c) => c.id));
  const lineIds = moves.map((m) => m.line_id);
  const existing = lineIds.length ? await db().select().from(checkAllocations).where(inArray(checkAllocations.orderLineId, lineIds)) : [];
  const sharesByLine = new Map<string, Share[]>();
  for (const m of moves) {
    if (existing.some((a) => a.orderLineId === m.line_id && locked.has(a.checkId))) {
      const lockedLabel = chks.find((c) => locked.has(c.id) && existing.some((a) => a.orderLineId === m.line_id && a.checkId === c.id))!.label;
      throw AppError.invariant("check_locked_by_payment", `${lockedLabel} is paid`, `Refund ${lockedLabel} to move items out of it.`);
    }
    const idx = m.check_ids.map((id) => chks.findIndex((c) => c.id === id));
    if (idx.some((i) => i < 0)) throw AppError.notFound("bill");
    if (idx.some((i) => locked.has(chks[i]!.id))) throw AppError.invariant("check_locked_by_payment", "Items cannot be moved onto a paid bill", "Choose an unpaid bill.");
    sharesByLine.set(m.line_id, sharedAmong(chks.length, idx));
  }
  return syncAllocations(order.id, { sharesByLine });
}

export async function unsplit(order: { id: string; merchantId: string; outletId: string }): Promise<CheckRow[]> {
  await resetChecks(order, 1);
  const lines = await liveLines(order.id);
  return syncAllocations(order.id, { sharesByLine: new Map(lines.map((l) => [l.id, [{ num: 1, den: 1 }]])) });
}
