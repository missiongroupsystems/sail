/**
 * Local development without Docker or Supabase:
 *   pnpm --filter @sail/server dev:local
 *
 * Starts an embedded Postgres, migrates it, bootstraps two demo merchants
 * (Singapore: admin@sail.local; EU VAT in EUR: admin.eu@sail.local; PIN
 * 123456 for both), and serves the API on :8080 with the SSE listener. Sign-in tokens come from POST /v1/auth/dev-token {email}.
 * Set SAIL_DEV_DATA_DIR to keep data between runs (default: fresh each time).
 */
import { serve } from "@hono/node-server";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { startEmbeddedPostgres } from "../test/pg.js";
import { runMigrations } from "../src/db/migrate.js";
import { bootstrapMerchant } from "../src/bootstrap.js";

const pg = await startEmbeddedPostgres();
const url = `postgres://postgres@127.0.0.1:${pg.port}/sail_dev`;
const { default: postgres } = await import("postgres");
const admin = postgres(pg.adminUrl, { max: 1, onnotice: () => {} });
await admin`create database sail_dev`;
await admin.end();
await runMigrations(url, { log: console.log });

process.env.NODE_ENV ??= "development";
process.env.DATABASE_URL = url;
process.env.LISTEN_DATABASE_URL = url;
process.env.ALLOW_POOLER_LISTEN = "1";
process.env.DEV_AUTH_SECRET ??= "local-dev-secret-change-me-0123456789";
process.env.STATION_TOKEN_SECRET ??= "local-station-secret-0123456789abcdef";
process.env.GUEST_TOKEN_SECRET ??= "local-guest-secret-0123456789abcdef";
process.env.RELAY_TOKEN_SECRET ??= "local-relay-secret-0123456789abcdef";
process.env.AGENT_TOKEN_SECRET ??= "local-agent-secret-0123456789abcdef";
process.env.PORT ??= "8080";
process.env.CORS_ORIGIN ??= "*";

// Two demo merchants, so both tax paths run locally: Singapore (GST 9% on exclusive prices, rounded per line,
// service charge and container deposit) and an EU café (inclusive VAT at 20% and 10%, rounded once per rate, EUR).
const boot = await bootstrapMerchant(url, {
  merchantName: "Harbour Group",
  brandName: "Harbour Kitchen",
  outletName: "Harbour Kitchen · Marina",
  admin: { name: "Ada Admin", email: "admin@sail.local", pin: "123456" },
  preset: "sg",
  timeZone: "Asia/Singapore",
  cashRoundingIncrement: 5,
});
const bootEu = await bootstrapMerchant(url, {
  merchantName: "Kanal Gruppe",
  brandName: "Café Kanal",
  outletName: "Café Kanal · Kreuzberg",
  admin: { name: "Erika Admin", email: "admin.eu@sail.local", pin: "123456" },
  preset: "eu-vat",
  timeZone: "Europe/Berlin",
  locale: "de-DE",
});

const seed = await import("./dev-seed.js");
await seed.devSeed(url, boot);
await seed.devSeedEu(url, bootEu);

await import("../src/modules.js");
const { buildApp } = await import("../src/app.js");
const { startListener } = await import("../src/sse/listener.js");
const app = buildApp();
await startListener();
const { runWorker } = await import("../src/worker/index.js");
await runWorker(); // imports, scheduled rules, stale print claims, guest session expiry
const port = Number(process.env.PORT);
serve({ fetch: app.fetch, port }, () => {
  const info = { api: `http://localhost:${port}`, database_url: url, admin_email: "admin@sail.local", admin_pin: "123456", ...boot, eu: { admin_email: "admin.eu@sail.local", admin_pin: "123456", ...bootEu } };
  writeFileSync(join(process.cwd(), ".dev-local.json"), JSON.stringify(info, null, 2));
  console.log("\nSail API (local) ready:\n" + JSON.stringify(info, null, 2) + "\n\nGet a sign-in token: curl -X POST localhost:" + port + "/v1/auth/dev-token -H 'content-type: application/json' -d '{\"email\":\"admin@sail.local\"}'\n");
});

const shutdown = async () => {
  await pg.stop();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
