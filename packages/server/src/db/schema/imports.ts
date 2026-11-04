import { boolean, index, jsonb, pgEnum, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { merchants } from "./org.js";

/** Legacy POS importer jobs (scope doc 4.2): CSV-first, re-runnable, dry-run report first. */
export const importStatusEnum = pgEnum("import_status", ["queued", "running", "dry_run_complete", "applied", "failed"]);

export const importJobs = pgTable(
  "import_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    merchantId: uuid("merchant_id")
      .notNull()
      .references(() => merchants.id, { onDelete: "cascade" }),
    status: importStatusEnum("status").notNull().default("queued"),
    dryRun: boolean("dry_run").notNull().default(true),
    /** Which entity each file holds and how its columns map: { files: [{ name, entity, columns: { ourField: "Their Column" } }] } */
    mapping: jsonb("mapping").$type<ImportMapping>().notNull(),
    /** Uploaded CSV contents keyed by file name. */
    files: jsonb("files").$type<Record<string, string>>().notNull(),
    /** Creates, updates, unchanged and rejected rows per entity, with reasons. */
    report: jsonb("report").$type<ImportReport | null>(),
    error: text("error"),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [index("import_jobs_merchant_idx").on(t.merchantId, t.createdAt)],
);

export type ImportEntity = "brands" | "outlets" | "categories" | "products" | "modifier_groups" | "modifier_options" | "menus" | "menu_sections" | "menu_items" | "areas" | "tables" | "tender_types" | "void_reasons" | "staff" | "customers" | "layouts";

export type ImportMapping = {
  files: { name: string; entity: ImportEntity; columns: Record<string, string>; defaults?: Record<string, string> }[];
  options?: { brand_legacy_id?: string; outlet_legacy_id?: string; tile_colour_map?: Record<string, string> };
};

export type ImportReport = {
  entities: Record<string, { creates: number; updates: number; unchanged: number; rejected: { row: number; reason: string; data: Record<string, string> }[] }>;
  warnings: string[];
};
