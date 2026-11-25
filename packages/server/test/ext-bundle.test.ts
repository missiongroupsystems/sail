// A downstream production image bundles its start file with @sail/server inlined (Sail exports TypeScript source), so
// every Sail module lands in one file. This builds that file from a fixture entry and runs it with node.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { migrationsFolder } from "../src/db/migrate.js";
import { freshDb, TEST_SECRETS, type TestDb } from "./helpers.js";

const SERVER = join(import.meta.dirname, "..");
const EXT = join(SERVER, "test/fixtures/ext-migrations");
const FIXTURE = join(SERVER, "test/fixtures/ext-bundle");
// Laid out as a downstream image: the bundle in dist/, the downstream's own migrations in drizzle/ beside it. Inside
// Sail's package, so the bundle finds the dependencies it leaves external (hono, postgres, ...) as an image would.
const root = join(SERVER, "node_modules/.cache", `ext-bundle-${randomUUID().slice(0, 8)}`);
const out = join(root, "dist");
let db: TestDb;
let cwd: string;

beforeAll(async () => {
  // The downstream's folder: its package.json names @sail/server only, and its tsup config is the docs' recipe. Built
  // with tsup's command there, as a downstream builds it, so tsup sees that package.json and not Sail's.
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, "node_modules/@sail"), { recursive: true });
  symlinkSync(SERVER, join(root, "node_modules/@sail/server"), "dir");
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "downstream", private: true, type: "module", dependencies: { "@sail/server": "*" } }));
  cpSync(join(FIXTURE, "tsup.config.ts"), join(root, "tsup.config.ts"));
  cpSync(join(FIXTURE, "entry.ts"), join(root, "src/start.ts"));
  cpSync(join(FIXTURE, "migrate.ts"), join(root, "src/migrate.ts"));
  const built = spawnSync(process.execPath, [join(SERVER, "node_modules/tsup/dist/cli-default.js"), "--silent"], { cwd: root, encoding: "utf8" });
  expect(built.status, built.stderr + built.stdout).toBe(0);
  db = await freshDb();
  // The downstream's own migrations, beside its bundle and in its working folder: neither is Sail's.
  cpSync(EXT, join(root, "drizzle"), { recursive: true });
  cwd = mkdtempSync(join(tmpdir(), "ext-bundle-cwd-"));
  mkdirSync(join(cwd, "drizzle"));
  cpSync(EXT, join(cwd, "drizzle"), { recursive: true });
}, 120_000);

afterAll(async () => {
  rmSync(root, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
  await db?.drop();
});

/** Runs a bundled file to its end: exit code and everything it printed. */
const run = (file: string, env: Record<string, string | undefined>) =>
  new Promise<{ code: number | null; output: string }>((ok) => {
    const child = spawn(process.execPath, [join(out, file)], { cwd, env: { PATH: process.env.PATH, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (d) => (output += d));
    child.stderr.on("data", (d) => (output += d));
    child.on("exit", (code) => ok({ code, output }));
  });

const freePort = () =>
  new Promise<number>((ok) => {
    const s = createServer().listen(0, () => {
      const { port } = s.address() as { port: number };
      s.close(() => ok(port));
    });
  });

describe("a bundled downstream start file", () => {
  it("starts the API and serves, and does not run migrations or exit", async () => {
    const port = await freePort();
    const env = { PATH: process.env.PATH, NODE_ENV: "test", LOG_LEVEL: "warn", PORT: String(port), DATABASE_URL: db.url, LISTEN_DATABASE_URL: db.url, ALLOW_POOLER_LISTEN: "1", ...TEST_SECRETS };
    const child: ChildProcess = spawn(process.execPath, [join(out, "server.js"), "--role=app"], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout!.on("data", (d) => (output += d));
    child.stderr!.on("data", (d) => (output += d));
    const exited = new Promise<number | null>((ok) => child.on("exit", (code) => ok(code)));
    try {
      const health = await new Promise<number>((ok, no) => {
        const deadline = Date.now() + 30_000;
        void exited.then((code) => no(new Error(`the bundle exited (code ${code}) instead of serving:\n${output}`)));
        const poll = () =>
          fetch(`http://127.0.0.1:${port}/health`).then(
            (r) => ok(r.status),
            () => (Date.now() > deadline ? no(new Error(`no answer on :${port}:\n${output}`)) : setTimeout(poll, 200)),
          );
        poll();
      });
      expect(health).toBe(200);
      expect(output).not.toMatch(/drift check|migrated/);
    } finally {
      child.kill("SIGTERM");
      await exited;
    }
  }, 60_000);

  it("a migrate file never takes the downstream's own drizzle/ for Sail's, and applies Sail's from the folder it names", async () => {
    const admin = postgres(inject("pgAdminUrl"), { max: 1, onnotice: () => {} });
    const name = `bundle_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    await admin.unsafe(`create database ${name}`);
    const url = `postgres://postgres@127.0.0.1:${inject("pgPort")}/${name}`;
    const sql = postgres(url, { max: 1, onnotice: () => {} });
    try {
      const lost = await run("migrate.js", { DATABASE_URL: url });
      expect(lost.code).toBe(1);
      expect(lost.output).toContain("Sail's migrations folder was not found next to the runner");
      expect((await sql`select to_regclass('drizzle.__drizzle_migrations') as t`)[0]!.t).toBeNull();
      // Named explicitly, a folder that is not Sail's is refused too.
      const wrong = await run("migrate.js", { DATABASE_URL: url, SAIL_FOLDER: EXT });
      expect(wrong.code).toBe(1);
      expect(wrong.output).toContain("is not Sail's migrations folder");
      const ok = await run("migrate.js", { DATABASE_URL: url, SAIL_FOLDER: migrationsFolder() });
      expect(ok.code, ok.output).toBe(0);
      const total = (JSON.parse(readFileSync(join(migrationsFolder(), "meta/_journal.json"), "utf8")) as { entries: unknown[] }).entries.length;
      expect(JSON.parse(ok.output.trim().split("\n").at(-1)!)).toEqual({ applied: total, total, sets: [] });
    } finally {
      await sql.end({ timeout: 2 });
      await admin.unsafe(`drop database if exists ${name} with (force)`);
      await admin.end({ timeout: 2 });
    }
  }, 120_000);
});
