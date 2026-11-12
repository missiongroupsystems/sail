import { boolean, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { merchants } from "./org.js";

/**
 * Agent identities, sessions and proposals. An agent is an
 * untrusted client with a valid badge: it reaches the same operations through
 * the same permission checks, capped by a risk ceiling; anything above the
 * ceiling becomes a proposal a human approves.
 */
export const agentIdentities = pgTable(
  "agent_identities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    merchantId: uuid("merchant_id")
      .notNull()
      .references(() => merchants.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** One of the five roles; the effective role is the lower of this and the on-behalf-of human's. */
    role: text("role").$type<"server" | "cashier" | "manager" | "finance" | "admin">().notNull(),
    outletIds: uuid("outlet_ids").array().notNull().default([]),
    brandIds: uuid("brand_ids").array().notNull().default([]),
    toolsets: text("toolsets").array().notNull().default([]),
    /** T0, T1 or T2. No agent identity reaches T3. */
    riskCeiling: text("risk_ceiling").$type<"T0" | "T1" | "T2">().notNull().default("T1"),
    credentialHash: text("credential_hash"),
    credentialRotatedAt: timestamp("credential_rotated_at", { withTimezone: true }),
    enabled: boolean("enabled").notNull().default(true),
    /** Per-identity limits: operations per hour, proposals per day. */
    maxOpsPerHour: integer("max_ops_per_hour").notNull().default(600),
    maxProposalsPerDay: integer("max_proposals_per_day").notNull().default(50),
    createdBy: uuid("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("agent_identities_merchant_idx").on(t.merchantId)],
);

/**
 * The person an attended agent acts for: their role and scope when they delegated, and the session they delegated
 * from. The agent acts for them only while that session lasts.
 */
export type OnBehalfOf = { principal_id: string; principal_type: string; name: string | null; role: string; outlet_ids: string[]; brand_ids: string[]; staff_session_id?: string | null; backoffice_session_id?: string | null };

/**
 * A single-use grant a signed-in person mints for one agent identity, so an agent runner can start a session on their
 * behalf without ever holding the person's own token. Only the hash of the grant is stored.
 */
export const agentDelegations = pgTable(
  "agent_delegations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    merchantId: uuid("merchant_id").notNull(),
    identityId: uuid("identity_id")
      .notNull()
      .references(() => agentIdentities.id, { onDelete: "cascade" }),
    grantHash: text("grant_hash").notNull(),
    person: jsonb("person").$type<OnBehalfOf>().notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("agent_delegations_identity_idx").on(t.identityId)],
);

export const agentSessions = pgTable(
  "agent_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    merchantId: uuid("merchant_id").notNull(),
    identityId: uuid("identity_id")
      .notNull()
      .references(() => agentIdentities.id, { onDelete: "cascade" }),
    taskId: text("task_id"),
    /** The human the agent acts for, when attended: their principal id, type, role and outlet scope at session start. */
    onBehalfOf: jsonb("on_behalf_of").$type<OnBehalfOf | null>(),
    effectiveRole: text("effective_role").notNull(),
    effectiveOutletIds: uuid("effective_outlet_ids").array().notNull().default([]),
    effectiveBrandIds: uuid("effective_brand_ids").array().notNull().default([]),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("agent_sessions_identity_idx").on(t.identityId, t.expiresAt)],
);

/**
 * An identity's use of a budget in one window (operations per clock hour, proposals per UTC day), across all its
 * sessions. Counted on a connection of its own, so a refused or failed call still counts.
 */
export const agentUsage = pgTable(
  "agent_usage",
  {
    identityId: uuid("identity_id")
      .notNull()
      .references(() => agentIdentities.id, { onDelete: "cascade" }),
    merchantId: uuid("merchant_id").notNull(),
    kind: text("kind").notNull(),
    windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
    count: integer("count").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.identityId, t.kind, t.windowStart] })],
);

/** An order's money as the pricing engine last computed it, and the customer whose group pricing applies to it. */
export type OrderMoney = { subtotal: number; discount_total: number; fee_total: number; tax_total: number; total: number; customer_id: string | null };
export type MoneyEffect = { reason: string; before: OrderMoney | null; after: OrderMoney | null };

export type ProposalStatus = "pending" | "approved" | "rejected" | "failed" | "expired";

export const proposals = pgTable(
  "proposals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    merchantId: uuid("merchant_id").notNull(),
    outletId: uuid("outlet_id"),
    operationId: text("operation_id").notNull(),
    tier: text("tier").notNull(),
    method: text("method").notNull(),
    path: text("path").notNull(),
    /** The frozen request body, replayed exactly on approval. */
    body: jsonb("body").$type<unknown>(),
    idempotencyKey: text("idempotency_key"),
    /** For a request on an order or one of its bills: the order's version when proposed. Execution is refused once the order has changed. */
    expectedVersion: integer("expected_version"),
    targetKind: text("target_kind"),
    /** The order the request acts on, and its total when proposed: what the approver is shown. */
    orderId: uuid("order_id"),
    orderTotal: integer("order_total"),
    /** When an agent's call would have lowered the amount due or changed tax or fees: why, and the order's money before and after (the pricing engine's result). */
    effect: jsonb("effect").$type<MoneyEffect | null>(),
    /** For a proposal on a shift, business day or stock cap: the figures the approver is shown. Execution is refused once they have changed. */
    pin: jsonb("pin").$type<Record<string, unknown> | null>(),
    targetId: text("target_id"),
    /** The agent's rationale (free text from a model: shown to staff, never executed). */
    rationale: text("rationale"),
    status: text("status").$type<ProposalStatus>().notNull().default("pending"),
    proposedByType: text("proposed_by_type").notNull(),
    proposedById: text("proposed_by_id").notNull(),
    proposedByName: text("proposed_by_name"),
    agentIdentityId: uuid("agent_identity_id"),
    agentSessionId: uuid("agent_session_id"),
    /** The person the proposing agent acted for: they may not approve it either. */
    onBehalfOfId: text("on_behalf_of_id"),
    decidedBy: text("decided_by"),
    decidedByName: text("decided_by_name"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    rejectReason: text("reject_reason"),
    /** HTTP status and body of the executed request. */
    result: jsonb("result").$type<{ status: number; body: unknown } | null>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => [index("proposals_outlet_status_idx").on(t.outletId, t.status, t.createdAt)],
);
