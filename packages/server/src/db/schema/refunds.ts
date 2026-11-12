import { bigint, boolean, index, integer, jsonb, pgEnum, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import type { TaxAmount } from "@sail/shared";
import { orderLines, orders } from "./orders.js";
import { checks, payments } from "./payments.js";

/** Refunds: full, by lines or by amount, against one check, assigned to original payments. Immutable once created. */
export const refundKindEnum = pgEnum("refund_kind", ["full", "lines", "amount"]);

export const refunds = pgTable(
  "refunds",
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
    kind: refundKindEnum("kind").notNull(),
    reason: text("reason").notNull(),
    refundedBy: uuid("refunded_by"),
    refundedByName: text("refunded_by_name"),
    approvedBy: uuid("approved_by"),
    approvedByName: text("approved_by_name"),
    overrideId: uuid("override_id"),
    stationId: uuid("station_id"),
    shiftId: uuid("shift_id"),
    /** Refunds count on the business day they happen. */
    businessDate: text("business_date").notNull(),
    base: bigint("base", { mode: "number" }).notNull(),
    discount: bigint("discount", { mode: "number" }).notNull(),
    fee: bigint("fee", { mode: "number" }).notNull(),
    tax: bigint("tax", { mode: "number" }).notNull(),
    taxes: jsonb("taxes").$type<TaxAmount[]>().notNull().default([]),
    total: bigint("total", { mode: "number" }).notNull(),
    refundReceiptNo: text("refund_receipt_no").notNull(),
    creditNoteNo: text("credit_note_no"),
    /** Snapshot documents, so receipts and credit notes reproduce exactly. */
    receiptDocument: jsonb("receipt_document").$type<unknown>().notNull(),
    creditNoteDocument: jsonb("credit_note_document").$type<unknown>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("refunds_check_idx").on(t.checkId), index("refunds_outlet_date_idx").on(t.outletId, t.businessDate)],
);

export const refundLines = pgTable(
  "refund_lines",
  {
    merchantId: uuid("merchant_id").notNull(),
    refundId: uuid("refund_id")
      .notNull()
      .references(() => refunds.id, { onDelete: "cascade" }),
    orderLineId: uuid("order_line_id")
      .notNull()
      .references(() => orderLines.id),
    /** 0 for goodwill (by amount) refunds. */
    quantity: integer("quantity").notNull(),
    base: bigint("base", { mode: "number" }).notNull(),
    discount: bigint("discount", { mode: "number" }).notNull(),
    fee: bigint("fee", { mode: "number" }).notNull(),
    tax: bigint("tax", { mode: "number" }).notNull(),
    taxes: jsonb("taxes").$type<TaxAmount[]>().notNull().default([]),
    total: bigint("total", { mode: "number" }).notNull(),
    adjustments: jsonb("adjustments").$type<Record<string, { amount: number; tax: number }>>().notNull().default({}),
  },
  (t) => [primaryKey({ columns: [t.refundId, t.orderLineId] }), index("refund_lines_line_idx").on(t.orderLineId)],
);

export const refundTenders = pgTable(
  "refund_tenders",
  {
    merchantId: uuid("merchant_id").notNull(),
    refundId: uuid("refund_id")
      .notNull()
      .references(() => refunds.id, { onDelete: "cascade" }),
    paymentId: uuid("payment_id")
      .notNull()
      .references(() => payments.id),
    tenderName: text("tender_name").notNull(),
    isCash: boolean("is_cash").notNull(),
    amount: bigint("amount", { mode: "number" }).notNull(),
    roundingCents: bigint("rounding_cents", { mode: "number" }).notNull().default(0),
    reference: text("reference"),
  },
  (t) => [primaryKey({ columns: [t.refundId, t.paymentId] }), index("refund_tenders_payment_idx").on(t.paymentId)],
);
