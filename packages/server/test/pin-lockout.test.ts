import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkLimit, enforceLimit, pruneGuestRateHits, recordHit } from "../src/services/guest.js";
import type { TestDb } from "./helpers.js";
import { bootWorld, type Call, type World } from "./world.js";

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
