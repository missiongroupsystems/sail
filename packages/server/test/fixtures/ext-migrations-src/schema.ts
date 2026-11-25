// The fixture extension's tables as a downstream declares them with Drizzle; `drizzle-kit generate` with
// drizzle.config.ts beside this file wrote ../ext-migrations/0000_*.sql. Sail's tables it points at are declared here
// with only the columns the keys need, and schemaFilter keeps drizzle-kit to the extension's own schema.
import { foreignKey, pgSchema, pgTable, serial, text, uuid } from "drizzle-orm/pg-core";

const merchants = pgTable("merchants", { id: uuid("id").primaryKey() });
const outlets = pgTable("outlets", { id: uuid("id").primaryKey(), merchantId: uuid("merchant_id").notNull() });
const brands = pgTable("brands", { id: uuid("id").primaryKey(), merchantId: uuid("merchant_id").notNull() });

export const extFixture = pgSchema("ext_fixture");

export const notes = extFixture.table(
  "notes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    merchantId: uuid("merchant_id").notNull().references(() => merchants.id),
    outletId: uuid("outlet_id").notNull(),
    brandId: uuid("brand_id"),
    /** From a sequence the first migration makes, before the grants: the recipe grants the sequences already there. */
    number: serial("number").notNull(),
    body: text("body").notNull(),
    /** A customer's contact column: staff read it, agents never do. */
    email: text("email"),
  },
  (t) => [
    // Composite: the outlet and the brand must be the row's own merchant's.
    foreignKey({ columns: [t.outletId, t.merchantId], foreignColumns: [outlets.id, outlets.merchantId], name: "notes_outlet_same_merchant" }),
    foreignKey({ columns: [t.brandId, t.merchantId], foreignColumns: [brands.id, brands.merchantId], name: "notes_brand_same_merchant" }),
  ],
);
