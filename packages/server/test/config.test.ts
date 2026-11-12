import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

const SECRETS = ["SESSION_TOKEN_SECRET", "STATION_TOKEN_SECRET", "GUEST_TOKEN_SECRET", "RELAY_TOKEN_SECRET", "AGENT_TOKEN_SECRET"] as const;
const strong = (k: string) => `${k.toLowerCase()}-${"x7Qp2Lm9".repeat(5)}`;
const base = { NODE_ENV: "production", DATABASE_URL: "postgres://u:p@db:5432/sail", WEB_APP_URL: "https://backoffice.example.com", ...Object.fromEntries(SECRETS.map((k) => [k, strong(k)])) };

/** The secret values the repository publishes: .env.example and dev:local. A production server must refuse every one. */
function publishedSecrets(): [string, string][] {
  const example = readFileSync(join(__dirname, "..", ".env.example"), "utf8");
  const devLocal = readFileSync(join(__dirname, "..", "scripts", "dev-local.ts"), "utf8");
  const out: [string, string][] = [];
  for (const m of example.matchAll(/^([A-Z_]*SECRET)=(.+)$/gm)) out.push([m[1]!, m[2]!.trim()]);
  for (const m of devLocal.matchAll(/process\.env\.([A-Z_]*SECRET) \?\?= "([^"]+)"/g)) out.push([m[1]!, m[2]!]);
  return out;
}

describe("production refuses weak secrets (B6)", () => {
  it("starts with strong secrets", () => {
    expect(loadConfig(base).NODE_ENV).toBe("production");
  });

  it("refuses every secret value published in .env.example or dev:local", () => {
    const published = publishedSecrets();
    expect(published.length).toBeGreaterThanOrEqual(10);
    for (const [k, v] of published) expect(() => loadConfig({ ...base, [k]: v }), `${k}=${v}`).toThrow(/placeholder|too short/);
  });

  it("refuses a secret shorter than 32 characters, and only in production", () => {
    expect(() => loadConfig({ ...base, AGENT_TOKEN_SECRET: "a".repeat(31) })).toThrow(/AGENT_TOKEN_SECRET.*too short/);
    expect(loadConfig({ ...base, NODE_ENV: "development", AGENT_TOKEN_SECRET: "change-me-agent-0123456789abcdef" }).NODE_ENV).toBe("development");
  });

  it("refuses the test suite's secrets, and a missing STATION_TOKEN_SECRET (it keys PIN lookups)", () => {
    expect(() => loadConfig({ ...base, GUEST_TOKEN_SECRET: "guest-secret-for-tests-0123456789abcd" })).toThrow(/placeholder/);
    expect(() => loadConfig({ ...base, STATION_TOKEN_SECRET: undefined })).toThrow(/STATION_TOKEN_SECRET is required/);
  });
});
