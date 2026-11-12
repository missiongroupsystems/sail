import { boolean, index, integer, jsonb, pgEnum, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

/** Merchant > Brand > Outlet > Station. Every row carries merchant_id. */

export const taxModeEnum = pgEnum("tax_mode", ["inclusive", "exclusive"]);
export const taxRoundingEnum = pgEnum("tax_rounding", ["per_line", "per_rate"]);

export const merchants = pgTable("merchants", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const merchantSettings = pgTable("merchant_settings", {
  merchantId: uuid("merchant_id")
    .primaryKey()
    .references(() => merchants.id, { onDelete: "cascade" }),
  taxMode: taxModeEnum("tax_mode").notNull().default("exclusive"),
  taxRounding: taxRoundingEnum("tax_rounding").notNull(),
  /** Null = cash rounding off. Otherwise the increment in minor units of the currency, for example 5 (CHF 0.05) or 100 (SEK 1). */
  cashRoundingIncrement: integer("cash_rounding_increment"),
  /** Notes and coins the POS cash counter offers, largest first, in minor units. Empty = enter the total only. */
  cashDenominations: integer("cash_denominations").array().notNull().default([]),
  /** Closing a shift more than this many minor units out needs a reason. */
  cashVarianceThreshold: integer("cash_variance_threshold").notNull(),
  /** HH:MM local time at which the business day rolls over. */
  businessDayCutoff: text("business_day_cutoff").notNull().default("04:00"),
  /** IANA time zone; required, never defaulted. */
  timezone: text("timezone").notNull(),
  /** ISO 4217; fixes the minor-unit exponent of every stored amount, so it never changes once set. */
  currency: text("currency").notNull(),
  /** BCP 47 locale for money, dates and times, for example "en-GB". */
  locale: text("locale").notNull(),
  /** Printed before the outlet's registration numbers on documents, for example "Company no." and "VAT no.". */
  businessRegistrationLabel: text("business_registration_label").notNull(),
  taxRegistrationLabel: text("tax_registration_label").notNull(),
  receiptFooter: text("receipt_footer"),
  receiptShowOutletPhone: boolean("receipt_show_outlet_phone").notNull().default(true),
  /** Outlets with more open orders than this show the POS in busy mode. */
  busyModeThreshold: integer("busy_mode_threshold").notNull().default(12),
  /** A kitchen display ticket turns amber after this many minutes and red after the late threshold. */
  kitchenWarnMinutes: integer("kitchen_warn_minutes").notNull().default(8),
  kitchenLateMinutes: integer("kitchen_late_minutes").notNull().default(15),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const brands = pgTable(
  "brands",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    merchantId: uuid("merchant_id")
      .notNull()
      .references(() => merchants.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** Brand accent colour (hex) for the order header stripe and the guest app. */
    accentColor: text("accent_color"),
    displayFont: text("display_font"),
    logoUrl: text("logo_url"),
    legacyId: text("legacy_id"),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("brands_merchant_idx").on(t.merchantId)],
);

export const outlets = pgTable(
  "outlets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    merchantId: uuid("merchant_id")
      .notNull()
      .references(() => merchants.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    address: text("address"),
    phone: text("phone"),
    /** Company or business registration number printed on documents, after the merchant's label. */
    businessRegistrationNo: text("business_registration_no"),
    /** Tax (VAT, sales tax) registration number printed on documents. */
    taxRegistrationNo: text("tax_registration_no"),
    /** Overrides the merchant cutoff when set. */
    businessDayCutoff: text("business_day_cutoff"),
    /** Opening hours by weekday: { mon: [["11:00","22:00"]], ... } */
    hours: jsonb("hours").$type<Record<string, [string, string][]>>().notNull().default({}),
    /** Service (dark) theme starts at this local time. */
    serviceThemeFrom: text("service_theme_from").default("18:00"),
    legacyId: text("legacy_id"),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("outlets_merchant_idx").on(t.merchantId)],
);

export const stationHomeEnum = pgEnum("station_home", ["floor", "takeaway"]);
/** A POS iPad, or a kitchen display that shows and bumps tickets without a PIN. */
export const stationKindEnum = pgEnum("station_kind", ["pos", "display"]);

export const stations = pgTable(
  "stations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    merchantId: uuid("merchant_id")
      .notNull()
      .references(() => merchants.id, { onDelete: "cascade" }),
    outletId: uuid("outlet_id")
      .notNull()
      .references(() => outlets.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    kind: stationKindEnum("kind").notNull().default("pos"),
    /** A display station shows the tickets of these display destinations (same outlet). */
    displayDestinationIds: uuid("display_destination_ids").array().notNull().default([]),
    /** POS layout (per brand); set in v0.4 when layouts exist. */
    layoutId: uuid("layout_id"),
    brandId: uuid("brand_id").references(() => brands.id),
    payBeforeFiring: boolean("pay_before_firing").notNull().default(false),
    seatsEnabled: boolean("seats_enabled").notNull().default(false),
    home: stationHomeEnum("home").notNull().default("floor"),
    receiptPrinterId: uuid("receipt_printer_id"),
    textSize: text("text_size").notNull().default("standard"),
    /** Set when an iPad is paired (v0.4). */
    pairedAt: timestamp("paired_at", { withTimezone: true }),
    deviceLabel: text("device_label"),
    /** Hash of the current station token; rotating it un-pairs the old iPad. */
    tokenHash: text("token_hash"),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("stations_outlet_idx").on(t.merchantId, t.outletId)],
);
