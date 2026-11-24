/**
 * What a downstream workspace imports from `@sail/server`: the start function and what a module, a route handler and
 * a worker task use. Importing this file adds no routes.
 */
export { startServer, type StartOptions, type Started } from "./start.js";
export { registerRoutes, type RouteModule } from "./app.js";
export { dataResponse, defineOp, errorResponses, jsonBody, jsonResponse, listResponse, mutationResponse, z, type OpContext } from "./lib/openapi.js";
export { registerOperations, roleAtLeast, type OperationSpec, type Role } from "@sail/shared";
export type { AppContext, AppEnv } from "./lib/context.js";
export { AppError, isAppError } from "./lib/errors.js";
export { appendEvent, type AppendEventInput } from "./lib/events.js";
export { registerWorkerTask, type WorkerTask } from "./worker/index.js";
export { registerPaymentProvider } from "./payments/provider.js";
export { onCancel, onFire, onVoid } from "./routes/orders.js";
export { registerOrderClosedHook, registerRepriceHook } from "./services/orders.js";
export { outletVisible, principalCanSeeOutlet, principalRole, type Principal } from "./auth/principal.js";

/**
 * In a route handler: the caller's request transaction. It runs as the caller's database role with the caller's
 * merchant, outlets and brands set, so row-level security applies; it is rolled back on an error answer or a dry run,
 * and its answer is stored for the idempotency key. Use these, never a transaction of your own, in a handler.
 */
export { db, tx, schema, type Db } from "./db/client.js";

/**
 * Outside a request only: a worker task or a start-up step. It opens its own transaction as the connection owner, with
 * no role and no merchant set, so row-level security does not apply and the code must name the merchant in every
 * query. Inside a route handler it would bypass the caller's row-level security, dry run and idempotency: use `db()`
 * or `tx()` there.
 */
export { withTransaction } from "./db/client.js";
export { migrationSetsFromEnv, runMigrations, type MigrationSet } from "./db/migrate.js";
