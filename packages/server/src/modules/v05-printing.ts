import { registerRoutes } from "../app.js";
import { registerWorkerTask } from "../worker/index.js";
import { printingRoutes } from "../routes/printing.js";
import { onFire, onVoid } from "../routes/orders.js";
import { createKitchenJobs, createVoidJobs, requeueStaleClaims } from "../services/printing.js";
import { withTransaction } from "../db/client.js";
import { appendEvent } from "../lib/events.js";
import { logger } from "../logger.js";
import { randomUUID } from "node:crypto";
import { lt, and, isNotNull, isNull } from "drizzle-orm";
import { printRelays } from "../db/schema/index.js";

/** v0.5: printers, relays, durable print jobs; tickets created in the same transaction as the fire or void. */
registerRoutes(printingRoutes);

onFire(async ({ order, lines, round, station, principal, correlationId }) => {
  const { warnings } = await createKitchenJobs({ order, lines, round, stationId: station?.id ?? null, principal, correlationId });
  return warnings;
});

onVoid(async ({ order, line, quantity, fired, principal, correlationId }) => {
  if (!fired) return;
  await createVoidJobs({ order, line, quantity, principal, correlationId });
});

registerWorkerTask({
  name: "print_jobs.requeue_stale",
  intervalMs: 15_000,
  run: async () => {
    const ids = await withTransaction(() => requeueStaleClaims());
    if (ids.length) logger.warn({ ids }, "re-queued stale print claims");
  },
});

/** Relay heartbeat alerts: a paired relay silent for 2 minutes gets a `relay.offline` event on its outlet (once per silence). */
const alerted = new Set<string>();
registerWorkerTask({
  name: "relays.heartbeat_alerts",
  intervalMs: 30_000,
  run: async () => {
    await withTransaction(async (t) => {
      const cutoff = new Date(Date.now() - 120_000);
      const silent = await t.db.select().from(printRelays).where(and(isNotNull(printRelays.tokenHash), isNull(printRelays.archivedAt), lt(printRelays.lastSeenAt, cutoff)));
      const silentIds = new Set(silent.map((r) => r.id));
      for (const r of silent) {
        if (alerted.has(r.id)) continue;
        alerted.add(r.id);
        await appendEvent({ merchantId: r.merchantId, outletId: r.outletId, type: "relay.offline", aggregate: { kind: "relay", id: r.id }, operationId: "relays.heartbeat_alerts", payload: { name: r.name, last_seen_at: r.lastSeenAt?.toISOString() ?? null }, correlationId: randomUUID() });
      }
      for (const id of [...alerted]) if (!silentIds.has(id)) alerted.delete(id);
    });
  },
});
