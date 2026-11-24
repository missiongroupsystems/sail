import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { registerOperations } from "@sail/shared";
import { loadConfig, setConfigForTests } from "../src/config.js";
import { TEST_SECRETS } from "./helpers.js";
import { buildApp } from "../src/app.js";

const openapi = async (app: ReturnType<typeof buildApp>) => (await app.request("/openapi.json")).text();

/** A downstream workspace adds modules through `@sail/server` (src/public.ts) and `startServer({ modules })`. */
describe("extension loading", () => {
  setConfigForTests(loadConfig({ NODE_ENV: "test", DATABASE_URL: "postgres://localhost:5432/sail", ...TEST_SECRETS }));

  it("with no extra modules, the OpenAPI document is the committed one", async () => {
    const pub = await import("../src/public.js");
    expect(typeof pub.startServer).toBe("function");

    await import("../src/modules.js");
    const doc = await openapi(buildApp());
    const committed = readFileSync(join(import.meta.dirname, "..", "openapi.json"), "utf8");
    expect(JSON.stringify(JSON.parse(doc), null, 2) + "\n").toBe(committed);
  });

  it("an extra module's operation and route join the document and nothing else changes", async () => {
    const pub = await import("../src/public.js");
    const stock = JSON.parse(await openapi(buildApp())) as { paths: Record<string, unknown> };

    registerOperations({
      "ext.ping": { op: "ext.ping", summary: "Ping", description: "A constant.", tier: "T0", minRole: null, overrideAllowed: false, reasonRequired: false, dryRun: false, principals: ["staff"], emits: [], mcp: { expose: false, toolsets: [] } },
    });
    pub.registerRoutes((app) => {
      pub.defineOp(app, { op: "ext.ping", method: "get", path: "/v1/ext/ping", responses: { 200: pub.jsonResponse(pub.dataResponse(pub.z.object({ ok: pub.z.boolean() }))) } }, (c) => c.json({ data: { ok: true } }, 200));
    });
    const app = buildApp();
    const layered = JSON.parse(await openapi(app)) as { paths: Record<string, unknown> };
    const { "/v1/ext/ping": added, ...rest } = layered.paths;
    expect(added).toBeDefined();
    expect(rest).toEqual(stock.paths);
    expect((await app.request("/v1/ext/ping")).status).toBe(401);
  });
});
