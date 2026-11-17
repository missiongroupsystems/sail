import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import "../src/modules.js";
import { buildApp, type App } from "../src/app.js";
import { api, freshDb, seedMerchant, type SeededMerchant, type TestDb } from "./helpers.js";

/** When a station's pairing ends, the iPad's PIN session says so as the pairing ending, so the POS goes to pairing (final review B-P15). */
let db: TestDb;
let app: App;
let A: SeededMerchant;
let call: ReturnType<typeof api>["call"];
const station = randomUUID();

beforeAll(async () => {
  db = await freshDb();
  app = buildApp();
  call = api(app).call;
  A = await seedMerchant(db.sql, "Alpha");
  await call("POST", "/v1/stations", { token: A.admin.token, body: { id: station, outlet_id: A.outletId, brand_id: A.brandId, name: "Floor" } });
});
afterAll(async () => db.drop());

const pair = async () => {
  const code = await call<{ data: { code: string } }>("POST", `/v1/stations/${station}/pairing-code`, { token: A.admin.token, body: {} });
  return (await call<{ data: { station_token: string } }>("POST", "/v1/stations/pair", { body: { code: code.body.data.code, device_label: "iPad" }, idempotencyKey: null })).body.data.station_token;
};

describe("a PIN session after its station's pairing ended", () => {
  it("answers 401 with the reason station_unpaired, also once the session is marked ended", async () => {
    const first = await pair();
    const pin = (await call<{ data: { session_token: string } }>("POST", "/v1/stations/sessions", { token: first, body: { pin: "333333" } })).body.data.session_token;
    expect((await call("GET", `/v1/outlets/${A.outletId}/floor`, { token: pin })).status).toBe(200);
    // Another iPad pairs to the station: pairing ends this station's PIN sessions.
    await pair();
    for (const token of [pin, first]) {
      const r = await call<{ code: string; details?: { reason?: string } }>("GET", `/v1/outlets/${A.outletId}/floor`, { token });
      expect(r.status).toBe(401);
      expect(r.body.details?.reason).toBe("station_unpaired");
    }
  });

  it("a session simply signed out still says the session ended", async () => {
    const token = await pair();
    const pin = (await call<{ data: { session_token: string } }>("POST", "/v1/stations/sessions", { token, body: { pin: "333333" } })).body.data.session_token;
    await call("POST", "/v1/stations/sessions/end", { token: pin, body: {} });
    const r = await call<{ code: string; message: string; details?: { reason?: string } }>("GET", `/v1/outlets/${A.outletId}/floor`, { token: pin });
    expect(r.status).toBe(401);
    expect(r.body.details?.reason).toBeUndefined();
  });
});
