import type { OpenAPIHono } from "@hono/zod-openapi";
import { randomUUID } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { operation, registerOperations, roleAtLeast, ROLES, type OperationSpec, type Role } from "@sail/shared";
import { db, withTransaction } from "../db/client.js";
import { agentIdentities, orders, proposals } from "../db/schema/index.js";
import { AppError } from "../lib/errors.js";
import type { AppEnv } from "../lib/context.js";
import { dataResponse, defineOp, errorResponses, jsonBody, jsonResponse, listResponse, mutationResponse, z } from "../lib/openapi.js";
import { appendEvent } from "../lib/events.js";
import { recordAudit } from "../lib/audit.js";
import { principalCanSeeOutlet, principalRole } from "../auth/principal.js";
import { registerAgentResolver } from "../auth/resolve.js";
import { registerFloorExtra } from "./orders.js";
import { issueCredential, lockPendingProposal, resolveAgentPrincipal, revokeAgentSessions, startAgentSession, TIERS, toProposal } from "../services/agents.js";

const op = (o: Partial<OperationSpec> & { op: string; summary: string; description: string }): OperationSpec => ({ tier: "T0", minRole: null, overrideAllowed: false, reasonRequired: false, dryRun: false, principals: ["staff"], emits: [], mcp: { expose: false, toolsets: [] }, ...o });

registerOperations({
  "agent_identities.list": op({ op: "agent_identities.list", summary: "Agent identities", description: "The merchant's agent identities with role, scope, toolsets, ceiling and status. Credentials are never returned.", minRole: "manager" }),
  "agent_identities.create": op({ op: "agent_identities.create", summary: "Create an agent identity", description: "Admin. Name, role, outlet and brand scope, toolsets and risk ceiling (T0 to T2; no agent reaches T3). Returns the credential once; store it in the agent runner's secrets.", tier: "T3", minRole: "admin", emits: ["agent_identity.created"] }),
  "agent_identities.update": op({ op: "agent_identities.update", summary: "Update an agent identity", description: "Admin. Widening scope, role, toolsets or ceiling is a T3 change; disabling an identity revokes its live sessions at once (kill switch).", tier: "T3", minRole: "admin", emits: ["agent_identity.updated"] }),
  "agent_identities.rotate_credential": op({ op: "agent_identities.rotate_credential", summary: "Rotate an agent credential", description: "Admin. The old credential stops working and live sessions are revoked. Returns the new credential once.", tier: "T3", minRole: "admin", emits: ["agent_identity.credential_rotated"] }),
  "agent_sessions.start": op({ op: "agent_sessions.start", summary: "Start an agent session", description: "Exchanges an agent credential for a 15-minute agent token bound to a task. With `on_behalf_of` (a staff PIN session or back-office token) the effective role is the lower of the agent's and the person's, and the outlet scope is the intersection, so an agent never does for a Server what the Server could not.", principals: [], emits: ["agent_session.started"] }),
  "proposals.list": op({ op: "proposals.list", summary: "Proposals for an outlet", description: "Pending proposals waiting for a human, and recent decided ones. Agents see their own.", minRole: "server", principals: ["staff", "station", "agent"], mcp: { expose: true, toolsets: ["pos.read", "pos.order", "pos.refund", "watch"] } }),
  "proposals.get": op({ op: "proposals.get", summary: "One proposal", description: "Status, frozen request, decision and the executed result. Agents poll this after a `requires_confirmation` response.", principals: ["staff", "station", "agent"], mcp: { expose: true, toolsets: ["pos.read", "pos.order", "pos.refund", "pos.payment", "kitchen", "watch"] } }),
  "proposals.approve": op({ op: "proposals.approve", summary: "Approve a proposal", description: "A human with the operation's role approves; the register executes the frozen request exactly, as the approver, with the frozen idempotency key. The approver cannot be the proposer. If the target changed, execution fails with version_conflict and the proposal is marked failed.", tier: "T1", minRole: "server", emits: ["proposal.approved", "proposal.failed"] }),
  "proposals.reject": op({ op: "proposals.reject", summary: "Reject a proposal", description: "With a reason, shown to the agent. Rejections become eval cases.", tier: "T1", minRole: "server", reasonRequired: true, emits: ["proposal.rejected"] }),
});

registerAgentResolver(resolveAgentPrincipal);

registerFloorExtra(async (outletId) => {
  const [n] = await db().select({ n: sql<number>`count(*)::int` }).from(proposals).where(and(eq(proposals.outletId, outletId), eq(proposals.status, "pending"), sql`${proposals.expiresAt} > now()`));
  return { extra: { pending_proposals: n?.n ?? 0 } };
});

const IdentityOut = z.object({ id: z.string(), name: z.string(), role: z.enum(ROLES), outlet_ids: z.array(z.string()), brand_ids: z.array(z.string()), toolsets: z.array(z.string()), risk_ceiling: z.enum(["T0", "T1", "T2"]), enabled: z.boolean(), max_ops_per_hour: z.number(), max_proposals_per_day: z.number(), credential_rotated_at: z.string().nullable(), created_at: z.string() });
const toIdentity = (r: typeof agentIdentities.$inferSelect) => ({ id: r.id, name: r.name, role: r.role, outlet_ids: r.outletIds, brand_ids: r.brandIds, toolsets: r.toolsets, risk_ceiling: r.riskCeiling, enabled: r.enabled, max_ops_per_hour: r.maxOpsPerHour, max_proposals_per_day: r.maxProposalsPerDay, credential_rotated_at: r.credentialRotatedAt?.toISOString() ?? null, created_at: r.createdAt.toISOString() });
const TOOLSETS = ["pos.read", "pos.order", "pos.payment", "pos.refund", "kitchen", "guest", "config.author", "reports", "watch"] as const;
const IdentityIn = z.object({ id: z.uuid().optional(), name: z.string().min(1).max(60), role: z.enum(ROLES), outlet_ids: z.array(z.uuid()).default([]), brand_ids: z.array(z.uuid()).default([]), toolsets: z.array(z.enum(TOOLSETS)).min(1), risk_ceiling: z.enum(["T0", "T1", "T2"]).default("T1"), max_ops_per_hour: z.number().int().min(1).max(100_000).optional(), max_proposals_per_day: z.number().int().min(0).max(10_000).optional() });
const Any = z.record(z.string(), z.unknown());

export function agentRoutes(app: OpenAPIHono<AppEnv>) {
  defineOp(app, { op: "agent_identities.list", method: "get", path: "/v1/agent-identities", tags: ["agents"], responses: { 200: jsonResponse(listResponse(IdentityOut)), ...errorResponses } }, async (c) => {
    const rows = await db().select().from(agentIdentities).where(eq(agentIdentities.merchantId, c.get("principal").merchantId)).orderBy(agentIdentities.name);
    return c.json({ data: rows.map(toIdentity), next_cursor: null }, 200);
  });

  defineOp(app, { op: "agent_identities.create", method: "post", path: "/v1/agent-identities", tags: ["agents"], request: { body: jsonBody(IdentityIn) }, responses: { 201: jsonResponse(mutationResponse(IdentityOut.extend({ credential: z.string() }))), ...errorResponses } }, async (c) => {
    const p = c.get("principal");
    const b = c.req.valid("json");
    const id = b.id ?? randomUUID();
    const { credential, hash } = issueCredential(id);
    const [row] = await db().insert(agentIdentities).values({ id, merchantId: p.merchantId, name: b.name, role: b.role, outletIds: b.outlet_ids, brandIds: b.brand_ids, toolsets: b.toolsets, riskCeiling: b.risk_ceiling, credentialHash: hash, credentialRotatedAt: new Date(), maxOpsPerHour: b.max_ops_per_hour, maxProposalsPerDay: b.max_proposals_per_day, createdBy: p.type === "staff" ? p.id : null }).returning();
    const ev = await appendEvent({ merchantId: p.merchantId, outletId: null, type: "agent_identity.created", aggregate: { kind: "agent_identity", id }, operationId: "agent_identities.create", payload: { name: b.name, role: b.role, toolsets: b.toolsets, risk_ceiling: b.risk_ceiling, outlet_ids: b.outlet_ids }, correlationId: c.get("correlationId"), idempotencyKey: c.get("idempotencyKey") }, p);
    await recordAudit(p, { action: "agent_identities.create", targetKind: "agent_identity", targetId: id, details: { name: b.name, role: b.role, risk_ceiling: b.risk_ceiling } });
    return c.json({ data: { ...toIdentity(row!), credential }, events: [ev], warnings: ["Store the credential now; it is not shown again."] }, 201);
  });

  defineOp(app, { op: "agent_identities.update", method: "patch", path: "/v1/agent-identities/{id}", tags: ["agents"], request: { params: z.object({ id: z.uuid() }), body: jsonBody(IdentityIn.partial().extend({ enabled: z.boolean().optional() })) }, responses: { 200: jsonResponse(mutationResponse(IdentityOut)), ...errorResponses } }, async (c) => {
    const p = c.get("principal");
    const { id } = c.req.valid("param");
    const b = c.req.valid("json");
    const [row] = await db().update(agentIdentities).set({ name: b.name, role: b.role, outletIds: b.outlet_ids, brandIds: b.brand_ids, toolsets: b.toolsets, riskCeiling: b.risk_ceiling, enabled: b.enabled, maxOpsPerHour: b.max_ops_per_hour, maxProposalsPerDay: b.max_proposals_per_day, updatedAt: new Date() }).where(eq(agentIdentities.id, id)).returning();
    if (!row) throw AppError.notFound("agent identity", id);
    let revoked = 0;
    if (b.enabled === false) revoked = await revokeAgentSessions(id);
    const ev = await appendEvent({ merchantId: p.merchantId, outletId: null, type: "agent_identity.updated", aggregate: { kind: "agent_identity", id }, operationId: "agent_identities.update", payload: { ...b, sessions_revoked: revoked }, correlationId: c.get("correlationId"), idempotencyKey: c.get("idempotencyKey") }, p);
    await recordAudit(p, { action: "agent_identities.update", targetKind: "agent_identity", targetId: id, details: b });
    return c.json({ data: toIdentity(row), events: [ev], warnings: revoked ? [`${revoked} live session(s) revoked`] : [] }, 200);
  });

  defineOp(app, { op: "agent_identities.rotate_credential", method: "post", path: "/v1/agent-identities/{id}/credential", tags: ["agents"], request: { params: z.object({ id: z.uuid() }), body: jsonBody(z.object({}).passthrough()) }, responses: { 201: jsonResponse(mutationResponse(z.object({ credential: z.string(), sessions_revoked: z.number() }))), ...errorResponses } }, async (c) => {
    const p = c.get("principal");
    const { id } = c.req.valid("param");
    const { credential, hash } = issueCredential(id);
    const [row] = await db().update(agentIdentities).set({ credentialHash: hash, credentialRotatedAt: new Date(), updatedAt: new Date() }).where(eq(agentIdentities.id, id)).returning();
    if (!row) throw AppError.notFound("agent identity", id);
    const revoked = await revokeAgentSessions(id);
    const ev = await appendEvent({ merchantId: p.merchantId, outletId: null, type: "agent_identity.credential_rotated", aggregate: { kind: "agent_identity", id }, operationId: "agent_identities.rotate_credential", payload: { sessions_revoked: revoked }, correlationId: c.get("correlationId"), idempotencyKey: c.get("idempotencyKey") }, p);
    await recordAudit(p, { action: "agent_identities.rotate_credential", targetKind: "agent_identity", targetId: id });
    return c.json({ data: { credential, sessions_revoked: revoked }, events: [ev], warnings: ["Store the credential now; it is not shown again."] }, 201);
  });

  defineOp(app, { op: "agent_sessions.start", method: "post", path: "/v1/agent-sessions", tags: ["agents"], request: { body: jsonBody(z.object({ credential: z.string().min(40).max(200), task_id: z.string().max(120).optional(), on_behalf_of: z.string().max(4000).optional() })) }, responses: { 201: jsonResponse(dataResponse(z.object({ agent_token: z.string(), session_id: z.string(), identity_id: z.string(), name: z.string(), effective_role: z.enum(ROLES), outlet_ids: z.array(z.string()), toolsets: z.array(z.string()), risk_ceiling: z.string(), on_behalf_of: z.string().nullable(), expires_at: z.string() }))), ...errorResponses } }, async (c) => {
    const b = c.req.valid("json");
    const r = await withTransaction(async (t) => {
      const r = await startAgentSession({ credential: b.credential, taskId: b.task_id ?? null, onBehalfOf: b.on_behalf_of ?? null }, t);
      await appendEvent({ merchantId: r.identity.merchantId, outletId: null, type: "agent_session.started", aggregate: { kind: "agent_identity", id: r.identity.id }, operationId: "agent_sessions.start", payload: { session_id: r.session.id, task_id: b.task_id ?? null, effective_role: r.session.effectiveRole, on_behalf_of: r.session.onBehalfOf?.principal_id ?? null }, actor: { principal_type: "agent", principal_id: r.identity.id, role: r.session.effectiveRole as Role, name: r.identity.name, agent: { identity_id: r.identity.id, session_id: r.session.id, task_id: b.task_id ?? undefined } }, correlationId: c.get("correlationId") });
      return r;
    });
    return c.json({ data: { agent_token: r.token, session_id: r.session.id, identity_id: r.identity.id, name: r.identity.name, effective_role: r.session.effectiveRole as Role, outlet_ids: r.session.effectiveOutletIds, toolsets: r.identity.toolsets, risk_ceiling: r.identity.riskCeiling, on_behalf_of: r.session.onBehalfOf?.principal_id ?? null, expires_at: r.session.expiresAt.toISOString() } }, 201);
  });

  /* ---- Proposals ---- */

  defineOp(app, { op: "proposals.list", method: "get", path: "/v1/outlets/{id}/proposals", tags: ["agents"], request: { params: z.object({ id: z.uuid() }), query: z.object({ status: z.enum(["pending", "approved", "rejected", "failed", "expired"]).optional() }) }, responses: { 200: jsonResponse(listResponse(Any)), ...errorResponses } }, async (c) => {
    const p = c.get("principal");
    const { id } = c.req.valid("param");
    const q = c.req.valid("query");
    if (!principalCanSeeOutlet(p, id)) throw AppError.notFound("outlet", id);
    const rows = await db()
      .select()
      .from(proposals)
      .where(and(eq(proposals.outletId, id), q.status ? eq(proposals.status, q.status) : sql`true`, p.type === "agent" ? eq(proposals.agentIdentityId, p.identityId) : sql`true`))
      .orderBy(desc(proposals.createdAt))
      .limit(200);
    return c.json({ data: rows.map(toProposal), next_cursor: null }, 200);
  });

  defineOp(app, { op: "proposals.get", method: "get", path: "/v1/proposals/{id}", tags: ["agents"], request: { params: z.object({ id: z.uuid() }) }, responses: { 200: jsonResponse(dataResponse(Any)), ...errorResponses } }, async (c) => {
    const p = c.get("principal");
    const { id } = c.req.valid("param");
    const [row] = await db().select().from(proposals).where(eq(proposals.id, id)).limit(1);
    if (!row || (p.type === "agent" && row.agentIdentityId !== p.identityId)) throw AppError.notFound("proposal", id);
    return c.json({ data: toProposal(row) }, 200);
  });

  defineOp(app, { op: "proposals.approve", method: "post", path: "/v1/proposals/{id}/approve", tags: ["agents"], request: { params: z.object({ id: z.uuid() }), body: jsonBody(z.object({}).passthrough()) }, responses: { 200: jsonResponse(mutationResponse(Any)), ...errorResponses } }, async (c) => {
    const p = c.get("principal");
    const { id } = c.req.valid("param");
    const prop = await lockPendingProposal(id);
    if (prop.proposedById === p.id) throw new AppError("permission_denied", "You cannot approve your own proposal", { remedy: "Ask another person with the required role." });
    const spec = operation(prop.operationId);
    const role = principalRole(p);
    if (!role || (spec.minRole && !roleAtLeast(role, spec.minRole))) throw AppError.permission(spec.minRole ?? "server", false, spec.op);
    if (prop.tier === "T3" && !roleAtLeast(role, "manager")) throw AppError.permission("manager", false, spec.op);
    // The approver approves the order as it was proposed: once it has changed, nothing executes.
    const [current] = prop.orderId ? await db().select({ version: orders.version }).from(orders).where(eq(orders.id, prop.orderId)).limit(1) : [];
    let res: { status: number; text: () => Promise<string> };
    if (prop.orderId && current?.version !== prop.expectedVersion) {
      const e = AppError.version("The order has changed since this proposal was made", { current_version: current?.version ?? null, expected_version: prop.expectedVersion, order_id: prop.orderId });
      res = { status: e.status, text: async () => JSON.stringify(e.toBody()) };
    } else {
      // Execute the frozen request exactly, as the approver, through the ordinary pipeline (its own transaction, same checks);
      // the replay's lockOrder refuses it if the order changes in between.
      res = await app.request(prop.path, {
        method: prop.method,
        headers: { authorization: c.req.header("authorization") ?? "", "content-type": "application/json", "idempotency-key": prop.idempotencyKey ?? prop.id, "x-correlation-id": c.get("correlationId"), "x-proposal-id": prop.id },
        body: prop.body == null ? undefined : JSON.stringify(prop.body),
      });
    }
    const text = await res.text();
    let body: unknown = text;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      /* keep text */
    }
    const ok = res.status < 400;
    const [updated] = await db().update(proposals).set({ status: ok ? "approved" : "failed", decidedBy: p.id, decidedByName: "name" in p ? p.name : null, decidedAt: new Date(), result: { status: res.status, body } }).where(eq(proposals.id, id)).returning();
    const ev = await appendEvent({ merchantId: p.merchantId, outletId: prop.outletId, type: ok ? "proposal.approved" : "proposal.failed", aggregate: { kind: "proposal", id }, operationId: "proposals.approve", payload: { proposal_id: id, operation_id: prop.operationId, agent_identity_id: prop.agentIdentityId, result_status: res.status, result_code: (body as { code?: string } | null)?.code ?? null }, correlationId: c.get("correlationId"), idempotencyKey: c.get("idempotencyKey") }, p);
    await recordAudit(p, { action: "proposals.approve", targetKind: prop.targetKind ?? "proposal", targetId: prop.targetId ?? id, outletId: prop.outletId ?? undefined, details: { proposal_id: id, operation_id: prop.operationId, outcome: ok ? "approved" : "failed" } });
    return c.json({ data: toProposal(updated!), events: [ev], warnings: ok ? [] : [`The frozen request failed (${res.status}); the agent must propose again from the current state.`] }, 200);
  });

  defineOp(app, { op: "proposals.reject", method: "post", path: "/v1/proposals/{id}/reject", tags: ["agents"], request: { params: z.object({ id: z.uuid() }), body: jsonBody(z.object({ reason: z.string().min(1).max(200) })) }, responses: { 200: jsonResponse(mutationResponse(Any)), ...errorResponses } }, async (c) => {
    const p = c.get("principal");
    const { id } = c.req.valid("param");
    const { reason } = c.req.valid("json");
    const prop = await lockPendingProposal(id);
    const [updated] = await db().update(proposals).set({ status: "rejected", decidedBy: p.id, decidedByName: "name" in p ? p.name : null, decidedAt: new Date(), rejectReason: reason }).where(eq(proposals.id, id)).returning();
    const ev = await appendEvent({ merchantId: p.merchantId, outletId: prop.outletId, type: "proposal.rejected", aggregate: { kind: "proposal", id }, operationId: "proposals.reject", payload: { proposal_id: id, operation_id: prop.operationId, agent_identity_id: prop.agentIdentityId }, reason: { text: reason }, correlationId: c.get("correlationId"), idempotencyKey: c.get("idempotencyKey") }, p);
    await recordAudit(p, { action: "proposals.reject", targetKind: prop.targetKind ?? "proposal", targetId: prop.targetId ?? id, outletId: prop.outletId ?? undefined, reason, details: { proposal_id: id } });
    return c.json({ data: toProposal(updated!), events: [ev], warnings: [] }, 200);
  });
}

export { TIERS };
