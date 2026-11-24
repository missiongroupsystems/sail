// An extension's own migrations (docs/extensions.md, "Migrations"): applied after Sail's, tracked in a table of their
// own, and isolated by merchant, outlet and brand under RLS like Sail's tables. The fixture is the drizzle-kit route:
// 0000 is exactly what drizzle-kit generates for a pgSchema table (test/fixtures/ext-migrations-src), 0001 the grants.
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
const fixtureCount = async (sql: postgres.Sql) => Number((await sql<{ n: string }[]>`select count(*)::text as n from sail_migrations.ext_fixture`)[0]!.n);
const FIXTURE_TOTAL = 2;
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

  it("run after all of Sail's, which the fixture needs (it references merchants and sail.merchant_id()), and start with drizzle-kit's CREATE SCHEMA", async () => {
    await admin.unsafe(`create database ${name}`);
    const url = `postgres://postgres@127.0.0.1:${inject("pgPort")}/${name}`;
    const log: string[] = [];
    const r = await runMigrations(url, { sets: [fixture], log: (m) => log.push(m) });
    expect(r).toEqual({ applied: sailTotal, total: sailTotal, sets: [{ schema: "ext_fixture", applied: FIXTURE_TOTAL, total: FIXTURE_TOTAL }] });
    expect(log).toEqual([
      `drift check: 0 of ${sailTotal} migrations applied`,
      "drift check (ext_fixture): 0 of 2 migrations applied",
      `drift check: ${sailTotal} of ${sailTotal} migrations applied`,
      "drift check (ext_fixture): 2 of 2 migrations applied",
    ]);
    expect(readFileSync(join(FIXTURE, "0000_melted_shriek.sql"), "utf8")).toMatch(/^CREATE SCHEMA "ext_fixture";/);
  }, 60_000);
});

describe("a run after one through a transaction pooler", () => {
  const admin = postgres(inject("pgAdminUrl"), { max: 1, onnotice: () => {} });
  const name = `ext_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  afterAll(async () => {
    await admin.unsafe(`drop database if exists ${name} with (force)`);
    await admin.end({ timeout: 2 });
  });

  it("finishes although a pooled backend still holds the session lock an earlier version of the runner took", async () => {
    await admin.unsafe(`create database ${name}`);
    const url = `postgres://postgres@127.0.0.1:${inject("pgPort")}/${name}`;
    // A transaction pooler keeps the backend a session lock was taken on, so the lock outlives the run that took it.
    // This connection plays that backend, holding the key the runner once took (the first 8 bytes of
    // sha256("sail migrations")).
    const pooled = postgres(url, { max: 1, onnotice: () => {} });
    try {
      await pooled`select pg_advisory_lock(947581615311437968)`;
      const run = runMigrations(url, { sets: [fixture] }).then((r) => r.sets[0]!.applied);
      const outcome = await Promise.race([run, new Promise((r) => setTimeout(() => r("still waiting"), 20_000))]);
      expect(outcome).toBe(FIXTURE_TOTAL);
    } finally {
      await pooled.end({ timeout: 2 });
    }
  }, 120_000);
});

/**
 * A copy of Sail's folder with one more migration, as Sail's next release would ship: a database migrated with Sail's
 * own folder has that one pending. (The fixture needs Sail's latest migration, so none of Sail's can be held back.)
 */
function sailWithOneMore(): { folder: string; cleanup: () => void } {
  const folder = mkdtempSync(join(tmpdir(), "sail-next-"));
  cpSync(migrationsFolder(), folder, { recursive: true });
  const journalPath = join(folder, "meta/_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as { entries: { idx: number; when: number; tag: string }[] };
  const last = journal.entries.at(-1)!;
  journal.entries.push({ ...last, idx: last.idx + 1, when: last.when + 1000, tag: "9999_next_release" });
  writeFileSync(join(folder, "9999_next_release.sql"), "CREATE TABLE public.next_release (id int);");
  writeFileSync(journalPath, JSON.stringify(journal));
  return { folder, cleanup: () => rmSync(folder, { recursive: true, force: true }) };
}

describe("an extension's migrations while Sail has one pending", () => {
  const admin = postgres(inject("pgAdminUrl"), { max: 1, onnotice: () => {} });
  const names: string[] = [];
  afterAll(async () => {
    for (const n of names) await admin.unsafe(`drop database if exists ${n} with (force)`);
    await admin.end({ timeout: 2 });
  });
  const next = sailWithOneMore();
  afterAll(() => next.cleanup());
  /** A database with all of Sail's migrations and the given fixture folder applied; `next.folder` has one more of Sail's. */
  async function behind(setFolder: string) {
    const name = `ext_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    names.push(name);
    await admin.unsafe(`create database ${name}`);
    const url = `postgres://postgres@127.0.0.1:${inject("pgPort")}/${name}`;
    await runMigrations(url, { sets: [{ ...fixture, folder: setFolder }] });
    return { url, sql: postgres(url, { max: 1, onnotice: () => {} }) };
  }

  it("checks the extension's drift before Sail applies anything: a database ahead of the extension changes nothing", async () => {
    const ahead = fixtureWith(PINNED);
    const { url, sql } = await behind(ahead.folder);
    ahead.cleanup();
    try {
      expect(await sailCount(sql)).toBe(sailTotal);
      await expect(runMigrations(url, { folder: next.folder, sets: [fixture] })).rejects.toThrow("ext_fixture: database has 3 migrations but the journal has 2");
      expect(await sailCount(sql)).toBe(sailTotal);
    } finally {
      await sql.end({ timeout: 2 });
    }
  }, 120_000);

  it("keeps Sail's just-applied migration committed and tracked when the extension's then fails", async () => {
    const { url, sql } = await behind(FIXTURE);
    const broken = fixtureWith(["0002_broken", "ALTER TABLE ext_fixture.no_such_table ADD COLUMN x int;"]);
    try {
      await expect(runMigrations(url, { folder: next.folder, sets: [{ ...fixture, folder: broken.folder }] })).rejects.toThrow(/^ext_fixture: relation "ext_fixture.no_such_table" does not exist/);
      expect(await sailCount(sql)).toBe(sailTotal + 1);
      expect(await fixtureCount(sql)).toBe(FIXTURE_TOTAL);
      // And the next run, with the extension fixed, has only the extension's left to do.
      await expect(runMigrations(url, { folder: next.folder, sets: [fixture] })).resolves.toEqual({ applied: 0, total: sailTotal + 1, sets: [{ schema: "ext_fixture", applied: 0, total: FIXTURE_TOTAL }] });
    } finally {
      broken.cleanup();
      await sql.end({ timeout: 2 });
    }
  }, 120_000);
});

const PINNED: [string, string] = ["0002_note_pinned", "ALTER TABLE ext_fixture.notes ADD COLUMN pinned boolean NOT NULL DEFAULT false;"];
const TAGS: [string, string] = ["0003_tags", "CREATE TABLE ext_fixture.tags (id serial PRIMARY KEY, merchant_id uuid NOT NULL REFERENCES public.merchants(id), name text NOT NULL);\n--> statement-breakpoint\nALTER TABLE ext_fixture.tags ENABLE ROW LEVEL SECURITY;\n--> statement-breakpoint\nCREATE POLICY tags_tenant ON ext_fixture.tags FOR ALL TO app_authenticated USING (merchant_id = sail.merchant_id()) WITH CHECK (merchant_id = sail.merchant_id());"];

describe("an extension's migrations on a migrated database", () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await freshDb();
  });
  afterAll(async () => db?.drop());

  it("apply once, in their own tracking table, and leave Sail's count check passing", async () => {
    const r = await runMigrations(db.url, { sets: [fixture] });
    expect(r).toEqual({ applied: 0, total: sailTotal, sets: [{ schema: "ext_fixture", applied: FIXTURE_TOTAL, total: FIXTURE_TOTAL }] });
    expect(await sailCount(db.sql)).toBe(sailTotal);
    expect(await fixtureCount(db.sql)).toBe(FIXTURE_TOTAL);
    // Sail's runner alone still finds its count equal to its journal.
    await expect(runMigrations(db.url)).resolves.toEqual({ applied: 0, total: sailTotal, sets: [] });
  });

  it("are a no-op when run again", async () => {
    const r = await runMigrations(db.url, { sets: [fixture] });
    expect(r.sets).toEqual([{ schema: "ext_fixture", applied: 0, total: FIXTURE_TOTAL }]);
    expect(await fixtureCount(db.sql)).toBe(FIXTURE_TOTAL);
    expect(await sailCount(db.sql)).toBe(sailTotal);
  });

  it("apply only the new migration of a later release", async () => {
    const next = fixtureWith(PINNED);
    try {
      const r = await runMigrations(db.url, { sets: [{ ...fixture, folder: next.folder }] });
      expect(r.sets).toEqual([{ schema: "ext_fixture", applied: 1, total: 3 }]);
      expect(await fixtureCount(db.sql)).toBe(3);
      const [col] = await db.sql`select 1 from information_schema.columns where table_schema = 'ext_fixture' and table_name = 'notes' and column_name = 'pinned'`;
      expect(col).toBeDefined();
      // The database is now ahead of the original fixture: the runner refuses, as it does for Sail's own journal.
      await expect(runMigrations(db.url, { sets: [fixture] })).rejects.toThrow("ext_fixture: database has 3 migrations but the journal has 2");
    } finally {
      next.cleanup();
    }
  });

  it("that fail stop loudly and leave Sail's tables, Sail's tracking and the extension's applied migrations as they were", async () => {
    const tablesBefore = await publicTables(db.sql);
    const extBefore = await fixtureCount(db.sql);
    // The release after the one above: its one new migration fails halfway.
    const broken = fixtureWith(PINNED, ["0003_broken", "CREATE TABLE ext_fixture.half (id int);\n--> statement-breakpoint\nALTER TABLE ext_fixture.no_such_table ADD COLUMN x int;"]);
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
    for (const schema of ["public", "sail", "drizzle", "sail_migrations", "pg_temp", "auth", "storage", "extensions", "realtime", "vault", "graphql", "pgbouncer", "Bad-Name"]) await expect(runMigrations(db.url, { sets: [{ folder: FIXTURE, schema }] })).rejects.toThrow(/migration set/);
    await expect(runMigrations(db.url, { sets: [fixture, { ...fixture }] })).rejects.toThrow(/named twice/);
    // There is no tracking-table option: the table is always named after the schema, and a dotted name is refused.
    await expect(runMigrations(db.url, { sets: migrationSetsFromEnv(`ext_b.tracking=${FIXTURE}`) })).rejects.toThrow('migration set: "ext_b.tracking" is not a lower-case Postgres name');
    await expect(runMigrations(db.url, { sets: [{ folder: migrationsFolder(), schema: "ext_sail" }] })).rejects.toThrow(/Sail's own migrations folder/);
  });

  it("give a later migration's new table and its sequence the default grants of the first, to staff only", async () => {
    const next = fixtureWith(PINNED, TAGS);
    try {
      await runMigrations(db.url, { sets: [{ ...fixture, folder: next.folder }] });
    } finally {
      next.cleanup();
    }
    const m = await seedMerchant(db.sql, "Tags");
    const rows = await db.sql.begin(async (t) => {
      await t`select set_config('app.current_merchant', ${m.merchantId}, true)`;
      await t.unsafe("set local role app_authenticated");
      await t`insert into ext_fixture.tags (merchant_id, name) values (${m.merchantId}, 'spicy')`;
      return t<{ name: string }[]>`select name from ext_fixture.tags`;
    });
    expect(rows.map((r) => r.name)).toEqual(["spicy"]);
    // Agents get no default grants: the later table is closed to them until a migration grants it.
    const asAgent = () =>
      db.sql.begin(async (t) => {
        await t`select set_config('app.current_merchant', ${m.merchantId}, true)`;
        await t.unsafe("set local role app_agent");
        return t<{ name: string }[]>`select name from ext_fixture.tags`;
      });
    await expect(asAgent()).rejects.toThrow("denied for table tags");
    const granted = fixtureWith(PINNED, TAGS, ["0004_tags_agent", "GRANT SELECT ON ext_fixture.tags TO app_agent;\n--> statement-breakpoint\nCREATE POLICY tags_agent ON ext_fixture.tags FOR SELECT TO app_agent USING (merchant_id = sail.merchant_id());"]);
    try {
      await runMigrations(db.url, { sets: [{ ...fixture, folder: granted.folder }] });
    } finally {
      granted.cleanup();
    }
    expect((await asAgent()).map((r) => r.name)).toEqual(["spicy"]);
  });
});

describe("an extension's table under RLS", () => {
  let db: TestDb;
  let A: SeededMerchant;
  let B: SeededMerchant;
  /** A second brand of merchant A, and its one outlet. */
  let otherBrand: string;
  let otherOutlet: string;
  beforeAll(async () => {
    db = await freshDb();
    await runMigrations(db.url, { sets: [fixture] });
    A = await seedMerchant(db.sql, "Alpha");
    B = await seedMerchant(db.sql, "Bravo");
    otherBrand = randomUUID();
    otherOutlet = randomUUID();
    await db.sql`insert into brands (id, merchant_id, name) values (${otherBrand}, ${A.merchantId}, 'Alpha Other')`;
    await db.sql`insert into outlets (id, merchant_id, brand_id, name) values (${otherOutlet}, ${A.merchantId}, ${otherBrand}, 'Alpha Other Outlet')`;
    for (const m of [A, B]) await db.sql`insert into ext_fixture.notes (merchant_id, outlet_id, brand_id, body) values (${m.merchantId}, ${m.outletId}, ${m.brandId}, ${`note of ${m.merchantId}`})`;
    await db.sql`insert into ext_fixture.notes (merchant_id, outlet_id, brand_id, body) values (${A.merchantId}, ${otherOutlet}, ${otherBrand}, 'other brand')`;
  });
  afterAll(async () => db?.drop());

  /**
   * As the API runs a request: the merchant, outlets and brands set with set_config, then the caller's role
   * (src/middleware/pipeline.ts). '*' is every outlet or brand of the merchant.
   */
  const asApp = <T>(merchantId: string | null, fn: (t: postgres.TransactionSql) => Promise<T>, scope: { outlets?: string; brands?: string; role?: string } = {}) =>
    db.sql.begin(async (t) => {
      if (merchantId) await t`select set_config('app.current_merchant', ${merchantId}, true), set_config('app.current_outlets', ${scope.outlets ?? "*"}, true), set_config('app.current_brands', ${scope.brands ?? "*"}, true)`;
      await t.unsafe(`set local role ${scope.role ?? "app_authenticated"}`);
      return fn(t);
    }) as Promise<T>;

  it("shows each merchant its own rows only, and refuses a row for another merchant", async () => {
    for (const [me, other] of [[A, B], [B, A]] as const) {
      const rows = await asApp(me.merchantId, (t) => t<{ merchant_id: string }[]>`select distinct merchant_id from ext_fixture.notes`);
      expect(rows.map((r) => r.merchant_id)).toEqual([me.merchantId]);
      await expect(asApp(me.merchantId, (t) => t`insert into ext_fixture.notes (merchant_id, outlet_id, brand_id, body) values (${other.merchantId}, ${other.outletId}, ${other.brandId}, 'x')`)).rejects.toThrow(/row-level security/);
    }
    // The owner sees every row, so the filtering above is RLS and not missing rows.
    expect((await db.sql`select 1 from ext_fixture.notes`).length).toBe(3);
  });

  it("hides a row of another brand from staff and agents limited to one brand", async () => {
    for (const role of ["app_authenticated", "app_agent"]) {
      const limited = await asApp(A.merchantId, (t) => t<{ body: string }[]>`select body from ext_fixture.notes order by body`, { brands: A.brandId, role });
      expect(limited.map((r) => r.body)).toEqual([`note of ${A.merchantId}`]);
      const every = await asApp(A.merchantId, (t) => t<{ body: string }[]>`select body from ext_fixture.notes order by body`, { role });
      expect(every.map((r) => r.body)).toEqual([`note of ${A.merchantId}`, "other brand"]);
      await expect(asApp(A.merchantId, (t) => t`insert into ext_fixture.notes (merchant_id, outlet_id, brand_id, body) values (${A.merchantId}, ${otherOutlet}, ${otherBrand}, 'x')`, { brands: A.brandId, role })).rejects.toThrow(/row-level security/);
    }
  });

  it("ties a row's brand to its outlet's: a caller limited to one brand can neither write nor read at another brand's outlet", async () => {
    for (const role of ["app_authenticated", "app_agent"]) {
      // Limited to the other brand, with no outlet limit: A's own outlet belongs to A's brand.
      const scope = { brands: otherBrand, role };
      for (const brand of [null, otherBrand]) {
        await expect(asApp(A.merchantId, (t) => t`insert into ext_fixture.notes (merchant_id, outlet_id, brand_id, body) values (${A.merchantId}, ${A.outletId}, ${brand}, 'x')`, scope)).rejects.toThrow(/its outlet .* belongs to brand/);
      }
      const rows = await asApp(A.merchantId, (t) => t<{ body: string }[]>`select body from ext_fixture.notes order by body`, scope);
      expect(rows.map((r) => r.body)).toEqual(["other brand"]);
    }
    // Not even the owner can write a row whose brand is not its outlet's, so no row without a brand is left visible to every brand.
    await expect(db.sql`insert into ext_fixture.notes (merchant_id, outlet_id, brand_id, body) values (${A.merchantId}, ${A.outletId}, null, 'x')`).rejects.toThrow(/notes names brand <NULL>/);
    await expect(db.sql`update ext_fixture.notes set outlet_id = ${A.outletId} where brand_id = ${otherBrand}`).rejects.toThrow(/its outlet .* belongs to brand/);
  });

  it("numbers rows from a sequence the first migration made, for staff and agents", async () => {
    for (const role of ["app_authenticated", "app_agent"]) {
      const [row] = await asApp(A.merchantId, (t) => t<{ number: number }[]>`insert into ext_fixture.notes (merchant_id, outlet_id, brand_id, body) values (${A.merchantId}, ${A.outletId}, ${A.brandId}, ${`by ${role}`}) returning number`, { role });
      expect(row!.number).toBeGreaterThan(0);
    }
    await db.sql`delete from ext_fixture.notes where body like 'by %'`;
  });

  it("gives agents the columns and writes granted to them, never a contact column, an update or a delete", async () => {
    const asAgent = (fn: (t: postgres.TransactionSql) => Promise<unknown>) => asApp(A.merchantId, fn, { role: "app_agent" });
    await expect(asAgent((t) => t`select email from ext_fixture.notes`)).rejects.toThrow(/denied/);
    await expect(asAgent((t) => t`select * from ext_fixture.notes`)).rejects.toThrow(/denied/);
    await expect(asAgent((t) => t`update ext_fixture.notes set body = 'x'`)).rejects.toThrow(/denied/);
    await expect(asAgent((t) => t`delete from ext_fixture.notes`)).rejects.toThrow(/denied/);
    // Staff read the contact column.
    await expect(asApp(A.merchantId, (t) => t`select email from ext_fixture.notes`)).resolves.toBeDefined();
  });

  it("hides a row of another outlet from staff limited to their outlets", async () => {
    const rows = await asApp(A.merchantId, (t) => t`select 1 from ext_fixture.notes`, { outlets: A.outlet2Id });
    expect(rows).toEqual([]);
  });

  it("refuses an outlet or a brand of another merchant, even to the owner", async () => {
    await expect(db.sql`insert into ext_fixture.notes (merchant_id, outlet_id, brand_id, body) values (${A.merchantId}, ${B.outletId}, ${B.brandId}, 'x')`).rejects.toThrow(/notes_outlet_same_merchant/);
    // Another merchant's brand is never the outlet's, so the outlet-brand trigger refuses it before the key is checked.
    await expect(db.sql`insert into ext_fixture.notes (merchant_id, outlet_id, brand_id, body) values (${A.merchantId}, ${A.outletId}, ${B.brandId}, 'x')`).rejects.toThrow(/its outlet .* belongs to brand/);
  });

  it("shows nothing without a merchant context", async () => {
    expect(await asApp(null, (t) => t`select * from ext_fixture.notes`)).toEqual([]);
  });
});

describe("SAIL_MIGRATIONS", () => {
  it("reads schema=folder, comma-separated, and nothing when unset", () => {
    expect(migrationSetsFromEnv("")).toEqual([]);
    expect(migrationSetsFromEnv("ext_a=/x/a, ext_b=/x/b")).toEqual([
      { schema: "ext_a", folder: "/x/a" },
      { schema: "ext_b", folder: "/x/b" },
    ]);
  });

  it("refuses an entry without a schema, without a folder, or naming Sail's own folder", () => {
    expect(() => migrationSetsFromEnv("/x/a")).toThrow(/^SAIL_MIGRATIONS: expected schema=folder/);
    expect(() => migrationSetsFromEnv("ext_a=")).toThrow(/^SAIL_MIGRATIONS: "ext_a=" names no folder/);
    expect(() => migrationSetsFromEnv("ext_a= ")).toThrow(/^SAIL_MIGRATIONS: .* names no folder/);
    expect(() => migrationSetsFromEnv(`ext_a=${migrationsFolder()}`)).toThrow(/^SAIL_MIGRATIONS: .* is Sail's own migrations folder/);
  });
});
