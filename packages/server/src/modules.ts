/**
 * Phase modules. Each later phase adds an import here; importing a module
 * registers its routes, principal resolvers, manifest operations and worker
 * tasks. Keeping registration explicit makes the walking skeleton small and
 * the build order (roadmap) visible.
 */
import "./modules/v03-catalogue.js";
import "./modules/v04-orders.js";
import "./modules/v05-printing.js";
import "./modules/v06-payments.js";
import "./modules/v07-splits-refunds.js";
import "./modules/v08-guest.js";
import "./modules/v09-reports.js";
import "./modules/v09-agents.js";
import "./modules/v10-kitchen-display.js";
