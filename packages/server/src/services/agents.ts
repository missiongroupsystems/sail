import { randomUUID } from "node:crypto";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { roleAtLeast, type OperationSpec, type Role } from "@sail/shared";
import { db, tx, type RequestTx } from "../db/client.js";
import { agentDelegations, agentIdentities, agentSessions, backofficeSessions, checks, orders, paymentIntents, payments, proposals, staff, staffSessions, type OnBehalfOf, type ProposalStatus } from "../db/schema/index.js";
import { AppError } from "../lib/errors.js";
import { hashSecret, randomToken, sha256, signSailToken, verifySailToken, verifySecret } from "../auth/tokens.js";
import type { Principal } from "../auth/principal.js";
import { config } from "../config.js";
import { appendEvent } from "../lib/events.js";

/**
 * Agent principals: identities provisioned by an Admin, 15-minute
 * task-bound sessions, on-behalf-of intersection of role and scope, a risk
 * ceiling, and proposals for anything above it.
 */
export const TIERS = ["T0", "T1", "T2", "T3"] as const;
export type Tier = (typeof TIERS)[number];
export const tierRank = (t: string) => TIERS.indexOf(t as Tier);
export const AGENT_SESSION_SECONDS = 15 * 60;
export const PROPOSAL_TTL_SECONDS = 10 * 60;
export const DELEGATION_TTL_SECONDS = 5 * 60;

const lowerRole = (a: Role, b: Role): Role => (roleAtLeast(a, b) ? b : a);
const intersect = (a: string[], b: string[]) => (a.length === 0 ? b : b.length === 0 ? a : a.filter((x) => b.includes(x)));

/** `identity_id.secret`: the id finds the identity, the secret is checked against the stored hash. */
export function issueCredential(identityId: string): { credential: string; hash: string } {
  const secret = randomToken(32);
  return { credential: `${identityId}.${secret}`, hash: hashSecret(secret) };
}

/**
 * A signed-in person delegates to one agent identity: a single-use grant, valid for five minutes, that the agent runner
 * passes as `on_behalf_of`. The runner never holds the person's own token, so it can never act or approve as them.
 */
export async function mintDelegation(person: Extract<Principal, { type: "staff" }>, identityId: string): Promise<{ grant: string; expiresAt: Date }> {
  const [identity] = await db().select({ id: agentIdentities.id }).from(agentIdentities).where(and(eq(agentIdentities.id, identityId), eq(agentIdentities.merchantId, person.merchantId))).limit(1);
  if (!identity) throw AppError.notFound("agent identity", identityId);
  const secret = randomToken(32);
  const expiresAt = new Date(Date.now() + DELEGATION_TTL_SECONDS * 1000);
  const onBehalfOf: OnBehalfOf = { principal_id: person.id, principal_type: "staff", name: person.name, role: person.role, outlet_ids: person.outletId ? [person.outletId] : person.outletIds, brand_ids: person.brandIds, staff_session_id: person.sessionId ?? null, backoffice_session_id: person.backofficeSessionId ?? null };
  // The id is made here: the person's role may insert a grant but never read one back.
  const id = randomUUID();
  await db().insert(agentDelegations).values({ id, merchantId: person.merchantId, identityId, grantHash: sha256(secret), person: onBehalfOf, expiresAt });
  return { grant: `${id}.${secret}`, expiresAt };
}

export async function startAgentSession(input: { credential: string; taskId?: string | null; onBehalfOf?: string | null }, t: RequestTx): Promise<{ token: string; session: typeof agentSessions.$inferSelect; identity: typeof agentIdentities.$inferSelect }> {
  const dot = input.credential.indexOf(".");
  const identityId = dot > 0 ? input.credential.slice(0, dot) : "";
  const secret = dot > 0 ? input.credential.slice(dot + 1) : "";
  const [identity] = identityId.match(/^[0-9a-f-]{36}$/) ? await t.db.select().from(agentIdentities).where(eq(agentIdentities.id, identityId)).limit(1) : [];
  if (!identity || !verifySecret(secret, identity.credentialHash)) throw new AppError("unauthenticated", "Unknown agent credential", { remedy: "Ask an Admin to rotate the agent's credential." });
  if (!identity.enabled) throw new AppError("permission_denied", `Agent "${identity.name}" is switched off`, { remedy: "An Admin can enable it under Assistants." });

  let effectiveRole: Role = identity.role;
  let outletIds = identity.outletIds;
  let brandIds = identity.brandIds;
  let onBehalfOf: OnBehalfOf | null = null;
  if (input.onBehalfOf) {
    const human = await redeemDelegation(input.onBehalfOf, identity, t);
    await assertPersonPresent(human, t);
    effectiveRole = lowerRole(identity.role, human.role as Role);
    outletIds = intersect(identity.outletIds, human.outlet_ids);
    brandIds = intersect(identity.brandIds, human.brand_ids);
    if (identity.outletIds.length && human.outlet_ids.length && outletIds.length === 0) throw new AppError("permission_denied", "The agent and this person share no outlet");
    onBehalfOf = human;
  }
  const expiresAt = new Date(Date.now() + AGENT_SESSION_SECONDS * 1000);
  const [session] = await t.db.insert(agentSessions).values({ merchantId: identity.merchantId, identityId: identity.id, taskId: input.taskId ?? null, onBehalfOf, effectiveRole, effectiveOutletIds: outletIds, effectiveBrandIds: brandIds, expiresAt }).returning();
  const token = await signSailToken({ typ: "agent", merchant_id: identity.merchantId, identity_id: identity.id, session_id: session!.id, role: effectiveRole, on_behalf_of: onBehalfOf?.principal_id }, AGENT_SESSION_SECONDS);
  return { token, session: session!, identity };
}

/** Use a delegation grant once, for the identity it was minted for. */
async function redeemDelegation(grant: string, identity: typeof agentIdentities.$inferSelect, t: RequestTx): Promise<OnBehalfOf> {
  const dot = grant.indexOf(".");
  const id = dot > 0 ? grant.slice(0, dot) : "";
  const refused = () => AppError.validation("on_behalf_of must be a delegation grant the person created for this agent with agent_delegations.create", { remedy: "Ask the person to delegate again; a grant works once, for five minutes." });
  if (!UUID.test(id)) throw refused();
  const [row] = await t.db
    .update(agentDelegations)
    .set({ usedAt: new Date() })
    .where(and(eq(agentDelegations.id, id), eq(agentDelegations.grantHash, sha256(grant.slice(dot + 1))), eq(agentDelegations.identityId, identity.id), eq(agentDelegations.merchantId, identity.merchantId), isNull(agentDelegations.usedAt), gt(agentDelegations.expiresAt, new Date())))
    .returning();
  if (!row) throw refused();
  return row.person;
}

/** The person an agent acts for is still active and still signed in with the session they delegated from. */
async function assertPersonPresent(person: OnBehalfOf, t: RequestTx): Promise<void> {
  const gone = () => new AppError("unauthenticated", `${person.name ?? "The person this agent acts for"} is no longer signed in`, { remedy: "Ask them to sign in and delegate again." });
  const [member] = await t.db.select({ active: staff.active }).from(staff).where(eq(staff.id, person.principal_id)).limit(1);
  if (!member?.active) throw gone();
  if (person.staff_session_id) {
    const [s] = await t.db.select({ endedAt: staffSessions.endedAt, lastSeenAt: staffSessions.lastSeenAt }).from(staffSessions).where(eq(staffSessions.id, person.staff_session_id)).limit(1);
    if (!s || s.endedAt || (Date.now() - s.lastSeenAt.getTime()) / 1000 > config().PIN_SESSION_IDLE_SECONDS) throw gone();
  }
  if (person.backoffice_session_id) {
    const [s] = await t.db.select({ endedAt: backofficeSessions.endedAt, expiresAt: backofficeSessions.expiresAt }).from(backofficeSessions).where(eq(backofficeSessions.id, person.backoffice_session_id)).limit(1);
    if (!s || s.endedAt || s.expiresAt.getTime() <= Date.now()) throw gone();
  }
}

/** Resolver for agent tokens: session must be live, identity enabled, within its operation budget. */
export async function resolveAgentPrincipal(token: string, t: RequestTx): Promise<Principal> {
  const claims = await verifySailToken(token, "agent");
  const [row] = await t.db
    .select({ s: agentSessions, i: agentIdentities })
    .from(agentSessions)
    .innerJoin(agentIdentities, eq(agentIdentities.id, agentSessions.identityId))
    .where(eq(agentSessions.id, claims.session_id!))
    .limit(1);
  if (!row || row.s.revokedAt || row.s.expiresAt.getTime() < Date.now()) throw new AppError("unauthenticated", "This agent session has ended", { remedy: "Start a new agent session." });
  if (!row.i.enabled) throw new AppError("permission_denied", `Agent "${row.i.name}" is switched off`);
  if (row.s.onBehalfOf) await assertPersonPresent(row.s.onBehalfOf, t);
  if (row.s.opsCount >= row.i.maxOpsPerHour) throw new AppError("rate_limited", `Agent "${row.i.name}" has used its operation budget for this session`, { remedy: "Wait for the session to expire or raise the identity's limit.", details: { retry_after_seconds: Math.max(1, Math.ceil((row.s.expiresAt.getTime() - Date.now()) / 1000)) } });
  await t.sql`update agent_sessions set last_seen_at = now(), ops_count = ops_count + 1 where id in (select id from agent_sessions where id = ${row.s.id} for update skip locked)`;
  return {
    type: "agent",
    id: row.i.id,
    merchantId: row.i.merchantId,
    role: row.s.effectiveRole as Role,
    name: row.i.name,
    outletIds: row.s.effectiveOutletIds,
    brandIds: row.s.effectiveBrandIds,
    identityId: row.i.id,
    sessionId: row.s.id,
    onBehalfOf: row.s.onBehalfOf?.principal_id ?? null,
    riskCeiling: row.i.riskCeiling,
    toolsets: row.i.toolsets,
  };
}

/* ---- Proposals ---- */

/**
 * The highest tier a principal runs without a person in the loop. An agent never runs T2 or T3 itself, whatever its
 * identity's ceiling: food leaving the kitchen, money being recorded, a comp or an order closing needs a person to
 * confirm that one action, and the proposal is that confirmation.
 */
export function directCeiling(type: string, ceiling: string | null): string | null {
  if (type !== "agent" || ceiling == null) return ceiling;
  return tierRank(ceiling) > tierRank("T1") ? "T1" : ceiling;
}

/** Does this principal's ceiling stop it running an operation of this tier directly? */
export function aboveCeiling(p: Principal, spec: OperationSpec): boolean {
  if (p.type === "agent") return tierRank(spec.tier) > tierRank(directCeiling(p.type, p.riskCeiling)!);
  if (p.type === "staff" && p.riskCeiling) return tierRank(spec.tier) > tierRank(p.riskCeiling);
  return false;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Best-effort target, outlet and order for a frozen request, so the proposal lands on the right POS and is pinned to the order. */
export async function inferTarget(path: string, body: unknown): Promise<{ targetKind: string | null; targetId: string | null; outletId: string | null; orderId: string | null }> {
  const segs = path.split("?")[0]!.split("/").filter(Boolean); // ["v1","orders","<id>","fire"]
  const kind = segs[1] ? segs[1].replace(/-/g, "_").replace(/s$/, "") : null;
  const id = segs[2] && UUID.test(segs[2]) ? segs[2] : null;
  const b = (body ?? {}) as Record<string, unknown>;
  let outletId = typeof b.outlet_id === "string" ? b.outlet_id : null;
  if (!outletId && kind === "outlet" && id) outletId = id;
  const order =
    id && kind === "order"
      ? (await db().select({ o: orders.outletId, id: orders.id }).from(orders).where(eq(orders.id, id)).limit(1))[0]
      : id && kind === "check"
        ? (await db().select({ o: checks.outletId, id: checks.orderId }).from(checks).where(eq(checks.id, id)).limit(1))[0]
        : id && kind === "payment"
          ? (await db().select({ o: payments.outletId, id: payments.orderId }).from(payments).where(eq(payments.id, id)).limit(1))[0]
          : id && kind === "payment_intent"
            ? (await db().select({ o: paymentIntents.outletId, id: paymentIntents.orderId }).from(paymentIntents).where(eq(paymentIntents.id, id)).limit(1))[0]
            : undefined;
  return { targetKind: kind, targetId: id, outletId: outletId ?? order?.o ?? null, orderId: order?.id ?? null };
}

export async function createProposal(input: { principal: Principal; spec: OperationSpec; method: string; path: string; body: unknown; idempotencyKey: string | null; rationale: string | null; correlationId: string }) {
  const { principal: p, spec } = input;
  if (p.type === "agent") {
    const [n] = await db().select({ n: sql<number>`count(*)::int` }).from(proposals).where(and(eq(proposals.agentIdentityId, p.identityId), gt(proposals.createdAt, sql`now() - interval '1 day'`)));
    const [identity] = await db().select({ max: agentIdentities.maxProposalsPerDay }).from(agentIdentities).where(eq(agentIdentities.id, p.identityId)).limit(1);
    if ((n?.n ?? 0) >= (identity?.max ?? 50)) throw new AppError("rate_limited", `Agent "${p.name}" has reached its daily proposal limit`, { remedy: "A Manager can review today's proposals; an Admin can raise the limit." });
  }
  const { targetKind, targetId, outletId, orderId } = await inferTarget(input.path, input.body);
  const scope = p.type === "agent" ? p.outletIds : p.type === "staff" ? (p.outletId ? [p.outletId] : p.outletIds) : [];
  if (outletId && scope.length && !scope.includes(outletId)) throw AppError.notFound(targetKind ?? "target", targetId ?? undefined);
  const b = (input.body ?? {}) as Record<string, unknown>;
  // Pin the proposal to the order as it is now, whatever the proposer sent: the approver approves this version and total.
  const [order] = orderId ? await db().select({ version: orders.version, total: orders.total }).from(orders).where(eq(orders.id, orderId)).limit(1) : [];
  if (order && typeof b.expected_version === "number" && b.expected_version !== order.version) throw AppError.version("The order was changed by someone else", { current_version: order.version, expected_version: b.expected_version, order_id: orderId });
  const [row] = await db()
    .insert(proposals)
    .values({
      merchantId: p.merchantId,
      outletId,
      operationId: spec.op,
      tier: spec.tier,
      method: input.method,
      path: input.path,
      body: input.body ?? null,
      idempotencyKey: input.idempotencyKey,
      expectedVersion: order ? order.version : typeof b.expected_version === "number" ? b.expected_version : null,
      targetKind,
      targetId,
      orderId: order ? orderId : null,
      orderTotal: order?.total ?? null,
      rationale: input.rationale,
      proposedByType: p.type,
      proposedById: p.id,
      proposedByName: "name" in p ? p.name : null,
      agentIdentityId: p.type === "agent" ? p.identityId : null,
      agentSessionId: p.type === "agent" ? p.sessionId : null,
      onBehalfOfId: p.type === "agent" ? p.onBehalfOf : null,
      expiresAt: new Date(Date.now() + PROPOSAL_TTL_SECONDS * 1000),
    })
    .returning();
  await appendEvent({ merchantId: p.merchantId, outletId, type: "proposal.created", aggregate: { kind: "proposal", id: row!.id }, operationId: spec.op, payload: { proposal_id: row!.id, operation_id: spec.op, tier: spec.tier, target_kind: targetKind, target_id: targetId, ceiling: p.type === "agent" || p.type === "staff" ? p.riskCeiling : null }, correlationId: input.correlationId }, p);
  return row!;
}

export const toProposal = (r: typeof proposals.$inferSelect) => ({
  id: r.id,
  outlet_id: r.outletId,
  operation_id: r.operationId,
  tier: r.tier,
  method: r.method,
  path: r.path,
  body: r.body,
  idempotency_key: r.idempotencyKey,
  expected_version: r.expectedVersion,
  target_kind: r.targetKind,
  target_id: r.targetId,
  order: r.orderId == null ? null : { id: r.orderId, version: r.expectedVersion, total: r.orderTotal },
  rationale: r.rationale == null ? null : { untrusted_text: r.rationale },
  status: r.status,
  proposed_by: { type: r.proposedByType, id: r.proposedById, name: r.proposedByName, agent_identity_id: r.agentIdentityId, agent_session_id: r.agentSessionId, on_behalf_of: r.onBehalfOfId },
  decided_by: r.decidedBy,
  decided_by_name: r.decidedByName,
  decided_at: r.decidedAt?.toISOString() ?? null,
  reject_reason: r.rejectReason,
  result: r.result,
  created_at: r.createdAt.toISOString(),
  expires_at: r.expiresAt.toISOString(),
});

/** Lock a pending proposal for a decision; expired ones are marked and refused. */
export async function lockPendingProposal(id: string): Promise<typeof proposals.$inferSelect> {
  const rows = await tx()<(typeof proposals.$inferSelect & Record<string, unknown>)[]>`select * from proposals where id = ${id} for update`;
  const raw = rows[0];
  if (!raw) throw AppError.notFound("proposal", id);
  const [row] = await db().select().from(proposals).where(eq(proposals.id, id)).limit(1);
  if (row!.status === "pending" && row!.expiresAt.getTime() < Date.now()) {
    await db().update(proposals).set({ status: "expired" }).where(eq(proposals.id, id));
    throw AppError.state("This proposal has expired", [], "Ask the agent to propose again from the current state.");
  }
  if (row!.status !== "pending") throw AppError.state(`This proposal is already ${row!.status}`, []);
  return row!;
}

/** The order a proposal was pinned to, for the replayed request's `lockOrder`. */
export async function proposalOrderPin(proposalId: string): Promise<{ orderId: string; version: number } | null> {
  const [row] = await db().select({ orderId: proposals.orderId, version: proposals.expectedVersion }).from(proposals).where(eq(proposals.id, proposalId)).limit(1);
  return row?.orderId && row.version != null ? { orderId: row.orderId, version: row.version } : null;
}

export async function expireProposals(): Promise<number> {
  const rows = await tx()<{ id: string }[]>`update proposals set status = 'expired' where status = 'pending' and expires_at < now() returning id`;
  return rows.length;
}

export async function revokeAgentSessions(identityId: string): Promise<number> {
  const rows = await db().update(agentSessions).set({ revokedAt: new Date() }).where(and(eq(agentSessions.identityId, identityId), isNull(agentSessions.revokedAt))).returning({ id: agentSessions.id });
  return rows.length;
}

export type { ProposalStatus };
