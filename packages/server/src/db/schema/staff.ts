import { boolean, index, integer, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { merchants, stations } from "./org.js";

export const roleEnum = pgEnum("staff_role", ["server", "cashier", "manager", "finance", "admin"]);

export const staff = pgTable(
  "staff",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    merchantId: uuid("merchant_id")
      .notNull()
      .references(() => merchants.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    initials: text("initials"),
    email: text("email"),
    /** Supabase Auth subject for back-office login. */
    authSubject: text("auth_subject"),
    role: roleEnum("role").notNull(),
    /** scrypt hash of the 6-digit POS PIN (v0.4). */
    pinHash: text("pin_hash"),
    /** HMAC(merchant_id:pin) with the server secret, for a single indexed lookup at sign-in. Unique per merchant. */
    pinLookup: text("pin_lookup"),
    pinFailedAttempts: integer("pin_failed_attempts").notNull().default(0),
    pinLockedUntil: timestamp("pin_locked_until", { withTimezone: true }),
    /** Outlet scope. Empty = every outlet of the merchant. */
    outletIds: uuid("outlet_ids").array().notNull().default([]),
    /** Brand scope. Empty = every brand. */
    brandIds: uuid("brand_ids").array().notNull().default([]),
    /** Optional risk ceiling: T0..T3. Null = role only. */
    riskCeiling: text("risk_ceiling"),
    leftHanded: boolean("left_handed").notNull().default(false),
    active: boolean("active").notNull().default(true),
    legacyId: text("legacy_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("staff_merchant_idx").on(t.merchantId),
    uniqueIndex("staff_auth_subject_uq").on(t.authSubject),
    uniqueIndex("staff_merchant_email_uq").on(t.merchantId, t.email),
    uniqueIndex("staff_merchant_pin_uq").on(t.merchantId, t.pinLookup),
  ],
);

/** PIN sessions on stations (v0.4). Short-lived; expire after inactivity. */
export const staffSessions = pgTable(
  "staff_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    merchantId: uuid("merchant_id")
      .notNull()
      .references(() => merchants.id, { onDelete: "cascade" }),
    staffId: uuid("staff_id")
      .notNull()
      .references(() => staff.id, { onDelete: "cascade" }),
    stationId: uuid("station_id")
      .notNull()
      .references(() => stations.id, { onDelete: "cascade" }),
    outletId: uuid("outlet_id").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
  },
  (t) => [index("staff_sessions_station_idx").on(t.stationId, t.endedAt)],
);
