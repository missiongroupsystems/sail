// An extension's own migrations (docs/how-to.md, "Tables owned by an extension"): applied after Sail's, tracked in
// a table of their own, and isolated by merchant under RLS like Sail's tables.
import { randomUUID } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { migrationSetsFromEnv, migrationsFolder, runMigrations, type MigrationSet } from "../src/db/migrate.js";
import { freshDb, seedMerchant, type SeededMerchant, type TestDb } from "./helpers.js";

const FIXTURE = join(import.meta.dirname, "fixtures/ext-migrations");
const fixture: MigrationSet = { folder: FIXTURE, schema: "ext_fixture" };
const sailTotal = (JSON.parse(readFileSync(join(migrationsFolder(), "meta/_journal.json"), "utf8")) as { entries: unknown[] }).entries.length;

const sailCount = async (sql: postgres.Sql) => Number((await sql<{ n: string }[]>`select count(*)::text as n from drizzle.__drizzle_migrations`)[0]!.n);
const fixtureCount = async (sql: postgres.Sql) => Number((await sql<{ n: string }[]>`select count(*)::text as n from ext_fixture.__drizzle_migrations`)[0]!.n);
const publicTables = async (sql: postgres.Sql) => (await sql<{ t: string }[]>`select table_name as t from information_schema.tables where table_schema = 'public' order by 1`).map((r) => r.t);

/** A copy of the fixture with more migrations, as a later release of the extension would ship. */
function fixtureWith(...more: [tag: string, body: string][]): { folder: string; cleanup: () => void } {
  const folder = mkdtempSync(join(tmpdir(), "ext-fixture-"));
  cpSync(FIXTURE, folder, { recursive: true });
  const journalPath = join(folder, "meta/_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as { entries: { idx: number; when: number; tag: string }[] };
  for (const [tag, body] of more) {
    const last = journal.entries.at(-1)!;
    journal.entries.push({ ...last, idx: last.idx + 1, when: last.when + 1000, tag });
    writeFileSync(join(folder, `${tag}.sql`), body);
  }
  writeFileSync(journalPath, JSON.stringify(journal));
  return { folder, cleanup: () => rmSync(folder, { recursive: true, force: true }) };
}

describe("an extension's migrations on an empty database", () => {
  const admin = postgres(inject("pgAdminUrl"), { max: 1, onnotice: () => {} });
  const name = `ext_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  afterAll(async () => {
    await admin.unsafe(`drop database if exists ${name} with (force)`);
    await admin.end({ timeout: 2 });
  });

  it("run after all of Sail's, which the fixture needs (it references merchants and sail.merchant_id())", async () => {
    await admin.unsafe(`create database ${name}`);
    const url = `postgres://postgres@127.0.0.1:${inject("pgPort")}/${name}`;
    const log: string[] = [];
    const r = await runMigrations(url, { sets: [fixture], log: (m) => log.push(m) });
    expect(r).toEqual({ applied: sailTotal, total: sailTotal, sets: [{ schema: "ext_fixture", applied: 1, total: 1 }] });
    expect(log).toEqual([
      `drift check: 0 of ${sailTotal} migrations applied`,
      "drift check (ext_fixture): 0 of 1 migrations applied",
      `drift check: ${sailTotal} of ${sailTotal} migrations applied`,
      "drift check (ext_fixture): 1 of 1 migrations applied",
    ]);
  }, 60_000);
});

const PINNED: [string, string] = ["0001_note_pinned", "ALTER TABLE ext_fixture.notes ADD COLUMN pinned boolean NOT NULL DEFAULT false;"];

describe("an extension's migrations on a migrated database", () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await freshDb();
  });
  afterAll(async () => db?.drop());

  it("apply once, in their own tracking table, and leave Sail's count check passing", async () => {
    const r = await runMigrations(db.url, { sets: [fixture] });
    expect(r).toEqual({ applied: 0, total: sailTotal, sets: [{ schema: "ext_fixture", applied: 1, total: 1 }] });
    expect(await sailCount(db.sql)).toBe(sailTotal);
    expect(await fixtureCount(db.sql)).toBe(1);
    // Sail's runner alone still finds its count equal to its journal.
    await expect(runMigrations(db.url)).resolves.toEqual({ applied: 0, total: sailTotal, sets: [] });
  });

  it("are a no-op when run again", async () => {
    const r = await runMigrations(db.url, { sets: [fixture] });
    expect(r.sets).toEqual([{ schema: "ext_fixture", applied: 0, total: 1 }]);
    expect(await fixtureCount(db.sql)).toBe(1);
    expect(await sailCount(db.sql)).toBe(sailTotal);
  });

  it("apply only the new migration of a later release", async () => {
    const next = fixtureWith(PINNED);
    try {
      const r = await runMigrations(db.url, { sets: [{ ...fixture, folder: next.folder }] });
      expect(r.sets).toEqual([{ schema: "ext_fixture", applied: 1, total: 2 }]);
      expect(await fixtureCount(db.sql)).toBe(2);
      const [col] = await db.sql`select 1 from information_schema.columns where table_schema = 'ext_fixture' and table_name = 'notes' and column_name = 'pinned'`;
      expect(col).toBeDefined();
      // The database is now ahead of the original fixture: the runner refuses, as it does for Sail's own journal.
      await expect(runMigrations(db.url, { sets: [fixture] })).rejects.toThrow("ext_fixture: database has 2 migrations but the journal has 1");
    } finally {
      next.cleanup();
    }
  });

  it("that fail stop loudly and leave Sail's tables, Sail's tracking and the extension's applied migrations as they were", async () => {
    const tablesBefore = await publicTables(db.sql);
    const extBefore = await fixtureCount(db.sql);
    // The release after the one above: its one new migration fails halfway.
    const broken = fixtureWith(PINNED, ["0002_broken", "CREATE TABLE ext_fixture.half (id int);\n--> statement-breakpoint\nALTER TABLE ext_fixture.no_such_table ADD COLUMN x int;"]);
    try {
      await expect(runMigrations(db.url, { sets: [{ ...fixture, folder: broken.folder }] })).rejects.toThrow('ext_fixture: relation "ext_fixture.no_such_table" does not exist');
    } finally {
      broken.cleanup();
    }
    expect(await sailCount(db.sql)).toBe(sailTotal);
    expect(await publicTables(db.sql)).toEqual(tablesBefore);
    expect(await fixtureCount(db.sql)).toBe(extBefore);
    // The failing migration's first statement was rolled back with it.
    const [half] = await db.sql<{ ok: boolean }[]>`select to_regclass('ext_fixture.half') is not null as ok`;
    expect(half!.ok).toBe(false);
  });

  it("refuse a schema that belongs to Sail or Postgres", async () => {
    for (const schema of ["public", "sail", "drizzle", "pg_temp", "Bad-Name"]) await expect(runMigrations(db.url, { sets: [{ folder: FIXTURE, schema }] })).rejects.toThrow(/migration set/);
    await expect(runMigrations(db.url, { sets: [fixture, { ...fixture, table: "other" }] })).rejects.toThrow(/named twice/);
  });
});

describe("an extension's table under RLS", () => {
  let db: TestDb;
  let A: SeededMerchant;
  let B: SeededMerchant;
  beforeAll(async () => {
    db = await freshDb();
    await runMigrations(db.url, { sets: [fixture] });
    A = await seedMerchant(db.sql, "Alpha");
    B = await seedMerchant(db.sql, "Bravo");
    for (const m of [A, B]) await db.sql`insert into ext_fixture.notes (merchant_id, body) values (${m.merchantId}, ${`note of ${m.merchantId}`})`;
  });
  afterAll(async () => db?.drop());

  /** As the API runs a request: the merchant set with set_config, then the app role (src/middleware/pipeline.ts). */
  const asApp = <T>(merchantId: string | null, fn: (t: postgres.TransactionSql) => Promise<T>) =>
    db.sql.begin(async (t) => {
      if (merchantId) await t`select set_config('app.current_merchant', ${merchantId}, true)`;
      await t.unsafe("set local role app_authenticated");
      return fn(t);
    }) as Promise<T>;

  it("shows each merchant its own rows only, and refuses a row for another merchant", async () => {
    for (const [me, other] of [[A, B], [B, A]] as const) {
      const rows = await asApp(me.merchantId, (t) => t<{ merchant_id: string }[]>`select merchant_id from ext_fixture.notes`);
      expect(rows.map((r) => r.merchant_id)).toEqual([me.merchantId]);
      await expect(asApp(me.merchantId, (t) => t`insert into ext_fixture.notes (merchant_id, body) values (${other.merchantId}, 'x')`)).rejects.toThrow(/row-level security/);
    }
    // The owner sees both, so the filtering above is RLS and not missing rows.
    expect((await db.sql`select 1 from ext_fixture.notes`).length).toBe(2);
  });

  it("shows nothing without a merchant context", async () => {
    expect(await asApp(null, (t) => t`select * from ext_fixture.notes`)).toEqual([]);
  });
});

describe("SAIL_MIGRATIONS", () => {
  it("reads schema=folder and schema.table=folder, comma-separated, and nothing when unset", () => {
    expect(migrationSetsFromEnv("")).toEqual([]);
    expect(migrationSetsFromEnv("ext_a=/x/a, ext_b.tracking=/x/b")).toEqual([
      { schema: "ext_a", table: undefined, folder: "/x/a" },
      { schema: "ext_b", table: "tracking", folder: "/x/b" },
    ]);
    expect(() => migrationSetsFromEnv("/x/a")).toThrow(/schema=folder/);
  });
});
