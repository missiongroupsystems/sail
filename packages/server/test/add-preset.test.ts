import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { REGION_PRESET_KEYS, REGION_PRESETS, type RegionPreset } from "@sail/shared";
import "../src/modules.js";
import { buildApp } from "../src/app.js";
import { api, freshDb, type TestDb } from "./helpers.js";

/**
 * docs/configuration.md says a region preset is added in packages/shared/src/presets.ts alone. This adds a throwaway
 * one the way the doc says (a key and an entry) and checks nothing else has to change: the API contract stays the
 * committed openapi.json (so `openapi:check` and the generated client types still pass), and first-run setup accepts it.
 */
const KEY = "zz-throwaway";
const throwaway: RegionPreset = { ...REGION_PRESETS.blank, key: KEY as RegionPreset["key"], name: "Throwaway (test)", currency: "AUD", locale: "en-AU", time_zone_suggestion: "Australia/Sydney", cash_rounding_increment: 5, cash_variance_threshold: 500 };

let db: TestDb;
beforeAll(async () => {
  (REGION_PRESET_KEYS as unknown as string[]).push(KEY);
  (REGION_PRESETS as Record<string, RegionPreset>)[KEY] = throwaway;
  db = await freshDb();
});
afterAll(async () => {
  (REGION_PRESET_KEYS as unknown as string[]).pop();
  delete (REGION_PRESETS as Record<string, RegionPreset>)[KEY];
  await db.drop();
});

describe("adding a region preset (B4)", () => {
  it("leaves the API contract unchanged", async () => {
    const doc = await (await buildApp().request("/openapi.json")).json();
    const committed = JSON.parse(readFileSync(join(__dirname, "..", "openapi.json"), "utf8"));
    expect(doc).toEqual(committed);
    // The contract names no preset, so a new one never changes it (an enum here would need openapi:generate and gen:api).
    const preset = (doc as { paths: Record<string, { post: { requestBody: { content: { "application/json": { schema: { properties: Record<string, Record<string, unknown>> } } } } } }> }).paths["/v1/setup"]!.post.requestBody.content["application/json"].schema.properties.preset!;
    expect(preset.type).toBe("string");
    expect(preset.enum).toBeUndefined();
  });

  it("first-run setup accepts the new preset and applies it", async () => {
    const call = api(buildApp()).call;
    const r = await call<{ data: { merchant_id: string } }>("POST", "/v1/setup", { body: { business_name: "Throwaway", preset: KEY, time_zone: "Australia/Sydney", outlet_name: "One", admin: { name: "First Admin", email: "first@throwaway.test", password: "a long enough password" } }, idempotencyKey: null });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const [m] = await db.sql<{ currency: string }[]>`select currency from merchant_settings where merchant_id = ${r.body.data.merchant_id}`;
    expect(m!.currency).toBe("AUD");
    expect((await call("POST", "/v1/setup", { body: { business_name: "X", preset: "not-a-preset", time_zone: "UTC", outlet_name: "O", admin: { name: "A", email: "a@b.test", password: "a long enough password" } }, idempotencyKey: null })).status).toBe(400);
  });
});
