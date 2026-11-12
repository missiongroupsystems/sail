import { boolean, index, integer, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { merchants, outlets } from "./org.js";
import { orders } from "./orders.js";

/**
 * Kitchen display. A display destination is a routing target like a kitchen
 * printer (same tags, order types and sources); display stations show the
 * destinations they are assigned. A fire creates one ticket per destination it
 * routes to, in the same transaction as the print jobs.
 */

export const displayDestinations = pgTable(
  "display_destinations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    merchantId: uuid("merchant_id")
      .notNull()
      .references(() => merchants.id, { onDelete: "cascade" }),
    outletId: uuid("outlet_id")
      .notNull()
      .references(() => outlets.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    includeTags: text("include_tags").array().notNull().default([]),
    excludeTags: text("exclude_tags").array().notNull().default([]),
    /** Empty = every order type. */
    orderTypes: text("order_types").array().notNull().default([]),
    /** Empty = every source (pos, guest). */
    sources: text("sources").array().notNull().default([]),
    /** Takes the items no other display destination matched, as the default kitchen printer does for printers. */
    isDefault: boolean("is_default").notNull().default(false),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("display_destinations_outlet_idx").on(t.outletId)],
);

/** new → in_progress → ready (bumped); ready → recalled → ready; any → cancelled when the order is cancelled. */
export const kitchenTicketStatusEnum = pgEnum("kitchen_ticket_status", ["new", "in_progress", "ready", "recalled", "cancelled"]);

export const kitchenTickets = pgTable(
  "kitchen_tickets",
  {
    id: uuid("id").primaryKey(),
    merchantId: uuid("merchant_id").notNull(),
    outletId: uuid("outlet_id")
      .notNull()
      .references(() => outlets.id, { onDelete: "cascade" }),
    destinationId: uuid("destination_id")
      .notNull()
      .references(() => displayDestinations.id),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    /** The order's fire round this ticket carries. */
    roundNo: integer("round_no").notNull(),
    /* The order as it was when the round was sent, so a later move or type change never edits a ticket silently. */
    orderNo: text("order_no").notNull(),
    orderType: text("order_type").notNull(),
    tableName: text("table_name"),
    pax: integer("pax"),
    customerName: text("customer_name"),
    serverName: text("server_name"),
    status: kitchenTicketStatusEnum("status").notNull().default("new"),
    /** Set when a later event (a void) changed the ticket after it reached the display. */
    changed: boolean("changed").notNull().default(false),
    firedAt: timestamp("fired_at", { withTimezone: true }).notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    /** Set by a bump; cleared by a recall. A ticket is on the display while this is null. */
    bumpedAt: timestamp("bumped_at", { withTimezone: true }),
    recalledAt: timestamp("recalled_at", { withTimezone: true }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    changedAt: timestamp("changed_at", { withTimezone: true }),
  },
  // One ticket per fire round per destination: a retried fire can never show the same round twice.
  (t) => [index("kitchen_tickets_destination_idx").on(t.destinationId, t.bumpedAt, t.firedAt), uniqueIndex("kitchen_tickets_order_round_destination_key").on(t.orderId, t.roundNo, t.destinationId)],
);

export const kitchenTicketLines = pgTable(
  "kitchen_ticket_lines",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    merchantId: uuid("merchant_id").notNull(),
    outletId: uuid("outlet_id").notNull(),
    ticketId: uuid("ticket_id")
      .notNull()
      .references(() => kitchenTickets.id, { onDelete: "cascade" }),
    orderLineId: uuid("order_line_id").notNull(),
    productId: uuid("product_id").notNull(),
    /** Kitchen name at the time of the fire. */
    name: text("name").notNull(),
    quantity: integer("quantity").notNull(),
    /** Voided after the fire; the display strikes the line when it reaches the quantity. */
    voidedQuantity: integer("voided_quantity").notNull().default(0),
    modifiers: text("modifiers").array().notNull().default([]),
    notes: text("notes"),
    seatNo: integer("seat_no"),
    source: text("source").notNull().default("pos"),
    sort: integer("sort").notNull().default(0),
  },
  (t) => [index("kitchen_ticket_lines_ticket_idx").on(t.ticketId), index("kitchen_ticket_lines_order_line_idx").on(t.orderLineId)],
);
