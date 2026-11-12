import { boolean, index, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { merchants } from "./org.js";

/** Customers and customer groups. Groups feed pricing-rule conditions. */
export const customers = pgTable(
  "customers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    merchantId: uuid("merchant_id")
      .notNull()
      .references(() => merchants.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    mobile: text("mobile"),
    email: text("email"),
    marketingConsent: boolean("marketing_consent").notNull().default(false),
    notes: text("notes"),
    legacyId: text("legacy_id"),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("customers_mobile_uq").on(t.merchantId, t.mobile), uniqueIndex("customers_legacy_uq").on(t.merchantId, t.legacyId), index("customers_name_idx").on(t.merchantId, t.name)],
);

export const customerGroups = pgTable(
  "customer_groups",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    merchantId: uuid("merchant_id")
      .notNull()
      .references(() => merchants.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (t) => [index("customer_groups_merchant_idx").on(t.merchantId)],
);

export const customerGroupMembers = pgTable(
  "customer_group_members",
  {
    merchantId: uuid("merchant_id").notNull(),
    groupId: uuid("group_id")
      .notNull()
      .references(() => customerGroups.id, { onDelete: "cascade" }),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "cascade" }),
    addedAt: timestamp("added_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.groupId, t.customerId] }), index("customer_group_members_customer_idx").on(t.customerId)],
);
