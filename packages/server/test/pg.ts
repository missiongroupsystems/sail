import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import net from "node:net";

/**
 * Embedded Postgres for tests (Docker is not available on every machine).
 * Uses the real Postgres binaries shipped by `@embedded-postgres/<platform>`,
 * so RLS, SET LOCAL ROLE, triggers and LISTEN/NOTIFY behave exactly as in
 * production Postgres.
 */
export type EmbeddedPg = { url: string; adminUrl: string; port: number; stop: () => Promise<void>; dataDir: string };

function platformPackage(): string {
  const map: Record<string, string> = { "linux-x64": "@embedded-postgres/linux-x64", "linux-arm64": "@embedded-postgres/linux-arm64", "darwin-arm64": "@embedded-postgres/darwin-arm64", "darwin-x64": "@embedded-postgres/darwin-x64" };
  const key = `${process.platform}-${process.arch}`;
  const pkg = map[key];
  if (!pkg) throw new Error(`No embedded Postgres binaries for ${key}`);
  return pkg;
}

export function nativeDir(): string {
  const require = createRequire(import.meta.url);
  // The package exports only ./dist/index.js; the binaries live in ./native next to dist.
  const entry = require.resolve(platformPackage());
  let dir = dirname(entry);
  for (let i = 0; i < 4; i++) {
    const candidate = join(dir, "native");
    if (existsSync(join(candidate, "bin", "initdb"))) return candidate;
    dir = dirname(dir);
  }
  throw new Error(`initdb not found near ${entry}`);
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

export async function startEmbeddedPostgres(): Promise<EmbeddedPg> {
  const native = nativeDir();
  const env = { ...process.env, LD_LIBRARY_PATH: `${join(native, "lib")}:${process.env.LD_LIBRARY_PATH ?? ""}`, DYLD_LIBRARY_PATH: join(native, "lib"), LC_ALL: "C" };
  const dataDir = mkdtempSync(join(tmpdir(), "sail-pg-"));
  const pwFile = join(dataDir, "pw");
  rmSync(dataDir, { recursive: true, force: true });
  const init = spawnSync(join(native, "bin", "initdb"), ["-D", dataDir, "-U", "postgres", "-A", "trust", "--no-locale", "-E", "UTF8"], { env, encoding: "utf8" });
  if (init.status !== 0) throw new Error(`initdb failed: ${init.stderr}\n${init.stdout}`);
  void pwFile;
  const port = await freePort();
  const sockDir = mkdtempSync(join(tmpdir(), "sail-pgsock-"));
  const pgOpts = `-c listen_addresses=127.0.0.1 -c port=${port} -c unix_socket_directories=${sockDir} -c fsync=off -c synchronous_commit=off -c full_page_writes=off -c max_connections=200 -c log_min_messages=warning`;
  const start = spawnSync(join(native, "bin", "pg_ctl"), ["-D", dataDir, "-o", pgOpts, "-w", "-t", "60", "-l", join(dataDir, "server.log"), "start"], { env, encoding: "utf8" });
  if (start.status !== 0) throw new Error(`pg_ctl start failed: ${start.stderr}\n${start.stdout}`);
  const adminUrl = `postgres://postgres@127.0.0.1:${port}/postgres`;
  // pg_ctl leaves the server running on its own, so a process killed before its cleanup (SIGKILL, a test runner or
  // Playwright tearing it down) would leave the server and its directories behind. A detached watchdog outlives this
  // process, and once it has gone stops the server and removes the directories.
  const watchdog = spawn(process.execPath, ["-e", WATCHDOG, String(process.pid), join(native, "bin", "pg_ctl"), dataDir, sockDir], { env, detached: true, stdio: "ignore" });
  watchdog.unref();
  return {
    url: adminUrl,
    adminUrl,
    port,
    dataDir,
    stop: async () => {
      watchdog.kill();
      await new Promise<void>((resolve) => {
        const p = spawn(join(native, "bin", "pg_ctl"), ["-D", dataDir, "-m", "immediate", "stop"], { env, stdio: "ignore" });
        p.on("exit", () => resolve());
        p.on("error", () => resolve());
      });
      rmSync(dataDir, { recursive: true, force: true });
      rmSync(sockDir, { recursive: true, force: true });
    },
  };
}

/** Run as `node -e WATCHDOG <pid> <pg_ctl> <dataDir> <sockDir>`: waits for the process to exit, then cleans up after it. */
const WATCHDOG = `
const { spawnSync } = require("node:child_process");
const { rmSync } = require("node:fs");
const [pid, pgCtl, dataDir, sockDir] = process.argv.slice(1);
const timer = setInterval(() => {
  try { process.kill(Number(pid), 0); return; } catch {}
  clearInterval(timer);
  spawnSync(pgCtl, ["-D", dataDir, "-m", "immediate", "stop"], { stdio: "ignore" });
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(sockDir, { recursive: true, force: true });
}, 500);
`;

export function listMigrationFiles(folder: string): string[] {
  return readdirSync(folder).filter((f) => f.endsWith(".sql")).sort();
}
