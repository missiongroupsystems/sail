import { and, eq, sql } from "drizzle-orm";
import { formatMoney, freezeFrom, roundCash } from "@sail/shared";
import { db } from "../db/client.js";
import { checks, merchantSettings, orderLines, orders, payments, refunds, shifts, tenderTypes } from "../db/schema/index.js";
import { AppError } from "../lib/errors.js";
import type { Principal } from "../auth/principal.js";
import { orderClosed, repriceOrder } from "./orders.js";
import { activeRules } from "./pricing-rules.js";
import { syncAllocations } from "./checks.js";
import { businessDateFor } from "../lib/time.js";
import { businessDayInputs } from "./business-day.js";

/**
 * Payments (scope doc 4.3): several tenders per check, part payments until the
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
  reference?: string | null;
  stationId?: string | null;
};

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
  const [settings] = await db().select().from(merchantSettings).where(eq(merchantSettings.merchantId, order.merchantId)).limit(1);
  if (!settings) throw AppError.notFound("merchant settings", order.merchantId);
  const formatCents = (amount: number) => formatMoney(amount, settings);
  if (!Number.isInteger(input.amount) || input.amount <= 0) throw AppError.validation("amount must be a positive number of cents");
  if (input.tipCents != null && (!Number.isInteger(input.tipCents) || input.tipCents < 0)) throw AppError.validation("tip_cents must be zero or a positive number of cents");

  const paymentsSoFar = await db().select({ n: sql<number>`count(*)::int` }).from(payments).where(and(eq(payments.orderId, order.id), eq(payments.status, "recorded")));
  const firstPayment = (paymentsSoFar[0]?.n ?? 0) === 0;
  const now = new Date();

  if (firstPayment && !order.pricingFrozenAt) {
    // Freeze order-level and minimum-spend results (scope doc 4.8). The re-price runs with the rules
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
  const tip = input.tipCents ?? 0;
  if (tender.isCash) {
    if (applied > balance) {
      tendered = tendered ?? applied;
      applied = balance;
    }
    if (applied === balance && settings.cashRoundingIncrement && settings.cashRoundingIncrement > 1) {
      rounding = roundCash(balance, settings.cashRoundingIncrement).roundingCents;
    }
    // A cash tip stays in the drawer: it is part of what the guest hands over, never part of the change.
    const due = applied + rounding + tip;
    if (tendered != null) {
      if (tendered < due) throw AppError.validation(`Cash tendered (${formatCents(tendered)}) is less than the amount due (${formatCents(due)})`, { remedy: `Take at least ${formatCents(due)}, or record a part payment of ${formatCents(tendered)}.`, details: { due_cents: due, tendered_cents: tendered, balance } });
      change = tendered - due;
    }
  } else {
    if (applied > balance) throw AppError.validation(`${tender.name} payments cannot exceed the balance of ${formatCents(balance)}`, { remedy: `The bill's balance is ${formatCents(balance)}. Enter the balance or a smaller part payment.`, details: { balance, check_id: check.id, check_total: check.total } });
  }

  const openShift = await db()
    .select({ id: shifts.id })
    .from(shifts)
    .where(and(eq(shifts.outletId, order.outletId), eq(shifts.status, "open"), input.stationId ? sql`(${shifts.stationId} = ${input.stationId} or ${shifts.stationId} is null)` : sql`${shifts.stationId} is null`))
    .orderBy(sql`${shifts.stationId} nulls last`)
    .limit(1);
  const bd = await businessDayInputs(order.merchantId, order.outletId);

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
      shiftId: openShift[0]?.id ?? null,
      businessDate: businessDateFor(now, bd.cutoff, bd.timeZone),
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

/** Reopen a completed order on the same business day: payments reversed, checks unlocked, pricing unfrozen, order back to fired/open. */
export async function reopenOrder(order: typeof orders.$inferSelect, principal: Principal, reason: string, now = new Date()) {
  if (order.status !== "completed") throw AppError.state(`Only completed orders can be reopened; this one is ${order.status}`, ["completed → open"]);
  const bd = await businessDayInputs(order.merchantId, order.outletId);
  const today = businessDateFor(now, bd.cutoff, bd.timeZone);
  if (order.businessDate !== today) throw AppError.invariant("reopen_same_business_day", `The order belongs to business day ${order.businessDate}`, "Orders can only be reopened on the same business day. Use a refund instead.");
  // A refund has already handed money back against these payments; reversing them as well would double-count.
  const [refunded] = await db().select({ n: sql<number>`count(*)::int` }).from(refunds).where(eq(refunds.orderId, order.id));
  if ((refunded?.n ?? 0) > 0) throw AppError.invariant("order_has_refunds", "This order already has a refund", "Reopening would reverse payments that were partly refunded. Correct the order with a further refund instead.");
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
