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
export function migrationsFolder(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // src/db → ../../drizzle ; dist → ../drizzle
  for (const candidate of [join(here, "../../drizzle"), join(here, "../drizzle"), join(process.cwd(), "drizzle")]) {
    try {
      readFileSync(join(candidate, "meta/_journal.json"));
      return candidate;
    } catch {
      /* try next */
    }
  }
  throw new Error("drizzle migrations folder not found");
}

type Journal = { entries: { idx: number; tag: string; when: number }[] };

/**
 * An extension's own migrations: a drizzle folder (with `meta/_journal.json`) applied after Sail's, tracked in
 * `<schema>.<table>` so Sail's own tracking table and its count check never see them. See docs/how-to.md,
 * "Tables owned by an extension".
 */
export type MigrationSet = { folder: string; schema: string; table?: string };

const SCHEMA_NAME = /^[a-z_][a-z0-9_]{0,62}$/;
const SAIL_SCHEMAS = new Set(["drizzle", "sail", "public", "information_schema", "faketime"]);

export async function runMigrations(
  url: string,
  opts: { log?: (msg: string) => void; sets?: MigrationSet[] } = {},
): Promise<{ applied: number; total: number; sets: { schema: string; applied: number; total: number }[] }> {
  const log = opts.log ?? (() => {});
  const sets = (opts.sets ?? []).map(checkSet);
  const sql = postgres(url, { max: 1, prepare: false, onnotice: () => {} });
  try {
    const folder = migrationsFolder();
    const journal = readJournal(folder);
    const before = await appliedCount(sql, "drizzle", "__drizzle_migrations");
    log(`drift check: ${before} of ${journal.entries.length} migrations applied`);
    if (before > journal.entries.length) throw new Error(`database has ${before} migrations but the journal has ${journal.entries.length}: the deployed code is older than the database`);
    // Every extension's drift check comes before anything is applied, so a database ahead of the code changes nothing.
    const setsBefore: number[] = [];
    for (const set of sets) {
      const n = await appliedCount(sql, set.schema, set.table);
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
      await apply(sql, { migrationsFolder: set.folder, migrationsSchema: set.schema, migrationsTable: set.table }, set.schema);
      const n = await appliedCount(sql, set.schema, set.table);
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
    const [schema, table] = entry.slice(0, eq).split(".");
    return { schema: schema!, table, folder: resolve(entry.slice(eq + 1)) };
  });
}

function checkSet(set: MigrationSet): Required<MigrationSet> {
  const table = set.table ?? "__drizzle_migrations";
  for (const name of [set.schema, table]) if (!SCHEMA_NAME.test(name)) throw new Error(`migration set: "${name}" is not a lower-case Postgres name`);
  if (SAIL_SCHEMAS.has(set.schema) || set.schema.startsWith("pg_")) throw new Error(`migration set: schema "${set.schema}" belongs to Sail or Postgres; an extension uses a schema of its own`);
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

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const url = process.env.MIGRATE_DATABASE_URL ?? process.env.LISTEN_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url) {
    console.error("Set MIGRATE_DATABASE_URL (a 5432 session connection)");
    process.exit(1);
  }
  runMigrations(url, { log: console.log, sets: migrationSetsFromEnv() })
    .then((r) => {
      console.log(`migrated: ${r.applied} applied, ${r.total} total`);
      for (const s of r.sets) console.log(`migrated (${s.schema}): ${s.applied} applied, ${s.total} total`);
      process.exit(0);
    })
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
