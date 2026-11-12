import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkLimit, enforceLimit, pruneGuestRateHits, recordHit } from "../src/services/guest.js";
import type { TestDb } from "./helpers.js";
import { bootWorld, orderHelpers, type Call, type World } from "./world.js";

let db: TestDb;
let call: Call;
let w: World;

beforeAll(async () => {
  ({ db, call, w } = await bootWorld());
});
afterAll(async () => db.drop());

const signIn = (station: string, pin: string) => call<{ code: string; details?: { retry_after_seconds: number } }>("POST", "/v1/stations/sessions", { token: station, body: { pin } });
const lockRow = (stationId: string) => db.sql<{ failures: number; locked: boolean }[]>`select failures, coalesce(locked_until > now(), false) as locked from pin_attempts where merchant_id = ${w.m.merchantId} and scope = ${`station:${stationId}`}`;

describe("PIN lockout is shared by every API machine", () => {
  it("wrong sign-in PINs are counted in Postgres, so a lock set by one machine holds on another and clearing it there unlocks", async () => {
    for (let i = 0; i < 4; i++) expect((await signIn(w.station2Token, String(800000 + i))).status).toBe(401);
    // The refused requests rolled back, but the count committed on its own.
    expect(await lockRow(w.ids.station2)).toEqual([{ failures: 4, locked: false }]);
    expect((await signIn(w.station2Token, "800004")).status).toBe(401);
    expect(await lockRow(w.ids.station2)).toEqual([{ failures: 0, locked: true }]);
    const locked = await signIn(w.station2Token, "333333");
    expect(locked.status).toBe(429);
    expect(locked.body.details!.retry_after_seconds).toBeGreaterThan(0);
    // Another machine sees only the database: clearing the row there unlocks the station here.
    await db.sql`delete from pin_attempts where merchant_id = ${w.m.merchantId}`;
    expect((await signIn(w.station2Token, "333333")).status).toBe(201);
    // And a lock written by another machine is honoured here, for that station only.
    await db.sql`insert into pin_attempts (merchant_id, scope, failures, locked_until) values (${w.m.merchantId}, ${`station:${w.ids.station}`}, 0, now() + interval '30 seconds')`;
    expect((await signIn(w.stationToken, "333333")).status).toBe(429);
    expect((await signIn(w.station2Token, "333333")).status).toBe(201);
    await db.sql`delete from pin_attempts where merchant_id = ${w.m.merchantId}`;
  });

  it("the lock lasts 30 seconds, and once it has passed the count starts again from zero", async () => {
    for (let i = 0; i < 5; i++) await signIn(w.station2Token, String(820000 + i));
    const locked = await signIn(w.station2Token, "333333");
    expect(locked.status).toBe(429);
    expect(locked.body.details!.retry_after_seconds).toBeGreaterThanOrEqual(29);
    expect(locked.body.details!.retry_after_seconds).toBeLessThanOrEqual(30);
    await db.sql`update pin_attempts set locked_until = now() - interval '1 second' where merchant_id = ${w.m.merchantId}`;
    for (let i = 0; i < 4; i++) expect((await signIn(w.station2Token, String(830000 + i))).status).toBe(401);
    expect((await signIn(w.station2Token, "333333")).status).toBe(201);
  });

  it("concurrent wrong PINs all count", async () => {
    await Promise.all(Array.from({ length: 4 }, (_, i) => signIn(w.station2Token, String(810000 + i))));
    expect(await lockRow(w.ids.station2)).toEqual([{ failures: 4, locked: false }]);
    const right = await signIn(w.station2Token, "333333");
    expect(right.status).toBe(201);
    expect(await lockRow(w.ids.station2)).toEqual([]);
  });

  it("a burst of concurrent guesses gets five tries, not one per request", async () => {
    const tries = await Promise.all(Array.from({ length: 12 }, (_, i) => signIn(w.station2Token, String(840000 + i))));
    expect(tries.filter((t) => t.status === 401).length).toBeLessThanOrEqual(5);
    expect((await signIn(w.station2Token, "333333")).status).toBe(429);
    await db.sql`delete from pin_attempts where merchant_id = ${w.m.merchantId}`;
  });
});

describe("manager approval PINs share the station's lockout", () => {
  const grant = (token: string, targetId: string, pin: string) => call<{ code: string; details?: { retry_after_seconds: number } }>("POST", "/v1/overrides", { token, body: { action: "orders.reopen", target_kind: "order", target_id: targetId, approver_pin: pin, args: {} } });

  it("5 wrong approval PINs lock the station for approvals and sign-in alike, and the right PIN is refused while locked", async () => {
    const orderId = (await orderHelpers(call, w).orderWith(w.pins.cashierStation2, [{ product_id: w.ids.kopi }])).id;
    for (let i = 0; i < 4; i++) expect((await grant(w.pins.cashierStation2, orderId, String(900000 + i))).status).toBe(403);
    expect(await lockRow(w.ids.station2)).toEqual([{ failures: 4, locked: false }]);
    expect((await grant(w.pins.cashierStation2, orderId, "900004")).status).toBe(403);
    const locked = await grant(w.pins.cashierStation2, orderId, "222222");
    expect(locked.status).toBe(429);
    expect(locked.body.details!.retry_after_seconds).toBeGreaterThan(0);
    expect((await signIn(w.station2Token, "333333")).status).toBe(429);
    // The other station is unaffected.
    expect((await grant(w.pins.cashier, orderId, "222222")).status).toBe(201);
    await db.sql`delete from pin_attempts where merchant_id = ${w.m.merchantId}`;
  });

  it("wrong sign-in PINs and wrong approval PINs add up on one counter; a right approval PIN clears it", async () => {
    const orderId = (await orderHelpers(call, w).orderWith(w.pins.cashierStation2, [{ product_id: w.ids.kopi }])).id;
    for (let i = 0; i < 3; i++) expect((await signIn(w.station2Token, String(910000 + i))).status).toBe(401);
    expect((await grant(w.pins.cashierStation2, orderId, "910003")).status).toBe(403);
    expect(await lockRow(w.ids.station2)).toEqual([{ failures: 4, locked: false }]);
    expect((await grant(w.pins.cashierStation2, orderId, "222222")).status).toBe(201);
    expect(await lockRow(w.ids.station2)).toEqual([]);
    for (let i = 0; i < 4; i++) expect((await grant(w.pins.cashierStation2, orderId, String(920000 + i))).status).toBe(403);
    expect((await signIn(w.station2Token, "920004")).status).toBe(401);
    expect((await signIn(w.station2Token, "333333")).status).toBe(429);
    await db.sql`delete from pin_attempts where merchant_id = ${w.m.merchantId}`;
  });
});

describe("manager approval lockout edge cases", () => {
  const grantAs = (token: string, targetId: string, pin: string, outletId?: string) => call<{ code: string; message: string }>("POST", "/v1/overrides", { token, body: { action: "orders.reopen", target_kind: "order", target_id: targetId, approver_pin: pin, args: {}, outlet_id: outletId } });

  it("your own PIN neither counts as a wrong PIN nor resets the count", async () => {
    const orderId = (await orderHelpers(call, w).orderWith(w.pins.manager, [{ product_id: w.ids.kopi }])).id;
    for (let i = 0; i < 4; i++) expect((await grantAs(w.pins.manager, orderId, String(930000 + i))).status).toBe(403);
    const own = await grantAs(w.pins.manager, orderId, "222222");
    expect(own.body.message).toBe("You cannot approve your own action");
    expect(await lockRow(w.ids.station)).toEqual([{ failures: 4, locked: false }]);
    expect((await grantAs(w.pins.manager, orderId, "930004")).status).toBe(403);
    expect((await grantAs(w.pins.manager, orderId, "111111")).status).toBe(429);
    await db.sql`delete from pin_attempts where merchant_id = ${w.m.merchantId}`;
  });

  it("off a station the count is per requesting staff member", async () => {
    const orderId = (await orderHelpers(call, w).orderWith(w.pins.cashier, [{ product_id: w.ids.kopi }])).id;
    for (let i = 0; i < 5; i++) expect((await grantAs(w.m.cashier.token, orderId, String(940000 + i), w.m.outletId)).status).toBe(403);
    expect((await grantAs(w.m.cashier.token, orderId, "222222", w.m.outletId)).status).toBe(429);
    const [row] = await db.sql<{ scope: string }[]>`select scope from pin_attempts where merchant_id = ${w.m.merchantId}`;
    expect(row!.scope).toBe(`staff:${w.m.cashier.id}`);
    // The stations are not locked by it.
    expect((await grantAs(w.pins.cashier, orderId, "222222")).status).toBe(201);
    await db.sql`delete from pin_attempts where merchant_id = ${w.m.merchantId}`;
  });
});

describe("guest rate limits are shared by every API machine", () => {
  const limit = [3, 60_000] as const;
  it("hits are stored in Postgres and a window filled by another machine refuses here", async () => {
    const key = `test:${randomUUID()}`;
    for (let i = 0; i < 3; i++) await enforceLimit(w.m.merchantId, key, limit, "tries");
    await expect(enforceLimit(w.m.merchantId, key, limit, "tries")).rejects.toMatchObject({ code: "rate_limited" });
    const [row] = await db.sql<{ n: number }[]>`select cardinality(hits) as n from guest_rate_hits where merchant_id = ${w.m.merchantId} and key = ${key}`;
    expect(row!.n).toBe(3);
    const other = `test:${randomUUID()}`;
    await db.sql`insert into guest_rate_hits (merchant_id, key, hits) values (${w.m.merchantId}, ${other}, array[now(), now(), now()]::timestamptz[])`;
    await expect(checkLimit(w.m.merchantId, other, limit, "tries")).rejects.toMatchObject({ code: "rate_limited", details: { retry_after_seconds: 60 } });
    // Hits older than the window no longer count.
    await db.sql`update guest_rate_hits set hits = array[now() - interval '2 minutes', now() - interval '2 minutes', now() - interval '2 minutes']::timestamptz[] where key = ${other}`;
    await checkLimit(w.m.merchantId, other, limit, "tries");
    // A check never creates a row; the worker drops keys with nothing left in the longest window.
    await checkLimit(w.m.merchantId, `test:${randomUUID()}`, limit, "tries");
    await db.sql`update guest_rate_hits set hits = array[now() - interval '61 minutes']::timestamptz[] where key = ${other}`;
    await pruneGuestRateHits();
    const keys = await db.sql<{ key: string }[]>`select key from guest_rate_hits where merchant_id = ${w.m.merchantId}`;
    expect(keys.map((k) => k.key)).toEqual([key]);
  });

  it("concurrent attempts each count, and a check does not record a hit", async () => {
    const key = `test:${randomUUID()}`;
    const results = await Promise.allSettled(Array.from({ length: 6 }, () => enforceLimit(w.m.merchantId, key, limit, "tries")));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(3);
    const quiet = `test:${randomUUID()}`;
    for (let i = 0; i < 5; i++) await checkLimit(w.m.merchantId, quiet, [1, 60_000], "tries");
    await recordHit(w.m.merchantId, quiet, [1, 60_000]);
    await expect(checkLimit(w.m.merchantId, quiet, [1, 60_000], "tries")).rejects.toMatchObject({ code: "rate_limited" });
  });
});
