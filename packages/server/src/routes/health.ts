import type { OpenAPIHono } from "@hono/zod-openapi";
import { pool6543 } from "../db/client.js";
import type { AppEnv } from "../lib/context.js";
import { defineOp, jsonResponse, z } from "../lib/openapi.js";
import { admissionGate } from "../middleware/pipeline.js";
import { subscriberCount } from "../sse/listener.js";

export const HealthSchema = z.object({
  ok: z.boolean(),
  db: z.enum(["ok", "error"]),
  version: z.string(),
  gate: z.object({ in_flight: z.number(), waiting: z.number(), rejected: z.number(), timed_out: z.number() }),
  sse_subscribers: z.number(),
});

export function healthRoutes(app: OpenAPIHono<AppEnv>) {
  defineOp(app, { op: "health.get", method: "get", path: "/health", tags: ["system"], responses: { 200: jsonResponse(HealthSchema) } }, async (c) => {
    let db: "ok" | "error" = "ok";
    try {
      await pool6543()`select 1`;
    } catch {
      db = "error";
    }
    const gate = admissionGate();
    return c.json(
      { ok: db === "ok", db, version: process.env.SAIL_VERSION ?? "dev", gate: { in_flight: gate.inFlight, waiting: gate.waiting, rejected: gate.rejected, timed_out: gate.timedOut }, sse_subscribers: subscriberCount() },
      200,
    );
  });
}
