import { defineConfig, devices } from "@playwright/test";

/**
 * The back office built with the test extension (packages/web/test/extension), as a downstream builds it: a production
 * build (webpack, SAIL_EXTENSIONS) served by `next start`, against the API on the demo seed (`dev:local`). Only
 * tests/extension.spec.ts runs here, in Chromium and WebKit: `pnpm --filter @sail/e2e test:e2e:extension`.
 * E2E_REUSE_SERVERS=1 runs against servers already up; E2E_API_URL and E2E_WEB_URL move them as in playwright.config.ts.
 */
const reuse = Boolean(process.env.E2E_REUSE_SERVERS);
const api = process.env.E2E_API_URL ?? "http://localhost:8080";
const web = process.env.E2E_WEB_URL ?? "http://localhost:3000";

export default defineConfig({
  testDir: "./tests",
  testMatch: /extension\.spec\.ts$/,
  fullyParallel: false,
  workers: 1,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  retries: 0,
  reporter: [["list"]],
  use: { actionTimeout: 20_000, navigationTimeout: 60_000, trace: "retain-on-failure", screenshot: "only-on-failure" },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
  ],
  webServer: [
    { command: `node scripts/with-log.mjs api pnpm --filter @sail/server dev:local`, env: { PORT: new URL(api).port, WEB_APP_URL: web }, url: `${api}/health`, timeout: 180_000, reuseExistingServer: reuse, stdout: "ignore", stderr: "pipe" },
    {
      command: `node scripts/with-log.mjs web-extension "pnpm --filter @sail/web build && pnpm --filter @sail/web exec next start -p ${new URL(web).port}"`,
      env: { NEXT_PUBLIC_API_URL: api, SAIL_EXTENSIONS: "test/extension", SAIL_WEB_DIST_DIR: ".next-extension" },
      url: `${web}/login`,
      timeout: 900_000,
      reuseExistingServer: reuse,
      stdout: "ignore",
      stderr: "pipe",
    },
  ],
});
