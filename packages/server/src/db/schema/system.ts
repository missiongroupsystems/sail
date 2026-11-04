import { bigint, date, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { merchants, outlets } from "./org.js";

/**
 * The append-only event log (scope doc 7.1 rule 4; vision 6.2). Outlet events
 * get a per-outlet sequence; merchant-level (configuration) events get a
 * per-merchant sequence and a null outlet_id.
 */
export const events = pgTable(
  "events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    merchantId: uuid("merchant_id")
      .notNull()
      .references(() => merchants.id, { onDelete: "cascade" }),
    outletId: uuid("outlet_id").references(() => outlets.id, { onDelete: "cascade" }),
    seq: bigint("seq", { mode: "number" }).notNull(),
    businessDate: date("business_date").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
    type: text("type").notNull(),
    aggregateKind: text("aggregate_kind").notNull(),
    aggregateId: uuid("aggregate_id").notNull(),
    aggregateVersion: integer("aggregate_version").notNull().default(0),
    operationId: text("operation_id").notNull(),
    idempotencyKey: text("idempotency_key"),
    actor: jsonb("actor").$type<EventActor>().notNull(),
    approval: jsonb("approval").$type<EventApproval | null>(),
    reason: jsonb("reason").$type<{ id?: string; text?: string } | null>(),
    causationId: uuid("causation_id"),
    correlationId: uuid("correlation_id").notNull(),
    payload: jsonb("payload").$type<unknown>().notNull().default({}),
  },
  (t) => [
    uniqueIndex("events_outlet_seq_uq").on(t.outletId, t.seq),
    index("events_merchant_seq_idx").on(t.merchantId, t.seq),
    index("events_aggregate_idx").on(t.aggregateKind, t.aggregateId),
    index("events_business_date_idx").on(t.merchantId, t.outletId, t.businessDate),
  ],
);

export type EventActor = {
  principal_type: "staff" | "station" | "guest" | "relay" | "agent" | "system";
  principal_id: string;
  role: string | null;
  name?: string;
  on_behalf_of?: string;
  station_id?: string;
  agent?: { identity_id: string; session_id: string; task_id?: string; model?: string; playbook_versions?: string[] };
};
export type EventApproval = { override_id?: string; proposal_id?: string; approver_id: string; approver_name?: string };

/** One row per outlet: the counter for its event sequence, locked FOR UPDATE at assignment. */
export const outletSequences = pgTable("outlet_sequences", {
  outletId: uuid("outlet_id")
    .primaryKey()
    .references(() => outlets.id, { onDelete: "cascade" }),
  merchantId: uuid("merchant_id").notNull(),
  nextSeq: bigint("next_seq", { mode: "number" }).notNull().default(1),
  /** Per-outlet order number counter (P-0001, QR-0001...). */
  nextOrderNo: integer("next_order_no").notNull().default(1),
});

export const merchantSequences = pgTable("merchant_sequences", {
  merchantId: uuid("merchant_id")
    .primaryKey()
    .references(() => merchants.id, { onDelete: "cascade" }),
  nextSeq: bigint("next_seq", { mode: "number" }).notNull().default(1),
});

/**
 * Audit log (scope doc 4.1): who did what, on which target, when, and who
 * approved it. Written by one server-side function (`audit.record`).
 */
export const auditLog = pgTable(
  "audit_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    merchantId: uuid("merchant_id")
      .notNull()
      .references(() => merchants.id, { onDelete: "cascade" }),
    outletId: uuid("outlet_id"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
    actorType: text("actor_type").notNull(),
    actorId: text("actor_id").notNull(),
    actorName: text("actor_name"),
    actorRole: text("actor_role"),
    onBehalfOf: text("on_behalf_of"),
    action: text("action").notNull(),
    targetKind: text("target_kind").notNull(),
    targetId: text("target_id"),
    approverId: text("approver_id"),
    approverName: text("approver_name"),
    overrideId: uuid("override_id"),
    reason: text("reason"),
    details: jsonb("details").$type<Record<string, unknown>>().notNull().default({}),
  },
  (t) => [index("audit_merchant_time_idx").on(t.merchantId, t.occurredAt), index("audit_target_idx").on(t.targetKind, t.targetId)],
);

/** Idempotency-Key storage: one row per (principal, key). Replays the stored response. */
export const idempotencyKeys = pgTable(
  "idempotency_keys",
  {
    merchantId: uuid("merchant_id"),
    principalId: text("principal_id").notNull(),
    key: text("key").notNull(),
    requestHash: text("request_hash").notNull(),
    status: integer("status"),
    body: jsonb("body").$type<unknown>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.principalId, t.key] }), index("idempotency_created_idx").on(t.createdAt)],
);
