import postgres from "postgres";
import type { TestProject } from "vitest/node";
import { runMigrations } from "../src/db/migrate.js";
import { installFakeClock, startEmbeddedPostgres, type EmbeddedPg } from "./pg.js";

declare module "vitest" {
  export interface ProvidedContext {
    pgAdminUrl: string;
    pgPort: number;
    /** SAIL_TEST_NOW minus the real time when the run started, in ms; 0 when the clock is real. */
    clockOffsetMs: number;
  }
}

/**
 * Starts one embedded Postgres for the whole run and builds `sail_template`
 * from the migration journal. Each test file clones the template into its own
 * database (CREATE DATABASE ... TEMPLATE), so files run in parallel and never
 * see each other's rows.
 */
let pg: EmbeddedPg | null = null;

export default async function setup(project: TestProject) {
  pg = await startEmbeddedPostgres();
  const offsetMs = clockOffset();
  const admin = postgres(pg.adminUrl, { max: 1, onnotice: () => {} });
  await admin`create database sail_template`;
  if (offsetMs !== 0) {
    // Postgres moves with the faked clock (test/fake-clock.ts): faketime comes before pg_catalog on every session's
    // search path, so now() and clock_timestamp() resolve to it, and so do the migrations' column defaults.
    await admin.unsafe(`alter system set search_path = public, faketime, pg_catalog`);
    await admin`select pg_reload_conf()`;
    await installFakeClock(`postgres://postgres@127.0.0.1:${pg.port}/sail_template`, offsetMs);
  }
  await admin.end();
  await runMigrations(`postgres://postgres@127.0.0.1:${pg.port}/sail_template`);
  project.provide("pgAdminUrl", pg.adminUrl);
  project.provide("pgPort", pg.port);
  project.provide("clockOffsetMs", offsetMs);
  return async () => {
    await pg?.stop();
  };
}

/** SAIL_TEST_NOW=<ISO instant> runs the whole suite as if it started at that instant (see test/fake-clock.ts). */
function clockOffset(): number {
  const at = process.env.SAIL_TEST_NOW;
  if (!at) return 0;
  const t = Date.parse(at);
  if (Number.isNaN(t)) throw new Error(`SAIL_TEST_NOW is not an instant: ${at}`);
  return t - Date.now();
}
