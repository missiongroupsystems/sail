import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, isNotNull, isNull, notInArray, sql } from "drizzle-orm";
import { allocateLine, currencyExponent, sumTaxes, type BillDocument, type Share, type TaxAmount } from "@sail/shared";
import { assertNotSettled, db } from "../db/client.js";
import { brands, checkAllocations, checks, merchantSettings, orderAdjustmentLines, orderAdjustments, orderLines, orders, outlets, payments, tables } from "../db/schema/index.js";
import { AppError } from "../lib/errors.js";

/**
 * Checks (bills) and allocations. In v0.6 every order has one
 * check; the model already supports N checks and shares, which v0.7 uses for
 * splits. `syncAllocations` runs after every re-price: unlocked checks are
 * rebuilt from the current line components; a check with a payment is locked
 * and its allocations never change.
 */

export type CheckRow = typeof checks.$inferSelect;

export async function checksFor(orderId: string): Promise<CheckRow[]> {
  return db().select().from(checks).where(eq(checks.orderId, orderId)).orderBy(asc(checks.index));
}

export async function ensureFirstCheck(order: { id: string; merchantId: string; outletId: string }): Promise<CheckRow[]> {
  const existing = await checksFor(order.id);
  if (existing.length) return existing;
  const [row] = await db().insert(checks).values({ id: randomUUID(), merchantId: order.merchantId, outletId: order.outletId, orderId: order.id, index: 1, label: "Bill 1" }).returning();
  return [row!];
}

type LineComp = { id: string; base: number; discount: number; fee: number; taxes: TaxAmount[]; total: number; adjustments: Record<string, { amount: number; tax: number }> };

async function lineComponents(orderId: string): Promise<LineComp[]> {
  const [lines, adjLines] = await Promise.all([
    db().select().from(orderLines).where(and(eq(orderLines.orderId, orderId), sql`${orderLines.status} <> 'voided'`)).orderBy(asc(orderLines.sort), asc(orderLines.createdAt)),
    db().select({ adjustmentId: orderAdjustmentLines.adjustmentId, orderLineId: orderAdjustmentLines.orderLineId, amount: orderAdjustmentLines.amount, taxAmount: orderAdjustmentLines.taxAmount }).from(orderAdjustmentLines).innerJoin(orderAdjustments, eq(orderAdjustments.id, orderAdjustmentLines.adjustmentId)).where(eq(orderAdjustments.orderId, orderId)),
  ]);
  return lines.map((l) => ({
    id: l.id,
    base: l.baseAmount,
    discount: l.discountAmount,
    fee: l.feeAmount,
    taxes: l.taxes.map((t) => ({ name: t.name, bps: t.bps, amount: t.amount })),
    total: l.total,
    adjustments: Object.fromEntries(adjLines.filter((a) => a.orderLineId === l.id).map((a) => [a.adjustmentId, { amount: a.amount, tax: a.taxAmount }])),
  }));
}

/**
 * Rebuild allocations for unlocked checks from the current pricing. Lines with
 * no allocation yet go to the first unlocked check (a new one when every check
 * is locked). Empty bills are kept (staff add an empty bill, then move items
 * onto it); re-splitting or unsplitting replaces the set. Returns the checks
 * after the sync.
 */
export async function syncAllocations(orderId: string, opts: { sharesByLine?: Map<string, Share[]> } = {}): Promise<CheckRow[]> {
  assertNotSettled("syncAllocations");
  const [order] = await db().select().from(orders).where(eq(orders.id, orderId)).limit(1);
  if (!order) throw AppError.notFound("order", orderId);
  let chks = await ensureFirstCheck(order);
  const [comps, existing] = await Promise.all([lineComponents(orderId), db().select().from(checkAllocations).where(inArray(checkAllocations.checkId, chks.map((c) => c.id)))]);
  const lockedIds = new Set(chks.filter((c) => c.lockedAt).map((c) => c.id));
  const taxAdds = order.taxMode === "exclusive";

  // Lines whose allocations include a locked check are fixed.
  const fixedLines = new Set(existing.filter((a) => lockedIds.has(a.checkId)).map((a) => a.orderLineId));

  // Target for lines with no allocations: the first unlocked check, else a new one.
  let target = chks.find((c) => !c.lockedAt);
  const unallocated = comps.filter((l) => !existing.some((a) => a.orderLineId === l.id) && !opts.sharesByLine?.has(l.id));
  if (unallocated.length && !target) {
    const index = chks.length + 1;
    const [row] = await db().insert(checks).values({ id: randomUUID(), merchantId: order.merchantId, outletId: order.outletId, orderId, index, label: `Bill ${index}` }).returning();
    chks = [...chks, row!];
    target = row!;
  }

  // Shares per line across the ordered checks.
  const sharesFor = (line: LineComp): Share[] => {
    const given = opts.sharesByLine?.get(line.id);
    if (given) return given;
    const mine = existing.filter((a) => a.orderLineId === line.id);
    if (mine.length === 0) return chks.map((c) => (c.id === target!.id ? { num: 1, den: 1 } : { num: 0, den: 1 }));
    return chks.map((c) => {
      const a = mine.find((x) => x.checkId === c.id);
      return a ? { num: a.shareNum, den: a.shareDen } : { num: 0, den: 1 };
    });
  };

  const unlockedCheckIds = chks.filter((c) => !c.lockedAt).map((c) => c.id);
  if (unlockedCheckIds.length) {
    // Every allocation on an unlocked check that is not pinned by a paid bill is rebuilt from scratch (this also drops voided lines).
    const rebuilt = comps.filter((l) => !fixedLines.has(l.id));
    const fixed = [...fixedLines];
    await db().delete(checkAllocations).where(and(inArray(checkAllocations.checkId, unlockedCheckIds), fixed.length ? notInArray(checkAllocations.orderLineId, fixed) : sql`true`));
    // One balance for the whole split: each line's odd cents go to the bill that has had the fewest, so even bills stay within a cent.
    const balance = chks.map(() => 0);
    const values = rebuilt.flatMap((line) => {
      const shares = sharesFor(line);
      const parts = allocateLine({ base: line.base, discount: line.discount, fee: line.fee, taxes: line.taxes, adjustments: line.adjustments }, shares, { taxAddsToTotal: taxAdds, balance });
      return chks
        .map((c, i) => ({ c, p: parts[i]!, s: shares[i]! }))
        .filter(({ s }) => s.num > 0)
        .map(({ c, p, s }) => ({ merchantId: order.merchantId, checkId: c.id, orderLineId: line.id, shareNum: s.num, shareDen: s.den, base: p.base, discount: p.discount, fee: p.fee, tax: p.tax, taxes: p.taxes, total: p.total, adjustments: p.adjustments }));
    });
    if (values.length) await db().insert(checkAllocations).values(values);
  }

  // Recompute totals for unlocked checks from their allocations (tax by component is added up in code).
  const allocs = unlockedCheckIds.length ? await db().select({ checkId: checkAllocations.checkId, base: checkAllocations.base, discount: checkAllocations.discount, fee: checkAllocations.fee, tax: checkAllocations.tax, taxes: checkAllocations.taxes, total: checkAllocations.total }).from(checkAllocations).where(inArray(checkAllocations.checkId, unlockedCheckIds)) : [];
  const sums = unlockedCheckIds.map((checkId) => {
    const mine = allocs.filter((a) => a.checkId === checkId);
    const add = (k: "base" | "discount" | "fee" | "tax" | "total") => mine.reduce((s, a) => s + a[k], 0);
    return { checkId, base: add("base"), discount: add("discount"), fee: add("fee"), tax: add("tax"), taxes: sumTaxes(mine.map((a) => a.taxes)), total: add("total") };
  });
  const now = new Date();
  const refreshed: CheckRow[] = [];
  for (const c of chks) {
    if (c.lockedAt) {
      refreshed.push(c);
      continue;
    }
    const s = sums.find((x) => x.checkId === c.id)!;
    if (s.base === c.subtotal && s.discount === c.discountTotal && s.fee === c.feeTotal && s.tax === c.taxTotal && s.total === c.total && JSON.stringify(s.taxes) === JSON.stringify(c.taxes)) {
      refreshed.push(c);
      continue;
    }
    const [row] = await db()
      .update(checks)
      .set({ subtotal: s.base, discountTotal: s.discount, feeTotal: s.fee, taxTotal: s.tax, taxes: s.taxes, total: s.total, status: s.total === 0 && c.paidTotal === 0 ? "open" : c.status, updatedAt: now })
      .where(eq(checks.id, c.id))
      .returning();
    refreshed.push(row!);
  }
  return refreshed;
}

/** Manual adjustments with a stored amount on a paid bill's line cannot be removed: refund the bill instead. */
export async function assertAdjustmentUnlocked(orderId: string, applicationId: string) {
  const [row] = await db()
    .select({ label: checks.label })
    .from(orderAdjustments)
    .innerJoin(orderAdjustmentLines, eq(orderAdjustmentLines.adjustmentId, orderAdjustments.id))
    .innerJoin(checkAllocations, eq(checkAllocations.orderLineId, orderAdjustmentLines.orderLineId))
    .innerJoin(checks, eq(checks.id, checkAllocations.checkId))
    .where(and(eq(orderAdjustments.orderId, orderId), eq(orderAdjustments.manualApplicationId, applicationId), isNotNull(checks.lockedAt)))
    .limit(1);
  if (row) throw AppError.invariant("check_locked_by_payment", `${row.label} is paid and includes this discount`, `Refund ${row.label} to change it.`);
}

/** Sum of recorded payments on the order (for pay-before-firing and change-type guards). */
export async function paidTotalFor(orderId: string): Promise<number> {
  const [row] = await db().select({ s: sql<number>`coalesce(sum(amount),0)::int` }).from(payments).where(and(eq(payments.orderId, orderId), eq(payments.status, "recorded")));
  return row?.s ?? 0;
}

/** A line on a locked (paid) check cannot be changed or voided; refund it instead. */
export async function assertLineUnlocked(lineId: string) {
  const [row] = await db()
    .select({ label: checks.label })
    .from(checkAllocations)
    .innerJoin(checks, eq(checks.id, checkAllocations.checkId))
    .where(and(eq(checkAllocations.orderLineId, lineId), isNotNull(checks.lockedAt)))
    .limit(1);
  if (row) throw AppError.invariant("check_locked_by_payment", `${row.label} is paid`, `Refund ${row.label} to change this item.`);
}

export type CheckSnapshot = {
  id: string;
  index: number;
  label: string;
  status: string;
  seat_no: number | null;
  totals: { subtotal: number; discount_total: number; fee_total: number; tax_total: number; taxes: TaxAmount[]; total: number };
  paid_total: number;
  rounding_total: number;
  refunded_total: number;
  balance: number;
  locked: boolean;
  invoice_no: string | null;
  allocations: { line_id: string; share: string; base: number; discount: number; fee: number; tax: number; taxes: TaxAmount[]; total: number }[];
  payments: { id: string; tender_type_id: string; tender: string; is_cash: boolean; amount: number; rounding_cents: number; tendered: number | null; change_cents: number; tip_cents: number; reference: string | null; status: string; recorded_by: string | null; created_at: string }[];
};

export async function checkSnapshots(orderId: string): Promise<CheckSnapshot[]> {
  const chks = await checksFor(orderId);
  if (chks.length === 0) return [];
  const ids = chks.map((c) => c.id);
  const [allocs, pays] = await Promise.all([db().select().from(checkAllocations).where(inArray(checkAllocations.checkId, ids)), db().select().from(payments).where(inArray(payments.checkId, ids)).orderBy(asc(payments.createdAt))]);
  return chks.map((c) => ({
    id: c.id,
    index: c.index,
    label: c.label,
    status: c.status,
    seat_no: c.seatNo,
    totals: { subtotal: c.subtotal, discount_total: c.discountTotal, fee_total: c.feeTotal, tax_total: c.taxTotal, taxes: c.taxes, total: c.total },
    paid_total: c.paidTotal,
    rounding_total: c.roundingTotal,
    refunded_total: c.refundedTotal,
    balance: c.total - c.paidTotal,
    locked: c.lockedAt != null,
    invoice_no: c.invoiceNo,
    allocations: allocs.filter((a) => a.checkId === c.id).map((a) => ({ line_id: a.orderLineId, share: a.shareNum === a.shareDen ? "1" : `${a.shareNum}/${a.shareDen}`, base: a.base, discount: a.discount, fee: a.fee, tax: a.tax, taxes: a.taxes, total: a.total })),
    payments: pays.filter((p) => p.checkId === c.id).map((p) => ({ id: p.id, tender_type_id: p.tenderTypeId, tender: p.tenderName, is_cash: p.isCash, amount: p.amount, rounding_cents: p.roundingCents, tendered: p.tendered, change_cents: p.changeCents, tip_cents: p.tipCents, reference: p.reference, status: p.status, recorded_by: p.recordedByName, created_at: p.createdAt.toISOString() })),
  }));
}

/** Build the bill document (pre-bill, receipt) for one check from stored data. */
export async function billDocumentFor(checkId: string, kind: "prebill" | "receipt", extra: { jobId?: string; stationName?: string | null; serverName?: string | null; digitalReceiptUrl?: string } = {}): Promise<BillDocument> {
  const [c] = await db().select().from(checks).where(eq(checks.id, checkId)).limit(1);
  if (!c) throw AppError.notFound("check", checkId);
  const [o] = await db().select().from(orders).where(eq(orders.id, c.orderId)).limit(1);
  if (!o) throw AppError.notFound("order", c.orderId);
  const [outlet] = await db().select().from(outlets).where(eq(outlets.id, o.outletId)).limit(1);
  const [brand] = await db().select().from(brands).where(eq(brands.id, o.brandId)).limit(1);
  const [settings] = await db().select().from(merchantSettings).where(eq(merchantSettings.merchantId, o.merchantId)).limit(1);
  if (!settings) throw AppError.notFound("merchant settings", o.merchantId);
  const table = o.tableId ? (await db().select({ name: tables.name }).from(tables).where(eq(tables.id, o.tableId)).limit(1))[0] : null;
  const allocs = await db().select().from(checkAllocations).where(eq(checkAllocations.checkId, checkId));
  const lines = allocs.length ? await db().select().from(orderLines).where(inArray(orderLines.id, allocs.map((a) => a.orderLineId))).orderBy(asc(orderLines.sort)) : [];
  const adjs = await db().select().from(orderAdjustments).where(eq(orderAdjustments.orderId, o.id)).orderBy(asc(orderAdjustments.sort));
  const pays = await db().select().from(payments).where(and(eq(payments.checkId, checkId), eq(payments.status, "recorded"))).orderBy(asc(payments.createdAt));
  const allChecks = await checksFor(o.id);

  const adjustmentTotals = new Map<string, number>();
  for (const a of allocs) for (const [adjId, v] of Object.entries(a.adjustments)) adjustmentTotals.set(adjId, (adjustmentTotals.get(adjId) ?? 0) + v.amount);

  return {
    header: {
      outlet_name: outlet?.name ?? "Outlet",
      brand_name: brand?.name ?? "Brand",
      order_no: o.orderNo,
      order_type: o.orderType as BillDocument["header"]["order_type"],
      table_name: table?.name,
      pax: o.pax ?? undefined,
      customer_ref: o.customerRef ?? undefined,
      server_name: extra.serverName ?? o.openedByName ?? undefined,
      station_name: extra.stationName ?? undefined,
      printed_at: new Date().toISOString(),
      job_id: extra.jobId ?? "pending",
      time_zone: settings.timezone,
      locale: settings.locale,
    },
    kind,
    currency: settings.currency,
    currency_exponent: currencyExponent(settings.currency),
    check_label: allChecks.length > 1 ? `${c.label} of ${allChecks.length}` : c.label,
    lines: lines.map((l) => {
      const a = allocs.find((x) => x.orderLineId === l.id)!;
      return { quantity: l.quantity, name: l.name, unit_price: l.unitPrice, amount: a.base, modifiers: l.modifiers.map((m) => ({ name: m.quantity > 1 ? `${m.quantity}× ${m.name}` : m.name, price: m.price * m.quantity * l.quantity })), seat_no: l.seatNo ?? undefined, share: a.shareNum === a.shareDen ? undefined : `${a.shareNum}/${a.shareDen}` };
    }),
    adjustments: adjs.filter((a) => (adjustmentTotals.get(a.id) ?? 0) !== 0).map((a) => ({ name: a.name, amount: adjustmentTotals.get(a.id)!, kind: a.kind as "fee" | "discount" })),
    totals: { subtotal: c.subtotal, discount_total: c.discountTotal, fee_total: c.feeTotal, tax_total: c.taxTotal, taxes: c.taxes, total: c.total, tax_mode: o.taxMode as "inclusive" | "exclusive" },
    payments: kind === "receipt" ? pays.map((p) => ({ tender: p.tenderName, amount: p.amount, rounding_cents: p.roundingCents || undefined, reference: p.reference ?? undefined, tip: p.tipCents || undefined, change: p.changeCents || undefined })) : undefined,
    balance: c.total - c.paidTotal > 0 ? c.total - c.paidTotal : undefined,
    invoice_no: c.invoiceNo ?? undefined,
    footer_lines: settings.receiptFooter ? settings.receiptFooter.split("\n") : undefined,
    outlet_phone: settings.receiptShowOutletPhone && outlet?.phone ? outlet.phone : undefined,
    ...registrations(settings, outlet),
    digital_receipt_url: extra.digitalReceiptUrl,
  };
}

/** The outlet's registration numbers as printed, each after the merchant's label for it. */
export function registrations(settings: typeof merchantSettings.$inferSelect, outlet: typeof outlets.$inferSelect | undefined): Pick<BillDocument, "business_registration" | "tax_registration"> {
  return {
    business_registration: outlet?.businessRegistrationNo ? { label: settings.businessRegistrationLabel, value: outlet.businessRegistrationNo } : undefined,
    tax_registration: outlet?.taxRegistrationNo ? { label: settings.taxRegistrationLabel, value: outlet.taxRegistrationNo } : undefined,
  };
}

export { isNull };
