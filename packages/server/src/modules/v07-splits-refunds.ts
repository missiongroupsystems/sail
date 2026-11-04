import { registerRoutes } from "../app.js";
import { splitRefundRoutes } from "../routes/splits-refunds.js";
import "../services/refunds.js"; // registers the Z-report refund totals provider

/** v0.7: bill splitting (even, by seat, by item with shared lines) and refunds with receipts and credit notes. */
registerRoutes(splitRefundRoutes);
