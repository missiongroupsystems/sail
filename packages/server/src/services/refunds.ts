import { and, eq, inArray, sql } from "drizzle-orm";
import { formatMoney, quoteRefund, RefundError, sumTaxes, type BillDocument, type MoneyFormat, type RefundQuote, type RefundRequest, type RefundableLine, type RefundablePayment } from "@sail/shared";
import { db } from "../db/client.js";
import { checkAllocations, checks, merchantSettings, orderAdjustments, orderLines, orders, payments, refundLines, refundTenders, refunds } from "../db/schema/index.js";
import { AppError } from "../lib/errors.js";
import type { Principal } from "../auth/principal.js";
import { billDocumentFor } from "./checks.js";
import { nextDocumentNo, type InvoiceDocument } from "./documents.js";
import { currentBusinessDate } from "./business-day.js";
import { openShiftFor } from "./payments.js";
import { registerRefundTotals } from "./shifts.js";

/**
 * Refunds: quote with the pure reversal, then record the refund,
 * its lines and tenders, the refund receipt number and, for invoiced checks,
 * the credit note. Refunds count on the business day they happen and never
 * restore daily caps. A whole-bill refund also gives back each payment's tip.
 */
export async function refundableFor(checkId: string): Promise<{ check: typeof checks.$inferSelect; order: typeof orders.$inferSelect; lines: RefundableLine[]; lineNames: Map<string, string>; paymentsList: RefundablePayment[]; increment: number | null; money: MoneyFormat }> {
  const [check] = await db().select().from(checks).where(eq(checks.id, checkId)).limit(1);
  if (!check) throw AppError.notFound("bill", checkId);
  const [order] = await db().select().from(orders).where(eq(orders.id, check.orderId)).limit(1);
  if (!order) throw AppError.notFound("order", check.orderId);
  if (!check.lockedAt) throw AppError.state(`${check.label} has no payment to refund`, [], "Refunds reverse payments; this bill is unpaid.");
  const allocs = await db().select().from(checkAllocations).where(eq(checkAllocations.checkId, checkId));
  const lineRows = allocs.length ? await db().select().from(orderLines).where(inArray(orderLines.id, allocs.map((a) => a.orderLineId))) : [];
  const priorRefunds = await db().select({ id: refunds.id }).from(refunds).where(eq(refunds.checkId, checkId));
  const prior = priorRefunds.length ? await db().select().from(refundLines).where(inArray(refundLines.refundId, priorRefunds.map((r) => r.id))) : [];
  const priorTenders = priorRefunds.length ? await db().select().from(refundTenders).where(inArray(refundTenders.refundId, priorRefunds.map((r) => r.id))) : [];
  const lines: RefundableLine[] = allocs.map((a) => {
    const l = lineRows.find((x) => x.id === a.orderLineId)!;
    const mine = prior.filter((p) => p.orderLineId === a.orderLineId);
    const sum = (k: "base" | "discount" | "fee" | "total" | "quantity") => mine.reduce((s, p) => s + p[k], 0);
    return { line_id: a.orderLineId, quantity: l.quantity, base: a.base, discount: a.discount, fee: a.fee, taxes: a.taxes, total: a.total, adjustments: a.adjustments, refunded: { quantity: sum("quantity"), base: sum("base"), discount: sum("discount"), fee: sum("fee"), taxes: sumTaxes(mine.map((p) => p.taxes)), total: sum("total") } };
  });
  const pays = await db().select().from(payments).where(and(eq(payments.checkId, checkId), eq(payments.status, "recorded")));
  const paymentsList: RefundablePayment[] = pays.map((p) => {
    const prior = priorTenders.filter((t) => t.paymentId === p.id);
    return { payment_id: p.id, tender: p.tenderName, is_cash: p.isCash, amount: p.amount, rounding: p.roundingCents, refunded: prior.reduce((s, t) => s + t.amount, 0), refunded_rounding: prior.reduce((s, t) => s + t.roundingCents, 0), tip: p.tipCents, refunded_tip: prior.reduce((s, t) => s + t.tipCents, 0) };
  });
  const [settings] = await db().select().from(merchantSettings).where(eq(merchantSettings.merchantId, check.merchantId)).limit(1);
  if (!settings) throw AppError.notFound("merchant settings", check.merchantId);
  return { check, order, lines, lineNames: new Map(lineRows.map((l) => [l.id, l.name])), paymentsList, increment: settings.cashRoundingIncrement ?? null, money: { currency: settings.currency, locale: settings.locale } };
}

export function quote(ref: Awaited<ReturnType<typeof refundableFor>>, request: RefundRequest, tenderSplit?: { payment_id: string; amount: number }[]): RefundQuote {
  const money = (amount: number) => formatMoney(amount, ref.money);
  try {
    return quoteRefund(ref.lines, ref.paymentsList, request, { tenderSplit, cashRoundingIncrement: ref.increment, formatMoney: money });
  } catch (e) {
    if (e instanceof RefundError) {
      const code = e.code === "exceeds_line" || e.code === "exceeds_payment" || e.code === "nothing_to_refund" ? "invariant_violation" : "validation";
      const { message, remedy } = refundErrorText(e, ref.lineNames, money);
      throw new AppError(code, message, { remedy, details: { refund_error: e.code, ...e.details } });
    }
    throw e;
  }
}

/** What went wrong and what to do instead, in the merchant's currency. */
function refundErrorText(e: RefundError, names: Map<string, string>, money: (amount: number) => string): { message: string; remedy?: string } {
  const d = e.details as { line_id?: string; quantity?: number; remaining_quantity?: number; refundable?: number };
  if (e.code === "exceeds_line" && d.remaining_quantity !== undefined) {
    const name = names.get(d.line_id ?? "") ?? "This item";
    if (d.remaining_quantity === 0) return { message: `${name} has already been refunded`, remedy: "Pick another item, or refund by amount." };
    return { message: `Only ${d.remaining_quantity} of ${d.quantity} ${name} can still be refunded`, remedy: `Refund ${d.remaining_quantity} or fewer.` };
  }
  if (e.code === "exceeds_line" && d.refundable !== undefined) return { message: `Only ${money(d.refundable)} can still be refunded on this bill`, remedy: `Enter ${money(d.refundable)} or less.` };
  if (e.code === "exceeds_payment") return { message: `${e.message.charAt(0).toUpperCase()}${e.message.slice(1)}`, remedy: "Reduce the refund, or split it across the original payments." };
  if (e.code === "tender_mismatch") return { message: `${e.message.charAt(0).toUpperCase()}${e.message.slice(1)}`, remedy: "Make the amounts for each payment add up to the refund." };
  return { message: e.message };
}

export type CreatedRefund = { refund: typeof refunds.$inferSelect; quote: RefundQuote; receipt: BillDocument; creditNote: InvoiceDocument | null };

export async function createRefund(input: { refundId: string; checkId: string; request: RefundRequest; tenderSplit?: { payment_id: string; amount: number }[]; reason: string; reference?: string | null; principal: Principal; approver?: { id: string; name: string | null } | null; overrideId?: string | null; stationId?: string | null }): Promise<CreatedRefund> {
  const ref = await refundableFor(input.checkId);
  const q = quote(ref, input.request, input.tenderSplit);
  const now = new Date();
  const [openShift] = await openShiftFor(ref.order.outletId, input.stationId ?? null);
  // Cash comes out of a drawer; with no shift open it would leave no drawer short. A refund counts on its shift's day.
  if (q.tenders.some((t) => t.is_cash && t.amount + t.rounding_cents + t.tip_cents !== 0) && !openShift) throw AppError.invariant("no_open_shift", "No shift is open here to pay cash out of", "Open a shift first.");
  const businessDate = openShift?.businessDate ?? (await currentBusinessDate(ref.order.merchantId, ref.order.outletId, now));
  const receiptNo = await nextDocumentNo(ref.order.merchantId, "refund_receipt");
  // A credit note corrects the invoice; a refund of only the tip changes nothing the invoice holds, so it gets none.
  const creditNoteNo = ref.check.invoiceNo && q.totals.total > 0 ? await nextDocumentNo(ref.order.merchantId, "credit_note") : null;

  // Documents: a refund receipt linked to the original bill, and a credit note when the bill was invoiced.
  const original = await billDocumentFor(input.checkId, "receipt", { serverName: "name" in input.principal ? input.principal.name : null });
  const lineRows = await db().select().from(orderLines).where(inArray(orderLines.id, q.lines.map((l) => l.line_id)));
  const adjRows = await db().select().from(orderAdjustments).where(eq(orderAdjustments.orderId, ref.order.id));
  const adjTotals = new Map<string, number>();
  for (const l of q.lines) for (const [id, a] of Object.entries(l.adjustments)) adjTotals.set(id, (adjTotals.get(id) ?? 0) + a.amount);
  const receipt: BillDocument = {
    ...original,
    kind: "refund_receipt",
    header: { ...original.header, printed_at: now.toISOString(), job_id: "pending" },
    check_label: `Refund ${receiptNo} · ${original.check_label}`,
    lines: q.lines.map((l) => {
      const row = lineRows.find((x) => x.id === l.line_id)!;
      return { quantity: -(l.quantity || row.quantity), name: l.quantity ? row.name : `${row.name} (partial)`, unit_price: row.unitPrice, amount: -l.base, modifiers: [], seat_no: row.seatNo ?? undefined };
    }),
    adjustments: adjRows.filter((a) => (adjTotals.get(a.id) ?? 0) !== 0).map((a) => ({ name: a.name, amount: -(adjTotals.get(a.id) ?? 0), kind: a.kind as "fee" | "discount" })),
    totals: { ...original.totals, subtotal: -q.totals.base, discount_total: -q.totals.discount, fee_total: -q.totals.fee, tax_total: -q.totals.tax, taxes: q.totals.taxes.map((t) => ({ ...t, amount: -t.amount })), total: -q.totals.total },
    payments: q.tenders.map((t) => ({ tender: t.tender, amount: -t.amount, rounding_cents: t.rounding_cents ? -t.rounding_cents : undefined, tip: t.tip_cents ? -t.tip_cents : undefined, reference: input.reference ?? undefined })),
    balance: undefined,
    original_check_no: original.header.order_no + " · " + original.check_label,
    original_date: ref.check.paidAt?.toISOString() ?? ref.check.createdAt.toISOString(),
    refund_reason: input.reason,
    credit_note_no: creditNoteNo ?? undefined,
    invoice_no: ref.check.invoiceNo ?? undefined,
  };
  const creditNote: InvoiceDocument | null = creditNoteNo ? { ...receipt, kind: "refund_receipt", invoice_no: ref.check.invoiceNo ?? undefined, invoice: { ...(ref.check.invoiceDocument as InvoiceDocument).invoice, number: creditNoteNo, issued_at: now.toISOString() } } : null;

  const [refund] = await db()
    .insert(refunds)
    .values({
      id: input.refundId,
      merchantId: ref.order.merchantId,
      outletId: ref.order.outletId,
      orderId: ref.order.id,
      checkId: input.checkId,
      kind: input.request.kind,
      reason: input.reason,
      refundedBy: input.principal.type === "staff" ? input.principal.id : null,
      refundedByName: "name" in input.principal ? input.principal.name : null,
      approvedBy: input.approver?.id ?? null,
      approvedByName: input.approver?.name ?? null,
      overrideId: input.overrideId ?? null,
      stationId: input.stationId ?? null,
      shiftId: openShift?.id ?? null,
      businessDate,
      base: q.totals.base,
      discount: q.totals.discount,
      fee: q.totals.fee,
      tax: q.totals.tax,
      taxes: q.totals.taxes,
      total: q.totals.total,
      tip: q.tip,
      refundReceiptNo: receiptNo,
      creditNoteNo,
      receiptDocument: receipt,
      creditNoteDocument: creditNote,
    })
    .returning();
  // A refund of only the tip (the bill was given back before) has no lines.
  if (q.lines.length) await db().insert(refundLines).values(q.lines.map((l) => ({ merchantId: ref.order.merchantId, refundId: refund!.id, orderLineId: l.line_id, quantity: l.quantity, base: l.base, discount: l.discount, fee: l.fee, tax: l.tax, taxes: l.taxes, total: l.total, adjustments: l.adjustments })));
  await db().insert(refundTenders).values(q.tenders.map((t) => ({ merchantId: ref.order.merchantId, refundId: refund!.id, paymentId: t.payment_id, tenderName: t.tender, isCash: t.is_cash, amount: t.amount, roundingCents: t.rounding_cents, tipCents: t.tip_cents, reference: input.reference ?? null })));
  const newRefunded = ref.check.refundedTotal + q.totals.total;
  // Refunded means nothing is left to give back: the whole bill and every tip taken with it.
  const tipsLeft = ref.paymentsList.reduce((s, p) => s + (p.tip ?? 0) - (p.refunded_tip ?? 0), 0) - q.tip;
  await db().update(checks).set({ refundedTotal: newRefunded, status: newRefunded >= ref.check.total && tipsLeft <= 0 ? "refunded" : "partially_refunded", updatedAt: now }).where(eq(checks.id, input.checkId));
  return { refund: refund!, quote: q, receipt, creditNote };
}

// Z-report and shift close: refunds on the business day (or shift), with the cash portion (cash tips given back included).
registerRefundTotals(async (scope) => {
  const where = and(eq(refunds.outletId, scope.outletId), scope.shiftId ? eq(refunds.shiftId, scope.shiftId) : eq(refunds.businessDate, scope.businessDate), scope.stationId && !scope.shiftId ? eq(refunds.stationId, scope.stationId) : sql`true`);
  const [r] = await db()
    .select({ count: sql<number>`count(*)::int`, amount: sql<number>`coalesce(sum(${refunds.total}),0)::bigint`, tax: sql<number>`coalesce(sum(${refunds.tax}),0)::bigint`, tips: sql<number>`coalesce(sum(${refunds.tip}),0)::bigint`, net: sql<number>`coalesce(sum((select n.net from report_refunds n where n.refund_id = ${refunds.id})),0)::bigint` })
    .from(refunds)
    .where(where);
  const [cash] = await db()
    .select({ amount: sql<number>`coalesce(sum(${refundTenders.amount} + ${refundTenders.roundingCents} + ${refundTenders.tipCents}),0)::bigint` })
    .from(refundTenders)
    .innerJoin(refunds, eq(refunds.id, refundTenders.refundId))
    // For a day's drawer figures, only the cash given back out of the named (closed) shifts.
    .where(and(scope.cashShiftIds?.length ? and(eq(refunds.outletId, scope.outletId), inArray(refunds.shiftId, scope.cashShiftIds)) : where, eq(refundTenders.isCash, true)));
  const taxes = await db()
    .select({ name: sql<string>`t->>'name'`, bps: sql<number>`(t->>'bps')::int`, amount: sql<number>`coalesce(sum((t->>'amount')::bigint),0)::bigint` })
    .from(sql`${refunds} cross join lateral jsonb_array_elements(${refunds.taxes}) t`)
    .where(where)
    .groupBy(sql`1`, sql`2`)
    .orderBy(sql`2 desc`, sql`1`);
  return { count: r?.count ?? 0, amount: r?.amount ?? 0, net: r?.net ?? 0, tax: r?.tax ?? 0, tips: r?.tips ?? 0, cash_amount: cash?.amount ?? 0, taxes };
});
