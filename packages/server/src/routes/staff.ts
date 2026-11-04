import type { OpenAPIHono } from "@hono/zod-openapi";
import { and, asc, desc, eq, gte, lte, sql } from "drizzle-orm";
import { RoleSchema } from "@sail/shared";
import { db } from "../db/client.js";
import { auditLog, staff } from "../db/schema/index.js";
import { AppError } from "../lib/errors.js";
import type { AppEnv } from "../lib/context.js";
import { defineOp, errorResponses, jsonBody, jsonResponse, listResponse, mutationResponse, z } from "../lib/openapi.js";
import { appendEvent } from "../lib/events.js";
import { recordAudit } from "../lib/audit.js";
import { hashSecret, pinLookup } from "../auth/tokens.js";

export const StaffSchema = z.object({
  id: z.string(),
  name: z.string(),
  initials: z.string().nullable(),
  email: z.string().nullable(),
  role: RoleSchema,
  outlet_ids: z.array(z.string()),
  brand_ids: z.array(z.string()),
  has_pin: z.boolean(),
  has_login: z.boolean(),
  active: z.boolean(),
  legacy_id: z.string().nullable(),
  risk_ceiling: z.string().nullable(),
});
const StaffInput = z.object({
  id: z.uuid().optional(),
  name: z.string().min(1),
  initials: z.string().max(3).nullable().optional(),
  email: z.string().email().nullable().optional(),
  role: RoleSchema,
  outlet_ids: z.array(z.uuid()).optional(),
  brand_ids: z.array(z.uuid()).optional(),
  /** 6-digit POS PIN. Stored hashed. */
  pin: z.string().regex(/^\d{6}$/).nullable().optional(),
  legacy_id: z.string().nullable().optional(),
  risk_ceiling: z.enum(["T0", "T1", "T2", "T3"]).nullable().optional(),
});
const StaffPatch = StaffInput.omit({ id: true }).partial().extend({ active: z.boolean().optional() });

export const toStaff = (s: typeof staff.$inferSelect) => ({
  id: s.id,
  name: s.name,
  initials: s.initials,
  email: s.email,
  role: s.role,
  outlet_ids: s.outletIds,
  brand_ids: s.brandIds,
  has_pin: s.pinHash != null,
  has_login: s.authSubject != null,
  active: s.active,
  legacy_id: s.legacyId,
  risk_ceiling: s.riskCeiling,
});

export const AuditEntrySchema = z.object({
  id: z.string(),
  occurred_at: z.string(),
  outlet_id: z.string().nullable(),
  actor_type: z.string(),
  actor_id: z.string(),
  actor_name: z.string().nullable(),
  actor_role: z.string().nullable(),
  on_behalf_of: z.string().nullable(),
  action: z.string(),
  target_kind: z.string(),
  target_id: z.string().nullable(),
  approver_id: z.string().nullable(),
  approver_name: z.string().nullable(),
  override_id: z.string().nullable(),
  reason: z.string().nullable(),
  details: z.record(z.string(), z.unknown()),
});

function initialsFor(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");
}

export function staffRoutes(app: OpenAPIHono<AppEnv>) {
  defineOp(app, { op: "staff.list", method: "get", path: "/v1/staff", tags: ["team"], request: { query: z.object({ include_inactive: z.enum(["true", "false"]).optional() }) }, responses: { 200: jsonResponse(listResponse(StaffSchema)), ...errorResponses } }, async (c) => {
    const p = c.get("principal");
    const q = c.req.valid("query");
    const where = q.include_inactive === "true" ? eq(staff.merchantId, p.merchantId) : and(eq(staff.merchantId, p.merchantId), eq(staff.active, true));
    const rows = await db().select().from(staff).where(where).orderBy(asc(staff.name));
    return c.json({ data: rows.map(toStaff), next_cursor: null }, 200);
  });

  defineOp(app, { op: "staff.create", method: "post", path: "/v1/staff", tags: ["team"], request: { body: jsonBody(StaffInput) }, responses: { 201: jsonResponse(mutationResponse(StaffSchema)), ...errorResponses } }, async (c) => {
    const p = c.get("principal");
    const body = c.req.valid("json");
    const [row] = await db()
      .insert(staff)
      .values({
        id: body.id,
        merchantId: p.merchantId,
        name: body.name,
        initials: body.initials ?? initialsFor(body.name),
        email: body.email ?? null,
        role: body.role,
        outletIds: body.outlet_ids ?? [],
        brandIds: body.brand_ids ?? [],
        pinHash: body.pin ? hashSecret(body.pin) : null,
        pinLookup: body.pin ? pinLookup(p.merchantId, body.pin) : null,
        legacyId: body.legacy_id ?? null,
        riskCeiling: body.risk_ceiling ?? null,
      })
      .returning();
    const ev = await appendEvent({ merchantId: p.merchantId, outletId: null, type: "staff.created", aggregate: { kind: "staff", id: row!.id }, operationId: "staff.create", payload: toStaff(row!), correlationId: c.get("correlationId"), idempotencyKey: c.get("idempotencyKey") }, p);
    await recordAudit(p, { action: "staff.create", targetKind: "staff", targetId: row!.id, details: { name: row!.name, role: row!.role, outlet_ids: row!.outletIds } });
    return c.json({ data: toStaff(row!), events: [ev], warnings: [] }, 201);
  });

  defineOp(app, { op: "staff.update", method: "patch", path: "/v1/staff/{id}", tags: ["team"], request: { params: z.object({ id: z.uuid() }), body: jsonBody(StaffPatch) }, responses: { 200: jsonResponse(mutationResponse(StaffSchema)), ...errorResponses } }, async (c) => {
    const p = c.get("principal");
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    if (id === p.id && body.role && body.role !== "admin") throw AppError.invariant("admin_self_demotion", "You cannot lower your own role", "Ask another Admin to change your role.");
    const [row] = await db()
      .update(staff)
      .set({
        ...(body.name !== undefined && { name: body.name }),
        ...(body.initials !== undefined && { initials: body.initials }),
        ...(body.email !== undefined && { email: body.email }),
        ...(body.role !== undefined && { role: body.role }),
        ...(body.outlet_ids !== undefined && { outletIds: body.outlet_ids }),
        ...(body.brand_ids !== undefined && { brandIds: body.brand_ids }),
        ...(body.pin !== undefined && { pinHash: body.pin ? hashSecret(body.pin) : null, pinLookup: body.pin ? pinLookup(p.merchantId, body.pin) : null, pinFailedAttempts: 0, pinLockedUntil: null }),
        ...(body.legacy_id !== undefined && { legacyId: body.legacy_id }),
        ...(body.risk_ceiling !== undefined && { riskCeiling: body.risk_ceiling }),
        ...(body.active !== undefined && { active: body.active }),
        updatedAt: new Date(),
      })
      .where(and(eq(staff.id, id), eq(staff.merchantId, p.merchantId)))
      .returning();
    if (!row) throw AppError.notFound("staff member", id);
    const { pin: _pin, ...auditable } = body;
    const ev = await appendEvent({ merchantId: p.merchantId, outletId: null, type: "staff.updated", aggregate: { kind: "staff", id }, operationId: "staff.update", payload: { ...auditable, pin_changed: body.pin !== undefined }, correlationId: c.get("correlationId"), idempotencyKey: c.get("idempotencyKey") }, p);
    await recordAudit(p, { action: "staff.update", targetKind: "staff", targetId: id, details: { ...auditable, pin_changed: body.pin !== undefined } });
    return c.json({ data: toStaff(row), events: [ev], warnings: [] }, 200);
  });

  defineOp(
    app,
    {
      op: "audit.list",
      method: "get",
      path: "/v1/audit",
      tags: ["team"],
      request: {
        query: z.object({
          actor_id: z.string().optional(),
          action: z.string().optional(),
          target_kind: z.string().optional(),
          target_id: z.string().optional(),
          from: z.iso.datetime().optional(),
          to: z.iso.datetime().optional(),
          limit: z.coerce.number().int().min(1).max(500).default(100),
          cursor: z.string().optional(),
        }),
      },
      responses: { 200: jsonResponse(listResponse(AuditEntrySchema)), ...errorResponses },
    },
    async (c) => {
      const p = c.get("principal");
      const q = c.req.valid("query");
      const conds = [eq(auditLog.merchantId, p.merchantId)];
      if (q.actor_id) conds.push(eq(auditLog.actorId, q.actor_id));
      if (q.action) conds.push(eq(auditLog.action, q.action));
      if (q.target_kind) conds.push(eq(auditLog.targetKind, q.target_kind));
      if (q.target_id) conds.push(eq(auditLog.targetId, q.target_id));
      if (q.from) conds.push(gte(auditLog.occurredAt, new Date(q.from)));
      if (q.to) conds.push(lte(auditLog.occurredAt, new Date(q.to)));
      if (q.cursor) conds.push(sql`${auditLog.occurredAt} < ${new Date(q.cursor)}`);
      const rows = await db()
        .select()
        .from(auditLog)
        .where(and(...conds))
        .orderBy(desc(auditLog.occurredAt))
        .limit(q.limit + 1);
      const page = rows.slice(0, q.limit);
      const next = rows.length > q.limit ? page[page.length - 1]!.occurredAt.toISOString() : null;
      return c.json(
        {
          data: page.map((a) => ({
            id: a.id,
            occurred_at: a.occurredAt.toISOString(),
            outlet_id: a.outletId,
            actor_type: a.actorType,
            actor_id: a.actorId,
            actor_name: a.actorName,
            actor_role: a.actorRole,
            on_behalf_of: a.onBehalfOf,
            action: a.action,
            target_kind: a.targetKind,
            target_id: a.targetId,
            approver_id: a.approverId,
            approver_name: a.approverName,
            override_id: a.overrideId,
            reason: a.reason,
            details: a.details,
          })),
          next_cursor: next,
        },
        200,
      );
    },
  );
}
