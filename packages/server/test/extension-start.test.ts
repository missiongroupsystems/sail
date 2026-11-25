import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { OperationSpec } from "@sail/shared";
import * as pub from "../src/public.js";
import { workerTasks } from "../src/worker/index.js";
import { freshDb, seedMerchant, type SeededMerchant, type TestDb } from "./helpers.js";

/**
 * `startServer({ modules })`, the way a downstream start file calls it. Importing `public.ts` registers the operations
 * of the route modules it reaches, but none of Sail's worker tasks, so Sail's tasks seen by an extension module are
 * there because startServer loaded Sail's modules first.
 */
const spec = (op: string, over: Partial<OperationSpec> = {}): OperationSpec => ({ op, summary: "Extension operation", description: "An operation an extension adds.", tier: "T0", minRole: "server", overrideAllowed: false, reasonRequired: false, dryRun: false, principals: ["staff"], emits: [], mcp: { expose: false, toolsets: [] }, ...over });

let db: TestDb;
let a: SeededMerchant;
const role = process.env.SAIL_ROLE;

beforeAll(async () => {
  db = await freshDb({ PORT: "0" });
  a = await seedMerchant(db.sql, "Alpha");
});
afterAll(async () => {
  if (role === undefined) delete process.env.SAIL_ROLE;
  else process.env.SAIL_ROLE = role;
  await db.drop();
});

describe("startServer with extra modules", () => {
  it("a worker start loads the modules after Sail's own and runs the extension's task", async () => {
    process.env.SAIL_ROLE = "worker";
    const seen: { sailTasks: string[] }[] = [];
    let ran!: () => void;
    const taskRan = new Promise<void>((ok) => (ran = ok));
    const started = await pub.startServer({
      modules: [
        async () => {
          seen.push({ sailTasks: workerTasks() });
          pub.registerWorkerTask({ name: "ext.task", intervalMs: 60_000, run: async () => ran() });
        },
      ],
    });
    try {
      await Promise.race([taskRan, new Promise((_, no) => setTimeout(() => no(new Error("the extension's task never ran")), 10_000))]);
      expect(seen).toHaveLength(1);
      expect(seen[0]!.sailTasks).toContain("pricing_rules.activate_due");
      expect(workerTasks().at(-1)).toBe("ext.task");
    } finally {
      await started.stop();
    }
  });

  it("an app start loads the modules before the app is built: the extension's route is served", async () => {
    process.env.SAIL_ROLE = "app";
    const started = await pub.startServer({
      modules: [
        async () => {
          pub.registerOperations({ "ext.ping": spec("ext.ping", { minRole: null }) });
          pub.registerRoutes((app) => {
            pub.defineOp(app, { op: "ext.ping", method: "get", path: "/v1/ext/ping", responses: { 200: pub.jsonResponse(pub.dataResponse(pub.z.object({ ok: pub.z.boolean() }))) } }, (c) => c.json({ data: { ok: true } }, 200));
          });
        },
      ],
    });
    try {
      const base = `http://127.0.0.1:${started.port}`;
      const doc = (await (await fetch(`${base}/openapi.json`)).json()) as { paths: Record<string, unknown> };
      expect(doc.paths["/v1/ext/ping"]).toBeDefined();
      expect((await fetch(`${base}/v1/ext/ping`)).status).toBe(401);
      const ok = await fetch(`${base}/v1/ext/ping`, { headers: { authorization: `Bearer ${a.cashier.token}` } });
      expect(ok.status).toBe(200);
      expect(await ok.json()).toEqual({ data: { ok: true } });
    } finally {
      await started.stop();
    }
  });

  it("an mcp start answers on the port it is bound to (PORT=0 picks a free one)", async () => {
    process.env.SAIL_ROLE = "mcp";
    const started = await pub.startServer();
    try {
      expect(started.port).toBeGreaterThan(0);
      const health = await fetch(`http://127.0.0.1:${started.port}/health`);
      expect(health.status).toBe(200);
      expect(((await health.json()) as { role: string }).role).toBe("mcp");
    } finally {
      await started.stop();
    }
  });

  it("stop removes the signal handlers its start added, so starts do not pile them up", async () => {
    process.env.SAIL_ROLE = "worker";
    const before = { term: process.listenerCount("SIGTERM"), int: process.listenerCount("SIGINT") };
    for (let i = 0; i < 3; i++) {
      const started = await pub.startServer();
      expect(process.listenerCount("SIGTERM")).toBe(before.term + 1);
      await started.stop();
    }
    expect({ term: process.listenerCount("SIGTERM"), int: process.listenerCount("SIGINT") }).toEqual(before);
  });
});
