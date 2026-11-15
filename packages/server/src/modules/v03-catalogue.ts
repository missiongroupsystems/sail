import { registerRoutes } from "../app.js";
import { registerWorkerTask } from "../worker/index.js";
import { availabilityDeleteRoute, catalogueRoutes } from "../routes/catalogue.js";
import { floorRoutes } from "../routes/floor.js";
import { customerRoutes } from "../routes/customers.js";
import { pricingRoutes } from "../routes/pricing.js";
import { taxRoutes } from "../routes/tax.js";
import { importRoutes } from "../routes/imports.js";
import { runQueuedImports } from "../services/importer.js";
import { withTransaction } from "../db/client.js";
import { activateDueRules } from "../services/pricing-rules.js";
import { appendEvent } from "../lib/events.js";
import { randomUUID } from "node:crypto";

/** v0.3: catalogue, menus, channels, floor, reference lists, customers, pricing configuration and the legacy importer. */
registerRoutes(catalogueRoutes);
registerRoutes(availabilityDeleteRoute);
registerRoutes(floorRoutes);
registerRoutes(customerRoutes);
registerRoutes(pricingRoutes);
registerRoutes(taxRoutes);
registerRoutes(importRoutes);

registerWorkerTask({
  name: "pricing_rules.activate_due",
  intervalMs: 30_000,
  run: async () => {
    await withTransaction(async () => {
      const due = await activateDueRules(new Date());
      for (const r of due) {
        await appendEvent({ merchantId: r.merchant_id, outletId: null, type: "pricing_rule.activated", aggregate: { kind: "pricing_rule", id: r.id, version: r.version }, operationId: "pricing_rules.activate", payload: { rule_key: r.rule_key, version: r.version }, correlationId: randomUUID() });
      }
    });
  },
});

registerWorkerTask({ name: "imports.run_queued", intervalMs: 5_000, run: async () => {
    await runQueuedImports();
  },
});
