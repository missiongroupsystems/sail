import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp, type App } from "../src/app.js";
import { startListener, stopListener, listenerPid, listenerConnectCount } from "../src/sse/listener.js";
import { loadConfig } from "../src/config.js";
import { RLS_OPT_OUT } from "../src/db/rls-opt-out.js";
import { AdmissionGate } from "../src/lib/gate.js";
import { api, freshDb, readSse, seedMerchant, type SeededMerchant, type TestDb, TEST_SECRETS } from "./helpers.js";

let db: TestDb;
let app: App;
let A: SeededMerchant;
let B: SeededMerchant;
let call: ReturnType<typeof api>["call"];

beforeAll(async () => {
  db = await freshDb();
  app = buildApp();
  call = api(app).call;
  A = await seedMerchant(db.sql, "Alpha");
  B = await seedMerchant(db.sql, "Bravo");
  await startListener();
});
afterAll(async () => {
  await stopListener();
  await db.drop();
});

describe("health and auth", () => {
  it("serves /health without a token", async () => {
    const r = await call<{ ok: boolean; db: string }>("GET", "/health");
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.db).toBe("ok");
  });
  it("rejects missing or bad tokens with the shared error shape", async () => {
    const r = await call<{ code: string; remedy: string }>("GET", "/v1/me");
    expect(r.status).toBe(401);
    expect(r.body.code).toBe("unauthenticated");
    expect(r.body.remedy).toMatch(/Bearer/);
    const bad = await call<{ code: string }>("GET", "/v1/me", { token: "not.a.token" });
    expect(bad.status).toBe(401);
  });
  it("resolves a back-office JWT to a staff principal", async () => {
    const r = await call<{ data: { type: string; role: string; merchant_id: string; outlet_scope: string } }>("GET", "/v1/me", { token: A.admin.token });
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ type: "staff", role: "admin", merchant_id: A.merchantId, outlet_scope: "*" });
    const scoped = await call<{ data: { outlet_scope: string } }>("GET", "/v1/me", { token: A.outlet2Cashier.token });
    expect(scoped.body.data.outlet_scope).toBe(A.outlet2Id);
  });
});

describe("tenancy and outlet scoping (RLS)", () => {
  it("two merchants cannot see each other's brands, outlets or staff", async () => {
    const a = await call<{ data: { id: string }[] }>("GET", "/v1/brands", { token: A.admin.token });
    const b = await call<{ data: { id: string }[] }>("GET", "/v1/brands", { token: B.admin.token });
    expect(a.body.data.map((x) => x.id)).toEqual([A.brandId]);
    expect(b.body.data.map((x) => x.id)).toEqual([B.brandId]);
    const ao = await call<{ data: { id: string }[] }>("GET", "/v1/outlets", { token: A.admin.token });
    expect(ao.body.data.map((x) => x.id).sort()).toEqual([A.outletId, A.outlet2Id].sort());
    const as = await call<{ data: { id: string }[] }>("GET", "/v1/staff", { token: A.admin.token });
    expect(as.body.data).toHaveLength(5);
    expect(as.body.data.some((s) => s.id === B.admin.id)).toBe(false);
  });
  it("a staff member limited to one outlet sees only that outlet, even by direct ID", async () => {
    const r = await call<{ data: { id: string }[] }>("GET", "/v1/outlets", { token: A.outlet2Cashier.token });
    expect(r.body.data.map((x) => x.id)).toEqual([A.outlet2Id]);
    const other = await call<{ code: string }>("GET", `/v1/outlets/${A.outletId}/stations`, { token: A.outlet2Cashier.token });
    expect(other.status).toBe(404);
    const events = await call<{ code: string }>("GET", `/v1/outlets/${A.outletId}/events`, { token: A.outlet2Cashier.token });
    expect(events.status).toBe(404);
  });
  it("an update by ID on another merchant's row is not found", async () => {
    const r = await call<{ code: string }>("PATCH", `/v1/brands/${B.brandId}`, { token: A.admin.token, body: { name: "Hijack" } });
    expect(r.status).toBe(404);
    expect(r.body.code).toBe("not_found");
  });
});

describe("permissions from the manifest", () => {
  it("a cashier cannot create an outlet; the error names the required role", async () => {
    const r = await call<{ code: string; details: { required_role: string; override_allowed: boolean } }>("POST", "/v1/outlets", { token: A.cashier.token, body: { name: "Nope" } });
    expect(r.status).toBe(403);
    expect(r.body.code).toBe("permission_denied");
    expect(r.body.details.required_role).toBe("admin");
    expect(r.body.details.override_allowed).toBe(false);
  });
  it("a server cannot list staff (Manager+)", async () => {
    const r = await call("GET", "/v1/staff", { token: A.server.token });
    expect(r.status).toBe(403);
  });
  it("a manager can list staff but not add one", async () => {
    expect((await call("GET", "/v1/staff", { token: A.manager.token })).status).toBe(200);
    expect((await call("POST", "/v1/staff", { token: A.manager.token, body: { name: "X", role: "server" } })).status).toBe(403);
  });
});

describe("organisation CRUD writes events and audit entries", () => {
  it("admin creates a brand, an outlet, a station and a staff member; each appears in the audit log", async () => {
    const brand = await call<{ data: { id: string; name: string }; events: { seq: number; type: string }[] }>("POST", "/v1/brands", { token: A.admin.token, body: { name: "Kopi & Co", accent_color: "#AA5500" } });
    expect(brand.status).toBe(201);
    expect(brand.body.events[0]!.type).toBe("brand.created");

    const outlet = await call<{ data: { id: string } }>("POST", "/v1/outlets", { token: A.admin.token, body: { name: "Airport", business_registration_no: "201234567A", business_day_cutoff: "05:00", hours: { mon: [["08:00", "22:00"]] } } });
    expect(outlet.status).toBe(201);

    const station = await call<{ data: { id: string; paired: boolean }; events: { seq: number }[] }>("POST", "/v1/stations", { token: A.admin.token, body: { outlet_id: outlet.body.data.id, name: "Counter 1", pay_before_firing: true, home: "takeaway" } });
    expect(station.status).toBe(201);
    expect(station.body.data.paired).toBe(false);
    expect(station.body.events[0]!.seq).toBe(1); // first outlet-scoped event for the new outlet

    const member = await call<{ data: { id: string; has_pin: boolean; initials: string } }>("POST", "/v1/staff", { token: A.admin.token, body: { name: "Raj Kumar", role: "server", outlet_ids: [outlet.body.data.id], pin: "246810" } });
    expect(member.status).toBe(201);
    expect(member.body.data.has_pin).toBe(true);
    expect(member.body.data.initials).toBe("RK");

    const audit = await call<{ data: { action: string; target_id: string; actor_id: string }[] }>("GET", "/v1/audit", { token: A.admin.token });
    const actions = audit.body.data.map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(["brands.create", "outlets.create", "stations.create", "staff.create"]));
    expect(audit.body.data.every((a) => a.actor_id === A.admin.id)).toBe(true);
    const staffEntry = audit.body.data.find((a) => a.action === "staff.create")!;
    expect(JSON.stringify(staffEntry)).not.toContain("246810");
  });

  it("merchant settings update is validated and evented", async () => {
    const bad = await call<{ code: string }>("PATCH", "/v1/merchant/settings", { token: A.admin.token, body: { cash_rounding_increment: 0 } });
    expect(bad.status).toBe(400);
    const ok = await call<{ data: { settings: { cash_rounding_increment: number; tax_mode: string } } }>("PATCH", "/v1/merchant/settings", { token: A.admin.token, body: { cash_rounding_increment: 5, tax_mode: "inclusive" } });
    expect(ok.status).toBe(200);
    expect(ok.body.data.settings).toMatchObject({ cash_rounding_increment: 5, tax_mode: "inclusive" });
  });

  it("a failed request rolls its transaction back", async () => {
    const id = randomUUID();
    // Duplicate email violates a unique index after the insert of the brand row? No: use staff with a duplicate email.
    const first = await call("POST", "/v1/staff", { token: A.admin.token, body: { name: "Dup One", role: "server", email: "dup@alpha.test" } });
    expect(first.status).toBe(201);
    const second = await call<{ code: string }>("POST", "/v1/staff", { token: A.admin.token, body: { id, name: "Dup Two", role: "server", email: "dup@alpha.test" } });
    expect(second.status).toBe(409);
    const [row] = await db.sql`select count(*)::int as n from staff where id = ${id}`;
    expect(row!.n).toBe(0);
    const [evt] = await db.sql`select count(*)::int as n from events where aggregate_id = ${id}`;
    expect(evt!.n).toBe(0);
  });
});

describe("idempotency", () => {
  it("requires Idempotency-Key on mutations", async () => {
    const r = await call<{ code: string; remedy: string }>("POST", "/v1/brands", { token: A.admin.token, body: { name: "No key" }, idempotencyKey: null });
    expect(r.status).toBe(400);
    expect(r.body.remedy).toMatch(/Idempotency-Key/);
  });
  it("replays the stored response for the same key and body, and rejects a different body", async () => {
    const key = randomUUID();
    const first = await call<{ data: { id: string } }>("POST", "/v1/brands", { token: A.admin.token, body: { name: "Once" }, idempotencyKey: key });
    const second = await call<{ data: { id: string } }>("POST", "/v1/brands", { token: A.admin.token, body: { name: "Once" }, idempotencyKey: key });
    expect(second.status).toBe(201);
    expect(second.body.data.id).toBe(first.body.data.id);
    expect(second.headers.get("idempotent-replayed")).toBe("true");
    const conflict = await call<{ code: string }>("POST", "/v1/brands", { token: A.admin.token, body: { name: "Twice" }, idempotencyKey: key });
    expect(conflict.status).toBe(409);
    expect(conflict.body.code).toBe("idempotency_conflict");
    const [n] = await db.sql`select count(*)::int as n from brands where name = 'Once'`;
    expect(n!.n).toBe(1);
  });
  it("keys are scoped to the principal", async () => {
    const key = randomUUID();
    const a = await call<{ data: { id: string } }>("POST", "/v1/brands", { token: A.admin.token, body: { name: "Scoped" }, idempotencyKey: key });
    const b = await call<{ data: { id: string } }>("POST", "/v1/brands", { token: B.admin.token, body: { name: "Scoped" }, idempotencyKey: key });
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(a.body.data.id).not.toBe(b.body.data.id);
  });
  it("concurrent requests with the same key record once", async () => {
    const key = randomUUID();
    const results = await Promise.all(Array.from({ length: 5 }, () => call<{ data: { id: string } }>("POST", "/v1/brands", { token: A.admin.token, body: { name: "Race" }, idempotencyKey: key })));
    // Every racer gets the one stored result: the losers wait for the winner's commit and replay it, never a 500.
    expect(results.map((r) => r.status)).toEqual([201, 201, 201, 201, 201]);
    const ids = new Set(results.map((r) => r.body.data.id));
    expect(ids.size).toBe(1);
    expect(results.filter((r) => r.headers.get("idempotent-replayed") === "true")).toHaveLength(4);
    const [n] = await db.sql`select count(*)::int as n from brands where name = 'Race'`;
    expect(n!.n).toBe(1);
  });
});

describe("event log and live updates", () => {
  it("assigns a gap-free per-outlet sequence and serves catch-up", async () => {
    for (let i = 0; i < 3; i++) await call("POST", "/v1/stations", { token: A.admin.token, body: { outlet_id: A.outlet2Id, name: `S${i}` } });
    const r = await call<{ data: { seq: number; type: string }[]; latest_seq: number; has_more: boolean }>("GET", `/v1/outlets/${A.outlet2Id}/events?after=0`, { token: A.outlet2Cashier.token });
    expect(r.status).toBe(200);
    expect(r.body.data.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(r.body.latest_seq).toBe(3);
    const partial = await call<{ data: { seq: number }[] }>("GET", `/v1/outlets/${A.outlet2Id}/events?after=2`, { token: A.admin.token });
    expect(partial.body.data.map((e) => e.seq)).toEqual([3]);
  });

  it("filters catch-up by one event type or several", async () => {
    const st = await call<{ data: { id: string } }>("POST", "/v1/stations", { token: B.admin.token, body: { outlet_id: B.outletId, name: "Filtered" } });
    await call("PATCH", `/v1/stations/${st.body.data.id}`, { token: B.admin.token, body: { name: "Filtered 2" } });
    const all = await call<{ data: { type: string }[] }>("GET", `/v1/outlets/${B.outletId}/events`, { token: B.admin.token });
    const kinds = [...new Set(all.body.data.map((e) => e.type))];
    expect(kinds).toEqual(expect.arrayContaining(["station.created", "station.updated"]));
    const one = await call<{ data: { type: string }[] }>("GET", `/v1/outlets/${B.outletId}/events?types=station.updated`, { token: B.admin.token });
    expect(one.status, JSON.stringify(one.body)).toBe(200);
    expect(one.body.data.map((e) => e.type)).toEqual(["station.updated"]);
    const both = await call<{ data: { type: string }[] }>("GET", `/v1/outlets/${B.outletId}/events?types=station.created,station.updated`, { token: B.admin.token });
    expect(both.status, JSON.stringify(both.body)).toBe(200);
    expect(both.body.data).toHaveLength(all.body.data.filter((e) => e.type === "station.created" || e.type === "station.updated").length);
    expect(new Set(both.body.data.map((e) => e.type))).toEqual(new Set(["station.created", "station.updated"]));
  });

  it("events are append-only in the database", async () => {
    await expect(db.sql`delete from events where outlet_id = ${A.outlet2Id}`).rejects.toThrow(/append_only/);
  });

  it("the outlet stream says hello with the latest seq, then signals a change", async () => {
    const res = await app.request(`/v1/outlets/${A.outlet2Id}/stream`, { headers: { authorization: `Bearer ${A.admin.token}` } });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/event-stream/);
    const helloP = readSse(res.clone(), 1, 3000);
    const hello = await helloP;
    expect(hello[0]!.event).toBe("hello");
    expect((hello[0]!.data as { seq: number }).seq).toBe(3);

    const res2 = await app.request(`/v1/outlets/${A.outlet2Id}/stream`, { headers: { authorization: `Bearer ${A.admin.token}` } });
    const pending = readSse(res2, 2, 5000);
    await new Promise((r) => setTimeout(r, 100));
    await call("POST", "/v1/stations", { token: A.admin.token, body: { outlet_id: A.outlet2Id, name: "Streamed" } });
    const got = await pending;
    expect(got.map((e) => e.event)).toEqual(["hello", "change"]);
    expect(got[1]!.data).toMatchObject({ seq: 4, type: "station.created" });
  });

  it("an outlet-scoped cashier cannot open another outlet's stream", async () => {
    const res = await app.request(`/v1/outlets/${A.outletId}/stream`, { headers: { authorization: `Bearer ${A.outlet2Cashier.token}` } });
    expect(res.status).toBe(404);
  });

  it("after the LISTEN connection is killed, streams receive resync and keep working", async () => {
    const res = await app.request(`/v1/outlets/${A.outlet2Id}/stream`, { headers: { authorization: `Bearer ${A.admin.token}` } });
    const pending = readSse(res, 3, 10_000);
    await new Promise((r) => setTimeout(r, 100));
    const before = listenerConnectCount();
    const pid = await listenerPid();
    expect(pid).not.toBeNull();
    await db.sql`select pg_terminate_backend(${pid!})`;
    // Wait for reconnect, then write an event that must arrive through the new connection.
    const deadline = Date.now() + 8000;
    while (listenerConnectCount() <= before && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    expect(listenerConnectCount()).toBeGreaterThan(before);
    await call("POST", "/v1/stations", { token: A.admin.token, body: { outlet_id: A.outlet2Id, name: "After resync" } });
    const got = await pending;
    expect(got.map((e) => e.event)).toEqual(["hello", "resync", "change"]);
  });
});

describe("configuration guards", () => {
  it("rejects a LISTEN URL on the transaction pooler port", () => {
    expect(() => loadConfig({ DATABASE_URL: "postgres://u:p@h:6543/db", LISTEN_DATABASE_URL: "postgres://u:p@h:6543/db", ...TEST_SECRETS })).toThrow(/5432/);
    expect(() => loadConfig({ DATABASE_URL: "postgres://u:p@h:6543/db", LISTEN_DATABASE_URL: "postgres://u:p@h:5432/db", ...TEST_SECRETS })).not.toThrow();
  });
  it("the RLS opt-out list is only /health, the spec and the public sign-in, setup and pairing endpoints", () => {
    expect(RLS_OPT_OUT.map(String)).toEqual(["/^\\/health$/", "/^\\/openapi\\.json$/", "/^\\/v1\\/auth\\/status$/", "/^\\/v1\\/auth\\/sign-in$/", "/^\\/v1\\/auth\\/links\\/accept$/", "/^\\/v1\\/setup$/", "/^\\/v1\\/guest\\/sessions$/", "/^\\/v1\\/agent-sessions$/", "/^\\/v1\\/stations\\/pair$/", "/^\\/v1\\/relays\\/pair$/", "/^\\/v1\\/receipts\\/[^/]+$/"]);
  });
  it("the admission gate queues then rejects with 503", async () => {
    const gate = new AdmissionGate(1, 1);
    const r1 = await gate.acquire();
    const second = gate.acquire(); // queued
    await expect(gate.acquire()).rejects.toMatchObject({ code: "overloaded", status: 503 });
    r1();
    const r2 = await second;
    r2();
    expect(gate.rejected).toBe(1);
  });
});

describe("OpenAPI contract and manifest", () => {
  it("every /v1 route carries an x-sail manifest entry and an operationId", async () => {
    const res = await app.request("/openapi.json");
    const doc = (await res.json()) as { paths: Record<string, Record<string, { operationId?: string; "x-sail"?: { op: string; tier: string; min_role: string | null } }>> };
    const missing: string[] = [];
    for (const [path, methods] of Object.entries(doc.paths)) {
      for (const [method, op] of Object.entries(methods)) {
        if (!op.operationId || !op["x-sail"]?.op || !op["x-sail"].tier) missing.push(`${method.toUpperCase()} ${path}`);
      }
    }
    expect(missing).toEqual([]);
    expect(Object.keys(doc.paths).length).toBeGreaterThanOrEqual(12);
  });
});

describe("business-day time helpers", () => {
  it("computes business dates across the cutoff and the next cutoff instant", async () => {
    const { businessDateFor, nextCutoff } = await import("../src/lib/time.js");
    const { zonedToUtc } = await import("@sail/shared");
    // 01:30 Singapore on 5 Nov is still business day 4 Nov with a 04:00 cutoff.
    expect(businessDateFor(new Date("2026-11-04T17:30:00Z"), "04:00", "Asia/Singapore")).toBe("2026-11-04");
    expect(businessDateFor(new Date("2026-11-04T20:30:00Z"), "04:00", "Asia/Singapore")).toBe("2026-11-05");
    expect(zonedToUtc("2026-11-05", "04:00", "Asia/Singapore").toISOString()).toBe("2026-11-04T20:00:00.000Z");
    expect(nextCutoff(new Date("2026-11-04T13:00:00Z"), "04:00", "Asia/Singapore").toISOString()).toBe("2026-11-04T20:00:00.000Z");
    expect(nextCutoff(new Date("2026-11-04T21:00:00Z"), "04:00", "Asia/Singapore").toISOString()).toBe("2026-11-05T20:00:00.000Z");
  });
});
