import type { OpenAPIHono } from "@hono/zod-openapi";
import { and, asc, eq, gt, sql } from "drizzle-orm";
import { db, withTransaction } from "../db/client.js";
import { events, outletSequences, outlets } from "../db/schema/index.js";
import { AppError } from "../lib/errors.js";
import type { AppEnv } from "../lib/context.js";
import { defineOp, errorResponses, jsonResponse, z } from "../lib/openapi.js";
import { principalCanSeeOutlet } from "../auth/principal.js";
import { applyRls } from "../middleware/pipeline.js";
import { serveStream } from "../sse/stream.js";

export const EventSchema = z.object({
  id: z.string(),
  seq: z.number().int(),
  outlet_id: z.string().nullable(),
  business_date: z.string(),
  occurred_at: z.string(),
  type: z.string(),
  aggregate: z.object({ kind: z.string(), id: z.string(), version: z.number().int() }),
  operation_id: z.string(),
  actor: z.record(z.string(), z.unknown()),
  approval: z.record(z.string(), z.unknown()).nullable(),
  reason: z.record(z.string(), z.unknown()).nullable(),
  causation_id: z.string().nullable(),
  correlation_id: z.string(),
  payload: z.unknown(),
});

export const toEvent = (e: typeof events.$inferSelect) => ({
  id: e.id,
  seq: Number(e.seq),
  outlet_id: e.outletId,
  business_date: e.businessDate,
  occurred_at: e.occurredAt.toISOString(),
  type: e.type,
  aggregate: { kind: e.aggregateKind, id: e.aggregateId, version: e.aggregateVersion },
  operation_id: e.operationId,
  actor: e.actor as Record<string, unknown>,
  approval: (e.approval ?? null) as Record<string, unknown> | null,
  reason: (e.reason ?? null) as Record<string, unknown> | null,
  causation_id: e.causationId,
  correlation_id: e.correlationId,
  payload: e.payload,
});

export function eventRoutes(app: OpenAPIHono<AppEnv>) {
  defineOp(
    app,
    {
      op: "events.list",
      method: "get",
      path: "/v1/outlets/{id}/events",
      tags: ["events"],
      request: { params: z.object({ id: z.uuid() }), query: z.object({ after: z.coerce.number().int().min(0).default(0), limit: z.coerce.number().int().min(1).max(1000).default(500), types: z.string().optional(), aggregate_id: z.uuid().optional() }) },
      responses: { 200: jsonResponse(z.object({ data: z.array(EventSchema), latest_seq: z.number().int(), has_more: z.boolean() })), ...errorResponses },
    },
    async (c) => {
      const p = c.get("principal");
      const { id } = c.req.valid("param");
      const q = c.req.valid("query");
      if (!principalCanSeeOutlet(p, id)) throw AppError.notFound("outlet", id);
      const conds = [eq(events.outletId, id), gt(events.seq, q.after)];
      if (q.types) {
        const types = q.types.split(",").filter(Boolean);
        conds.push(sql`${events.type} = any(${types})`);
      }
      if (q.aggregate_id) conds.push(eq(events.aggregateId, q.aggregate_id));
      const rows = await db()
        .select()
        .from(events)
        .where(and(...conds))
        .orderBy(asc(events.seq))
        .limit(q.limit + 1);
      const [seqRow] = await db().select({ next: outletSequences.nextSeq }).from(outletSequences).where(eq(outletSequences.outletId, id)).limit(1);
      const latest = seqRow ? Number(seqRow.next) - 1 : 0;
      return c.json({ data: rows.slice(0, q.limit).map(toEvent), latest_seq: latest, has_more: rows.length > q.limit }, 200);
    },
  );

  defineOp(
    app,
    {
      op: "outlets.stream",
      method: "get",
      path: "/v1/outlets/{id}/stream",
      tags: ["events"],
      request: { params: z.object({ id: z.uuid() }) },
      responses: { 200: { description: "text/event-stream of `hello`, `change`, `job` and `resync` events", content: { "text/event-stream": { schema: z.string() } } }, ...errorResponses },
    },
    async (c) => {
      const p = c.get("principal");
      const { id } = c.req.valid("param");
      // Access check in a short RLS transaction before the long-lived stream opens.
      const latest = await withTransaction(async (t) => {
        await applyRls(t, p);
        const [o] = await t.db.select({ id: outlets.id }).from(outlets).where(eq(outlets.id, id)).limit(1);
        if (!o || !principalCanSeeOutlet(p, id)) throw AppError.notFound("outlet", id);
        const [seqRow] = await t.db.select({ next: outletSequences.nextSeq }).from(outletSequences).where(eq(outletSequences.outletId, id)).limit(1);
        return seqRow ? Number(seqRow.next) - 1 : 0;
      });
      return serveStream(c, [`outlet:${id}`], { seq: latest, outlet_id: id });
    },
  );
}
