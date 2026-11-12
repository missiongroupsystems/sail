import { index, pgEnum, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { outlets } from "./org.js";
import { channelLinks, tables } from "./catalogue.js";
import { orders } from "./orders.js";

/** Scan to Order: table QR tokens, guest sessions, guest rounds and table requests. Guests never pay. */

export const tableQrTokens = pgTable(
  "table_qr_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    merchantId: uuid("merchant_id").notNull(),
    outletId: uuid("outlet_id").notNull(),
    tableId: uuid("table_id")
      .notNull()
      .references(() => tables.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    /** Set when a newer token replaces this one; old QR codes stop working. */
    rotatedAt: timestamp("rotated_at", { withTimezone: true }),
  },
  (t) => [index("table_qr_tokens_table_idx").on(t.tableId), index("table_qr_tokens_hash_idx").on(t.tokenHash)],
);

export const guestSessions = pgTable(
  "guest_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    merchantId: uuid("merchant_id").notNull(),
    outletId: uuid("outlet_id")
      .notNull()
      .references(() => outlets.id),
    brandId: uuid("brand_id").notNull(),
    tableId: uuid("table_id")
      .notNull()
      .references(() => tables.id),
    channelLinkId: uuid("channel_link_id")
      .notNull()
      .references(() => channelLinks.id),
    /** The table's open order at the time of the scan (or opened on first scan); null until an order exists. */
    orderId: uuid("order_id").references(() => orders.id),
    deviceHash: text("device_hash").notNull(),
    guestName: text("guest_name"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [index("guest_sessions_table_idx").on(t.tableId, t.revokedAt), index("guest_sessions_order_idx").on(t.orderId)],
);

export const roundStatusEnum = pgEnum("round_status", ["pending", "accepted", "rejected", "fired"]);

export const guestRounds = pgTable(
  "guest_rounds",
  {
    /** Client-generated. */
    id: uuid("id").primaryKey(),
    merchantId: uuid("merchant_id").notNull(),
    outletId: uuid("outlet_id").notNull(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id),
    guestSessionId: uuid("guest_session_id")
      .notNull()
      .references(() => guestSessions.id),
    tableId: uuid("table_id").notNull(),
    status: roundStatusEnum("status").notNull().default("pending"),
    lineIds: uuid("line_ids").array().notNull().default([]),
    guestName: text("guest_name"),
    notes: text("notes"),
    submittedAt: timestamp("submitted_at", { withTimezone: true }).notNull().defaultNow(),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    decidedBy: uuid("decided_by"),
    decidedByName: text("decided_by_name"),
    rejectReason: text("reject_reason"),
  },
  (t) => [index("guest_rounds_order_idx").on(t.orderId, t.status), index("guest_rounds_outlet_idx").on(t.outletId, t.status)],
);

export const serviceRequestStatusEnum = pgEnum("service_request_status", ["open", "acknowledged"]);

export const serviceRequests = pgTable(
  "service_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    merchantId: uuid("merchant_id").notNull(),
    outletId: uuid("outlet_id").notNull(),
    tableId: uuid("table_id").notNull(),
    orderId: uuid("order_id"),
    guestSessionId: uuid("guest_session_id").references(() => guestSessions.id),
    /** `call_for_bill` or one of the channel link's configured requests. */
    type: text("type").notNull(),
    status: serviceRequestStatusEnum("status").notNull().default("open"),
    guestName: text("guest_name"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
    acknowledgedBy: uuid("acknowledged_by"),
    acknowledgedByName: text("acknowledged_by_name"),
    printJobId: uuid("print_job_id"),
  },
  (t) => [index("service_requests_outlet_idx").on(t.outletId, t.status), index("service_requests_table_idx").on(t.tableId, t.status)],
);
