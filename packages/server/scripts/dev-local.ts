/**
 * Local development without Docker or Supabase:
 *   pnpm --filter @sail/server dev:local
 *
 * Starts an embedded Postgres, migrates it, bootstraps two demo merchants
 * (Singapore: admin@sail.local; EU VAT in EUR: admin.eu@sail.local; PIN
 * 123456 and back-office password `sail-demo-password` for both), and serves
 * the API on :8080 with the SSE listener and the worker. It also starts the card-terminal simulator on a free
 * port (its URL is printed and written to .dev-local.json). The back office signs in with that
 * email and password, through the same local identity provider as production.
 * SAIL_DEV_EMPTY=1 skips the demo merchants, so the back office opens on
 * first-run setup.
 */
import { serve } from "@hono/node-server";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { startEmbeddedPostgres } from "../test/pg.js";
import { runMigrations } from "../src/db/migrate.js";
import { bootstrapMerchant } from "../src/bootstrap.js";
import { startSimulator } from "./payment-simulator.js";

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
process.env.SESSION_TOKEN_SECRET ??= "local-session-secret-0123456789abcdef";
// Sign-in reaches the API through the web app, which forwards the browser's address.
process.env.TRUST_PROXY ??= "1";
process.env.STATION_TOKEN_SECRET ??= "local-station-secret-0123456789abcdef";
process.env.GUEST_TOKEN_SECRET ??= "local-guest-secret-0123456789abcdef";
process.env.RELAY_TOKEN_SECRET ??= "local-relay-secret-0123456789abcdef";
process.env.AGENT_TOKEN_SECRET ??= "local-agent-secret-0123456789abcdef";
process.env.PORT ??= "8080";
process.env.CORS_ORIGIN ??= "*";

const DEMO_PASSWORD = "sail-demo-password";
const empty = process.env.SAIL_DEV_EMPTY === "1";

// The card-terminal simulator behind the demo's "Card (terminal)" payment method, on a free port.
const sim = await startSimulator({ apiUrl: `http://localhost:${process.env.PORT}` });
process.env.PAYMENT_SIMULATOR_URL = sim.url;

// Two demo merchants, so both tax paths run locally: Singapore (GST 9% on exclusive prices, rounded per line,
// service charge and container deposit) and an EU café (inclusive VAT at 20% and 10%, rounded once per rate, EUR).
const boot = empty ? null : await bootstrapMerchant(url, {
  merchantName: "Sample Group",
  brandName: "Sample Kitchen",
  outletName: "Sample Kitchen · Main",
  admin: { name: "Ada Admin", email: "admin@sail.local", pin: "123456", password: DEMO_PASSWORD },
  preset: "sg",
  timeZone: "Asia/Singapore",
  cashRoundingIncrement: 5,
});
const bootEu = empty ? null : await bootstrapMerchant(url, {
  merchantName: "Kanal Gruppe",
  brandName: "Café Kanal",
  outletName: "Café Kanal · Kreuzberg",
  admin: { name: "Erika Admin", email: "admin.eu@sail.local", pin: "123456", password: DEMO_PASSWORD },
  preset: "eu-vat",
  timeZone: "Europe/Berlin",
  locale: "de-DE",
});

if (boot && bootEu) {
  const seed = await import("./dev-seed.js");
  await seed.devSeed(url, boot);
  await seed.devSeedEu(url, bootEu);
}

await import("../src/modules.js");
const { buildApp } = await import("../src/app.js");
const { startListener } = await import("../src/sse/listener.js");
const app = buildApp();
await startListener();
const { runWorker } = await import("../src/worker/index.js");
await runWorker(); // imports, scheduled rules, stale print claims, guest session expiry
const port = Number(process.env.PORT);
serve({ fetch: app.fetch, port }, () => {
  if (!boot || !bootEu) {
    console.log(`\nSail API (local, empty) ready on http://localhost:${port}: open the back office to run first-run setup.\n`);
    return;
  }
  const info = { api: `http://localhost:${port}`, payment_simulator: sim.url, database_url: url, admin_email: "admin@sail.local", admin_password: DEMO_PASSWORD, admin_pin: "123456", ...boot, eu: { admin_email: "admin.eu@sail.local", admin_password: DEMO_PASSWORD, admin_pin: "123456", ...bootEu } };
  writeFileSync(join(process.cwd(), ".dev-local.json"), JSON.stringify(info, null, 2));
  console.log("\nSail API (local) ready:\n" + JSON.stringify(info, null, 2) + "\n\nGet a sign-in token: curl -X POST localhost:" + port + `/v1/auth/sign-in -H 'content-type: application/json' -d '{"email":"admin@sail.local","password":"${DEMO_PASSWORD}"}'\n`);
});

let stopping = false;
const shutdown = async () => {
  if (stopping) return;
  stopping = true;
  await sim.stop();
  await pg.stop();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
process.on("SIGHUP", () => void shutdown());
// The parent (pnpm, a terminal, Playwright) went away without signalling: this process was reparented, so stop too.
// A kill that leaves no chance to run this is covered by the embedded Postgres's own watchdog.
const parent = process.ppid;
setInterval(() => {
  if (process.ppid !== parent) void shutdown();
}, 1000).unref();
