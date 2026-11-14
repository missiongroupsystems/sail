import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import "../src/modules.js";
import { buildApp, type App } from "../src/app.js";
import { withTransaction } from "../src/db/client.js";
import { seedRulesForMerchant } from "../src/services/pricing-rules.js";
import { resetGuestRateLimitsForTests } from "../src/services/guest.js";
import { api, freshDb, seedMerchant, sgSeedRules, type SeededMerchant, type TestDb } from "./helpers.js";

/** Findings from the fifth live test that live in the register. */
let db: TestDb;
let app: App;
let A: SeededMerchant;
let call: ReturnType<typeof api>["call"];
let serverPin: string;
const ids = { kopi: randomUUID(), menu: randomUUID(), posLink: randomUUID(), qrLink: randomUUID(), area: randomUUID(), t1: randomUUID(), t2: randomUUID(), t3: randomUUID(), t4: randomUUID(), t5: randomUUID(), station: randomUUID(), kitchen: randomUUID(), cash: randomUUID() };
const qr: Record<string, string> = {};
const tokenFrom = (url: string) => url.split("/t/")[1]!;

type Snap = { id: string; status: string; lines: { id: string; status: string }[] };
type View = { data: { order: { id: string; status: string } | null; can_order: boolean; lines: { id: string; status: string }[]; rounds: { id: string; status: string; reject_reason: string | null; mine: boolean }[] } };

beforeAll(async () => {
  db = await freshDb({ GUEST_APP_URL: "https://order.example.test" });
  app = buildApp();
  call = api(app).call;
  A = await seedMerchant(db.sql, "Alpha");
  await withTransaction(() => seedRulesForMerchant(A.merchantId, sgSeedRules(A)));
  const t = A.admin.token;
  const must = async (path: string, body: unknown) => {
    const r = await call("POST", path, { token: t, body });
    expect(r.status, `${path} ${JSON.stringify(r.body)}`).toBeLessThan(300);
  };
  await must("/v1/products", { id: ids.kopi, name: "Kopi", price: 180, tags: ["kitchen"] });
  await must("/v1/menus", { id: ids.menu, brand_id: A.brandId, name: "M", sections: [{ name: "All", items: [{ product_id: ids.kopi }] }] });
  await must("/v1/channel-links", { id: ids.posLink, channel: "pos", outlet_id: A.outletId, brand_id: A.brandId, menu_id: ids.menu });
  await must("/v1/printers", { id: ids.kitchen, outlet_id: A.outletId, name: "Kitchen", ip: "10.0.0.1", is_default_kitchen: true });
  await must("/v1/channel-links", { id: ids.qrLink, channel: "scan_to_order", outlet_id: A.outletId, brand_id: A.brandId, menu_id: ids.menu, hold_orders: true, open_on_first_scan: true });
  await must("/v1/areas", { id: ids.area, outlet_id: A.outletId, name: "Main" });
  for (const [k, name] of [["t1", "1"], ["t2", "2"], ["t3", "3"], ["t4", "4"], ["t5", "5"]] as const) {
    await must("/v1/tables", { id: ids[k], outlet_id: A.outletId, area_id: ids.area, name });
    qr[k] = (await call<{ data: { url: string } }>("POST", `/v1/tables/${ids[k]}/qr/rotate`, { token: t, body: {} })).body.data.url;
  }
  await must("/v1/tender-types", { id: ids.cash, name: "Cash", is_cash: true });
  await must("/v1/shifts", { outlet_id: A.outletId, station_id: null, float_cents: 0 });
  await must("/v1/stations", { id: ids.station, outlet_id: A.outletId, brand_id: A.brandId, name: "Floor" });
  const code = await call<{ data: { code: string } }>("POST", `/v1/stations/${ids.station}/pairing-code`, { token: t, body: {} });
  const paired = await call<{ data: { station_token: string } }>("POST", "/v1/stations/pair", { body: { code: code.body.data.code, device_label: "iPad" }, idempotencyKey: null });
  serverPin = (await call<{ data: { session_token: string } }>("POST", "/v1/stations/sessions", { token: paired.body.data.station_token, body: { pin: "444444" } })).body.data.session_token;
});
afterAll(async () => db.drop());

const phone = async (table: string, device: string) => {
  await resetGuestRateLimitsForTests();
  const s = await call<{ data: { guest_token: string } }>("POST", "/v1/guest/sessions", { body: { token: tokenFrom(qr[table]!), device_id: device }, idempotencyKey: null });
  expect(s.status, JSON.stringify(s.body)).toBe(201);
  return s.body.data.guest_token;
};
const sendRound = async (g: string) => {
  await resetGuestRateLimitsForTests();
  const round_id = randomUUID();
  const r = await call<{ data: { order: { id: string } } }>("POST", "/v1/guest/rounds", { token: g, body: { round_id, lines: [{ line_id: randomUUID(), product_id: ids.kopi, quantity: 1 }] } });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return { roundId: round_id, orderId: r.body.data.order.id };
};
const reject = (roundId: string) => call<{ data: Snap; events: { type: string }[] }>("POST", `/v1/rounds/${roundId}/reject`, { token: serverPin, body: { reason: "Kitchen closed" } });
const tableStatus = async (tableId: string) => (await call<{ data: { tables: { id: string; status: string }[] } }>("GET", `/v1/outlets/${A.outletId}/floor`, { token: serverPin })).body.data.tables.find((t) => t.id === tableId)!.status;
const orderRow = async (id: string) => (await db.sql<{ status: string; cancel_reason: string | null }[]>`select status, cancel_reason from orders where id = ${id}`)[0]!;

describe("rejecting a guest's QR round (M2)", () => {
  it("cancels the order the round opened when nothing else is on it, frees the table, and the phone still shows the rejection and can order again", async () => {
    const g = await phone("t1", "device-m2-0001");
    const { roundId, orderId } = await sendRound(g);
    expect(await tableStatus(ids.t1)).toBe("seated");
    const r = await reject(roundId);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data.status).toBe("cancelled");
    expect(r.body.events.map((e) => e.type)).toEqual(expect.arrayContaining(["round.rejected", "order.cancelled"]));
    expect(await orderRow(orderId)).toEqual({ status: "cancelled", cancel_reason: "QR order rejected" });
    expect(await tableStatus(ids.t1)).toBe("free");
    // The phone's session carries on: it still shows its round as not accepted, with the round's items struck.
    const view = await call<View>("GET", "/v1/guest/order", { token: g });
    expect(view.status, JSON.stringify(view.body)).toBe(200);
    expect(view.body.data.rounds.find((x) => x.id === roundId)).toMatchObject({ status: "rejected", reject_reason: "Kitchen closed", mine: true });
    expect(view.body.data.lines.length).toBe(1);
    expect(view.body.data.lines[0]!.status).toBe("voided");
    expect(view.body.data.can_order).toBe(true);
    // Ordering again opens a fresh order on the free table.
    const again = await sendRound(g);
    expect(again.orderId).not.toBe(orderId);
  });

  it("keeps every phone at the table signed in: a second phone bound to the cancelled order is unbound, not ended", async () => {
    const a = await phone("t5", "device-m2-0005");
    const { roundId, orderId } = await sendRound(a);
    const b = await phone("t5", "device-m2-0006");
    expect((await call<View>("GET", "/v1/guest/order", { token: b })).body.data.order?.id).toBe(orderId);
    expect((await reject(roundId)).status).toBe(200);
    for (const g of [a, b]) {
      const v = await call<View>("GET", "/v1/guest/order", { token: g });
      expect(v.status, JSON.stringify(v.body)).toBe(200);
      expect(v.body.data.order).toBeNull();
    }
  });

  it("leaves the order open when it has other live lines", async () => {
    const g = await phone("t2", "device-m2-0002");
    const first = await sendRound(g);
    expect((await call("POST", `/v1/rounds/${first.roundId}/accept`, { token: serverPin, body: {} })).status).toBe(200);
    const second = await sendRound(g);
    const r = await reject(second.roundId);
    expect(r.status).toBe(200);
    expect(r.body.data.status).not.toBe("cancelled");
    expect((await orderRow(first.orderId)).status).not.toBe("cancelled");
  });

  it("leaves the order open when a line on it was sent to the kitchen, even if that line was voided since", async () => {
    const g = await phone("t3", "device-m2-0003");
    const first = await sendRound(g);
    const accepted = await call<{ data: Snap }>("POST", `/v1/rounds/${first.roundId}/accept`, { token: serverPin, body: {} });
    const sent = accepted.body.data.lines[0]!;
    const v = await call("POST", `/v1/orders/${first.orderId}/lines/${sent.id}/void`, { token: A.manager.token, body: { reason_text: "Kitchen error" } });
    expect(v.status, JSON.stringify(v.body)).toBe(200);
    const second = await sendRound(g);
    const r = await reject(second.roundId);
    expect(r.status).toBe(200);
    expect((await orderRow(first.orderId)).status).not.toBe("cancelled");
  });

  it("leaves an order staff opened (they seated the table) open", async () => {
    const seated = await call<{ data: Snap }>("POST", "/v1/orders", { token: serverPin, body: { order_id: randomUUID(), order_type: "dine_in", table_id: ids.t4, pax: 2 } });
    expect(seated.status, JSON.stringify(seated.body)).toBe(201);
    const g = await phone("t4", "device-m2-0004");
    const { roundId, orderId } = await sendRound(g);
    expect(orderId).toBe(seated.body.data.id);
    const r = await reject(roundId);
    expect(r.status).toBe(200);
    expect((await orderRow(orderId)).status).toBe("open");
    expect(await tableStatus(ids.t4)).toBe("seated");
  });
});
