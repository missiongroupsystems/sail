import { registerRoutes } from "../app.js";
import { paymentRoutes } from "../routes/payments.js";
import { registerPaidLineGuard } from "../routes/orders.js";
import { registerPaidProvider, registerRepriceHook, registerSnapshotExtras } from "../services/orders.js";
import { assertLineUnlocked, checkSnapshots, paidTotalFor, syncAllocations } from "../services/checks.js";

/** v0.6: checks and allocations, payments with cash rounding and the pricing freeze, receipts, invoices, shifts and the basic Z-report. */
registerRoutes(paymentRoutes);

// After every re-price the single (or split) checks are rebuilt from the line components.
registerRepriceHook(async (orderId) => {
  await syncAllocations(orderId);
});
registerPaidProvider(paidTotalFor);
registerPaidLineGuard(assertLineUnlocked);
registerSnapshotExtras(async (o) => {
  const checks = await checkSnapshots(o.id);
  const paid = checks.reduce((s, c) => s + c.paid_total, 0);
  const total = checks.reduce((s, c) => s + c.totals.total, 0);
  return { checks, paid_total: paid, balance: total - paid };
});
