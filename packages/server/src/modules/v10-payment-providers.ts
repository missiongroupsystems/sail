import { registerRoutes } from "../app.js";
import { registerWorkerTask } from "../worker/index.js";
import { paymentIntentRoutes } from "../routes/payment-intents.js";
import { registerPaymentProvider } from "../payments/provider.js";
import { simulatorProvider } from "../payments/simulator.js";
import { drainPaymentOutbox, expireIntents, pollPendingIntents, pruneWebhookEvents } from "../services/payment-intents.js";
import { logger } from "../logger.js";

/** v0.10: payment providers. Terminal payments as intents, an outbox the worker drains, signed webhooks, and payments.void. */
registerRoutes(paymentIntentRoutes);
registerPaymentProvider(simulatorProvider);

registerWorkerTask({
  name: "payments.outbox",
  intervalMs: 1_000,
  run: async () => {
    await drainPaymentOutbox();
  },
});

/** Polling and expiry run on their own, so a provider that is down for polls never holds up an expiry, or the reverse. */
registerWorkerTask({
  name: "payments.poll_and_expire",
  intervalMs: 5_000,
  run: async () => {
    for (const [name, step] of [["poll", () => pollPendingIntents()], ["expire", () => expireIntents()], ["prune", () => pruneWebhookEvents()]] as const) {
      try {
        await step();
      } catch (e) {
        logger.error({ err: e, step: name }, "payments worker step failed");
      }
    }
  },
});
