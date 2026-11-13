import { and, eq, isNull, sql } from "drizzle-orm";
import { formatMoney, type TaxAmount, type TaxBreakdown } from "@sail/shared";
import { db, tx } from "../db/client.js";
import { businessDayCloses, merchantSettings, orderAdjustments, orderLines, orders, payments, shifts, staff } from "../db/schema/index.js";
import { AppError } from "../lib/errors.js";
import { businessToday } from "./business-day.js";
import { brandScopeFor, type Principal } from "../auth/principal.js";
import { taxDue } from "./tax-due.js";

/**
 * Shifts and the basic Z-report. The
 * full breakdown by rule and reporting class arrives in v0.9; this covers
 * sales, tenders, expected vs counted cash, rounding, voids and covers.
 */
export type ZReport = {
  scope: { outlet_id: string; station_id: string | null; business_date: string; shift_id: string | null };
  orders: { count: number; by_type: Record<string, number>; covers: number; open_count: number };
  /**
   * `gross` and `discounts` are the items at menu prices and their discounts, as charged (tax included in inclusive mode).
   * `net` is net sales: items after discounts, without tax and fees, less `refunds` (the refunds' net).
   * `fees` excludes tax; `tax` is by component in `taxes`. `total` is the completed orders' total before refunds,
   * so `net + refunds + fees + tax = total`. The tenders add up to `total` only when every order was opened, paid and
   * completed in this scope; `reconciliation` gives the difference.
   * Before refunds, `net_before_refunds + fees + tax = total`; after them, `total_after_refunds = total - refunds.amount`
   * (the `refunds` block splits that amount into net, fees and tax).
   */
  sales: { gross: number; discounts: number; fees: number; tax: number; taxes: TaxBreakdown[]; refunds: number; net: number; total: number; net_before_refunds: number; total_after_refunds: number };
  adjustments: { rule_key: string; name: string; kind: string; report_class: string; total: number; count: number }[];
  tenders: { tender_type_id: string; tender: string; is_cash: boolean; count: number; amount: number; rounding: number; tips: number }[];
  /** Register-computed totals across tenders, so clients never add rows up: `non_cash` is the figure to compare with the terminal's end-of-day total. */
  tenders_summary: { cash: number; non_cash: number; tips: number; count: number };
  /** `expected = float + cash_payments + rounding + tips - refunds`: cash tips stay in the drawer until they are paid out; `refunds` is the cash given back, tips included. */
  cash: { float: number; cash_payments: number; rounding: number; tips: number; refunds: number; expected: number; counted: number | null; variance: number | null };
  voids: { count: number; quantity: number; value: number };
  /**
   * `amount` is the bills' share given back, `net + fees + tax = amount`; `taxes` is the tax given back, by component: a
   * period's tax due is `sales.taxes` less these, component by component. `tips` were given back on top of `amount`
   * (a whole-bill refund returns the tip); the cash ones are in `cash.refunds`.
   */
  refunds: { count: number; amount: number; net: number; fees: number; tax: number; tips: number; taxes: TaxAmount[] };
  /** The tax due by component: `sales.taxes` less `refunds.taxes`, matched on name and rate. Empty for a shift's report. */
  tax_due: TaxAmount[];
  /** Payments taken in this scope and then reversed (voided, or reversed by a reopen): they count in no tender. */
  reversals: { count: number; amount: number; cash_amount: number; items: { payment_id: string; order_no: string; tender: string; is_cash: boolean; amount: number; reversed_at: string | null; reversed_by: string | null; reason: string | null }[] };
  /**
   * How the tenders reconcile to the sales (pricing-semantics §10): `tenders = sales_total + paid_on_other_orders −
   * paid_elsewhere`. `paid_on_other_orders` is what this scope took for orders that are not its completed sales (still
   * open, part-paid, or of another day or station); `paid_elsewhere` is what its completed sales were paid in another
   * day, station or shift.
   */
  reconciliation: { tenders: number; sales_total: number; paid_on_other_orders: number; paid_elsewhere: number };
  generated_at: string;
};

type Scope = { outletId: string; businessDate: string; stationId?: string | null; shiftId?: string | null };

/** Refund figures arrive in v0.7 through this provider. */
let refundProvider: (scope: Scope) => Promise<{ count: number; amount: number; net: number; tax: number; tips: number; cash_amount: number; taxes: TaxAmount[] }> = async () => ({ count: 0, amount: 0, net: 0, tax: 0, tips: 0, cash_amount: 0, taxes: [] });
export function registerRefundTotals(fn: typeof refundProvider) {
  refundProvider = fn;
}

export async function zReport(scope: Scope, cashCounts: { float: number; counted: number | null } = { float: 0, counted: null }): Promise<ZReport> {
  const orderWhere = and(eq(orders.outletId, scope.outletId), eq(orders.businessDate, scope.businessDate), scope.stationId ? eq(orders.stationId, scope.stationId) : sql`true`);
  const completed = and(orderWhere, eq(orders.status, "completed"));
  const [o] = await tx()<{ count: number; covers: number; gross: number; discounts: number; fees: number; tax: number; net: number; total: number }[]>`
    select count(*)::int as count, coalesce(sum(pax),0)::bigint as covers, coalesce(sum(subtotal),0)::bigint as gross, coalesce(sum(discount_total),0)::bigint as discounts,
           coalesce(sum(fees_net),0)::bigint as fees, coalesce(sum(tax_total),0)::bigint as tax, coalesce(sum(net_sales),0)::bigint as net, coalesce(sum(total),0)::bigint as total
    from report_orders r
    where r.outlet_id = ${scope.outletId} and r.business_date = ${scope.businessDate} ${scope.stationId ? tx()`and r.station_id = ${scope.stationId}` : tx()``}`;
  const byType = await db().select({ t: orders.orderType, n: sql<number>`count(*)::int` }).from(orders).where(completed).groupBy(orders.orderType);
  const taxes = await tx()<TaxBreakdown[]>`
    select t->>'name' as name, (t->>'bps')::int as bps, coalesce(sum((t->>'taxable')::bigint),0)::bigint as taxable, coalesce(sum((t->>'amount')::bigint),0)::bigint as amount
    from orders o, jsonb_array_elements(o.taxes) t
    where o.outlet_id = ${scope.outletId} and o.business_date = ${scope.businessDate} and o.status = 'completed' ${scope.stationId ? tx()`and o.station_id = ${scope.stationId}` : tx()``}
    group by 1, 2 order by 2 desc, 1`;
  const [open] = await db().select({ n: sql<number>`count(*)::int` }).from(orders).where(and(orderWhere, sql`${orders.status} in ('open','fired','ready','out_for_delivery')`));
  const adj = await db()
    .select({ rule_key: orderAdjustments.ruleKey, name: orderAdjustments.name, kind: orderAdjustments.kind, report_class: orderAdjustments.reportClass, total: sql<number>`coalesce(sum(${orderAdjustments.total}),0)::bigint`, count: sql<number>`count(*)::int` })
    .from(orderAdjustments)
    .innerJoin(orders, eq(orders.id, orderAdjustments.orderId))
    .where(completed)
    .groupBy(orderAdjustments.ruleKey, orderAdjustments.name, orderAdjustments.kind, orderAdjustments.reportClass);
  const payScope = and(eq(payments.outletId, scope.outletId), scope.shiftId ? eq(payments.shiftId, scope.shiftId) : eq(payments.businessDate, scope.businessDate), scope.stationId && !scope.shiftId ? eq(payments.stationId, scope.stationId) : sql`true`);
  const payWhere = and(payScope, eq(payments.status, "recorded"));
  const tenders = await db()
    .select({ tender_type_id: payments.tenderTypeId, tender: payments.tenderName, is_cash: payments.isCash, count: sql<number>`count(*)::int`, amount: sql<number>`coalesce(sum(amount),0)::bigint`, rounding: sql<number>`coalesce(sum(rounding_cents),0)::bigint`, tips: sql<number>`coalesce(sum(tip_cents),0)::bigint` })
    .from(payments)
    .where(payWhere)
    .groupBy(payments.tenderTypeId, payments.tenderName, payments.isCash);
  const voidRows = await db()
    // A voided line is worth quantity × (unit price + modifiers per unit); the same formula as the report_voids view.
    .select({ count: sql<number>`count(*)::int`, quantity: sql<number>`coalesce(sum(${orderLines.quantity}),0)::bigint`, value: sql<number>`coalesce(sum(${orderLines.quantity} * (${orderLines.unitPrice} + coalesce((select sum((m->>'price')::bigint * (m->>'quantity')::bigint) from jsonb_array_elements(${orderLines.modifiers}) m), 0))),0)::bigint` })
    .from(orderLines)
    .innerJoin(orders, eq(orders.id, orderLines.orderId))
    .where(and(orderWhere, eq(orderLines.status, "voided")));
  const refunds = await refundProvider(scope);
  const reversed = await db()
    .select({ payment_id: payments.id, order_no: orders.orderNo, tender: payments.tenderName, is_cash: payments.isCash, amount: payments.amount, reversed_at: payments.reversedAt, reversed_by: staff.name, reason: payments.reversedReason })
    .from(payments)
    .innerJoin(orders, eq(orders.id, payments.orderId))
    .leftJoin(staff, eq(staff.id, payments.reversedBy))
    .where(and(payScope, eq(payments.status, "reversed")))
    .orderBy(payments.reversedAt);
  const [otherOrders] = await db()
    .select({ amount: sql<number>`coalesce(sum(${payments.amount}),0)::bigint` })
    .from(payments)
    .where(and(payWhere, sql`not exists (select 1 from ${orders} where ${orders.id} = ${payments.orderId} and ${completed})`));
  const [elsewhere] = await db()
    .select({ amount: sql<number>`coalesce(sum(${payments.amount}),0)::bigint` })
    .from(payments)
    .innerJoin(orders, eq(orders.id, payments.orderId))
    // A payment with no shift or no station makes the scope NULL, not false; it was still paid outside this report.
    .where(and(completed, eq(payments.status, "recorded"), sql`not coalesce(${payScope}, false)`));
  const cashPayments = tenders.filter((t) => t.is_cash).reduce((s, t) => s + t.amount, 0);
  const rounding = tenders.filter((t) => t.is_cash).reduce((s, t) => s + t.rounding, 0);
  const cashTips = tenders.filter((t) => t.is_cash).reduce((s, t) => s + t.tips, 0);
  const expected = cashCounts.float + cashPayments + rounding + cashTips - refunds.cash_amount;
  return {
    scope: { outlet_id: scope.outletId, station_id: scope.stationId ?? null, business_date: scope.businessDate, shift_id: scope.shiftId ?? null },
    orders: { count: o?.count ?? 0, by_type: Object.fromEntries(byType.map((b) => [b.t, b.n])), covers: o?.covers ?? 0, open_count: open?.n ?? 0 },
    sales: { gross: o?.gross ?? 0, discounts: o?.discounts ?? 0, fees: o?.fees ?? 0, tax: o?.tax ?? 0, taxes, refunds: refunds.net, net: (o?.net ?? 0) - refunds.net, total: o?.total ?? 0, net_before_refunds: o?.net ?? 0, total_after_refunds: (o?.total ?? 0) - refunds.amount },
    adjustments: adj,
    tenders,
    tenders_summary: { cash: cashPayments, non_cash: tenders.filter((t) => !t.is_cash).reduce((s, t) => s + t.amount, 0), tips: tenders.reduce((s, t) => s + t.tips, 0), count: tenders.reduce((s, t) => s + t.count, 0) },
    cash: { float: cashCounts.float, cash_payments: cashPayments, rounding, tips: cashTips, refunds: refunds.cash_amount, expected, counted: cashCounts.counted, variance: cashCounts.counted == null ? null : cashCounts.counted - expected },
    voids: voidRows[0] ?? { count: 0, quantity: 0, value: 0 },
    refunds: { count: refunds.count, amount: refunds.amount, net: refunds.net, fees: refunds.amount - refunds.net - refunds.tax, tax: refunds.tax, tips: refunds.tips, taxes: refunds.taxes },
    // Sales here are scoped by outlet, day and station, refunds by shift when one is named: a shift's tax due would mix the
    // two, so it is given only for a day or a station-day.
    tax_due: scope.shiftId ? [] : taxDue(taxes, refunds.taxes),
    reversals: {
      count: reversed.length,
      amount: reversed.reduce((s, p) => s + p.amount, 0),
      cash_amount: reversed.filter((p) => p.is_cash).reduce((s, p) => s + p.amount, 0),
      items: reversed.map((p) => ({ ...p, reversed_at: p.reversed_at?.toISOString() ?? null })),
    },
    reconciliation: { tenders: tenders.reduce((s, t) => s + t.amount, 0), sales_total: o?.total ?? 0, paid_on_other_orders: otherOrders?.amount ?? 0, paid_elsewhere: elsewhere?.amount ?? 0 },
    generated_at: new Date().toISOString(),
  };
}

/**
 * A denomination count (keys are the piece value in cents, values are pieces) must add up to the
 * total the client sends, so the stored count and the stored total can never disagree.
 */
export function assertCountsMatch(counts: Record<string, number> | null | undefined, totalCents: number, what: string) {
  if (!counts || Object.keys(counts).length === 0) return;
  let sum = 0;
  for (const [key, pieces] of Object.entries(counts)) {
    const cents = Number(key);
    if (!Number.isInteger(cents) || cents <= 0) throw AppError.validation(`${what}: each count must be for a note or coin value`, { details: { key } });
    if (!Number.isInteger(pieces) || pieces < 0) throw AppError.validation(`${what}: piece counts must be whole numbers`, { details: { key, pieces } });
    sum += cents * pieces;
  }
  if (sum !== totalCents) throw AppError.validation(`${what}: the notes and coins counted do not add up to the total`, { remedy: "Count again, or clear the denominations and enter the total.", details: { counted_from_denominations: sum, total: totalCents } });
}

export async function openShift(principal: Principal, input: { outletId: string; stationId: string | null; name: string | null; floatCents: number; floatCounts: Record<string, number> | null; businessDate: string }) {
  assertCountsMatch(input.floatCounts, input.floatCents, "float");
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

/**
 * A drawer and a business day belong to the whole outlet. A person scoped to some brands sees only those brands' orders
 * and payments, so their close would store one brand's figures as the outlet's (a false expected cash, a Z-report short
 * of the other brands' sales) and miss the other brands' open orders. They may close only when nothing of another brand
 * is in it; otherwise it is refused, and someone who sees every brand closes it.
 */
async function assertNoOtherBrands(principal: Principal, what: "shift" | "day", scope: { outletId: string; businessDate: string; shiftId?: string }) {
  const brands = brandScopeFor(principal);
  if (brands === "*") return;
  const mine = brands.split(",");
  await tx()`select set_config('app.current_brands', '*', true)`;
  try {
    const [r] = scope.shiftId
      ? await tx()<{ other: boolean }[]>`select exists (select 1 from payments p join orders o on o.id = p.order_id where p.shift_id = ${scope.shiftId} and not (o.brand_id = any(${mine}::uuid[])))
          or exists (select 1 from refunds f join orders o on o.id = f.order_id where f.shift_id = ${scope.shiftId} and not (o.brand_id = any(${mine}::uuid[]))) as other`
      : await tx()<{ other: boolean }[]>`select exists (select 1 from orders o where o.outlet_id = ${scope.outletId} and o.business_date = ${scope.businessDate} and not (o.brand_id = any(${mine}::uuid[])))
          or exists (select 1 from payments p join orders o on o.id = p.order_id where p.outlet_id = ${scope.outletId} and p.business_date = ${scope.businessDate} and not (o.brand_id = any(${mine}::uuid[])))
          or exists (select 1 from refunds f join orders o on o.id = f.order_id where f.outlet_id = ${scope.outletId} and f.business_date = ${scope.businessDate} and not (o.brand_id = any(${mine}::uuid[]))) as other`;
    if (r!.other) throw new AppError("permission_denied", what === "shift" ? "This drawer also holds another brand's payments" : "This business day also has another brand's orders", { remedy: `Ask someone who works for every brand at this outlet to close the ${what === "shift" ? "shift" : "business day"}.` });
  } finally {
    await tx()`select set_config('app.current_brands', ${brands}, true)`;
  }
}

export async function closeShift(principal: Principal, shiftId: string, input: { countedCashCents: number; countedCounts: Record<string, number> | null; varianceReason: string | null }) {
  // Locked, so a payment void in this shift either commits first (and is counted) or waits and finds the shift closed.
  await tx()`select id from shifts where id = ${shiftId} for update`;
  const [shift] = await db().select().from(shifts).where(eq(shifts.id, shiftId)).limit(1);
  if (!shift) throw AppError.notFound("shift", shiftId);
  if (shift.status === "closed") throw AppError.state("The shift is already closed", []);
  await assertNoOtherBrands(principal, "shift", { outletId: shift.outletId, businessDate: shift.businessDate, shiftId: shift.id });
  assertCountsMatch(input.countedCounts, input.countedCashCents, "counted cash");
  // A void still waiting for the provider would change this shift's figures after they were counted.
  const [voiding] = await tx()<{ n: number }[]>`select count(*)::int as n from payment_intents i join payments p on p.id = i.payment_id where p.shift_id = ${shiftId} and i.void_requested_at is not null and i.provider_voided_at is null`;
  if ((voiding?.n ?? 0) > 0) throw AppError.state("A card void in this shift is waiting for the terminal", [], "Wait for the terminal to confirm the void, then close the shift.");
  const report = await zReport({ outletId: shift.outletId, businessDate: shift.businessDate, stationId: shift.stationId, shiftId: shift.id }, { float: shift.floatCents, counted: input.countedCashCents });
  const [settings] = await db().select({ threshold: merchantSettings.cashVarianceThreshold, currency: merchantSettings.currency, locale: merchantSettings.locale }).from(merchantSettings).where(eq(merchantSettings.merchantId, shift.merchantId)).limit(1);
  if (!settings) throw AppError.notFound("merchant");
  const variance = report.cash.variance ?? 0;
  if (Math.abs(variance) > settings.threshold && !input.varianceReason?.trim())
    throw AppError.validation(`The drawer is ${formatMoney(Math.abs(variance), settings)} ${variance < 0 ? "short" : "over"}, more than the ${formatMoney(settings.threshold, settings)} allowed without a reason`, {
      remedy: "Count again, or close with a variance reason.",
      details: { expected: report.cash.expected, counted: input.countedCashCents, variance, variance_threshold: settings.threshold },
    });
  const now = new Date();
  const [row] = await db()
    .update(shifts)
    .set({ status: "closed", closedBy: principal.type === "staff" ? principal.id : null, closedByName: "name" in principal ? principal.name : null, closedAt: now, countedCashCents: input.countedCashCents, countedCounts: input.countedCounts, expectedCashCents: report.cash.expected, varianceCents: report.cash.variance, varianceReason: input.varianceReason, summary: report })
    .where(eq(shifts.id, shiftId))
    .returning();
  return { shift: row!, report };
}

export async function closeBusinessDay(principal: Principal, outletId: string, businessDate: string) {
  // Waits for a void being requested at this outlet, and refuses while a terminal void is still to be confirmed.
  await tx()`select id from outlets where id = ${outletId} for no key update`;
  const [voiding] = await tx()<{ n: number }[]>`select count(*)::int as n from payment_intents where outlet_id = ${outletId} and void_requested_at is not null and provider_voided_at is null`;
  if ((voiding?.n ?? 0) > 0) throw AppError.state("A card void at this outlet is waiting for the terminal", [], "Wait for the terminal to confirm the void, then close the business day.");
  const { today } = await businessToday(principal.merchantId, outletId);
  await assertNoOtherBrands(principal, "day", { outletId, businessDate });
  if (businessDate > today) throw AppError.state(`Business day ${businessDate} has not started yet`, [], "Close a business day once it has started.");
  // The day's own shifts: the next day's drawer, opened before anyone closed the night, counts on its own day.
  const [openShift] = await db().select({ id: shifts.id }).from(shifts).where(and(eq(shifts.outletId, outletId), eq(shifts.status, "open"), eq(shifts.businessDate, businessDate))).limit(1);
  if (openShift) throw AppError.invariant("open_shifts", `Every shift of business day ${businessDate} must be closed before the day`, "Close the open shifts first.");
  // A day closes once, with nothing left to change it: an order still open would add its sale after the report was stored.
  const [already] = await db().select({ id: businessDayCloses.id }).from(businessDayCloses).where(and(eq(businessDayCloses.outletId, outletId), eq(businessDayCloses.businessDate, businessDate))).limit(1);
  if (already) throw AppError.state(`Business day ${businessDate} is already closed`, [], "Its Z-report was stored at the close; read it from the business day.");
  const [stillOpen] = await db().select({ n: sql<number>`count(*)::int` }).from(orders).where(and(eq(orders.outletId, outletId), eq(orders.businessDate, businessDate), sql`${orders.status} not in ('completed','cancelled')`));
  if ((stillOpen?.n ?? 0) > 0) throw AppError.invariant("open_orders", `${stillOpen!.n} order${stillOpen!.n === 1 ? " is" : "s are"} still open on business day ${businessDate}`, "Settle or cancel the open orders first.");
  const closed = await db().select().from(shifts).where(and(eq(shifts.outletId, outletId), eq(shifts.businessDate, businessDate), eq(shifts.status, "closed")));
  const float = closed.reduce((s, x) => s + x.floatCents, 0);
  const counted = closed.reduce((s, x) => s + (x.countedCashCents ?? 0), 0);
  const report = await zReport({ outletId, businessDate }, { float, counted: closed.length ? counted : null });
  const [row] = await db()
    .insert(businessDayCloses)
    .values({ merchantId: principal.merchantId, outletId, businessDate, closedBy: principal.type === "staff" ? principal.id : null, closedByName: "name" in principal ? principal.name : null, zReport: report })
    .returning();
  return { close: row!, report };
}
