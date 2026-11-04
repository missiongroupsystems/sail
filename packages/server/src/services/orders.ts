import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { price, PricingContextSchema, type ManualApplication, type OrderType, type PricingLineInput, type PricingResult, ORDER_NUMBER_PREFIX, type ChannelType } from "@sail/shared";
import { db, tx } from "../db/client.js";
import { customerGroupMembers, merchantSettings, orderAdjustmentLines, orderAdjustments, orderLines, orderManualApplications, orders, tables } from "../db/schema/index.js";
import { AppError } from "../lib/errors.js";
import { activeRules } from "./pricing-rules.js";

/**
 * Order services: the register's own view of an order. Every mutation ends
 * with `repriceOrder` (the pricing pipeline run on the current lines) and
 * `bumpVersion`, then returns `loadSnapshot` so clients learn amounts from the
 * register, never by computing them (vision 2, principle 1).
 */

export type OrderSnapshot = {
  id: string;
  order_no: string;
  outlet_id: string;
  brand_id: string;
  channel_link_id: string;
  channel: ChannelType;
  order_type: OrderType;
  status: string;
  version: number;
  table_id: string | null;
  pax: number | null;
  customer_id: string | null;
  customer_ref: { name?: string; mobile?: string } | null;
  delivery_address: string | null;
  delivery_notes: string | null;
  ready_by: string | null;
  notes: string | null;
  station_id: string | null;
  opened_by: { id: string | null; name: string | null };
  business_date: string;
  opened_at: string;
  first_fired_at: string | null;
  ready_at: string | null;
  completed_at: string | null;
  cancelled_at: string | null;
  bill_requested_at: string | null;
  round_count: number;
  pricing_status: "live" | "frozen";
  totals: { tax_mode: string; gst_bps: number; subtotal: number; discount_total: number; fee_total: number; gst_total: number; total: number };
  lines: SnapshotLine[];
  adjustments: SnapshotAdjustment[];
  manual_applications: { id: string; rule_key: string; entered_value: number | null; line_ids: string[] | null; applied_by: string | null; reason: string | null }[];
  /** Filled by v0.6: checks, payments and balances. */
  checks: unknown[];
  paid_total: number;
  balance: number;
};
export type SnapshotLine = {
  id: string;
  product_id: string;
  name: string;
  kitchen_name: string | null;
  sku: string | null;
  quantity: number;
  unit_price: number;
  open_price: number | null;
  modifiers: { modifier_id: string; product_id: string; name: string; quantity: number; price: number; group_id: string }[];
  notes: string | null;
  seat_no: number | null;
  source: string;
  round_id: string | null;
  status: string;
  fire_round: number | null;
  fired_at: string | null;
  voided_at: string | null;
  void_reason: string | null;
  amounts: { base: number; discount: number; net: number; fee: number; gst: number; total: number };
  tags: string[];
  category_id: string | null;
  sort: number;
  added_by: string | null;
  created_at: string;
};
export type SnapshotAdjustment = {
  id: string;
  rule_key: string;
  rule_version: number;
  name: string;
  kind: string;
  level: string;
  report_class: string;
  total: number;
  gst_total: number;
  capped: boolean;
  frozen: boolean;
  manual_application_id: string | null;
  entered_value: number | null;
  applied_by: string | null;
  approved_by: string | null;
  reason: string | null;
  lines: { line_id: string; amount: number; gst_amount: number }[];
};

export const OPEN_STATUSES = ["open", "fired", "ready", "out_for_delivery"] as const;

export async function nextOrderNo(outletId: string, merchantId: string, channel: ChannelType): Promise<string> {
  const [row] = await tx()<{ n: number }[]>`
    insert into outlet_sequences (outlet_id, merchant_id, next_seq, next_order_no) values (${outletId}, ${merchantId}, 1, 2)
    on conflict (outlet_id) do update set next_order_no = outlet_sequences.next_order_no + 1
    returning next_order_no - 1 as n`;
  return `${ORDER_NUMBER_PREFIX[channel]}-${String(row!.n).padStart(4, "0")}`;
}

export async function getOrderRow(orderId: string) {
  const [row] = await db().select().from(orders).where(eq(orders.id, orderId)).limit(1);
  if (!row) throw AppError.notFound("order", orderId);
  return row;
}

/** Lock the order row for the rest of the transaction and check the caller's expected version. */
export async function lockOrder(orderId: string, expectedVersion?: number | null) {
  const [row] = await tx()<(typeof orders.$inferSelect & Record<string, unknown>)[]>`select * from orders where id = ${orderId} for update`;
  if (!row) throw AppError.notFound("order", orderId);
  const order = mapRow(row);
  if (expectedVersion != null && order.version !== expectedVersion) {
    throw AppError.version("The order was changed by someone else", { current_version: order.version, expected_version: expectedVersion, order_id: orderId });
  }
  return order;
}

/** postgres.js returns snake_case rows for raw queries; map the few fields the services read. */
function mapRow(r: Record<string, unknown>): typeof orders.$inferSelect {
  const camel: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(r)) camel[k.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())] = v;
  for (const k of ["readyBy", "openedAt", "firstFiredAt", "readyAt", "completedAt", "cancelledAt", "updatedAt", "pricingFrozenAt", "billRequestedAt"]) if (typeof camel[k] === "string") camel[k] = new Date(camel[k] as string);
  return camel as unknown as typeof orders.$inferSelect;
}

export async function bumpVersion(orderId: string): Promise<number> {
  const [row] = await db()
    .update(orders)
    .set({ version: sql`${orders.version} + 1`, updatedAt: new Date() })
    .where(eq(orders.id, orderId))
    .returning({ version: orders.version });
  return row!.version;
}

export function resolveUnitPrice(line: { openPrice: number | null; basePrice: number; pricesByOrderType: Record<string, number> }, orderType: string): number {
  return line.openPrice ?? line.pricesByOrderType[orderType] ?? line.basePrice;
}

/** Run the pricing pipeline on the order's current lines and persist the result. */
export async function repriceOrder(orderId: string, at = new Date()): Promise<PricingResult> {
  const order = await getOrderRow(orderId);
  const lines = await db().select().from(orderLines).where(and(eq(orderLines.orderId, orderId), sql`${orderLines.status} <> 'voided'`)).orderBy(asc(orderLines.sort), asc(orderLines.createdAt));
  const apps = await db().select().from(orderManualApplications).where(and(eq(orderManualApplications.orderId, orderId), isNull(orderManualApplications.removedAt)));
  const groupIds = order.customerId ? (await db().select({ g: customerGroupMembers.groupId }).from(customerGroupMembers).where(eq(customerGroupMembers.customerId, order.customerId))).map((x) => x.g) : [];
  const rules = await activeRules(order.merchantId, at);
  const [settings] = await db().select().from(merchantSettings).where(eq(merchantSettings.merchantId, order.merchantId)).limit(1);

  const pricingLines: PricingLineInput[] = lines.map((l) => ({
    line_id: l.id,
    product_id: l.productId,
    category_id: l.categoryId,
    parent_category_id: l.parentCategoryId,
    tags: l.tags,
    is_bcrs: l.isBcrs,
    quantity: l.quantity,
    prices: { base: l.basePrice, by_order_type: l.pricesByOrderType as Partial<Record<OrderType, number>> },
    open_price: l.openPrice,
    modifiers: l.modifiers.map((m) => ({ modifier_id: m.modifier_id, product_id: m.product_id, quantity: m.quantity, price: m.price, name: m.name })),
    name: l.name,
  }));
  const manual: ManualApplication[] = apps.map((a) => ({ application_id: a.id, rule_id: a.ruleKey, entered_value: a.enteredValue, line_ids: a.lineIds, applied_by: a.appliedBy, approved_by: a.approvedBy, override_id: a.overrideId, reason: a.reason }));

  const result = price(
    { order_type: order.orderType as OrderType, channel: order.channel as ChannelType, outlet_id: order.outletId, brand_id: order.brandId, customer_group_ids: groupIds, lines: pricingLines, manual_applications: manual },
    rules,
    PricingContextSchema.parse({
      tax_mode: order.taxMode,
      gst_bps: order.gstBps,
      now: at.toISOString(),
      frozen: order.pricingFrozenAt ? { frozen_at: order.pricingFrozenAt.toISOString(), adjustments: order.frozenAdjustments ?? [] } : null,
    }),
  );
  void settings;

  // Persist: line amounts, adjustments and their lines, order totals.
  for (const pl of result.lines) {
    await db()
      .update(orderLines)
      .set({ unitPrice: pl.unit_price, baseAmount: pl.base_amount, discountAmount: pl.discount_amount, netAmount: pl.net_amount, feeAmount: pl.fee_amount, gstAmount: pl.gst_on_net + pl.gst_on_fees, total: pl.total, updatedAt: at })
      .where(eq(orderLines.id, pl.line_id));
  }
  await db().delete(orderAdjustments).where(eq(orderAdjustments.orderId, orderId));
  let sort = 0;
  for (const a of result.adjustments) {
    const [row] = await db()
      .insert(orderAdjustments)
      .values({
        merchantId: order.merchantId,
        outletId: order.outletId,
        orderId,
        ruleKey: a.rule_id,
        ruleVersion: a.rule_version,
        ruleSnapshot: a.rule_snapshot,
        kind: a.kind,
        level: a.level,
        name: a.rule_name,
        reportClass: a.report_class,
        gstApplicable: a.gst_applicable,
        total: a.total,
        gstTotal: a.gst_total,
        capped: a.capped,
        frozen: a.frozen,
        manualApplicationId: a.manual_application_id,
        enteredValue: a.entered_value,
        appliedBy: a.applied_by,
        approvedBy: a.approved_by,
        overrideId: a.override_id,
        reason: a.reason,
        sort: sort++,
      })
      .returning({ id: orderAdjustments.id });
    if (a.lines.length) await db().insert(orderAdjustmentLines).values(a.lines.map((l) => ({ merchantId: order.merchantId, adjustmentId: row!.id, orderLineId: l.line_id, amount: l.amount, gstAmount: l.gst_amount })));
  }
  await db()
    .update(orders)
    .set({ subtotal: result.totals.subtotal, discountTotal: result.totals.discount_total, feeTotal: result.totals.fee_total, gstTotal: result.totals.gst_total, total: result.totals.total, updatedAt: at })
    .where(eq(orders.id, orderId));
  for (const hook of repriceHooks) await hook(orderId, result);
  return result;
}

/** Later phases (checks/allocations) run after every re-price. */
const repriceHooks: ((orderId: string, result: PricingResult) => Promise<void>)[] = [];
export function registerRepriceHook(fn: (orderId: string, result: PricingResult) => Promise<void>) {
  repriceHooks.push(fn);
}

export async function loadSnapshot(orderId: string): Promise<OrderSnapshot> {
  const o = await getOrderRow(orderId);
  const lines = await db().select().from(orderLines).where(eq(orderLines.orderId, orderId)).orderBy(asc(orderLines.sort), asc(orderLines.createdAt));
  const adjs = await db().select().from(orderAdjustments).where(eq(orderAdjustments.orderId, orderId)).orderBy(asc(orderAdjustments.sort));
  const adjLines = adjs.length ? await db().select().from(orderAdjustmentLines).where(inArray(orderAdjustmentLines.adjustmentId, adjs.map((a) => a.id))) : [];
  const apps = await db().select().from(orderManualApplications).where(and(eq(orderManualApplications.orderId, orderId), isNull(orderManualApplications.removedAt)));
  const extra = await snapshotExtras(o);
  return {
    id: o.id,
    order_no: o.orderNo,
    outlet_id: o.outletId,
    brand_id: o.brandId,
    channel_link_id: o.channelLinkId,
    channel: o.channel as ChannelType,
    order_type: o.orderType as OrderType,
    status: o.status,
    version: o.version,
    table_id: o.tableId,
    pax: o.pax,
    customer_id: o.customerId,
    customer_ref: o.customerRef ?? null,
    delivery_address: o.deliveryAddress,
    delivery_notes: o.deliveryNotes,
    ready_by: o.readyBy?.toISOString() ?? null,
    notes: o.notes,
    station_id: o.stationId,
    opened_by: { id: o.openedBy, name: o.openedByName },
    business_date: o.businessDate,
    opened_at: o.openedAt.toISOString(),
    first_fired_at: o.firstFiredAt?.toISOString() ?? null,
    ready_at: o.readyAt?.toISOString() ?? null,
    completed_at: o.completedAt?.toISOString() ?? null,
    cancelled_at: o.cancelledAt?.toISOString() ?? null,
    bill_requested_at: o.billRequestedAt?.toISOString() ?? null,
    round_count: o.roundCount,
    pricing_status: o.pricingFrozenAt ? "frozen" : "live",
    totals: { tax_mode: o.taxMode, gst_bps: o.gstBps, subtotal: o.subtotal, discount_total: o.discountTotal, fee_total: o.feeTotal, gst_total: o.gstTotal, total: o.total },
    lines: lines.map((l) => ({
      id: l.id,
      product_id: l.productId,
      name: l.name,
      kitchen_name: l.kitchenName,
      sku: l.sku,
      quantity: l.quantity,
      unit_price: l.unitPrice,
      open_price: l.openPrice,
      modifiers: l.modifiers,
      notes: l.notes,
      seat_no: l.seatNo,
      source: l.source,
      round_id: l.roundId,
      status: l.status,
      fire_round: l.fireRound,
      fired_at: l.firedAt?.toISOString() ?? null,
      voided_at: l.voidedAt?.toISOString() ?? null,
      void_reason: l.voidReason,
      amounts: { base: l.baseAmount, discount: l.discountAmount, net: l.netAmount, fee: l.feeAmount, gst: l.gstAmount, total: l.total },
      tags: l.tags,
      category_id: l.categoryId,
      sort: l.sort,
      added_by: l.addedByName,
      created_at: l.createdAt.toISOString(),
    })),
    adjustments: adjs.map((a) => ({
      id: a.id,
      rule_key: a.ruleKey,
      rule_version: a.ruleVersion,
      name: a.name,
      kind: a.kind,
      level: a.level,
      report_class: a.reportClass,
      total: a.total,
      gst_total: a.gstTotal,
      capped: a.capped,
      frozen: a.frozen,
      manual_application_id: a.manualApplicationId,
      entered_value: a.enteredValue,
      applied_by: a.appliedBy,
      approved_by: a.approvedBy,
      reason: a.reason,
      lines: adjLines.filter((x) => x.adjustmentId === a.id).map((x) => ({ line_id: x.orderLineId, amount: x.amount, gst_amount: x.gstAmount })),
    })),
    manual_applications: apps.map((a) => ({ id: a.id, rule_key: a.ruleKey, entered_value: a.enteredValue, line_ids: a.lineIds, applied_by: a.appliedByName, reason: a.reason })),
    ...extra,
  };
}

/** Later phases (checks, payments) register a provider for the payment part of the snapshot. */
type Extras = Pick<OrderSnapshot, "checks" | "paid_total" | "balance">;
let extrasProvider: (o: typeof orders.$inferSelect) => Promise<Extras> = async (o) => ({ checks: [], paid_total: 0, balance: o.total });
export function registerSnapshotExtras(fn: typeof extrasProvider) {
  extrasProvider = fn;
}
async function snapshotExtras(o: typeof orders.$inferSelect): Promise<Extras> {
  return extrasProvider(o);
}

/** Amount paid so far (0 until payments exist in v0.6). Used by pay-before-firing and change-type guards. */
let paidProvider: (orderId: string) => Promise<number> = async () => 0;
export function registerPaidProvider(fn: typeof paidProvider) {
  paidProvider = fn;
}
export function paidTotal(orderId: string) {
  return paidProvider(orderId);
}

/** Open dine-in order on a table, if any. */
export async function openOrderForTable(tableId: string) {
  const [row] = await db()
    .select({ id: orders.id, status: orders.status })
    .from(orders)
    .where(and(eq(orders.tableId, tableId), inArray(orders.status, [...OPEN_STATUSES])))
    .limit(1);
  return row ?? null;
}

export async function tableExists(tableId: string, outletId: string) {
  const [t] = await db().select({ id: tables.id }).from(tables).where(and(eq(tables.id, tableId), eq(tables.outletId, outletId), isNull(tables.archivedAt))).limit(1);
  return !!t;
}

/** Called when an order completes or is cancelled (guest sessions expire, v0.8). */
const closedHooks: ((orderId: string) => Promise<void>)[] = [];
export function registerOrderClosedHook(fn: (orderId: string) => Promise<void>) {
  closedHooks.push(fn);
}
export async function orderClosed(orderId: string) {
  for (const h of closedHooks) await h(orderId);
}
