import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import "../src/modules.js";
import { buildApp, type App } from "../src/app.js";
import { api, freshDb, seedMerchant, type SeededMerchant, type TestDb } from "./helpers.js";

/**
 * An outlet belongs to one brand, and everything under it is on that brand: a station (a kitchen display too), a
 * channel and a new order take the outlet's brand when none is given, and are refused when they name another. The
 * register says so in words; the database refuses the same writes whoever makes them.
 */
let db: TestDb;
let app: App;
let A: SeededMerchant;
let call: ReturnType<typeof api>["call"];
const other = randomUUID(); // a second brand of the merchant, with an outlet of its own
const otherOutlet = randomUUID();
const menu = randomUUID();
type Refusal = { code: string; message: string; remedy?: string; details?: { field?: string; reason?: string } };
type Station = { id: string; brand_id: string | null; kind: string };

beforeAll(async () => {
  db = await freshDb();
  app = buildApp();
  call = api(app).call;
  A = await seedMerchant(db.sql, "Alpha");
  const t = A.admin.token;
  expect((await call("POST", "/v1/brands", { token: t, body: { id: other, name: "Second brand" } })).status).toBe(201);
  expect((await call("POST", "/v1/outlets", { token: t, body: { id: otherOutlet, brand_id: other, name: "Second brand's outlet" } })).status).toBe(201);
  expect((await call("POST", "/v1/menus", { token: t, body: { id: menu, brand_id: A.brandId, name: "Menu", sections: [] } })).status).toBe(201);
});
afterAll(async () => db.drop());

describe("an outlet has one brand", () => {
  it("an outlet cannot be created without a brand, with an unknown brand or with another merchant's", async () => {
    const B = await seedMerchant(db.sql, "Beta");
    const none = await call<Refusal>("POST", "/v1/outlets", { token: A.admin.token, body: { name: "No brand" } });
    expect(none.status).toBe(400);
    for (const brand_id of [randomUUID(), B.brandId]) {
      const r = await call<Refusal>("POST", "/v1/outlets", { token: A.admin.token, body: { name: "Not ours", brand_id } });
      expect(r.status, JSON.stringify(r.body)).toBe(404);
      expect(r.body.message).toMatch(/^brand .* was not found$/);
    }
    const [left] = await db.sql<{ n: number }[]>`select count(*)::int as n from outlets where name in ('No brand', 'Not ours')`;
    expect(left!.n).toBe(0);
  });

  it("lists by brand, and says each outlet's brand", async () => {
    const all = await call<{ data: { id: string; brand_id: string }[] }>("GET", "/v1/outlets", { token: A.admin.token });
    expect(Object.fromEntries(all.body.data.map((o) => [o.id, o.brand_id]))).toMatchObject({ [A.outletId]: A.brandId, [A.outlet2Id]: A.brandId, [otherOutlet]: other });
    const theirs = await call<{ data: { id: string }[] }>("GET", `/v1/outlets?brand_id=${other}`, { token: A.admin.token });
    expect(theirs.body.data.map((o) => o.id)).toEqual([otherOutlet]);
  });

  it("an outlet's brand changes while it has no orders and no channels, and its stations go with it; after that it is refused", async () => {
    const outlet = randomUUID();
    const t = A.admin.token;
    await call("POST", "/v1/outlets", { token: t, body: { id: outlet, brand_id: A.brandId, name: "Movable" } });
    const st = await call<{ data: Station }>("POST", "/v1/stations", { token: t, body: { outlet_id: outlet, name: "Till" } });
    expect(st.body.data.brand_id).toBe(A.brandId);

    const moved = await call<{ data: { brand_id: string } }>("PATCH", `/v1/outlets/${outlet}`, { token: t, body: { brand_id: other } });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    expect(moved.body.data.brand_id).toBe(other);
    const stations = await call<{ data: Station[] }>("GET", `/v1/outlets/${outlet}/stations`, { token: t });
    expect(stations.body.data.map((s) => s.brand_id)).toEqual([other]);
    // The same brand again changes nothing and is not refused.
    expect((await call("PATCH", `/v1/outlets/${outlet}`, { token: t, body: { brand_id: other } })).status).toBe(200);

    // With a channel set up for its brand, the outlet stays.
    const back = await call("PATCH", `/v1/outlets/${outlet}`, { token: t, body: { brand_id: A.brandId } });
    expect(back.status).toBe(200);
    expect((await call("POST", "/v1/channel-links", { token: t, body: { channel: "pos", outlet_id: outlet, menu_id: menu } })).status).toBe(201);
    const linked = await call<Refusal>("PATCH", `/v1/outlets/${outlet}`, { token: t, body: { brand_id: other } });
    expect(linked.status).toBe(409);
    expect(linked.body.details).toMatchObject({ reason: "outlet_has_channels", field: "brand_id" });

    // With an order, it stays, and says what to do instead.
    const traded = randomUUID();
    await call("POST", "/v1/outlets", { token: t, body: { id: traded, brand_id: A.brandId, name: "Traded" } });
    await db.sql`insert into channel_links (merchant_id, channel, outlet_id, brand_id, menu_id) values (${A.merchantId}, 'pos', ${traded}, ${A.brandId}, ${menu})`;
    expect((await call("POST", "/v1/orders", { token: t, body: { order_id: randomUUID(), order_type: "takeaway", outlet_id: traded } })).status).toBe(201);
    await db.sql`delete from channel_links where outlet_id = ${traded}`.catch(() => undefined);
    const withOrders = await call<Refusal>("PATCH", `/v1/outlets/${traded}`, { token: t, body: { brand_id: other } });
    expect(withOrders.status).toBe(409);
    expect(withOrders.body.code).toBe("state_conflict");
    expect(withOrders.body.message).toBe("This outlet has orders, so its brand cannot change");
    expect(withOrders.body.remedy).toMatch(/new outlet/);
    expect(withOrders.body.details).toMatchObject({ reason: "outlet_has_orders", field: "brand_id" });
    // Its other details still change.
    expect((await call("PATCH", `/v1/outlets/${traded}`, { token: t, body: { name: "Traded, renamed" } })).status).toBe(200);
  });
});

describe("a station is on its outlet's brand", () => {
  it("takes the outlet's brand when none is given, a kitchen display too", async () => {
    for (const body of [{ outlet_id: A.outletId, name: "No brand given" }, { outlet_id: A.outletId, name: "Null brand", brand_id: null }, { outlet_id: A.outletId, name: "Same brand", brand_id: A.brandId }, { outlet_id: A.outletId, name: "Pass screen", kind: "display" }, { outlet_id: otherOutlet, name: "Their till" }]) {
      const r = await call<{ data: Station }>("POST", "/v1/stations", { token: A.admin.token, body });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      expect(r.body.data.brand_id, body.name).toBe(body.outlet_id === otherOutlet ? other : A.brandId);
    }
  });

  it("is refused with another brand, on create and on update, with the field and a remedy", async () => {
    const made = await call<Refusal>("POST", "/v1/stations", { token: A.admin.token, body: { outlet_id: A.outletId, name: "Wrong brand", brand_id: other } });
    expect(made.status).toBe(400);
    expect(made.body.code).toBe("validation");
    expect(made.body.message).toBe("A station is on its outlet's brand");
    expect(made.body.remedy).toMatch(/outlet/);
    expect(made.body.details?.field).toBe("brand_id");

    const st = await call<{ data: Station }>("POST", "/v1/stations", { token: A.admin.token, body: { outlet_id: A.outletId, name: "Counter" } });
    for (const brand_id of [other, null]) {
      const changed = await call<Refusal>("PATCH", `/v1/stations/${st.body.data.id}`, { token: A.admin.token, body: { brand_id } });
      expect(changed.status, String(brand_id)).toBe(400);
      expect(changed.body.details?.field).toBe("brand_id");
    }
    // Sending the outlet's own brand is not a change, and other fields save as before.
    const same = await call<{ data: Station & { name: string } }>("PATCH", `/v1/stations/${st.body.data.id}`, { token: A.admin.token, body: { brand_id: A.brandId, name: "Counter 2" } });
    expect(same.status).toBe(200);
    expect(same.body.data).toMatchObject({ brand_id: A.brandId, name: "Counter 2" });
    const [wrong] = await db.sql<{ n: number }[]>`select count(*)::int as n from stations s join outlets o on o.id = s.outlet_id where s.brand_id is distinct from o.brand_id`;
    expect(wrong!.n).toBe(0);
  });

  it("the database keeps it so, whoever writes: a station with no brand takes the outlet's, another brand is refused", async () => {
    const id = randomUUID();
    await db.sql`insert into stations (id, merchant_id, outlet_id, name) values (${id}, ${A.merchantId}, ${A.outletId}, 'Written directly')`;
    expect((await db.sql<{ brand_id: string }[]>`select brand_id from stations where id = ${id}`)[0]!.brand_id).toBe(A.brandId);
    await expect(db.sql`update stations set brand_id = ${other} where id = ${id}`).rejects.toThrow(/belongs to brand/);
    await expect(db.sql`insert into stations (merchant_id, outlet_id, brand_id, name) values (${A.merchantId}, ${A.outletId}, ${other}, 'Other brand')`).rejects.toThrow(/belongs to brand/);
  });
});

describe("a channel and a new order are on their outlet's brand", () => {
  it("a channel takes the outlet's brand when none is given, and is refused with another", async () => {
    const made = await call<{ data: { id: string; brand_id: string } }>("POST", "/v1/channel-links", { token: A.admin.token, body: { channel: "pos", outlet_id: A.outletId, menu_id: menu } });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    expect(made.body.data.brand_id).toBe(A.brandId);
    const wrong = await call<Refusal>("POST", "/v1/channel-links", { token: A.admin.token, body: { channel: "scan_to_order", outlet_id: A.outletId, brand_id: other, menu_id: menu } });
    expect(wrong.status).toBe(400);
    expect(wrong.body.message).toBe("A channel is on its outlet's brand");
    expect(wrong.body.details?.field).toBe("brand_id");
    await expect(db.sql`insert into channel_links (merchant_id, channel, outlet_id, brand_id, menu_id) values (${A.merchantId}, 'scan_to_order', ${A.outletId}, ${other}, ${menu})`).rejects.toThrow(/belongs to brand/);
  });

  it("an order opens under the outlet's brand, from the back office and from a station, and is refused with another", async () => {
    const office = await call<{ data: { id: string; brand_id: string } }>("POST", "/v1/orders", { token: A.admin.token, body: { order_id: randomUUID(), order_type: "takeaway", outlet_id: A.outletId } });
    expect(office.status, JSON.stringify(office.body)).toBe(201);
    const [stored] = await db.sql<{ brand_id: string }[]>`select brand_id from orders where id = ${office.body.data.id}`;
    expect(stored!.brand_id).toBe(A.brandId);
    const wrong = await call<Refusal>("POST", "/v1/orders", { token: A.admin.token, body: { order_id: randomUUID(), order_type: "takeaway", outlet_id: A.outletId, brand_id: other } });
    expect(wrong.status).toBe(400);
    expect(wrong.body.message).toBe("brand_id is not this outlet's brand");
    expect(wrong.body.details?.field).toBe("brand_id");

    const st = await call<{ data: Station }>("POST", "/v1/stations", { token: A.admin.token, body: { outlet_id: A.outletId, name: "Order till" } });
    const code = await call<{ data: { code: string } }>("POST", `/v1/stations/${st.body.data.id}/pairing-code`, { token: A.admin.token, body: {} });
    const paired = await call<{ data: { station_token: string } }>("POST", "/v1/stations/pair", { body: { code: code.body.data.code, device_label: "iPad" }, idempotencyKey: null });
    const pin = await call<{ data: { session_token: string } }>("POST", "/v1/stations/sessions", { token: paired.body.data.station_token, body: { pin: "333333" } });
    const fromTill = await call<{ data: { id: string } }>("POST", "/v1/orders", { token: pin.body.data.session_token, body: { order_id: randomUUID(), order_type: "takeaway" } });
    expect(fromTill.status, JSON.stringify(fromTill.body)).toBe(201);
    expect((await db.sql<{ brand_id: string }[]>`select brand_id from orders where id = ${fromTill.body.data.id}`)[0]!.brand_id).toBe(A.brandId);
    expect((await call("POST", "/v1/orders", { token: pin.body.data.session_token, body: { order_id: randomUUID(), order_type: "takeaway", brand_id: other } })).status).toBe(400);
  });
});

describe("brand scope reaches the outlet and what is under it", () => {
  it("someone limited to one brand sees that brand's outlets only, and nothing under another brand's", async () => {
    const t = A.admin.token;
    const area = randomUUID();
    await call("POST", "/v1/areas", { token: t, body: { id: area, outlet_id: otherOutlet, name: "Their room" } });
    await call("POST", "/v1/tables", { token: t, body: { outlet_id: otherOutlet, area_id: area, name: "X1" } });
    await db.sql`update staff set brand_ids = ${db.sql.array([A.brandId])}::uuid[] where id = ${A.manager.id}`;
    try {
      const mine = A.manager.token;
      const outlets = await call<{ data: { id: string; brand_id: string }[] }>("GET", "/v1/outlets", { token: mine });
      expect(outlets.body.data.map((o) => o.id)).toEqual(expect.arrayContaining([A.outletId, A.outlet2Id]));
      expect(outlets.body.data.every((o) => o.brand_id === A.brandId)).toBe(true);
      expect(outlets.body.data.map((o) => o.id)).not.toContain(otherOutlet);
      expect((await call<{ data: unknown[] }>("GET", `/v1/outlets?brand_id=${other}`, { token: mine })).body.data).toEqual([]);
      // Another brand's outlet is as good as unknown: its stations, floor and tables are not there.
      expect((await call("GET", `/v1/outlets/${otherOutlet}/stations`, { token: mine })).status).toBe(404);
      expect((await call("GET", `/v1/outlets/${otherOutlet}/floor`, { token: mine })).status).toBe(404);
      const tables = await call<{ data: { name: string }[] }>("GET", `/v1/tables?outlet_id=${otherOutlet}`, { token: mine });
      expect(JSON.stringify(tables.body)).not.toContain("X1");
      const areas = await call<{ data: { name: string }[] }>("GET", "/v1/areas", { token: mine });
      expect(JSON.stringify(areas.body)).not.toContain("Their room");
      // And it cannot be written to.
      expect((await call("POST", "/v1/stations", { token: mine, body: { outlet_id: otherOutlet, name: "Sneaked" } })).status).toBeGreaterThanOrEqual(400);
      expect((await db.sql<{ n: number }[]>`select count(*)::int as n from stations where name = 'Sneaked'`)[0]!.n).toBe(0);
      // Its own brand's outlets are all there.
      expect((await call("GET", `/v1/outlets/${A.outletId}/stations`, { token: mine })).status).toBe(200);
    } finally {
      await db.sql`update staff set brand_ids = '{}' where id = ${A.manager.id}`;
    }
    // With no brand limit, both brands' outlets are back.
    const all = await call<{ data: { id: string }[] }>("GET", "/v1/outlets", { token: A.manager.token });
    expect(all.body.data.map((o) => o.id)).toContain(otherOutlet);
  });

  it("an Admin limited to a brand adds an outlet of that brand, and is refused one of another brand", async () => {
    await db.sql`update staff set brand_ids = ${db.sql.array([A.brandId])}::uuid[] where id = ${A.admin.id}`;
    try {
      const added = await call<{ data: { id: string; brand_id: string } }>("POST", "/v1/outlets", { token: A.admin.token, body: { brand_id: A.brandId, name: "Limited Admin's new outlet" } });
      expect(added.status, JSON.stringify(added.body)).toBe(201);
      expect(added.body.data.brand_id).toBe(A.brandId);
      // It is theirs from the next request on.
      expect((await call("GET", `/v1/outlets/${added.body.data.id}/stations`, { token: A.admin.token })).status).toBe(200);
      const refused = await call<Refusal>("POST", "/v1/outlets", { token: A.admin.token, body: { brand_id: other, name: "Limited Admin's other brand" } });
      expect(refused.status).toBe(403);
      expect(refused.body.details).toMatchObject({ field: "brand_id" });
      expect((await db.sql<{ n: number }[]>`select count(*)::int as n from outlets where name = 'Limited Admin''s other brand'`)[0]!.n).toBe(0);
    } finally {
      await db.sql`update staff set brand_ids = '{}' where id = ${A.admin.id}`;
    }
  });

  it("someone limited to a brand is offered that brand only, archived ones included", async () => {
    await db.sql`update staff set brand_ids = ${db.sql.array([other])}::uuid[] where id = ${A.manager.id}`;
    try {
      for (const q of ["", "?include_archived=true"]) {
        const r = await call<{ data: { id: string }[] }>("GET", `/v1/brands${q}`, { token: A.manager.token });
        expect(r.status).toBe(200);
        expect(r.body.data.map((b) => b.id)).toEqual([other]);
      }
    } finally {
      await db.sql`update staff set brand_ids = '{}' where id = ${A.manager.id}`;
    }
    const all = await call<{ data: { id: string }[] }>("GET", "/v1/brands", { token: A.manager.token });
    expect(all.body.data.map((b) => b.id)).toEqual(expect.arrayContaining([A.brandId, other]));
  });

  it("limited to a brand and to an outlet of another brand, a person sees no outlet at all, never every outlet", async () => {
    await db.sql`update staff set brand_ids = ${db.sql.array([other])}::uuid[], outlet_ids = ${db.sql.array([A.outletId])}::uuid[] where id = ${A.cashier.id}`;
    try {
      const none = await call<{ data: unknown[] }>("GET", "/v1/outlets", { token: A.cashier.token });
      expect(none.status).toBe(200);
      expect(none.body.data).toEqual([]);
      expect((await call("GET", `/v1/outlets/${A.outletId}/floor`, { token: A.cashier.token })).status).toBe(404);
    } finally {
      await db.sql`update staff set brand_ids = '{}', outlet_ids = '{}' where id = ${A.cashier.id}`;
    }
  });
});

describe("Changes for a brand", () => {
  it("audit.list with brand_id gives the entries at that brand's outlets and the merchant-wide ones, never another brand's outlets'", async () => {
    const t = A.admin.token;
    // One change at each brand's outlet, and one for the whole business.
    await call("POST", "/v1/stations", { token: t, body: { outlet_id: A.outletId, name: "Audit till A" } });
    await call("POST", "/v1/stations", { token: t, body: { outlet_id: otherOutlet, name: "Audit till B" } });
    await call("POST", "/v1/brands", { token: t, body: { name: "Audit brand" } });
    type Entry = { action: string; outlet_id: string | null; details: { name?: string } | null };
    const list = async (brand: string) => (await call<{ data: Entry[] }>("GET", `/v1/audit?brand_id=${brand}&limit=500`, { token: t })).body.data;
    const mine = await list(A.brandId);
    const theirs = await list(other);
    const names = (rows: Entry[]) => rows.map((r) => r.details?.name ?? "");
    expect(names(mine)).toContain("Audit till A");
    expect(names(mine)).not.toContain("Audit till B");
    expect(names(theirs)).toContain("Audit till B");
    expect(names(theirs)).not.toContain("Audit till A");
    for (const rows of [mine, theirs]) expect(rows.some((r) => r.action === "brands.create" && r.outlet_id === null && r.details?.name === "Audit brand")).toBe(true);
    expect(mine.every((r) => r.outlet_id === null || r.outlet_id !== otherOutlet)).toBe(true);
    // Without it, everything is there.
    const all = (await call<{ data: Entry[] }>("GET", "/v1/audit?limit=500", { token: t })).body.data;
    expect(names(all)).toEqual(expect.arrayContaining(["Audit till A", "Audit till B"]));
  });
});
