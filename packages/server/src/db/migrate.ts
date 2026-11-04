import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";

/**
 * Migration runner: drift check → migrate → drift check (Launchpad discipline).
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

export async function runMigrations(url: string, opts: { log?: (msg: string) => void } = {}): Promise<{ applied: number; total: number }> {
  const log = opts.log ?? (() => {});
  const sql = postgres(url, { max: 1, prepare: false, onnotice: () => {} });
  try {
    const folder = migrationsFolder();
    const journal = JSON.parse(readFileSync(join(folder, "meta/_journal.json"), "utf8")) as Journal;
    const before = await appliedCount(sql);
    log(`drift check: ${before} of ${journal.entries.length} migrations applied`);
    if (before > journal.entries.length) throw new Error(`database has ${before} migrations but the journal has ${journal.entries.length}: the deployed code is older than the database`);
    await migrate(drizzle(sql), { migrationsFolder: folder });
    const after = await appliedCount(sql);
    log(`drift check: ${after} of ${journal.entries.length} migrations applied`);
    if (after !== journal.entries.length) throw new Error(`after migrating, ${after} applied but journal has ${journal.entries.length}`);
    return { applied: after - before, total: after };
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function appliedCount(sql: postgres.Sql): Promise<number> {
  const [exists] = await sql<{ ok: boolean }[]>`select to_regclass('drizzle.__drizzle_migrations') is not null as ok`;
  if (!exists?.ok) return 0;
  const [row] = await sql<{ n: string }[]>`select count(*)::text as n from drizzle.__drizzle_migrations`;
  return Number(row?.n ?? 0);
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const url = process.env.MIGRATE_DATABASE_URL ?? process.env.LISTEN_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url) {
    console.error("Set MIGRATE_DATABASE_URL (a 5432 session connection)");
    process.exit(1);
  }
  runMigrations(url, { log: console.log })
    .then((r) => {
      console.log(`migrated: ${r.applied} applied, ${r.total} total`);
      process.exit(0);
    })
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
