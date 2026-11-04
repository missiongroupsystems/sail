import { registerRoutes } from "../app.js";
import { stationRoutes } from "../routes/stations.js";
import { orderRoutes } from "../routes/orders.js";

/** v0.4: stations and PIN sessions, manager overrides, orders, lines, manual adjustments, floor snapshot. */
registerRoutes(stationRoutes);
registerRoutes(orderRoutes);
