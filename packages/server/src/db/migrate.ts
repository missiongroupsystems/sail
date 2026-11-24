import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";

/**
 * Migration runner: drift check → migrate → drift check.
 * Runs on a session connection. Forward-only. Never `drizzle-kit push` against
 * a shared environment.
 */

/**
 * Sail's own migrations folder: next to this file in Sail's source (src/db → ../../drizzle) or Sail's build
 * (dist → ../drizzle), and only if its journal is Sail's. A downstream bundle that inlines Sail sits elsewhere, where
 * `../drizzle` may be its own migrations; it passes Sail's folder to `runMigrations(url, { folder })` instead.
 */
export function migrationsFolder(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const candidate of [join(here, "../../drizzle"), join(here, "../drizzle")]) if (isSailFolder(candidate)) return candidate;
  throw new Error("Sail's migrations folder was not found next to the runner: from a bundled start file, pass runMigrations(url, { folder }) with a copy of Sail's packages/server/drizzle");
}

/** Sail's journal starts with its two foundation migrations; an extension's never does. */
export function isSailFolder(folder: string): boolean {
  try {
    const [first, second] = readJournal(folder).entries;
    return first?.tag === "0000_foundations" && second?.tag === "0001_rls_foundations";
  } catch {
    return false;
  }
}

type Journal = { entries: { idx: number; tag: string; when: number }[] };

/**
 * An extension's own migrations: a drizzle folder (with `meta/_journal.json`) applied after Sail's. Each set is
 * tracked in a table of its own in `sail_migrations` (named after its schema unless `table` names it), so Sail's
 * tracking table and its count check never see it, and the extension's first migration may create its schema the way
 * drizzle-kit writes it (`CREATE SCHEMA "x"`). See docs/extensions.md, "Migrations".
 */
export type MigrationSet = { folder: string; schema: string; table?: string };

/** Where the runner tracks every extension set; Sail owns it and no extension may name it. */
export const SETS_TRACKING_SCHEMA = "sail_migrations";
/** The session advisory lock every runner takes: the first 8 bytes of sha256("sail migrations"). */
const MIGRATION_LOCK = "947581615311437968";
const SCHEMA_NAME = /^[a-z_][a-z0-9_]{0,62}$/;
// Sail's own, Postgres's, and those a managed Postgres keeps for its own services (auth, storage, realtime, ...).
const RESERVED_SCHEMAS = new Set([
  "drizzle", "sail", SETS_TRACKING_SCHEMA, "public", "information_schema",
  "auth", "storage", "extensions", "realtime", "_realtime", "vault", "graphql", "graphql_public", "pgbouncer", "pgsodium", "pgsodium_masks", "net", "cron", "supabase_functions", "supabase_migrations",
]);

export async function runMigrations(
  url: string,
  opts: { log?: (msg: string) => void; sets?: MigrationSet[]; /** Sail's migrations folder; found next to the runner when left out. */ folder?: string } = {},
): Promise<{ applied: number; total: number; sets: { schema: string; applied: number; total: number }[] }> {
  const log = opts.log ?? (() => {});
  const sets = (opts.sets ?? []).map(checkSet);
  const dup = sets.find((s, i) => sets.findIndex((o) => o.schema === s.schema) !== i);
  if (dup) throw new Error(`migration set: schema "${dup.schema}" is named twice; each extension has a schema of its own`);
  const dupTable = sets.find((s, i) => sets.findIndex((o) => o.table === s.table) !== i);
  if (dupTable) throw new Error(`migration set: tracking table "${dupTable.table}" is named twice`);
  const sql = postgres(url, { max: 1, prepare: false, onnotice: () => {} });
  try {
    // One runner at a time, over Sail's and every set's migrations: a second waits here, then finds nothing to do.
    // The lock is the session's (one connection), so it holds across drizzle's own transactions.
    await sql`select pg_advisory_lock(${MIGRATION_LOCK}::bigint)`;
    const folder = opts.folder ?? migrationsFolder();
    if (!isSailFolder(folder)) throw new Error(`${folder} is not Sail's migrations folder (its journal does not start with Sail's foundations)`);
    const journal = readJournal(folder);
    const before = await appliedCount(sql, "drizzle", "__drizzle_migrations");
    log(`drift check: ${before} of ${journal.entries.length} migrations applied`);
    if (before > journal.entries.length) throw new Error(`database has ${before} migrations but the journal has ${journal.entries.length}: the deployed code is older than the database`);
    // Every extension's drift check comes before anything is applied, so a database ahead of the code changes nothing.
    const setsBefore: number[] = [];
    for (const set of sets) {
      const n = await appliedCount(sql, SETS_TRACKING_SCHEMA, set.table);
      const total = readJournal(set.folder).entries.length;
      log(`drift check (${set.schema}): ${n} of ${total} migrations applied`);
      if (n > total) throw new Error(`${set.schema}: database has ${n} migrations but the journal has ${total}: the deployed code is older than the database`);
      setsBefore.push(n);
    }
    await apply(sql, { migrationsFolder: folder });
    const after = await appliedCount(sql, "drizzle", "__drizzle_migrations");
    log(`drift check: ${after} of ${journal.entries.length} migrations applied`);
    if (after !== journal.entries.length) throw new Error(`after migrating, ${after} applied but journal has ${journal.entries.length}`);
    const results: { schema: string; applied: number; total: number }[] = [];
    for (const [i, set] of sets.entries()) {
      const total = readJournal(set.folder).entries.length;
      // Each set runs in a transaction of its own: a failing migration undoes that set's pending migrations only.
      await apply(sql, { migrationsFolder: set.folder, migrationsSchema: SETS_TRACKING_SCHEMA, migrationsTable: set.table }, set.schema);
      const n = await appliedCount(sql, SETS_TRACKING_SCHEMA, set.table);
      log(`drift check (${set.schema}): ${n} of ${total} migrations applied`);
      if (n !== total) throw new Error(`${set.schema}: after migrating, ${n} applied but journal has ${total}`);
      results.push({ schema: set.schema, applied: n - setsBefore[i]!, total: n });
    }
    return { applied: after - before, total: after, sets: results };
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/**
 * `SAIL_MIGRATIONS`: an extension's migration sets for the migrate entry and `dev:local`, comma-separated
 * `schema=folder` or `schema.table=folder`; folders are resolved from the working directory.
 */
export function migrationSetsFromEnv(value = process.env.SAIL_MIGRATIONS ?? ""): MigrationSet[] {
  return value.split(",").map((s) => s.trim()).filter(Boolean).map((entry) => {
    const eq = entry.indexOf("=");
    if (eq < 1) throw new Error(`SAIL_MIGRATIONS: expected schema=folder, got "${entry}"`);
    const names = entry.slice(0, eq).split(".");
    if (names.length > 2) throw new Error(`SAIL_MIGRATIONS: expected schema=folder or schema.table=folder, got "${entry}"`);
    const path = entry.slice(eq + 1).trim();
    if (!path) throw new Error(`SAIL_MIGRATIONS: "${entry}" names no folder`);
    const folder = resolve(path);
    if (isSailFolder(folder)) throw new Error(`SAIL_MIGRATIONS: ${folder} is Sail's own migrations folder, which the runner always applies; name the extension's folder`);
    return { schema: names[0]!, table: names[1], folder };
  });
}

function checkSet(set: MigrationSet): Required<MigrationSet> {
  const table = set.table ?? set.schema;
  for (const name of [set.schema, table]) if (!SCHEMA_NAME.test(name)) throw new Error(`migration set: "${name}" is not a lower-case Postgres name`);
  if (RESERVED_SCHEMAS.has(set.schema) || set.schema.startsWith("pg_")) throw new Error(`migration set: schema "${set.schema}" belongs to Sail, Postgres or a managed Postgres's services; an extension uses a schema of its own`);
  if (isSailFolder(set.folder)) throw new Error(`migration set: ${set.folder} is Sail's own migrations folder; a set is an extension's own`);
  readJournal(set.folder);
  return { folder: set.folder, schema: set.schema, table };
}

function readJournal(folder: string): Journal {
  return JSON.parse(readFileSync(join(folder, "meta/_journal.json"), "utf8")) as Journal;
}

async function apply(sql: postgres.Sql, config: Parameters<typeof migrate>[1], label?: string) {
  await migrate(drizzle(sql), config).catch((e: unknown) => {
    // drizzle's message is "Failed query:" and the whole statement; what the migration itself says is in the cause.
    // Say that first, with its hint, so the person deploying reads the reason and what to do.
    const cause = (e as { cause?: unknown }).cause as { message?: string; hint?: string } | undefined;
    if (!cause?.message) throw e;
    const message = cause.hint ? `${cause.message}\nHINT: ${cause.hint}` : cause.message;
    throw new Error(label ? `${label}: ${message}` : message, { cause: e });
  });
}

async function appliedCount(sql: postgres.Sql, schema: string, table: string): Promise<number> {
  const [exists] = await sql<{ ok: boolean }[]>`select to_regclass(${`"${schema}"."${table}"`}) is not null as ok`;
  if (!exists?.ok) return 0;
  const [row] = await sql<{ n: string }[]>`select count(*)::text as n from ${sql(schema)}.${sql(table)}`;
  return Number(row?.n ?? 0);
}
