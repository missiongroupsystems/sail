import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import "../src/modules.js";
import { buildApp, type App } from "../src/app.js";
import { api, freshDb, seedMerchant, type SeededMerchant, type TestDb } from "./helpers.js";

/**
 * Pairing codes: a new code ends the station's unused one, which once ended a code somebody was typing. A caller can
 * ask not to replace a live code; and a code that was right until it was replaced, ran out or was used is told apart
 * from a wrong one, so the iPad can say which.
 */
let db: TestDb;
let app: App;
let A: SeededMerchant;
let call: ReturnType<typeof api>["call"];
const station = randomUUID();
type Refusal = { code: string; message: string; remedy?: string; details?: { reason?: string; issued_at?: string; expires_at?: string } };
type Issued = { data: { code: string; expires_at: string } };

beforeAll(async () => {
  db = await freshDb();
  app = buildApp();
  call = api(app).call;
  A = await seedMerchant(db.sql, "Alpha");
  await call("POST", "/v1/stations", { token: A.admin.token, body: { id: station, outlet_id: A.outletId, brand_id: A.brandId, name: "Floor" } });
});
afterAll(async () => db.drop());

const issue = (body: Record<string, unknown> = {}) => call<Issued & Refusal>("POST", `/v1/stations/${station}/pairing-code`, { token: A.admin.token, body });
const pair = (code: string) => call<{ data: { station_token: string; station: { paired: boolean; paired_at: string | null } } } & Refusal>("POST", "/v1/stations/pair", { body: { code, device_label: "Bar iPad" }, idempotencyKey: null });
/** Six digits that are none of the given codes. */
const other = (...codes: string[]) => ["135790", "246801", "975310", "864209"].find((c) => !codes.includes(c))!;

describe("issuing a pairing code", () => {
  it("replace: false is refused while a code is live, and says since when and until when; the live code still pairs", async () => {
    const first = await issue();
    expect(first.status).toBe(201);
    const again = await issue({ replace: false });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe("state_conflict");
    expect(again.body.details?.reason).toBe("pairing_code_live");
    expect(again.body.details?.expires_at).toBe(first.body.data.expires_at);
    expect(Date.parse(again.body.details!.issued_at!)).toBeLessThan(Date.parse(first.body.data.expires_at));
    expect(again.body.remedy).toMatch(/replace: true/);

    const before = await call<{ data: { paired_at: string | null }[] }>("GET", `/v1/outlets/${A.outletId}/stations`, { token: A.admin.token });
    expect(before.body.data.every((s) => s.paired_at === null)).toBe(true);
    const paired = await pair(first.body.data.code);
    expect(paired.status).toBe(200);
    expect(paired.body.data.station.paired).toBe(true);
    expect(Date.parse(paired.body.data.station.paired_at!)).toBeGreaterThan(Date.now() - 60_000);
  });

  it("with no live code, replace: false issues one like any other request", async () => {
    const r = await issue({ replace: false });
    expect(r.status).toBe(201);
    expect(r.body.data.code).toMatch(/^\d{6}$/);
  });

  it("two replace: false requests at once: exactly one issues a code, the other is refused and the code still pairs", async () => {
    // Several stations, so an unlocked check-then-insert would let both through on at least one of them.
    for (let i = 0; i < 5; i++) {
      const id = randomUUID();
      await call("POST", "/v1/stations", { token: A.admin.token, body: { id, outlet_id: A.outletId, brand_id: A.brandId, name: `Race ${i}` } });
      const both = await Promise.all([0, 1].map(() => call<Issued & Refusal>("POST", `/v1/stations/${id}/pairing-code`, { token: A.admin.token, body: { replace: false } })));
      expect(both.map((r) => r.status).sort()).toEqual([201, 409]);
      const issued = both.find((r) => r.status === 201)!;
      expect(both.find((r) => r.status === 409)!.body.details?.expires_at).toBe(issued.body.data.expires_at);
      expect((await pair(issued.body.data.code)).status).toBe(200);
    }
  });

  it("left out, or true, a new code replaces the live one, as before", async () => {
    const a = await issue();
    const b = await issue({ replace: true });
    expect(b.status).toBe(201);
    const old = await pair(a.body.data.code);
    expect(old.status).toBe(401);
    expect((await pair(b.body.data.code)).status).toBe(200);
  });
});

describe("entering a pairing code", () => {
  it("a replaced code and a used code say expired or replaced; any other code says wrong, and nothing more", async () => {
    const a = await issue();
    const b = await issue();
    const replaced = await pair(a.body.data.code);
    expect(replaced.status).toBe(401);
    expect(replaced.body.message).toBe("This code has expired or was replaced");
    expect(replaced.body.remedy).toMatch(/new one in the back office/);
    expect(replaced.body.details?.reason).toBe("pairing_code_expired");

    const wrong = await pair(other(a.body.data.code, b.body.data.code));
    expect(wrong.status).toBe(401);
    expect(wrong.body.message).toBe("Wrong code");
    expect(wrong.body.details).toEqual({ reason: "pairing_code_wrong" });

    expect((await pair(b.body.data.code)).status).toBe(200);
    const used = await pair(b.body.data.code);
    expect(used.status).toBe(401);
    expect(used.body.details?.reason).toBe("pairing_code_expired");
  });

  it("a code that ran out says expired or replaced", async () => {
    const a = await issue();
    // Runs out now, so it is the code that stopped working last: only the latest three are looked at.
    await db.sql`update station_pairing_codes set expires_at = now() where station_id = ${station} and used_at is null and expires_at > now()`;
    const late = await pair(a.body.data.code);
    expect(late.status).toBe(401);
    expect(late.body.details?.reason).toBe("pairing_code_expired");
  });
});
