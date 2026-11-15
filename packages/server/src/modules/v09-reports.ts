import { registerRoutes } from "../app.js";
import { reportRoutes } from "../routes/reports.js";

/** v0.9: operational reports from the report_* views; CSV and PDF exports. */
registerRoutes(reportRoutes);
