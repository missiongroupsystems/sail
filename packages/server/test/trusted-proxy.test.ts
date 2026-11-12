import { afterAll, beforeAll, describe, expect, it } from "vitest";
import "../src/modules.js";
import { buildApp } from "../src/app.js";
import { api, freshDb, type TestDb } from "./helpers.js";

/**
 * X-Forwarded-For is honoured only with TRUST_PROXY on (identity.test.ts runs with it on). Without it a caller cannot
 * pick its own address: every attempt counts against the address the API sees, whatever the header says.
 */
let db: TestDb;
let call: ReturnType<typeof api>["call"];
beforeAll(async () => {
  db = await freshDb();
  call = api(buildApp()).call;
});
afterAll(async () => db.drop());

describe("forwarded addresses without TRUST_PROXY", () => {
  it("a different X-Forwarded-For on every attempt does not escape the per-address lock", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 21; i++) {
      const r = await call("POST", "/v1/auth/sign-in", { body: { email: `spray.${i}@nowhere.test`, password: "a common password" }, headers: { "x-forwarded-for": `198.51.100.${i + 1}` }, idempotencyKey: null });
      statuses.push(r.status);
    }
    expect(statuses.slice(0, 20).every((s) => s === 401)).toBe(true);
    expect(statuses[20]).toBe(429);
    const scopes = await db.sql<{ scope: string }[]>`select scope from pin_attempts where scope like 'signin-address:%'`;
    expect(scopes.map((r) => r.scope).some((s) => s.includes("198.51.100."))).toBe(false);
  });
});
