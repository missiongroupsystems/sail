import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/** Every stored hash checked against a guess, and whether the check ran on the event loop. */
const checked = vi.hoisted(() => [] as { hash: string; sync: boolean }[]);
vi.mock("../src/auth/tokens.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/auth/tokens.js")>();
  return {
    ...real,
    verifySecret: (value: string, stored: string | null | undefined) => {
      if (stored) checked.push({ hash: stored, sync: true });
      return real.verifySecret(value, stored);
    },
    verifySecretAsync: async (value: string, stored: string | null | undefined) => {
      if (stored) checked.push({ hash: stored, sync: false });
      return real.verifySecretAsync(value, stored);
    },
  };
});

import "../src/modules.js";
import { buildApp, type App } from "../src/app.js";
import { api, freshDb, seedMerchant, type SeededMerchant, type TestDb } from "./helpers.js";

/**
 * stations.pair is public, so what a wrong guess costs is set by the server, not the caller: one hash per live code,
 * and at most three more for the "expired or was replaced" answer, none of them a live code again and none holding the
 * event loop (each is about 30 ms of scrypt).
 */
let db: TestDb;
let app: App;
let A: SeededMerchant;
let call: ReturnType<typeof api>["call"];
const stationIds = [randomUUID(), randomUUID(), randomUUID()];
const codes: string[] = [];

beforeAll(async () => {
  db = await freshDb();
  app = buildApp();
  call = api(app).call;
  A = await seedMerchant(db.sql, "Alpha");
  for (const [i, id] of stationIds.entries()) await call("POST", "/v1/stations", { token: A.admin.token, body: { id, outlet_id: A.outletId, brand_id: A.brandId, name: `Till ${i}` } });
  // Station 0 is given seven codes in a row: six replaced, one live. Stations 1 and 2 have one live code each.
  for (let i = 0; i < 7; i++) codes.push((await issue(stationIds[0]!)).body.data.code);
  for (const id of stationIds.slice(1)) codes.push((await issue(id)).body.data.code);
});
afterAll(async () => db.drop());
beforeEach(() => {
  checked.length = 0;
});

const issue = (id: string) => call<{ data: { code: string } }>("POST", `/v1/stations/${id}/pairing-code`, { token: A.admin.token, body: {} });
const pair = (code: string) => call<{ message: string; details?: { reason?: string } }>("POST", "/v1/stations/pair", { body: { code, device_label: "Bar iPad" }, idempotencyKey: null });
const liveHashes = async () => (await db.sql<{ code_hash: string }[]>`select code_hash from station_pairing_codes where used_at is null and expires_at > now()`).map((r) => r.code_hash);
const wrongGuess = () => ["135790", "246801", "975310", "864209"].find((c) => !codes.includes(c))!;

describe("a wrong pairing code", () => {
  it("hashes each live code once and at most three spent ones, off the event loop", async () => {
    const live = await liveHashes();
    expect(live).toHaveLength(3);
    const r = await pair(wrongGuess());
    expect(r.status).toBe(401);
    expect(r.body.details?.reason).toBe("pairing_code_wrong");

    const spentChecks = checked.filter((c) => !live.includes(c.hash));
    const liveChecks = checked.filter((c) => live.includes(c.hash));
    expect(liveChecks.map((c) => c.hash).sort()).toEqual([...live].sort());
    expect(spentChecks.length).toBeGreaterThan(0);
    expect(spentChecks.length).toBeLessThanOrEqual(3);
    expect(spentChecks.every((c) => !c.sync)).toBe(true);
  });

  it("still says expired or replaced for the code replaced last", async () => {
    const r = await pair(codes[5]!);
    expect(r.status).toBe(401);
    expect(r.body.details?.reason).toBe("pairing_code_expired");
  });

  it("a code that stopped working over ten minutes ago is not looked at, and says wrong", async () => {
    await db.sql`update station_pairing_codes set expires_at = now() - interval '11 minutes' where station_id = ${stationIds[0]!} and used_at is null and expires_at <= now()`;
    const r = await pair(codes[5]!);
    expect(r.body.details?.reason).toBe("pairing_code_wrong");
    const live = await liveHashes();
    expect(checked.filter((c) => !live.includes(c.hash))).toHaveLength(0);
  });
});
