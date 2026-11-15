import { registerRoutes } from "../app.js";
import { kitchenRoutes } from "../routes/kitchen.js";
import { onCancel, onVoid } from "../routes/orders.js";
import { cancelOrderTickets, strikeVoidedLine } from "../services/kitchen.js";

/**
 * Kitchen display: destinations, tickets and the display's operations. Tickets are created with the print jobs
 * (services/printing.ts createKitchenJobs); later voids and cancels change them in the same transaction.
 */
registerRoutes(kitchenRoutes);

onVoid(async ({ order, line, quantity, fired, principal, correlationId }) => {
  if (!fired) return;
  await strikeVoidedLine({ order, lineId: line.id, quantity, principal, correlationId, operationId: "lines.void" });
});

onCancel(async ({ order, principal, correlationId, idempotencyKey }) => {
  await cancelOrderTickets({ order, principal, correlationId, idempotencyKey, operationId: "orders.cancel" });
});
