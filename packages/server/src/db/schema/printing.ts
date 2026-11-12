import { boolean, index, integer, jsonb, pgEnum, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { merchants, outlets, stations } from "./org.js";

/** Network ESC/POS printing through a print relay at each outlet. */

export const printerRoleEnum = pgEnum("printer_role", ["kitchen", "receipt"]);

export const printers = pgTable(
  "printers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    merchantId: uuid("merchant_id")
      .notNull()
      .references(() => merchants.id, { onDelete: "cascade" }),
    outletId: uuid("outlet_id")
      .notNull()
      .references(() => outlets.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    ip: text("ip").notNull(),
    port: integer("port").notNull().default(9100),
    paperWidth: text("paper_width").notNull().default("80mm"),
    role: printerRoleEnum("role").notNull().default("kitchen"),
    /** Station-specific printer (bar station → bar printer); null = outlet printer. */
    stationId: uuid("station_id").references(() => stations.id, { onDelete: "set null" }),
    includeTags: text("include_tags").array().notNull().default([]),
    excludeTags: text("exclude_tags").array().notNull().default([]),
    /** Empty = every order type. */
    orderTypes: text("order_types").array().notNull().default([]),
    /** Empty = every source (pos, guest). */
    sources: text("sources").array().notNull().default([]),
    copies: integer("copies").notNull().default(1),
    backupPrinterId: uuid("backup_printer_id"),
    isDefaultKitchen: boolean("is_default_kitchen").notNull().default(false),
    /** The printer supports the DLE EOT status query. */
    supportsStatus: boolean("supports_status").notNull().default(true),
    /** The printer has a CJK code page; otherwise CJK text is rendered as an image. */
    codePageCjk: boolean("code_page_cjk").notNull().default(false),
    cut: boolean("cut").notNull().default(true),
    beep: boolean("beep").notNull().default(false),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("printers_outlet_idx").on(t.outletId)],
);

export const printRelays = pgTable(
  "print_relays",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    merchantId: uuid("merchant_id")
      .notNull()
      .references(() => merchants.id, { onDelete: "cascade" }),
    outletId: uuid("outlet_id")
      .notNull()
      .references(() => outlets.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    tokenHash: text("token_hash"),
    pairedAt: timestamp("paired_at", { withTimezone: true }),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    version: text("version"),
    /** Relay-reported printer reachability: { [printer_id]: { ok, checked_at, error } } */
    printerStatus: jsonb("printer_status").$type<Record<string, { ok: boolean; checked_at: string; error?: string }>>().notNull().default({}),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("print_relays_outlet_idx").on(t.outletId)],
);

export const relayPairingCodes = pgTable(
  "relay_pairing_codes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    merchantId: uuid("merchant_id").notNull(),
    relayId: uuid("relay_id")
      .notNull()
      .references(() => printRelays.id, { onDelete: "cascade" }),
    codeHash: text("code_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
  },
  (t) => [index("relay_pairing_codes_relay_idx").on(t.relayId)],
);

export const printJobStatusEnum = pgEnum("print_job_status", ["queued", "claimed", "printed", "failed", "rerouted"]);
export const printJobKindEnum = pgEnum("print_job_kind", ["kitchen", "void", "reprint", "prebill", "receipt", "refund_receipt", "service_slip", "test"]);

/** Durable print queue: queued → claimed → printed, or failed; failed/queued → rerouted. */
export const printJobs = pgTable(
  "print_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    merchantId: uuid("merchant_id").notNull(),
    outletId: uuid("outlet_id")
      .notNull()
      .references(() => outlets.id, { onDelete: "cascade" }),
    printerId: uuid("printer_id")
      .notNull()
      .references(() => printers.id),
    kind: printJobKindEnum("kind").notNull(),
    orderId: uuid("order_id"),
    checkId: uuid("check_id"),
    refundId: uuid("refund_id"),
    /** The rendered ESC/POS bytes, base64. Rendered on the server so templates change with a deploy. */
    payload: text("payload").notNull(),
    /** Plain-text rendering for previews and reprints in the back office. */
    text: text("text").notNull().default(""),
    /** The document data, so a reprint or a reroute can re-render for a different paper width. */
    document: jsonb("document").$type<unknown>().notNull().default({}),
    copyNo: integer("copy_no").notNull().default(1),
    copies: integer("copies").notNull().default(1),
    status: printJobStatusEnum("status").notNull().default("queued"),
    attempts: integer("attempts").notNull().default(0),
    claimedBy: uuid("claimed_by"),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    printedAt: timestamp("printed_at", { withTimezone: true }),
    failedAt: timestamp("failed_at", { withTimezone: true }),
    lastError: text("last_error"),
    reprintOf: uuid("reprint_of"),
    reroutedTo: uuid("rerouted_to"),
    reroutedFrom: uuid("rerouted_from"),
    requestedBy: text("requested_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("print_jobs_outlet_status_idx").on(t.outletId, t.status, t.createdAt), index("print_jobs_order_idx").on(t.orderId), index("print_jobs_printer_idx").on(t.printerId, t.status)],
);
