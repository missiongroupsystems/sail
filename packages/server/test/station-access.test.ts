import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TestDb } from "./helpers.js";
import { bootWorld, type Call, type World } from "./world.js";

/**
 * A station's device is trusted only while it holds the station's current pairing. Pairing another device, archiving
 * the station and issuing a newer code each end what came before, and a PIN session ends when nobody uses it.
 */
let db: TestDb;
let call: Call;
let w: World;

beforeAll(async () => {
  ({ db, call, w } = await bootWorld());
});
afterAll(async () => db.drop());

const code = async (stationId: string) => (await call<{ data: { code: string } }>("POST", `/v1/stations/${stationId}/pairing-code`, { token: w.m.admin.token, body: {} })).body.data.code;
const pair = (c: string) => call<{ data: { station_token: string }; code?: string }>("POST", "/v1/stations/pair", { body: { code: c, device_label: "iPad" }, idempotencyKey: null });
const signIn = async (stationToken: string, pin: string) => (await call<{ data: { session_token: string } }>("POST", "/v1/stations/sessions", { token: stationToken, body: { pin } })).body.data.session_token;
const openOrder = (token: string) => call("POST", "/v1/orders", { token, body: { order_id: randomUUID(), order_type: "takeaway", takeaway_ref: "T" } });

describe("pairing, re-pairing and archiving a station", () => {
  it("pairing a new device on a station signs the old device out, PIN sessions included", async () => {
    const stationId = randomUUID();
    await call("POST", "/v1/stations", { token: w.m.admin.token, body: { id: stationId, outlet_id: w.m.outletId, brand_id: w.m.brandId, name: "Counter" } });
    const deviceA = (await pair(await code(stationId))).body.data.station_token;
    const pinA = await signIn(deviceA, "333333");
    expect((await openOrder(pinA)).status).toBe(201);
    const deviceB = (await pair(await code(stationId))).body.data.station_token;
    expect((await openOrder(pinA)).status).toBe(401);
    expect((await call("GET", "/v1/merchant", { token: deviceA })).status).toBe(401);
    // The new device works, and its own sessions are not caught by the rule that ended A's.
    expect((await openOrder(await signIn(deviceB, "333333"))).status).toBe(201);
  });

  it("a newer pairing code cancels the older unused ones", async () => {
    const first = await code(w.ids.station2);
    const second = await code(w.ids.station2);
    expect((await pair(first)).status).toBe(401);
    expect((await pair(second)).status).toBe(200);
  });

  it("archiving a station unpairs its device, ends its sessions and codes, and the station stays listable until restored", async () => {
    const stationId = randomUUID();
    await call("POST", "/v1/stations", { token: w.m.admin.token, body: { id: stationId, outlet_id: w.m.outletId, brand_id: w.m.brandId, name: "Patio" } });
    const device = (await pair(await code(stationId))).body.data.station_token;
    const pin = await signIn(device, "333333");
    const spare = await code(stationId);
    const archived = await call<{ data: { archived: boolean; paired: boolean } }>("PATCH", `/v1/stations/${stationId}`, { token: w.m.admin.token, body: { archived: true } });
    expect(archived.body.data).toMatchObject({ archived: true, paired: false });
    expect((await call("GET", "/v1/merchant", { token: device })).status).toBe(401);
    expect((await openOrder(pin)).status).toBe(401);
    // Restoring does not bring the old device or an old code back.
    expect((await call("PATCH", `/v1/stations/${stationId}`, { token: w.m.admin.token, body: { archived: false } })).status).toBe(200);
    expect((await pair(spare)).status).toBe(401);
    expect((await call("GET", "/v1/merchant", { token: device })).status).toBe(401);
    await call("PATCH", `/v1/stations/${stationId}`, { token: w.m.admin.token, body: { archived: true } });
    const list = async (q: string) => (await call<{ data: { id: string; archived: boolean }[] }>("GET", `/v1/outlets/${w.m.outletId}/stations${q}`, { token: w.m.admin.token })).body.data;
    expect((await list("")).map((s) => s.id)).not.toContain(stationId);
    expect((await list("?include_archived=true")).find((s) => s.id === stationId)).toMatchObject({ archived: true });
  });
});

describe("a PIN session idles out unless a person uses it", () => {
  it("background reads do not keep a session alive; an action does", async () => {
    const pin = await signIn(w.stationToken, "333333");
    const [sess] = await db.sql<{ id: string }[]>`select id from staff_sessions where ended_at is null order by started_at desc limit 1`;
    const seen = async () => (await db.sql<{ t: Date }[]>`select last_seen_at as t from staff_sessions where id = ${sess!.id}`)[0]!.t.getTime();
    await db.sql`update staff_sessions set last_seen_at = now() - interval '10 minutes' where id = ${sess!.id}`;
    const before = await seen();
    // Polling the event log and the floor, as the POS does while it sits there.
    expect((await call("GET", `/v1/outlets/${w.m.outletId}/events?after=0`, { token: pin })).status).toBe(200);
    expect((await call("GET", `/v1/outlets/${w.m.outletId}/floor`, { token: pin })).status).toBe(200);
    expect(await seen()).toBe(before);
    // A person opening an order counts.
    expect((await openOrder(pin)).status).toBe(201);
    expect(await seen()).toBeGreaterThan(before);
    // Past the idle limit, even a read is refused.
    await db.sql`update staff_sessions set last_seen_at = now() - interval '16 minutes' where id = ${sess!.id}`;
    expect((await call("GET", `/v1/outlets/${w.m.outletId}/floor`, { token: pin })).status).toBe(401);
  });
});
