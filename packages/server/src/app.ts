import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import { ZodError } from "zod";
import { ApiErrorSchema } from "@sail/shared";
import { config } from "./config.js";
import { AppError } from "./lib/errors.js";
import { createApp } from "./lib/openapi.js";
import { loadSecretMarkers } from "./lib/secrets.js";
import { requestPipeline } from "./middleware/pipeline.js";
import { idempotency } from "./middleware/idempotency.js";
import { logger } from "./logger.js";
import { healthRoutes } from "./routes/health.js";
import { authRoutes } from "./routes/auth.js";
import { identityRoutes } from "./routes/identity.js";
import { orgRoutes } from "./routes/org.js";
import { staffRoutes } from "./routes/staff.js";
import { eventRoutes } from "./routes/events.js";

/** Later phases register their routes here. */
export type RouteModule = (app: ReturnType<typeof createApp>) => void;
const extraRoutes: RouteModule[] = [];
export function registerRoutes(mod: RouteModule) {
  extraRoutes.push(mod);
}

export function buildApp() {
  const app = createApp();
  const cfg = config();

  app.use(
    "*",
    cors({
      origin: cfg.CORS_ORIGIN === "*" ? "*" : cfg.CORS_ORIGIN.split(",").map((s) => s.trim()),
      allowHeaders: ["Authorization", "Content-Type", "Idempotency-Key", "X-Request-Id", "X-Correlation-Id", "X-Override-Id", "If-Match"],
      exposeHeaders: ["X-Request-Id", "Idempotent-Replayed", "ETag"],
      maxAge: 600,
    }),
  );

  app.onError((err, c) => {
    const requestId = c.get("requestId") ?? c.req.header("x-request-id") ?? "";
    if (err instanceof AppError) {
      if (err.status >= 500) logger.error({ err, requestId }, err.message);
      return c.json(err.toBody(), err.status as 400);
    }
    if (err instanceof ZodError) {
      return c.json({ code: "validation", message: err.issues[0]?.message ?? "Invalid input", details: { issues: err.issues } }, 400);
    }
    // A body that is not JSON at all, refused by the validator before any route runs.
    if (err instanceof HTTPException && err.status < 500) {
      return c.json({ code: "validation", message: err.status === 400 ? "The request body is not valid JSON" : err.message, remedy: "Send a JSON object with the fields this operation takes." }, err.status as 400);
    }
    // Drizzle wraps driver errors (DrizzleQueryError.cause); postgres.js throws PostgresError directly.
    // A body names a field at most: constraint names, key values and row-level security stay in the log.
    const cause = (err as { cause?: { code?: string } }).cause;
    const pg = (cause && typeof cause.code === "string" ? cause : err) as { code?: string; constraint_name?: string; column_name?: string; detail?: string; message?: string };
    const field = pg.column_name ?? keyColumn(pg.detail);
    if (pg.code?.startsWith("23") || pg.code === "P0001" || pg.code === "SL400") logger.info({ requestId, code: pg.code, constraint: pg.constraint_name, path: c.req.path }, "database refused the statement");
    // A PIN is how the register knows who is signing in, so two people at a merchant cannot share one.
    if (pg.code === "23505" && pg.constraint_name === "staff_merchant_pin_uq") return c.json({ code: "state_conflict", message: "Someone at this business already uses that PIN", remedy: "Choose a different six-digit PIN.", details: { field: "pin" } }, 409);
    if (pg.code === "23505") return c.json({ code: "state_conflict", message: "A record with the same unique value already exists", remedy: "Use a different value or update the existing record.", ...(field && { details: { field } }) }, 409);
    // An unknown id and another merchant's id fail the same way (migration 0051), so the answer says nothing about which.
    if (pg.code === "23503" && /still referenced/.test(pg.detail ?? "")) return c.json({ code: "state_conflict", message: "Other records still use this one", remedy: "Archive it instead." }, 409);
    if (pg.code === "23503") return c.json({ code: "validation", message: field ? `${field} does not name a record of this business` : "A referenced record does not exist", remedy: "Check the id, and that it belongs to this business.", ...(field && { details: { field } }) }, 400);
    // SL400: a trigger's refusal written for people. Other trigger errors (P0001) name internal checks and amounts.
    if (pg.code === "SL400") return c.json({ code: "validation", message: pg.message ?? "This change is not allowed", remedy: "Change the values and try again." }, 400);
    if (pg.code === "23514" || pg.code === "P0001") return c.json({ code: "invariant_violation", message: "The change would break a rule the register keeps", remedy: "Check the values and try again." }, 422);
    if (pg.code === "42501") {
      logger.warn({ err: pg, requestId, path: c.req.path }, "database refused the statement for this principal");
      return c.json({ code: "permission_denied", message: "You do not have access to this record" }, 403);
    }
    logger.error({ err, requestId }, "unhandled error");
    const body = ApiErrorSchema.parse({ code: "internal", message: "Something went wrong on the server", details: { request_id: requestId } });
    return c.json(body, 500);
  });

  app.use("*", requestPipeline);
  app.use("/v1/*", idempotency);

  healthRoutes(app);
  authRoutes(app);
  identityRoutes(app);
  orgRoutes(app);
  staffRoutes(app);
  eventRoutes(app);
  for (const mod of extraRoutes) mod(app);

  app.doc31("/openapi.json", {
    openapi: "3.1.0",
    info: { title: "Sail API", version: process.env.SAIL_VERSION ?? "0.9.0-beta.1", description: "The register. Every client (POS, back office, guest app, print relay, agents over MCP) calls these operations. All amounts are integer cents. Every mutation needs an Idempotency-Key." },
    servers: [{ url: "/" }],
  });
  app.openAPIRegistry.registerComponent("securitySchemes", "bearer", { type: "http", scheme: "bearer", bearerFormat: "JWT" });
  loadSecretMarkers(app.getOpenAPI31Document({ openapi: "3.1.0", info: { title: "Sail API", version: "markers" } }) as never);

  return app;
}

/** The first column a Postgres key detail names ("Key (area_id, merchant_id)=(...)"), without its value. */
function keyColumn(detail: string | undefined): string | undefined {
  const cols = /^Key \(([^)]*)\)/.exec(detail ?? "")?.[1]?.split(",").map((x) => x.trim()) ?? [];
  return cols.find((x) => /^[a-z_][a-z0-9_]*$/.test(x) && x !== "merchant_id");
}

export type App = ReturnType<typeof buildApp>;
