import { boolean, index, integer, jsonb, pgEnum, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import type { TaxAmount } from "@sail/shared";
import { merchants, outlets, stations } from "./org.js";
import { orderLines, orders } from "./orders.js";
import { tenderTypes } from "./catalogue.js";

/** Checks (bills), allocations, payments, document numbering, shifts and business days. */

export const checkStatusEnum = pgEnum("check_status", ["open", "paid", "partially_refunded", "refunded"]);

export const checks = pgTable(
  "checks",
  {
    id: uuid("id").primaryKey(),
    merchantId: uuid("merchant_id").notNull(),
    outletId: uuid("outlet_id").notNull(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    index: integer("index").notNull(),
    label: text("label").notNull(),
    status: checkStatusEnum("status").notNull().default("open"),
    /** Seat number for by-seat splits; null otherwise. */
    seatNo: integer("seat_no"),
    /* Totals: sums of this check's allocations. */
    subtotal: integer("subtotal").notNull().default(0),
    discountTotal: integer("discount_total").notNull().default(0),
    feeTotal: integer("fee_total").notNull().default(0),
    taxTotal: integer("tax_total").notNull().default(0),
    /** tax_total by component: the sums of the allocations' components. */
    taxes: jsonb("taxes").$type<TaxAmount[]>().notNull().default([]),
    total: integer("total").notNull().default(0),
    paidTotal: integer("paid_total").notNull().default(0),
    roundingTotal: integer("rounding_total").notNull().default(0),
    refundedTotal: integer("refunded_total").notNull().default(0),
    /** Set by the first payment: allocations are then fixed. */
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    invoiceNo: text("invoice_no"),
    invoiceIssuedAt: timestamp("invoice_issued_at", { withTimezone: true }),
    /** Snapshot of the bill document when the invoice was issued, so the PDF reproduces exactly. */
    invoiceDocument: jsonb("invoice_document").$type<unknown>(),
    receiptNo: text("receipt_no"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("checks_order_index_uq").on(t.orderId, t.index), index("checks_outlet_idx").on(t.outletId, t.status)],
);

/**
 * Every order line is allocated to checks; the per-component allocated cents
 * sum across checks to the line's components (enforced in the database).
 * Shares are equal fractions (1/1, 1/2, 1/3 ...) in v0.9.
 */
export const checkAllocations = pgTable(
  "check_allocations",
  {
    merchantId: uuid("merchant_id").notNull(),
    checkId: uuid("check_id")
      .notNull()
      .references(() => checks.id, { onDelete: "cascade" }),
    orderLineId: uuid("order_line_id")
      .notNull()
      .references(() => orderLines.id, { onDelete: "cascade" }),
    shareNum: integer("share_num").notNull().default(1),
    shareDen: integer("share_den").notNull().default(1),
    base: integer("base").notNull().default(0),
    discount: integer("discount").notNull().default(0),
    fee: integer("fee").notNull().default(0),
    tax: integer("tax").notNull().default(0),
    /** tax by component. */
    taxes: jsonb("taxes").$type<TaxAmount[]>().notNull().default([]),
    total: integer("total").notNull().default(0),
    /** Per-adjustment allocated cents: { [adjustment_id]: { amount, tax } } */
    adjustments: jsonb("adjustments").$type<Record<string, { amount: number; tax: number }>>().notNull().default({}),
  },
  (t) => [primaryKey({ columns: [t.checkId, t.orderLineId] }), index("check_allocations_line_idx").on(t.orderLineId)],
);

export const paymentStatusEnum = pgEnum("payment_status", ["recorded", "reversed"]);

export const payments = pgTable(
  "payments",
  {
    /** Client-generated. */
    id: uuid("id").primaryKey(),
    merchantId: uuid("merchant_id").notNull(),
    outletId: uuid("outlet_id").notNull(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id),
    checkId: uuid("check_id")
      .notNull()
      .references(() => checks.id),
    tenderTypeId: uuid("tender_type_id")
      .notNull()
      .references(() => tenderTypes.id),
    tenderName: text("tender_name").notNull(),
    isCash: boolean("is_cash").notNull(),
    /** Amount applied to the check's balance. */
    amount: integer("amount").notNull(),
    /** Cash rounding: rounded(balance) − balance, on the cash tender that settled the check. */
    roundingCents: integer("rounding_cents").notNull().default(0),
    /** Cash handed over, when given; change = tendered − (amount + rounding). */
    tendered: integer("tendered"),
    changeCents: integer("change_cents").notNull().default(0),
    tipCents: integer("tip_cents").notNull().default(0),
    reference: text("reference"),
    status: paymentStatusEnum("status").notNull().default("recorded"),
    recordedBy: uuid("recorded_by"),
    recordedByName: text("recorded_by_name"),
    stationId: uuid("station_id").references(() => stations.id),
    shiftId: uuid("shift_id"),
    businessDate: text("business_date").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    reversedAt: timestamp("reversed_at", { withTimezone: true }),
    reversedBy: uuid("reversed_by"),
    reversedReason: text("reversed_reason"),
  },
  (t) => [index("payments_check_idx").on(t.checkId), index("payments_outlet_date_idx").on(t.outletId, t.businessDate), index("payments_shift_idx").on(t.shiftId)],
);

/** Gap-free document numbering per merchant, incremented inside the transaction. */
export const documentSequences = pgTable(
  "document_sequences",
  {
    merchantId: uuid("merchant_id")
      .notNull()
      .references(() => merchants.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    nextNo: integer("next_no").notNull().default(1),
    prefix: text("prefix").notNull().default(""),
  },
  (t) => [primaryKey({ columns: [t.merchantId, t.kind] })],
);

export const shiftStatusEnum = pgEnum("shift_status", ["open", "closed"]);

export const shifts = pgTable(
  "shifts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    merchantId: uuid("merchant_id").notNull(),
    outletId: uuid("outlet_id")
      .notNull()
      .references(() => outlets.id),
    /** Null = an outlet-wide shift. */
    stationId: uuid("station_id").references(() => stations.id),
    name: text("name"),
    status: shiftStatusEnum("status").notNull().default("open"),
    businessDate: text("business_date").notNull(),
    openedBy: uuid("opened_by"),
    openedByName: text("opened_by_name"),
    openedAt: timestamp("opened_at", { withTimezone: true }).notNull().defaultNow(),
    floatCents: integer("float_cents").notNull().default(0),
    floatCounts: jsonb("float_counts").$type<Record<string, number> | null>(),
    closedBy: uuid("closed_by"),
    closedByName: text("closed_by_name"),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    countedCashCents: integer("counted_cash_cents"),
    countedCounts: jsonb("counted_counts").$type<Record<string, number> | null>(),
    expectedCashCents: integer("expected_cash_cents"),
    varianceCents: integer("variance_cents"),
    varianceReason: text("variance_reason"),
    /** The figures at close, so the shift record stands on its own. */
    summary: jsonb("summary").$type<unknown>(),
  },
  (t) => [index("shifts_outlet_idx").on(t.outletId, t.status), index("shifts_station_idx").on(t.stationId, t.status)],
);

export const businessDayCloses = pgTable(
  "business_day_closes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    merchantId: uuid("merchant_id").notNull(),
    outletId: uuid("outlet_id")
      .notNull()
      .references(() => outlets.id),
    businessDate: text("business_date").notNull(),
    closedBy: uuid("closed_by"),
    closedByName: text("closed_by_name"),
    closedAt: timestamp("closed_at", { withTimezone: true }).notNull().defaultNow(),
    zReport: jsonb("z_report").$type<unknown>().notNull(),
  },
  (t) => [uniqueIndex("business_day_closes_uq").on(t.outletId, t.businessDate)],
);

/** Digital receipts: an opaque token in a link or QR code; the page is public and read-only. */
export const digitalReceipts = pgTable(
  "digital_receipts",
  {
    token: text("token").primaryKey(),
    merchantId: uuid("merchant_id").notNull(),
    outletId: uuid("outlet_id").notNull(),
    checkId: uuid("check_id").references(() => checks.id, { onDelete: "cascade" }),
    refundId: uuid("refund_id"),
    /** The bill document as rendered at send time. */
    document: jsonb("document").$type<unknown>().notNull(),
    channel: text("channel").notNull(),
    destination: text("destination"),
    deliveryStatus: text("delivery_status").notNull().default("link_only"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => [index("digital_receipts_check_idx").on(t.checkId)],
);
