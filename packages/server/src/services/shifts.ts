import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { businessDayCloses, orderAdjustments, orderLines, orders, payments, shifts } from "../db/schema/index.js";
import { AppError } from "../lib/errors.js";
import type { Principal } from "../auth/principal.js";

/**
 * Shifts and the basic Z-report (scope doc 4.3 "Shifts and cash", 4.10). The
 * full breakdown by rule and reporting class arrives in v0.9; this covers
 * sales, tenders, expected vs counted cash, rounding, voids and covers.
 */
export type ZReport = {
  scope: { outlet_id: string; station_id: string | null; business_date: string; shift_id: string | null };
  orders: { count: number; by_type: Record<string, number>; covers: number; open_count: number };
  sales: { gross: number; discounts: number; fees: number; gst: number; net: number };
  adjustments: { rule_key: string; name: string; kind: string; report_class: string; total: number; count: number }[];
  tenders: { tender_type_id: string; tender: string; is_cash: boolean; count: number; amount: number; rounding: number; tips: number }[];
  cash: { float: number; cash_payments: number; rounding: number; refunds: number; expected: number; counted: number | null; variance: number | null };
  voids: { count: number; quantity: number; value: number };
  refunds: { count: number; amount: number };
  generated_at: string;
};

type Scope = { outletId: string; businessDate: string; stationId?: string | null; shiftId?: string | null };

/** Refund figures arrive in v0.7 through this provider. */
let refundProvider: (scope: Scope) => Promise<{ count: number; amount: number; cash_amount: number }> = async () => ({ count: 0, amount: 0, cash_amount: 0 });
export function registerRefundTotals(fn: typeof refundProvider) {
  refundProvider = fn;
}

export async function zReport(scope: Scope, cashCounts: { float: number; counted: number | null } = { float: 0, counted: null }): Promise<ZReport> {
  const orderWhere = and(eq(orders.outletId, scope.outletId), eq(orders.businessDate, scope.businessDate), scope.stationId ? eq(orders.stationId, scope.stationId) : sql`true`);
  const completed = and(orderWhere, eq(orders.status, "completed"));
  const [o] = await db()
    .select({ count: sql<number>`count(*)::int`, covers: sql<number>`coalesce(sum(pax),0)::int`, gross: sql<number>`coalesce(sum(subtotal),0)::int`, discounts: sql<number>`coalesce(sum(discount_total),0)::int`, fees: sql<number>`coalesce(sum(fee_total),0)::int`, gst: sql<number>`coalesce(sum(gst_total),0)::int`, net: sql<number>`coalesce(sum(total),0)::int` })
    .from(orders)
    .where(completed);
  const byType = await db().select({ t: orders.orderType, n: sql<number>`count(*)::int` }).from(orders).where(completed).groupBy(orders.orderType);
  const [open] = await db().select({ n: sql<number>`count(*)::int` }).from(orders).where(and(orderWhere, sql`${orders.status} in ('open','fired','ready','out_for_delivery')`));
  const adj = await db()
    .select({ rule_key: orderAdjustments.ruleKey, name: orderAdjustments.name, kind: orderAdjustments.kind, report_class: orderAdjustments.reportClass, total: sql<number>`coalesce(sum(${orderAdjustments.total}),0)::int`, count: sql<number>`count(*)::int` })
    .from(orderAdjustments)
    .innerJoin(orders, eq(orders.id, orderAdjustments.orderId))
    .where(completed)
    .groupBy(orderAdjustments.ruleKey, orderAdjustments.name, orderAdjustments.kind, orderAdjustments.reportClass);
  const payWhere = and(eq(payments.outletId, scope.outletId), eq(payments.status, "recorded"), scope.shiftId ? eq(payments.shiftId, scope.shiftId) : eq(payments.businessDate, scope.businessDate), scope.stationId && !scope.shiftId ? eq(payments.stationId, scope.stationId) : sql`true`);
  const tenders = await db()
    .select({ tender_type_id: payments.tenderTypeId, tender: payments.tenderName, is_cash: payments.isCash, count: sql<number>`count(*)::int`, amount: sql<number>`coalesce(sum(amount),0)::int`, rounding: sql<number>`coalesce(sum(rounding_cents),0)::int`, tips: sql<number>`coalesce(sum(tip_cents),0)::int` })
    .from(payments)
    .where(payWhere)
    .groupBy(payments.tenderTypeId, payments.tenderName, payments.isCash);
  const voidRows = await db()
    .select({ count: sql<number>`count(*)::int`, quantity: sql<number>`coalesce(sum(quantity),0)::int`, value: sql<number>`coalesce(sum(quantity * unit_price),0)::int` })
    .from(orderLines)
    .innerJoin(orders, eq(orders.id, orderLines.orderId))
    .where(and(orderWhere, eq(orderLines.status, "voided")));
  const refunds = await refundProvider(scope);
  const cashPayments = tenders.filter((t) => t.is_cash).reduce((s, t) => s + t.amount, 0);
  const rounding = tenders.filter((t) => t.is_cash).reduce((s, t) => s + t.rounding, 0);
  const expected = cashCounts.float + cashPayments + rounding - refunds.cash_amount;
  return {
    scope: { outlet_id: scope.outletId, station_id: scope.stationId ?? null, business_date: scope.businessDate, shift_id: scope.shiftId ?? null },
    orders: { count: o?.count ?? 0, by_type: Object.fromEntries(byType.map((b) => [b.t, b.n])), covers: o?.covers ?? 0, open_count: open?.n ?? 0 },
    sales: { gross: o?.gross ?? 0, discounts: o?.discounts ?? 0, fees: o?.fees ?? 0, gst: o?.gst ?? 0, net: o?.net ?? 0 },
    adjustments: adj,
    tenders,
    cash: { float: cashCounts.float, cash_payments: cashPayments, rounding, refunds: refunds.cash_amount, expected, counted: cashCounts.counted, variance: cashCounts.counted == null ? null : cashCounts.counted - expected },
    voids: voidRows[0] ?? { count: 0, quantity: 0, value: 0 },
    refunds: { count: refunds.count, amount: refunds.amount },
    generated_at: new Date().toISOString(),
  };
}

export async function openShift(principal: Principal, input: { outletId: string; stationId: string | null; name: string | null; floatCents: number; floatCounts: Record<string, number> | null; businessDate: string }) {
  const [existing] = await db()
    .select({ id: shifts.id })
    .from(shifts)
    .where(and(eq(shifts.outletId, input.outletId), eq(shifts.status, "open"), input.stationId ? eq(shifts.stationId, input.stationId) : isNull(shifts.stationId)))
    .limit(1);
  if (existing) throw AppError.state("A shift is already open here", ["close it first"], "Close the open shift before opening a new one.");
  const [row] = await db()
    .insert(shifts)
    .values({ merchantId: principal.merchantId, outletId: input.outletId, stationId: input.stationId, name: input.name, businessDate: input.businessDate, openedBy: principal.type === "staff" ? principal.id : null, openedByName: "name" in principal ? principal.name : null, floatCents: input.floatCents, floatCounts: input.floatCounts })
    .returning();
  return row!;
}

export async function closeShift(principal: Principal, shiftId: string, input: { countedCashCents: number; countedCounts: Record<string, number> | null; varianceReason: string | null }) {
  const [shift] = await db().select().from(shifts).where(eq(shifts.id, shiftId)).limit(1);
  if (!shift) throw AppError.notFound("shift", shiftId);
  if (shift.status === "closed") throw AppError.state("The shift is already closed", []);
  const report = await zReport({ outletId: shift.outletId, businessDate: shift.businessDate, stationId: shift.stationId, shiftId: shift.id }, { float: shift.floatCents, counted: input.countedCashCents });
  const now = new Date();
  const [row] = await db()
    .update(shifts)
    .set({ status: "closed", closedBy: principal.type === "staff" ? principal.id : null, closedByName: "name" in principal ? principal.name : null, closedAt: now, countedCashCents: input.countedCashCents, countedCounts: input.countedCounts, expectedCashCents: report.cash.expected, varianceCents: report.cash.variance, varianceReason: input.varianceReason, summary: report })
    .where(eq(shifts.id, shiftId))
    .returning();
  return { shift: row!, report };
}

export async function closeBusinessDay(principal: Principal, outletId: string, businessDate: string) {
  const [openShift] = await db().select({ id: shifts.id }).from(shifts).where(and(eq(shifts.outletId, outletId), eq(shifts.status, "open"))).limit(1);
  if (openShift) throw AppError.invariant("open_shifts", "Every shift must be closed before the business day", "Close the open shifts first.");
  const closed = await db().select().from(shifts).where(and(eq(shifts.outletId, outletId), eq(shifts.businessDate, businessDate), eq(shifts.status, "closed")));
  const float = closed.reduce((s, x) => s + x.floatCents, 0);
  const counted = closed.reduce((s, x) => s + (x.countedCashCents ?? 0), 0);
  const report = await zReport({ outletId, businessDate }, { float, counted: closed.length ? counted : null });
  const [row] = await db()
    .insert(businessDayCloses)
    .values({ merchantId: principal.merchantId, outletId, businessDate, closedBy: principal.type === "staff" ? principal.id : null, closedByName: "name" in principal ? principal.name : null, zReport: report })
    .onConflictDoUpdate({ target: [businessDayCloses.outletId, businessDayCloses.businessDate], set: { zReport: report, closedAt: new Date() } })
    .returning();
  return { close: row!, report };
}
