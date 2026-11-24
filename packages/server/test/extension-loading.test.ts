import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OPERATIONS, type OperationSpec } from "@sail/shared";
import * as pub from "../src/public.js";
import { buildApp } from "../src/app.js";
import { api, freshDb, seedMerchant, type SeededMerchant, type TestDb } from "./helpers.js";

/**
 * A downstream workspace adds modules through `@sail/server` (src/public.ts) and `startServer({ modules })`. Every
 * extension here uses only what public.ts exports.
 */
const spec = (op: string, over: Partial<OperationSpec> = {}): OperationSpec => ({ op, summary: "Extension operation", description: "An operation an extension adds.", tier: "T0", minRole: "server", overrideAllowed: false, reasonRequired: false, dryRun: false, principals: ["staff"], emits: [], mcp: { expose: false, toolsets: [] }, ...over });

let db: TestDb;
let a: SeededMerchant;
let b: SeededMerchant;

beforeAll(async () => {
  db = await freshDb();
  a = await seedMerchant(db.sql, "Alpha");
  b = await seedMerchant(db.sql, "Beta");
});
afterAll(async () => {
  await db.drop();
});

describe("extension loading", () => {
  it("with no extra modules, the OpenAPI document is the committed one", async () => {
    expect(typeof pub.startServer).toBe("function");
    await import("../src/modules.js");
    const doc = await (await buildApp().request("/openapi.json")).text();
    const committed = readFileSync(join(import.meta.dirname, "..", "openapi.json"), "utf8");
    expect(JSON.stringify(JSON.parse(doc), null, 2) + "\n").toBe(committed);
  });

  it("an extension route reads a tenant table through the request handles and sees only the caller's merchant", async () => {
    pub.registerOperations({ "ext.outlets": spec("ext.outlets") });
    pub.registerRoutes((app) => {
      pub.defineOp(app, { op: "ext.outlets", method: "get", path: "/v1/ext/outlets", responses: { 200: pub.jsonResponse(pub.dataResponse(pub.z.object({ drizzle: pub.z.array(pub.z.string()), sql: pub.z.array(pub.z.string()) }))) } }, async (c) => {
        const rows = await pub.db().select({ merchantId: pub.schema.outlets.merchantId }).from(pub.schema.outlets);
        const raw = await pub.tx()<{ merchant_id: string }[]>`select merchant_id from outlets`;
        return c.json({ data: { drizzle: rows.map((r) => r.merchantId), sql: raw.map((r) => r.merchant_id) } }, 200);
      });
    });
    const call = api(buildApp()).call;
    for (const m of [a, b]) {
      const r = await call<{ data: { drizzle: string[]; sql: string[] } }>("GET", "/v1/ext/outlets", { token: m.cashier.token });
      expect(r.status).toBe(200);
      expect(r.body.data.drizzle).toEqual([m.merchantId, m.merchantId]);
      expect(r.body.data.sql).toEqual([m.merchantId, m.merchantId]);
    }
    expect((await call("GET", "/v1/ext/outlets")).status).toBe(401);
    // withTransaction, by contrast, runs as the connection owner: both merchants' outlets. It is for worker tasks.
    const all = await pub.withTransaction(async () => pub.db().select({ merchantId: pub.schema.outlets.merchantId }).from(pub.schema.outlets));
    expect(new Set(all.map((r) => r.merchantId))).toEqual(new Set([a.merchantId, b.merchantId]));
  });

  it("an extension cannot replace an operation Sail registered", async () => {
    expect(() => pub.registerOperations({ "staff.list": spec("staff.list", { minRole: "server" }) })).toThrow("already registered");
    expect(OPERATIONS["staff.list"]!.minRole).toBe("manager");
  });

});
