import { registerRoutes } from "../app.js";
import { registerWorkerTask } from "../worker/index.js";
import { guestRoutes } from "../routes/guest.js";
import { pruneGuestRateHits, revokeStaleSessions } from "../services/guest.js";
import { db, withTransaction } from "../db/client.js";
import { and, eq } from "drizzle-orm";
import { guestRounds } from "../db/schema/index.js";
import { onCancel } from "../routes/orders.js";

/** v0.8: Scan to Order. Guests order to their table from their phones; staff accept, fire and charge at the POS. Guests never pay. */
registerRoutes(guestRoutes);

// A cancelled order has nothing left to accept: its waiting QR rounds are decided with it, so they leave the POS.
onCancel(async ({ order, principal }) => {
  await db()
    .update(guestRounds)
    .set({ status: "rejected", decidedAt: new Date(), decidedBy: principal.type === "staff" ? principal.id : null, decidedByName: "name" in principal ? principal.name : null, rejectReason: "Order cancelled" })
    .where(and(eq(guestRounds.orderId, order.id), eq(guestRounds.status, "pending")));
});

registerWorkerTask({
  name: "guest_sessions.revoke_stale",
  intervalMs: 60_000,
  run: async () => {
    await withTransaction(() => revokeStaleSessions());
    await pruneGuestRateHits();
  },
});
