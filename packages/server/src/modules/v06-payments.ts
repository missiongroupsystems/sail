import { registerRoutes } from "../app.js";
import { paymentRoutes } from "../routes/payments.js";
import { registerPaidProvider, registerRepriceHook, registerSnapshotExtras } from "../services/orders.js";
import { and, eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { orderLines } from "../db/schema/index.js";
import { checkSnapshots, paidTotalFor, syncAllocations } from "../services/checks.js";

/** v0.6: checks and allocations, payments with cash rounding and the pricing freeze, receipts, invoices, shifts and the basic Z-report. */
registerRoutes(paymentRoutes);

// After every re-price the single (or split) checks are rebuilt from the line components.
registerRepriceHook(async (orderId) => {
  await syncAllocations(orderId);
});
registerPaidProvider(paidTotalFor);
registerSnapshotExtras(async (o) => {
  const checks = await checkSnapshots(o.id);
  const paid = checks.reduce((s, c) => s + c.paid_total, 0);
  const refunded = checks.reduce((s, c) => s + c.refunded_total, 0);
  // Signed: what the guest still owes on the bills, less what was taken beyond the order's total and not yet given back
  // (a negative balance is money owed to the guest; it is never applied to later items on its own).
  // Per bill: what is still owed on it, and what was taken on it beyond its live items (a line voided after it was paid,
  // as a QR round rejected before the fix that keeps waiting rounds off bills) less what was given back.
  const voided = new Set((await db().select({ id: orderLines.id }).from(orderLines).where(and(eq(orderLines.orderId, o.id), eq(orderLines.status, "voided")))).map((r) => r.id));
  const unpaid = checks.reduce((s, c) => s + Math.max(0, c.totals.total - c.paid_total), 0);
  const owedToGuest = checks.reduce((s, c) => {
    const live = c.allocations.filter((a) => !voided.has(a.line_id)).reduce((n, a) => n + a.total, 0);
    return s + Math.max(0, c.paid_total - c.refunded_total - live);
  }, 0);
  return { checks, paid_total: paid, refunded_total: refunded, balance: unpaid - owedToGuest };
});
