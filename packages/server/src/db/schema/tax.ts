import { sql } from "drizzle-orm";
import { boolean, index, jsonb, pgTable, text, timestamp, unique, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import type { TaxComponent } from "@sail/shared";
import { merchants, outlets } from "./org.js";

/**
 * Tax classes and rates (docs/pricing-semantics.md §8). Products, open items
 * and taxed fees name a class; a class's rate is the row matching the order's
 * outlet and order type most closely, falling back to the class's default row
 * (no outlet, no order type), which every class has. A rate is a list of named
 * components in basis points; an empty list is tax-exempt.
 */
export const taxClasses = pgTable(
  "tax_classes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    merchantId: uuid("merchant_id")
      .notNull()
      .references(() => merchants.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** Products with no class of their own use the merchant's default class. Exactly one per merchant. */
    isDefault: boolean("is_default").notNull().default(false),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("tax_classes_merchant_idx").on(t.merchantId), uniqueIndex("tax_classes_default_uq").on(t.merchantId).where(sql`${t.isDefault}`)],
);

export const taxRates = pgTable(
  "tax_rates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    merchantId: uuid("merchant_id")
      .notNull()
      .references(() => merchants.id, { onDelete: "cascade" }),
    taxClassId: uuid("tax_class_id")
      .notNull()
      .references(() => taxClasses.id, { onDelete: "cascade" }),
    /** Null = every outlet. */
    outletId: uuid("outlet_id").references(() => outlets.id, { onDelete: "cascade" }),
    /** Null = every order type. */
    orderType: text("order_type"),
    components: jsonb("components").$type<TaxComponent[]>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("tax_rates_merchant_idx").on(t.merchantId), unique("tax_rates_scope_uq").on(t.taxClassId, t.outletId, t.orderType).nullsNotDistinct()],
);
