import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end tests against the real stack: the API on an embedded Postgres with the demo seed (`dev:local`), the
 * back office and POS (web, :3000) and the guest app (:3001). Every run starts its own stack on a fresh database;
 * set E2E_REUSE_SERVERS=1 to run against servers already up (their data must still have free tables, and no shift open).
 * E2E_API_URL moves the API off :8080 when that port is taken; the apps are pointed at it through NEXT_PUBLIC_API_URL.
 * E2E_WEB_URL and E2E_GUEST_URL do the same for the web app (:3000) and the guest app (:3001).
 */
const reuse = Boolean(process.env.E2E_REUSE_SERVERS);
const api = process.env.E2E_API_URL ?? "http://localhost:8080";
const web = process.env.E2E_WEB_URL ?? "http://localhost:3000";
const guest = process.env.E2E_GUEST_URL ?? "http://localhost:3001";

export default defineConfig({
  testDir: "./tests",
  // The specs share one register (tables, shifts), so they run one at a time in file order.
  fullyParallel: false,
  workers: 1,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  retries: 0,
  reporter: [["list"]],
  use: {
    // The dev servers compile a route on its first visit, so navigation gets longer than a click.
    actionTimeout: 20_000,
    navigationTimeout: 300_000,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    { command: "pnpm --filter @sail/server dev:local", env: { PORT: new URL(api).port, GUEST_APP_URL: guest }, url: `${api}/health`, timeout: 180_000, reuseExistingServer: reuse, stdout: "ignore", stderr: "pipe" },
    { command: `pnpm --filter @sail/web exec next dev -p ${new URL(web).port}`, env: { NEXT_PUBLIC_API_URL: api }, url: `${web}/login`, timeout: 180_000, reuseExistingServer: reuse, stdout: "ignore", stderr: "pipe" },
    { command: `pnpm --filter @sail/guest exec next dev -p ${new URL(guest).port}`, env: { NEXT_PUBLIC_API_URL: api }, url: guest, timeout: 180_000, reuseExistingServer: reuse, stdout: "ignore", stderr: "pipe" },
  ],
});
