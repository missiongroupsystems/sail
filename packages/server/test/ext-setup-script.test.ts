// A set-up script that uses Sail's pool ends on its own once it calls closePool (docs/extensions.md): the pool's idle
// connections would otherwise keep node running until they time out.
import { spawn } from "node:child_process";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { freshDb, TEST_SECRETS, type TestDb } from "./helpers.js";

const SERVER = join(import.meta.dirname, "..");
let db: TestDb;

beforeAll(async () => {
  db = await freshDb();
});
afterAll(async () => {
  await db.drop();
});

it("a script that calls closePool exits by itself, well before the pool's idle timeout", async () => {
  const started = Date.now();
  const child = spawn(process.execPath, ["--import", "tsx", join(SERVER, "test/fixtures/ext-setup/script.ts")], { cwd: SERVER, env: { PATH: process.env.PATH, NODE_ENV: "test", LOG_LEVEL: "warn", DATABASE_URL: db.url, ...TEST_SECRETS }, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (d) => (output += d));
  child.stderr.on("data", (d) => (output += d));
  const code = await new Promise<number | null>((ok, no) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      no(new Error(`the script was still running after 15 s:\n${output}`));
    }, 15_000);
    child.on("exit", (c) => {
      clearTimeout(timer);
      ok(c);
    });
  });
  expect(code, output).toBe(0);
  expect(JSON.parse(output.trim().split("\n").at(-1)!)).toEqual({ merchants: 0 });
  expect(Date.now() - started).toBeLessThan(15_000);
}, 30_000);
