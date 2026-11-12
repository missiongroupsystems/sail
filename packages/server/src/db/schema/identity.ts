import { index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { merchants } from "./org.js";
import { staff } from "./staff.js";

/**
 * Back-office sign-in for a staff member. With the `local` identity provider it holds the scrypt password hash; with
 * `oidc` it is the email an Admin pre-authorised, linked to the issuer's subject (`staff.auth_subject`) on first
 * sign-in. The email is lower-cased and unique across the server, because sign-in starts from the email alone.
 */
export const backofficeLogins = pgTable(
  "backoffice_logins",
  {
    staffId: uuid("staff_id")
      .primaryKey()
      .references(() => staff.id, { onDelete: "cascade" }),
    merchantId: uuid("merchant_id")
      .notNull()
      .references(() => merchants.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    passwordHash: text("password_hash"),
    passwordChangedAt: timestamp("password_changed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("backoffice_logins_email_uq").on(t.email), index("backoffice_logins_merchant_idx").on(t.merchantId)],
);

/** Sessions issued by the `local` provider. The bearer token names one row; ending or expiring the row ends the token. */
export const backofficeSessions = pgTable(
  "backoffice_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    merchantId: uuid("merchant_id")
      .notNull()
      .references(() => merchants.id, { onDelete: "cascade" }),
    staffId: uuid("staff_id")
      .notNull()
      .references(() => staff.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
  },
  (t) => [index("backoffice_sessions_staff_idx").on(t.staffId, t.endedAt)],
);

/** Single-use links an Admin generates: an invitation to set a first password, or a password reset. Only the hash is kept. */
export const backofficeLinks = pgTable(
  "backoffice_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    merchantId: uuid("merchant_id")
      .notNull()
      .references(() => merchants.id, { onDelete: "cascade" }),
    staffId: uuid("staff_id")
      .notNull()
      .references(() => staff.id, { onDelete: "cascade" }),
    /** invite | reset */
    kind: text("kind").notNull(),
    tokenHash: text("token_hash").notNull(),
    createdBy: uuid("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [uniqueIndex("backoffice_links_token_uq").on(t.tokenHash), index("backoffice_links_staff_idx").on(t.staffId)],
);
