import postgres from "postgres";
import type { TestProject } from "vitest/node";
import { runMigrations } from "../src/db/migrate.js";
import { startEmbeddedPostgres, type EmbeddedPg } from "./pg.js";

declare module "vitest" {
  export interface ProvidedContext {
    pgAdminUrl: string;
    pgPort: number;
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
  const admin = postgres(pg.adminUrl, { max: 1, onnotice: () => {} });
  await admin`create database sail_template`;
  await admin.end();
  await runMigrations(`postgres://postgres@127.0.0.1:${pg.port}/sail_template`);
  project.provide("pgAdminUrl", pg.adminUrl);
  project.provide("pgPort", pg.port);
  return async () => {
    await pg?.stop();
  };
}
