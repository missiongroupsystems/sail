import { index, integer, jsonb, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { merchants } from "./org.js";

/**
 * Pricing rules (scope doc 4.8), versioned. `rule_key` is the stable identity
 * the engine sees as `rule.id`; each change creates a new version row with an
 * `effective_from`. The active set at time T is, for each rule_key, the newest
 * non-archived version with effective_from <= T. Orders keep the snapshot they
 * were priced with (in order_adjustments, v0.4).
 */
export const ruleVersionStatusEnum = pgEnum("rule_version_status", ["scheduled", "active", "superseded", "archived"]);

export const pricingRules = pgTable(
  "pricing_rules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    merchantId: uuid("merchant_id")
      .notNull()
      .references(() => merchants.id, { onDelete: "cascade" }),
    ruleKey: text("rule_key").notNull(),
    version: integer("version").notNull(),
    status: ruleVersionStatusEnum("status").notNull().default("scheduled"),
    effectiveFrom: timestamp("effective_from", { withTimezone: true }).notNull(),
    /** The rule body as the engine's PricingRule (id = rule_key, version = version). */
    body: jsonb("body").$type<Record<string, unknown>>().notNull(),
    note: text("note"),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (t) => [uniqueIndex("pricing_rules_key_version_uq").on(t.merchantId, t.ruleKey, t.version), index("pricing_rules_effective_idx").on(t.merchantId, t.effectiveFrom)],
);
