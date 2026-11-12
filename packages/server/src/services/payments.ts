import { and, eq, sql } from "drizzle-orm";
import { formatMoney, freezeFrom, percentOfCents, PERMISSIONS, roleAtLeast, roundCash, type Role } from "@sail/shared";
import { db, tx } from "../db/client.js";
import { businessDayCloses, checks, merchantSettings, orderLines, orders, payments, refunds, shifts, tenderTypes } from "../db/schema/index.js";
import { AppError } from "../lib/errors.js";
import type { Principal } from "../auth/principal.js";
import { orderClosed, repriceOrder } from "./orders.js";
import { activeRules } from "./pricing-rules.js";
import { syncAllocations } from "./checks.js";
import { assertBusinessDayOpen, currentBusinessDate } from "./business-day.js";

/**
 * Payments: several tenders per check, part payments until the
 * balance is 0, cash rounding only on a cash tender that settles the balance,
 * the pricing freeze at the first payment, and auto-completion.
 */
export type RecordPaymentInput = {
  paymentId: string;
  checkId: string;
  tenderTypeId: string;
  /** Amount to apply to the balance. For cash, an amount above the balance is treated as the cash tendered. */
  amount: number;
  tendered?: number | null;
  tipCents?: number;
  /** A tip as a percentage (basis points) of the amount applied; the register works out the cents. Not with `tipCents`. */
  tipBps?: number;
  reference?: string | null;
  stationId?: string | null;
};

/** The role a payment with this tender needs: a Manager for a tender that requires approval, else the operation's own. */
export async function paymentRole(merchantId: string, tenderTypeId: string): Promise<Role> {
  const [t] = await db().select({ requiresApproval: tenderTypes.requiresApproval }).from(tenderTypes).where(and(eq(tenderTypes.id, tenderTypeId), eq(tenderTypes.merchantId, merchantId))).limit(1);
  const base = PERMISSIONS["payments.record"].minRole;
  return t?.requiresApproval && !roleAtLeast(base, "manager") ? "manager" : base;
}

export type RecordedPayment = { payment: typeof payments.$inferSelect; check: typeof checks.$inferSelect; changeDue: number; firstPayment: boolean; orderCompleted: boolean };

export async function recordPayment(order: typeof orders.$inferSelect, input: RecordPaymentInput, principal: Principal): Promise<RecordedPayment> {
  const loadCheck = async () => {
    const [row] = await db().select().from(checks).where(and(eq(checks.id, input.checkId), eq(checks.orderId, order.id))).limit(1);
    if (!row) throw AppError.notFound("bill", input.checkId);
    return row;
  };
  let check = await loadCheck();
  const [tender] = await db().select().from(tenderTypes).where(and(eq(tenderTypes.id, input.tenderTypeId), eq(tenderTypes.merchantId, order.merchantId))).limit(1);
  if (!tender || tender.archivedAt) throw AppError.notFound("payment method", input.tenderTypeId);
  if (tender.requiresReference && !input.reference?.trim()) throw AppError.validation(`${tender.name} needs a reference`, { remedy: `Enter the ${tender.name} reference (an account, a room or a voucher number).`, details: { tender_type_id: tender.id } });
  const [settings] = await db().select().from(merchantSettings).where(eq(merchantSettings.merchantId, order.merchantId)).limit(1);
  if (!settings) throw AppError.notFound("merchant settings", order.merchantId);
  const formatCents = (amount: number) => formatMoney(amount, settings);
  if (!Number.isInteger(input.amount) || input.amount <= 0) throw AppError.validation("amount must be a positive number of cents");
  if (input.tipCents != null && (!Number.isInteger(input.tipCents) || input.tipCents < 0)) throw AppError.validation("tip_cents must be zero or a positive number of cents");
  if (input.tipBps != null && input.tipCents != null) throw AppError.validation("Give the tip as tip_cents or as tip_bps, not both", { remedy: "Send tip_bps to preview a percentage, then the tip_cents it returned." });

  const paymentsSoFar = await db().select({ n: sql<number>`count(*)::int` }).from(payments).where(and(eq(payments.orderId, order.id), eq(payments.status, "recorded")));
  const firstPayment = (paymentsSoFar[0]?.n ?? 0) === 0;
  const now = new Date();

  if (firstPayment && !order.pricingFrozenAt) {
    // Freeze order-level and minimum-spend results. The re-price runs with the rules
    // active now, so a scheduled rule that switched on since the last edit is reflected on the bill.
    const result = await repriceOrder(order.id, now);
    const rules = await activeRules(order.merchantId, now);
    await db().update(orders).set({ pricingFrozenAt: now, frozenAdjustments: freezeFrom(result, rules) }).where(eq(orders.id, order.id));
    // Re-price under the frozen context so stored adjustments carry frozen=true (totals are unchanged by construction).
    await repriceOrder(order.id, now);
    // The bill may have been rebuilt by the re-price: validate the payment against its current balance, never a stale one.
    check = await loadCheck();
  }

  const balance = check.total - check.paidTotal;
  if (balance <= 0) throw AppError.state(`${check.label} is already paid`, [], "Nothing is owed on this bill.");

  let applied = input.amount;
  let tendered: number | null = input.tendered ?? null;
  let rounding = 0;
  let change = 0;
  let tip = input.tipCents ?? 0;
  if (tender.isCash) {
    if (applied > balance) {
      tendered = tendered ?? applied;
      applied = balance;
    }
    // A percentage tip in cash is rounded to the smallest cash amount, so the change can be paid.
    if (input.tipBps != null) tip = roundCash(percentOfCents(applied, input.tipBps), settings.cashRoundingIncrement ?? 1).rounded;
    if (applied === balance && settings.cashRoundingIncrement && settings.cashRoundingIncrement > 1) {
      rounding = roundCash(balance, settings.cashRoundingIncrement).roundingCents;
    }
    // A cash tip stays in the drawer: it is part of what the guest hands over, never part of the change.
    const step = settings.cashRoundingIncrement ?? 1;
    if (tip % step !== 0) throw AppError.validation(`A cash tip must be a multiple of ${formatCents(step)}, the smallest cash amount`, { remedy: `Round the tip to a multiple of ${formatCents(step)}.`, details: { tip_cents: tip, cash_rounding_increment: step } });
    const due = applied + rounding + tip;
    if (tendered != null) {
      if (tendered < due) throw AppError.validation(`Cash tendered (${formatCents(tendered)}) is less than the amount due (${formatCents(due)})`, { remedy: `Take at least ${formatCents(due)}, or record a part payment of ${formatCents(tendered)}.`, details: { due_cents: due, tendered_cents: tendered, balance } });
      change = tendered - due;
    }
  } else {
    if (input.tipBps != null) tip = percentOfCents(applied, input.tipBps);
    if (applied > balance) throw AppError.validation(`${tender.name} payments cannot exceed the balance of ${formatCents(balance)}`, { remedy: `The bill's balance is ${formatCents(balance)}. Enter the balance or a smaller part payment.`, details: { balance, check_id: check.id, check_total: check.total } });
  }

  assertTipAllowed(settings.tipsEnabled, tip);

  const [openShift] = await openShiftFor(order.outletId, input.stationId ?? null);
  // Cash goes into a drawer, and a drawer is counted at a shift's close: cash with no shift open would count nowhere.
  if (tender.isCash && !openShift) throw AppError.invariant("no_open_shift", "No shift is open here to take cash into", "Open a shift (with its float) first, or take the payment by card.");
  // A payment counts on its shift's business day, so the shift's count and the day's Z-report agree across the cutoff.
  const businessDate = openShift?.businessDate ?? (await currentBusinessDate(order.merchantId, order.outletId, now));

  const [payment] = await db()
    .insert(payments)
    .values({
      id: input.paymentId,
      merchantId: order.merchantId,
      outletId: order.outletId,
      orderId: order.id,
      checkId: check.id,
      tenderTypeId: tender.id,
      tenderName: tender.name,
      isCash: tender.isCash,
      amount: applied,
      roundingCents: rounding,
      tendered,
      changeCents: change,
      tipCents: tip,
      reference: input.reference ?? null,
      recordedBy: principal.type === "staff" ? principal.id : null,
      recordedByName: "name" in principal ? principal.name : null,
      stationId: input.stationId ?? null,
      shiftId: openShift?.id ?? null,
      businessDate,
    })
    .returning();

  const newPaid = check.paidTotal + applied;
  const settled = newPaid >= check.total;
  const [updatedCheck] = await db()
    .update(checks)
    .set({ paidTotal: newPaid, roundingTotal: check.roundingTotal + rounding, lockedAt: check.lockedAt ?? now, status: settled ? "paid" : check.status, paidAt: settled ? now : check.paidAt, updatedAt: now })
    .where(eq(checks.id, check.id))
    .returning();

  const completed = await maybeComplete(order.id, now);
  return { payment: payment!, check: updatedCheck!, changeDue: change, firstPayment, orderCompleted: completed };
}

/** A tip is taken only where the merchant has tips on: the register decides, not the pay screen. */
export function assertTipAllowed(tipsEnabled: boolean, tip: number) {
  if (tip > 0 && !tipsEnabled) throw AppError.validation("Tips are turned off for this business", { remedy: "Take the payment without a tip, or ask an Admin to turn tips on in Settings.", details: { tip_cents: tip } });
}

/** The open shift a payment or refund at this station counts in: the station's own, else the outlet's shared drawer. */
export function openShiftFor(outletId: string, stationId: string | null) {
  return db()
    .select({ id: shifts.id, businessDate: shifts.businessDate })
    .from(shifts)
    .where(and(eq(shifts.outletId, outletId), eq(shifts.status, "open"), stationId ? sql`(${shifts.stationId} = ${stationId} or ${shifts.stationId} is null)` : sql`${shifts.stationId} is null`))
    .orderBy(sql`${shifts.stationId} nulls last`)
    .limit(1);
}

/** Complete the order when every check is paid and every line is fired or voided. */
export async function maybeComplete(orderId: string, now = new Date()): Promise<boolean> {
  const [o] = await db().select().from(orders).where(eq(orders.id, orderId)).limit(1);
  if (!o || o.status === "completed" || o.status === "cancelled") return false;
  const chks = await db().select().from(checks).where(eq(checks.orderId, orderId));
  if (chks.length === 0) return false;
  if (!chks.every((c) => c.total - c.paidTotal <= 0)) return false;
  const [pending] = await db().select({ n: sql<number>`count(*)::int` }).from(orderLines).where(and(eq(orderLines.orderId, orderId), sql`${orderLines.status} in ('pending','held')`));
  if ((pending?.n ?? 0) > 0) return false;
  await db().update(checks).set({ status: "paid", paidAt: now }).where(and(eq(checks.orderId, orderId), eq(checks.status, "open")));
  await db().update(orders).set({ status: "completed", completedAt: now, updatedAt: now }).where(eq(orders.id, orderId));
  await orderClosed(orderId);
  return true;
}

/**
 * May this payment be voided? Only a recorded payment on a bill nothing has been refunded from, while the shift it
 * counts in is open and its business day is not closed. Later corrections are refunds.
 */
export async function assertVoidable(order: typeof orders.$inferSelect, payment: typeof payments.$inferSelect) {
  if (payment.status !== "recorded") throw AppError.state(`This payment is already ${payment.status}`, []);
  if (order.status === "cancelled") throw AppError.state("The order is cancelled", []);
  const [refunded] = await db().select({ n: sql<number>`count(*)::int` }).from(refunds).where(eq(refunds.checkId, payment.checkId));
  if ((refunded?.n ?? 0) > 0) throw AppError.invariant("payment_refunded", "Money has already been refunded from this bill", "Correct it with a further refund instead.");
  await assertReversible(payment);
}

/**
 * A recorded payment may be reversed (by a void or a reopen) only while the shift it counts in is open and its business
 * day is not closed: after that its cash has been counted and its day reported, so a correction is a refund.
 */
async function assertReversible(payment: typeof payments.$inferSelect) {
  // Locks, so a void and a shift or business-day close at the same moment run one after the other, never both.
  await tx()`select id from outlets where id = ${payment.outletId} for share`;
  if (payment.shiftId) {
    const [shift] = await tx()<{ status: string }[]>`select status from shifts where id = ${payment.shiftId} for update`;
    if (shift?.status !== "open") throw AppError.invariant("shift_closed", "The shift this payment was taken in is closed", "Use a refund instead (for a terminal payment, give it back on the terminal too).");
  }
  const [closed] = await db().select({ id: businessDayCloses.id }).from(businessDayCloses).where(and(eq(businessDayCloses.outletId, payment.outletId), eq(businessDayCloses.businessDate, payment.businessDate))).limit(1);
  if (closed) throw AppError.invariant("business_day_closed", `Business day ${payment.businessDate} is closed`, "Use a refund instead.");
}

/**
 * Reverse a payment taken in error. The bill owes the amount again; an order it completed goes back to open; when no
 * recorded payment is left, the bills unlock and pricing unfreezes, as on a reopen.
 */
export async function reversePayment(order: typeof orders.$inferSelect, payment: typeof payments.$inferSelect, reason: string, by: Principal, now = new Date()) {
  await db()
    .update(payments)
    .set({ status: "reversed", reversedAt: now, reversedBy: by.type === "staff" ? by.id : null, reversedReason: `voided: ${reason}` })
    .where(eq(payments.id, payment.id));
  const [left] = await db().select({ n: sql<number>`count(*)::int` }).from(payments).where(and(eq(payments.orderId, order.id), eq(payments.status, "recorded")));
  const [hasFired] = await db().select({ n: sql<number>`count(*)::int` }).from(orderLines).where(and(eq(orderLines.orderId, order.id), eq(orderLines.status, "fired")));
  const status = order.status === "completed" ? ((hasFired?.n ?? 0) > 0 ? "fired" : "open") : order.status;
  if ((left?.n ?? 0) === 0) {
    await db().update(checks).set({ paidTotal: 0, roundingTotal: 0, status: "open", paidAt: null, lockedAt: null, updatedAt: now }).where(eq(checks.orderId, order.id));
    await db().update(orders).set({ status, completedAt: null, pricingFrozenAt: null, frozenAdjustments: null, updatedAt: now }).where(eq(orders.id, order.id));
    await repriceOrder(order.id, now);
    await syncAllocations(order.id);
    return;
  }
  await db()
    .update(checks)
    .set({ paidTotal: sql`${checks.paidTotal} - ${payment.amount}`, roundingTotal: sql`${checks.roundingTotal} - ${payment.roundingCents}`, status: "open", paidAt: null, updatedAt: now })
    .where(eq(checks.id, payment.checkId));
  if (status !== order.status) await db().update(orders).set({ status, completedAt: null, updatedAt: now }).where(eq(orders.id, order.id));
}

/** Reopen a completed order on the same business day: payments reversed, checks unlocked, pricing unfrozen, order back to fired/open. */
export async function reopenOrder(order: typeof orders.$inferSelect, principal: Principal, reason: string, now = new Date()) {
  if (order.status !== "completed") throw AppError.state(`Only completed orders can be reopened; this one is ${order.status}`, ["completed → open"]);
  const today = await currentBusinessDate(order.merchantId, order.outletId, now);
  if (order.businessDate !== today) throw AppError.invariant("reopen_same_business_day", `The order belongs to business day ${order.businessDate}`, "Orders can only be reopened on the same business day. Use a refund instead.");
  // A refund has already handed money back against these payments; reversing them as well would double-count.
  const [refunded] = await db().select({ n: sql<number>`count(*)::int` }).from(refunds).where(eq(refunds.orderId, order.id));
  if ((refunded?.n ?? 0) > 0) throw AppError.invariant("order_has_refunds", "This order already has a refund", "Reopening would reverse payments that were partly refunded. Correct the order with a further refund instead.");
  // Every payment it reverses must be one a void could reverse: its shift still open, its day not closed.
  await assertBusinessDayOpen(order.outletId, order.businessDate);
  for (const payment of await db().select().from(payments).where(and(eq(payments.orderId, order.id), eq(payments.status, "recorded")))) await assertReversible(payment);
  const reversed = await db()
    .update(payments)
    .set({ status: "reversed", reversedAt: now, reversedBy: principal.type === "staff" ? principal.id : null, reversedReason: `reopened: ${reason}` })
    .where(and(eq(payments.orderId, order.id), eq(payments.status, "recorded")))
    .returning({ id: payments.id, amount: payments.amount, tender: payments.tenderName });
  await db().update(checks).set({ paidTotal: 0, roundingTotal: 0, status: "open", paidAt: null, lockedAt: null, updatedAt: now }).where(eq(checks.orderId, order.id));
  const [hasFired] = await db().select({ n: sql<number>`count(*)::int` }).from(orderLines).where(and(eq(orderLines.orderId, order.id), eq(orderLines.status, "fired")));
  await db().update(orders).set({ status: (hasFired?.n ?? 0) > 0 ? "fired" : "open", completedAt: null, pricingFrozenAt: null, frozenAdjustments: null, updatedAt: now }).where(eq(orders.id, order.id));
  await repriceOrder(order.id, now);
  await syncAllocations(order.id);
  return reversed;
}
