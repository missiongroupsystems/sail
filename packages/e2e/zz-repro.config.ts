import { defineConfig, devices } from "@playwright/test";
// Repro loops only (not committed): the servers are already up, none are started.
export default defineConfig({
  testDir: "./tests",
  workers: 1,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  retries: 0,
  reporter: [["list"]],
  use: { actionTimeout: 20_000, navigationTimeout: 300_000, trace: "off", screenshot: "only-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], timezoneId: process.env.E2E_BROWSER_TZ ?? "America/New_York", locale: process.env.E2E_BROWSER_LOCALE ?? "de-DE" } }],
});
