import { registerRoutes } from "../app.js";
import { registerWorkerTask } from "../worker/index.js";
import { guestRoutes } from "../routes/guest.js";
import { revokeStaleSessions } from "../services/guest.js";
import { withTransaction } from "../db/client.js";

/** v0.8: Scan to Order. Guests order to their table from their phones; staff accept, fire and charge at the POS. Guests never pay. */
registerRoutes(guestRoutes);

registerWorkerTask({
  name: "guest_sessions.revoke_stale",
  intervalMs: 60_000,
  run: async () => {
    await withTransaction(() => revokeStaleSessions());
  },
});
