import { cors } from "hono/cors";
import { ZodError } from "zod";
import { ApiErrorSchema } from "@sail/shared";
import { config } from "./config.js";
import { AppError } from "./lib/errors.js";
import { createApp } from "./lib/openapi.js";
import { requestPipeline } from "./middleware/pipeline.js";
import { idempotency } from "./middleware/idempotency.js";
import { logger } from "./logger.js";
import { healthRoutes } from "./routes/health.js";
import { authRoutes } from "./routes/auth.js";
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
    // Drizzle wraps driver errors (DrizzleQueryError.cause); postgres.js throws PostgresError directly.
    const cause = (err as { cause?: { code?: string } }).cause;
    const pg = (cause && typeof cause.code === "string" ? cause : err) as { code?: string; constraint_name?: string; detail?: string; message?: string };
    if (pg.code === "23505") return c.json({ code: "state_conflict", message: "A record with the same unique value already exists", remedy: "Use a different value or update the existing record.", details: { constraint: pg.constraint_name } }, 409);
    if (pg.code === "23503") return c.json({ code: "validation", message: "A referenced record does not exist", details: { constraint: pg.constraint_name, detail: pg.detail } }, 400);
    if (pg.code === "23514" || pg.code === "P0001") return c.json({ code: "invariant_violation", message: pg.message ?? "An invariant was violated", details: { constraint: pg.constraint_name } }, 422);
    if (pg.code === "42501") return c.json({ code: "permission_denied", message: "Not permitted for this principal", details: { rls: true } }, 403);
    logger.error({ err, requestId }, "unhandled error");
    const body = ApiErrorSchema.parse({ code: "internal", message: "Something went wrong on the server", details: { request_id: requestId } });
    return c.json(body, 500);
  });

  app.use("*", requestPipeline);
  app.use("/v1/*", idempotency);

  healthRoutes(app);
  authRoutes(app);
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

  return app;
}

export type App = ReturnType<typeof buildApp>;
