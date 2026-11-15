import { bigint, boolean, index, integer, jsonb, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import type { TaxBreakdown, TaxRate } from "@sail/shared";
import { brands, merchants, outlets, stations } from "./org.js";
import { channelLinks, tables, voidReasons } from "./catalogue.js";
import { customers } from "./customers.js";
import { staff } from "./staff.js";

/**
 * Orders: one model with an order_type. Current-state tables
 * are authoritative; every change also appends to `events` (per-outlet
 * sequence). Money columns are integer cents written only from the pricing
 * pipeline's result.
 */
export const orderStatusEnum = pgEnum("order_status", ["open", "fired", "ready", "out_for_delivery", "completed", "cancelled"]);
export const lineStatusEnum = pgEnum("line_status", ["pending", "held", "fired", "voided"]);
export const lineSourceEnum = pgEnum("line_source", ["pos", "guest"]);

export const orders = pgTable(
  "orders",
  {
    /** Client-generated. */
    id: uuid("id").primaryKey(),
    merchantId: uuid("merchant_id")
      .notNull()
      .references(() => merchants.id, { onDelete: "cascade" }),
    outletId: uuid("outlet_id")
      .notNull()
      .references(() => outlets.id),
    brandId: uuid("brand_id")
      .notNull()
      .references(() => brands.id),
    channelLinkId: uuid("channel_link_id")
      .notNull()
      .references(() => channelLinks.id),
    channel: text("channel").notNull(),
    orderType: text("order_type").notNull(),
    /** `P-0042` or `QR-0007`: source prefix plus a per-outlet sequence. */
    orderNo: text("order_no").notNull(),
    status: orderStatusEnum("status").notNull().default("open"),
    /** Optimistic concurrency. */
    version: integer("version").notNull().default(1),
    tableId: uuid("table_id").references(() => tables.id),
    pax: integer("pax"),
    customerId: uuid("customer_id").references(() => customers.id),
    customerRef: jsonb("customer_ref").$type<{ name?: string; mobile?: string } | null>(),
    deliveryAddress: text("delivery_address"),
    deliveryNotes: text("delivery_notes"),
    readyBy: timestamp("ready_by", { withTimezone: true }),
    notes: text("notes"),
    stationId: uuid("station_id").references(() => stations.id),
    openedBy: uuid("opened_by").references(() => staff.id),
    openedByName: text("opened_by_name"),
    businessDate: text("business_date").notNull(),
    /* Totals from the latest pricing run. */
    taxMode: text("tax_mode").notNull(),
    taxRounding: text("tax_rounding").notNull(),
    /** The merchant's tax rates when the order was opened: later rate changes never re-price it. */
    taxRates: jsonb("tax_rates").$type<TaxRate[]>().notNull(),
    subtotal: bigint("subtotal", { mode: "number" }).notNull().default(0),
    discountTotal: bigint("discount_total", { mode: "number" }).notNull().default(0),
    feeTotal: bigint("fee_total", { mode: "number" }).notNull().default(0),
    taxTotal: bigint("tax_total", { mode: "number" }).notNull().default(0),
    /** tax_total by component, with the amount it was charged on. */
    taxes: jsonb("taxes").$type<TaxBreakdown[]>().notNull().default([]),
    total: bigint("total", { mode: "number" }).notNull().default(0),
    pricingFrozenAt: timestamp("pricing_frozen_at", { withTimezone: true }),
    /** Frozen order-level results, stored at the first payment (v0.6). */
    frozenAdjustments: jsonb("frozen_adjustments").$type<unknown[] | null>(),
    /** Set when a pre-bill was printed (table status "bill requested"). */
    billRequestedAt: timestamp("bill_requested_at", { withTimezone: true }),
    /** Number of fire rounds so far. */
    roundCount: integer("round_count").notNull().default(0),
    openedAt: timestamp("opened_at", { withTimezone: true }).notNull().defaultNow(),
    firstFiredAt: timestamp("first_fired_at", { withTimezone: true }),
    readyAt: timestamp("ready_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    cancelReason: text("cancel_reason"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("orders_outlet_status_idx").on(t.outletId, t.status),
    index("orders_outlet_business_date_idx").on(t.outletId, t.businessDate),
    uniqueIndex("orders_outlet_no_uq").on(t.outletId, t.orderNo),
    index("orders_table_idx").on(t.tableId, t.status),
    index("orders_ready_by_idx").on(t.outletId, t.readyBy),
  ],
);

export type LineModifier = { modifier_id: string; product_id: string; name: string; quantity: number; price: number; group_id: string };

export const orderLines = pgTable(
  "order_lines",
  {
    /** Client-generated. */
    id: uuid("id").primaryKey(),
    merchantId: uuid("merchant_id").notNull(),
    outletId: uuid("outlet_id").notNull(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    productId: uuid("product_id").notNull(),
    /* Catalogue snapshot at the time the line was added. */
    name: text("name").notNull(),
    kitchenName: text("kitchen_name"),
    sku: text("sku"),
    categoryId: uuid("category_id"),
    parentCategoryId: uuid("parent_category_id"),
    tags: text("tags").array().notNull().default([]),
    hasDeposit: boolean("has_deposit").notNull().default(false),
    /** The product's tax class (or the merchant default) when the line was added. */
    taxClassId: uuid("tax_class_id").notNull(),
    quantity: integer("quantity").notNull(),
    /** Resolved unit price (open price, order-type price or base price). */
    unitPrice: bigint("unit_price", { mode: "number" }).notNull(),
    basePrice: bigint("base_price", { mode: "number" }).notNull(),
    pricesByOrderType: jsonb("prices_by_order_type").$type<Record<string, number>>().notNull().default({}),
    openPrice: bigint("open_price", { mode: "number" }),
    modifiers: jsonb("modifiers").$type<LineModifier[]>().notNull().default([]),
    notes: text("notes"),
    /** Null = shared (no seat). */
    seatNo: integer("seat_no"),
    source: lineSourceEnum("source").notNull().default("pos"),
    roundId: uuid("round_id"),
    status: lineStatusEnum("status").notNull().default("pending"),
    fireRound: integer("fire_round"),
    firedAt: timestamp("fired_at", { withTimezone: true }),
    firedBy: uuid("fired_by"),
    firedFromStationId: uuid("fired_from_station_id"),
    voidedAt: timestamp("voided_at", { withTimezone: true }),
    voidReasonId: uuid("void_reason_id").references(() => voidReasons.id),
    voidReason: text("void_reason"),
    voidedBy: uuid("voided_by"),
    voidApprovedBy: uuid("void_approved_by"),
    voidOverrideId: uuid("void_override_id"),
    /* Amounts from the latest pricing run (0 for voided lines). */
    baseAmount: bigint("base_amount", { mode: "number" }).notNull().default(0),
    discountAmount: bigint("discount_amount", { mode: "number" }).notNull().default(0),
    netAmount: bigint("net_amount", { mode: "number" }).notNull().default(0),
    feeAmount: bigint("fee_amount", { mode: "number" }).notNull().default(0),
    taxAmount: bigint("tax_amount", { mode: "number" }).notNull().default(0),
    /** tax_amount by component, with the amounts each was charged on. */
    taxes: jsonb("taxes").$type<TaxBreakdown[]>().notNull().default([]),
    total: bigint("total", { mode: "number" }).notNull().default(0),
    sort: integer("sort").notNull().default(0),
    addedBy: uuid("added_by"),
    addedByName: text("added_by_name"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("order_lines_order_idx").on(t.orderId, t.status), index("order_lines_outlet_idx").on(t.outletId)],
);

/** Manual rule applications on an order (the input to the pricing pipeline). */
export const orderManualApplications = pgTable(
  "order_manual_applications",
  {
    id: uuid("id").primaryKey(),
    merchantId: uuid("merchant_id").notNull(),
    outletId: uuid("outlet_id").notNull(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    ruleKey: text("rule_key").notNull(),
    enteredValue: bigint("entered_value", { mode: "number" }),
    lineIds: uuid("line_ids").array(),
    appliedBy: uuid("applied_by"),
    appliedByName: text("applied_by_name"),
    approvedBy: uuid("approved_by"),
    approvedByName: text("approved_by_name"),
    overrideId: uuid("override_id"),
    reason: text("reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    removedAt: timestamp("removed_at", { withTimezone: true }),
    removedBy: uuid("removed_by"),
  },
  (t) => [index("order_manual_applications_order_idx").on(t.orderId)],
);

/** One row per rule application from the latest pricing run. */
export const orderAdjustments = pgTable(
  "order_adjustments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    merchantId: uuid("merchant_id").notNull(),
    outletId: uuid("outlet_id").notNull(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    ruleKey: text("rule_key").notNull(),
    ruleVersion: integer("rule_version").notNull(),
    ruleSnapshot: jsonb("rule_snapshot").$type<unknown>().notNull(),
    kind: text("kind").notNull(),
    level: text("level").notNull(),
    name: text("name").notNull(),
    reportClass: text("report_class").notNull(),
    /** Fees: the class the fee was taxed at, null when untaxed. Null for discounts. */
    taxClassId: uuid("tax_class_id"),
    total: bigint("total", { mode: "number" }).notNull(),
    taxTotal: bigint("tax_total", { mode: "number" }).notNull(),
    capped: boolean("capped").notNull().default(false),
    frozen: boolean("frozen").notNull().default(false),
    manualApplicationId: uuid("manual_application_id"),
    enteredValue: bigint("entered_value", { mode: "number" }),
    appliedBy: uuid("applied_by"),
    approvedBy: uuid("approved_by"),
    overrideId: uuid("override_id"),
    reason: text("reason"),
    sort: integer("sort").notNull().default(0),
  },
  (t) => [index("order_adjustments_order_idx").on(t.orderId)],
);

/** The per-line amounts. Splits and refunds read only these. Sum per adjustment is enforced in the database. */
export const orderAdjustmentLines = pgTable(
  "order_adjustment_lines",
  {
    merchantId: uuid("merchant_id").notNull(),
    adjustmentId: uuid("adjustment_id")
      .notNull()
      .references(() => orderAdjustments.id, { onDelete: "cascade" }),
    orderLineId: uuid("order_line_id")
      .notNull()
      .references(() => orderLines.id, { onDelete: "cascade" }),
    amount: bigint("amount", { mode: "number" }).notNull(),
    taxAmount: bigint("tax_amount", { mode: "number" }).notNull().default(0),
  },
  (t) => [uniqueIndex("order_adjustment_lines_uq").on(t.adjustmentId, t.orderLineId), index("order_adjustment_lines_line_idx").on(t.orderLineId)],
);

/** Single-use manager override grants. */
export const overrides = pgTable(
  "overrides",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    merchantId: uuid("merchant_id").notNull(),
    outletId: uuid("outlet_id").notNull(),
    action: text("action").notNull(),
    targetKind: text("target_kind").notNull(),
    targetId: text("target_id").notNull(),
    /** The protected request's arguments the approver saw; the request must match them exactly. */
    args: jsonb("args").$type<Record<string, unknown>>().notNull().default({}),
    approverId: uuid("approver_id").notNull(),
    approverName: text("approver_name"),
    approverRole: text("approver_role").notNull(),
    requesterId: text("requester_id").notNull(),
    requesterName: text("requester_name"),
    /** The PIN session and station that asked; only they can spend the grant. */
    requesterSessionId: uuid("requester_session_id"),
    stationId: uuid("station_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    usedBy: text("used_by"),
  },
  (t) => [index("overrides_outlet_idx").on(t.outletId, t.expiresAt)],
);

/** One-time station pairing codes. */
export const stationPairingCodes = pgTable(
  "station_pairing_codes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    merchantId: uuid("merchant_id").notNull(),
    stationId: uuid("station_id")
      .notNull()
      .references(() => stations.id, { onDelete: "cascade" }),
    codeHash: text("code_hash").notNull(),
    createdBy: uuid("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
  },
  (t) => [index("station_pairing_codes_station_idx").on(t.stationId)],
);
