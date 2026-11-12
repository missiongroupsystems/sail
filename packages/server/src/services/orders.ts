import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { price, PricingContextSchema, sumCents, sumTaxBreakdowns, type Adjustment, type ManualApplication, type OrderType, type PricedLine, type PricingContext, type PricingLineInput, type PricingResult, type PricingRule, type TaxBreakdown, type TaxRate, ORDER_NUMBER_PREFIX, type ChannelType } from "@sail/shared";
import { assertNotSettled, db, maybeTx, tx } from "../db/client.js";
import { checkAllocations, checks, customerGroupMembers, orderAdjustmentLines, orderAdjustments, orderLines, orderManualApplications, orders, tables } from "../db/schema/index.js";
import { AppError } from "../lib/errors.js";
import { activeRules } from "./pricing-rules.js";
import { orderTaxRates, usedTaxClasses } from "./tax.js";

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
  totals: { tax_mode: string; tax_rounding: string; subtotal: number; discount_total: number; fee_total: number; tax_total: number; taxes: TaxBreakdown[]; total: number };
  lines: SnapshotLine[];
  adjustments: SnapshotAdjustment[];
  manual_applications: { id: string; rule_key: string; entered_value: number | null; line_ids: string[] | null; applied_by: string | null; reason: string | null }[];
  /** Filled by v0.6: checks, payments and balances. */
  checks: unknown[];
  paid_total: number;
  /** Sum of the bills' refunded totals (v0.7), so clients never add bills up. */
  refunded_total: number;
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
  amounts: { base: number; discount: number; net: number; fee: number; tax: number; total: number };
  /** amounts.tax by component. */
  taxes: TaxBreakdown[];
  tax_class_id: string;
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
  tax_class_id: string | null;
  total: number;
  tax_total: number;
  capped: boolean;
  frozen: boolean;
  manual_application_id: string | null;
  entered_value: number | null;
  applied_by: string | null;
  approved_by: string | null;
  reason: string | null;
  lines: { line_id: string; amount: number; tax_amount: number }[];
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
  const pinned = maybeTx()?.pinnedOrder;
  if (pinned && pinned.orderId === orderId && order.version !== pinned.version) {
    throw AppError.version("The order has changed since this proposal was made", { current_version: order.version, expected_version: pinned.version, order_id: orderId });
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

/** Lines allocated to a paid (locked) bill: their amounts are fixed until the bill is refunded or the order reopened. */
export async function lockedLineIds(orderId: string): Promise<Set<string>> {
  const rows = await db()
    .selectDistinct({ id: checkAllocations.orderLineId })
    .from(checkAllocations)
    .innerJoin(checks, eq(checks.id, checkAllocations.checkId))
    .where(and(eq(checks.orderId, orderId), sql`${checks.lockedAt} is not null`));
  return new Set(rows.map((r) => r.id));
}

const adjKey = (ruleKey: string, version: number, appId: string | null) => `${ruleKey}@${version}|${appId ?? ""}`;

/**
 * Run the pricing pipeline on the order's current lines and persist the result.
 *
 * Lines on a paid bill are never re-priced: their stored amounts and adjustment
 * shares are carried over unchanged, the pipeline runs on the unpaid lines only
 * (with each capped rule's remaining cap), and the two halves are merged. That
 * keeps "a paid bill never changes" true whatever happens to the rest of the
 * order (lines added, a customer attached, a scheduled rule switching on), while
 * the engine itself stays a pure function of its inputs.
 */
export async function repriceOrder(orderId: string, at = new Date()): Promise<PricingResult> {
  assertNotSettled("repriceOrder");
  const order = await getOrderRow(orderId);
  // Independent reads are issued together so postgres.js pipelines them on the transaction's connection.
  const [lines, apps, groupRows, rules, locked, storedAdjs] = await Promise.all([
    db().select().from(orderLines).where(and(eq(orderLines.orderId, orderId), sql`${orderLines.status} <> 'voided'`)).orderBy(asc(orderLines.sort), asc(orderLines.createdAt)),
    db().select().from(orderManualApplications).where(and(eq(orderManualApplications.orderId, orderId), isNull(orderManualApplications.removedAt))),
    order.customerId ? db().select({ g: customerGroupMembers.groupId }).from(customerGroupMembers).where(eq(customerGroupMembers.customerId, order.customerId)) : Promise.resolve([] as { g: string }[]),
    activeRules(order.merchantId, at),
    lockedLineIds(orderId),
    db().select().from(orderAdjustments).where(eq(orderAdjustments.orderId, orderId)).orderBy(asc(orderAdjustments.sort)),
  ]);
  const groupIds = groupRows.map((x) => x.g);
  const lockedLines = lines.filter((l) => locked.has(l.id));
  const liveLines = locked.size ? lines.filter((l) => !locked.has(l.id)) : lines;
  const storedAdjLines = locked.size && storedAdjs.length ? await db().select().from(orderAdjustmentLines).where(and(inArray(orderAdjustmentLines.adjustmentId, storedAdjs.map((a) => a.id)), inArray(orderAdjustmentLines.orderLineId, [...locked]))) : [];

  // A capped rule's cap is for the whole order: what paid lines already took is no longer available to the unpaid ones.
  const originalRules = new Map(rules.map((r) => [r.id, r]));
  const lockedUseByRule = new Map<string, number>();
  for (const al of storedAdjLines) {
    const adj = storedAdjs.find((a) => a.id === al.adjustmentId)!;
    lockedUseByRule.set(adj.ruleKey, (lockedUseByRule.get(adj.ruleKey) ?? 0) + Math.abs(al.amount));
  }
  const effectiveRules: PricingRule[] = rules.map((r) => (r.cap != null && lockedUseByRule.has(r.id) ? { ...r, cap: Math.max(0, r.cap - lockedUseByRule.get(r.id)!) } : r));
  const taxRates = await orderTaxRates(order, usedTaxClasses(liveLines, effectiveRules));

  const pricingLines: PricingLineInput[] = liveLines.map(pricingLineOf);
  const manual: ManualApplication[] = apps.map((a) => ({ application_id: a.id, rule_id: a.ruleKey, entered_value: a.enteredValue, line_ids: a.lineIds, applied_by: a.appliedBy, approved_by: a.approvedBy, override_id: a.overrideId, reason: a.reason }));

  const engine = price(
    { order_type: order.orderType as OrderType, channel: order.channel as ChannelType, outlet_id: order.outletId, brand_id: order.brandId, customer_group_ids: groupIds, lines: pricingLines, manual_applications: manual },
    effectiveRules,
    pricingContextOf(order, at, taxRates),
  );

  // Merge the paid lines back in: their stored amounts and their stored share of every adjustment.
  const adjustments: Adjustment[] = engine.adjustments.map((a) => ({ ...a, lines: [...a.lines], rule_snapshot: originalRules.get(a.rule_id) ?? a.rule_snapshot }));
  const lockedPriced: PricedLine[] = [];
  if (locked.size) {
    const byKey = new Map(adjustments.map((a) => [adjKey(a.rule_id, a.rule_version, a.manual_application_id), a]));
    for (const s of storedAdjs) {
      const mine = storedAdjLines.filter((al) => al.adjustmentId === s.id);
      if (mine.length === 0) continue;
      const k = adjKey(s.ruleKey, s.ruleVersion, s.manualApplicationId);
      const extra = mine.map((al) => ({ line_id: al.orderLineId, amount: al.amount, tax_amount: al.taxAmount }));
      const target = byKey.get(k);
      if (target) {
        target.lines.push(...extra);
        target.total += sumCents(extra.map((x) => x.amount));
        target.tax_total += sumCents(extra.map((x) => x.tax_amount));
      } else {
        const carried: Adjustment = {
          rule_id: s.ruleKey,
          rule_version: s.ruleVersion,
          rule_name: s.name,
          kind: s.kind as Adjustment["kind"],
          level: s.level as Adjustment["level"],
          report_class: s.reportClass as Adjustment["report_class"],
          tax_class_id: s.taxClassId,
          total: sumCents(extra.map((x) => x.amount)),
          tax_total: sumCents(extra.map((x) => x.tax_amount)),
          lines: extra,
          capped: s.capped,
          frozen: s.frozen,
          manual_application_id: s.manualApplicationId,
          entered_value: s.enteredValue,
          applied_by: s.appliedBy,
          approved_by: s.approvedBy,
          override_id: s.overrideId,
          reason: s.reason,
          rule_snapshot: s.ruleSnapshot,
        };
        byKey.set(k, carried);
        adjustments.push(carried);
      }
    }
    for (const l of lockedLines) {
      const taxOnFees = sumCents(storedAdjLines.filter((al) => al.orderLineId === l.id).map((al) => al.taxAmount));
      lockedPriced.push({ line_id: l.id, quantity: l.quantity, unit_price: l.unitPrice, modifiers_per_unit: sumCents(l.modifiers.map((m) => m.price * m.quantity)), base_amount: l.baseAmount, discount_amount: l.discountAmount, net_amount: l.netAmount, fee_amount: l.feeAmount, tax_on_net: l.taxAmount - taxOnFees, tax_on_fees: taxOnFees, taxes: l.taxes, total: l.total });
    }
  }
  const allLines = [...engine.lines, ...lockedPriced];
  const totals: PricingResult["totals"] = {
    tax_mode: engine.totals.tax_mode,
    subtotal: sumCents(allLines.map((l) => l.base_amount)),
    discount_total: sumCents(allLines.map((l) => l.discount_amount)),
    net_subtotal: sumCents(allLines.map((l) => l.net_amount)),
    fee_total: sumCents(allLines.map((l) => l.fee_amount)),
    tax_total: sumCents(allLines.map((l) => l.tax_on_net + l.tax_on_fees)),
    taxes: sumTaxBreakdowns(allLines.map((l) => l.taxes)),
    total: sumCents(allLines.map((l) => l.total)),
  };
  const result: PricingResult = {
    lines: allLines,
    adjustments,
    totals,
    trace: locked.size ? [...engine.trace, { step: 7, title: "Paid bills", entries: [{ outcome: "info", detail: `${locked.size} line${locked.size === 1 ? "" : "s"} on paid bills kept their stored amounts; capped rules priced the unpaid lines with their remaining cap` }] }] : engine.trace,
    warnings: engine.warnings,
    pricing_status: engine.pricing_status,
  };

  // Persist in a handful of statements: line amounts (one UPDATE over a VALUES list), adjustments, their lines, the order totals.
  if (engine.lines.length) {
    const ls = engine.lines;
    await tx()`
      update order_lines as l
      set unit_price = v.unit_price, base_amount = v.base_amount, discount_amount = v.discount_amount, net_amount = v.net_amount, fee_amount = v.fee_amount, tax_amount = v.tax_amount, taxes = v.taxes, total = v.total, updated_at = ${at.toISOString()}::timestamptz
      from unnest(${ls.map((l) => l.line_id)}::uuid[], ${ls.map((l) => l.unit_price)}::int[], ${ls.map((l) => l.base_amount)}::int[], ${ls.map((l) => l.discount_amount)}::int[], ${ls.map((l) => l.net_amount)}::int[], ${ls.map((l) => l.fee_amount)}::int[], ${ls.map((l) => l.tax_on_net + l.tax_on_fees)}::int[], ${ls.map((l) => JSON.stringify(l.taxes))}::jsonb[], ${ls.map((l) => l.total)}::int[])
        as v(id, unit_price, base_amount, discount_amount, net_amount, fee_amount, tax_amount, taxes, total)
      where l.id = v.id`;
  }
  await db().delete(orderAdjustments).where(eq(orderAdjustments.orderId, orderId));
  if (adjustments.length) {
    const inserted = await db()
      .insert(orderAdjustments)
      .values(
        adjustments.map((a, sort) => ({
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
          taxClassId: a.tax_class_id,
          total: a.total,
          taxTotal: a.tax_total,
          capped: a.capped,
          frozen: a.frozen,
          manualApplicationId: a.manual_application_id,
          enteredValue: a.entered_value,
          appliedBy: a.applied_by,
          approvedBy: a.approved_by,
          overrideId: a.override_id,
          reason: a.reason,
          sort,
        })),
      )
      .returning({ id: orderAdjustments.id, sort: orderAdjustments.sort });
    const idBySort = new Map(inserted.map((r) => [r.sort, r.id]));
    const lineRows = adjustments.flatMap((a, sort) => a.lines.map((l) => ({ merchantId: order.merchantId, adjustmentId: idBySort.get(sort)!, orderLineId: l.line_id, amount: l.amount, taxAmount: l.tax_amount })));
    if (lineRows.length) await db().insert(orderAdjustmentLines).values(lineRows);
  }
  await db()
    .update(orders)
    .set({ subtotal: totals.subtotal, discountTotal: totals.discount_total, feeTotal: totals.fee_total, taxTotal: totals.tax_total, taxes: totals.taxes, total: totals.total, taxRates, updatedAt: at })
    .where(eq(orders.id, orderId));
  for (const hook of repriceHooks) await hook(orderId, result);
  return result;
}

/** A stored line as the pricing engine sees it (the catalogue snapshot taken when the line was added). */
export function pricingLineOf(l: Pick<typeof orderLines.$inferSelect, "id" | "productId" | "categoryId" | "parentCategoryId" | "tags" | "hasDeposit" | "taxClassId" | "quantity" | "basePrice" | "pricesByOrderType" | "openPrice" | "modifiers" | "name">): PricingLineInput {
  return {
    line_id: l.id,
    product_id: l.productId,
    category_id: l.categoryId,
    parent_category_id: l.parentCategoryId,
    tags: l.tags,
    has_deposit: l.hasDeposit,
    tax_class_id: l.taxClassId,
    quantity: l.quantity,
    prices: { base: l.basePrice, by_order_type: l.pricesByOrderType as Partial<Record<OrderType, number>> },
    open_price: l.openPrice,
    modifiers: l.modifiers.map((m) => ({ modifier_id: m.modifier_id, product_id: m.product_id, quantity: m.quantity, price: m.price, name: m.name })),
    name: l.name,
  };
}

/** The pricing context of an order: the tax mode and rounding it was opened with, its tax table (`orderTaxRates`) and its freeze. */
export function pricingContextOf(o: typeof orders.$inferSelect, at: Date, taxRates: TaxRate[]): PricingContext {
  return PricingContextSchema.parse({
    tax_mode: o.taxMode,
    tax_rounding: o.taxRounding,
    tax_rates: taxRates,
    now: at.toISOString(),
    frozen: o.pricingFrozenAt ? { frozen_at: o.pricingFrozenAt.toISOString(), adjustments: o.frozenAdjustments ?? [] } : null,
  });
}

/** Later phases (checks/allocations) run after every re-price. */
const repriceHooks: ((orderId: string, result: PricingResult) => Promise<void>)[] = [];
export function registerRepriceHook(fn: (orderId: string, result: PricingResult) => Promise<void>) {
  repriceHooks.push(fn);
}

export async function loadSnapshot(orderId: string): Promise<OrderSnapshot> {
  const o = await getOrderRow(orderId);
  const [lines, adjs, adjLines, apps, extra] = await Promise.all([
    db().select().from(orderLines).where(eq(orderLines.orderId, orderId)).orderBy(asc(orderLines.sort), asc(orderLines.createdAt)),
    db().select().from(orderAdjustments).where(eq(orderAdjustments.orderId, orderId)).orderBy(asc(orderAdjustments.sort)),
    db().select({ adjustmentId: orderAdjustmentLines.adjustmentId, orderLineId: orderAdjustmentLines.orderLineId, amount: orderAdjustmentLines.amount, taxAmount: orderAdjustmentLines.taxAmount }).from(orderAdjustmentLines).innerJoin(orderAdjustments, eq(orderAdjustments.id, orderAdjustmentLines.adjustmentId)).where(eq(orderAdjustments.orderId, orderId)),
    db().select().from(orderManualApplications).where(and(eq(orderManualApplications.orderId, orderId), isNull(orderManualApplications.removedAt))),
    snapshotExtras(o),
  ]);
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
    totals: { tax_mode: o.taxMode, tax_rounding: o.taxRounding, subtotal: o.subtotal, discount_total: o.discountTotal, fee_total: o.feeTotal, tax_total: o.taxTotal, taxes: o.taxes, total: o.total },
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
      amounts: { base: l.baseAmount, discount: l.discountAmount, net: l.netAmount, fee: l.feeAmount, tax: l.taxAmount, total: l.total },
      taxes: l.taxes,
      tax_class_id: l.taxClassId,
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
      tax_class_id: a.taxClassId,
      total: a.total,
      tax_total: a.taxTotal,
      capped: a.capped,
      frozen: a.frozen,
      manual_application_id: a.manualApplicationId,
      entered_value: a.enteredValue,
      applied_by: a.appliedBy,
      approved_by: a.approvedBy,
      reason: a.reason,
      lines: adjLines.filter((x) => x.adjustmentId === a.id).map((x) => ({ line_id: x.orderLineId, amount: x.amount, tax_amount: x.taxAmount })),
    })),
    manual_applications: apps.map((a) => ({ id: a.id, rule_key: a.ruleKey, entered_value: a.enteredValue, line_ids: a.lineIds, applied_by: a.appliedByName, reason: a.reason })),
    ...extra,
  };
}

/** Later phases (checks, payments) register a provider for the payment part of the snapshot. */
type Extras = Pick<OrderSnapshot, "checks" | "paid_total" | "refunded_total" | "balance">;
let extrasProvider: (o: typeof orders.$inferSelect) => Promise<Extras> = async (o) => ({ checks: [], paid_total: 0, refunded_total: 0, balance: o.total });
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
