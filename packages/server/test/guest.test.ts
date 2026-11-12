import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import "../src/modules.js";
import { buildApp, type App } from "../src/app.js";
import { withTransaction } from "../src/db/client.js";
import { seedRulesForMerchant } from "../src/services/pricing-rules.js";
import { resetGuestRateLimitsForTests, revokeStaleSessions } from "../src/services/guest.js";
import { startListener, stopListener } from "../src/sse/listener.js";
import { api, freshDb, readSse, seedMerchant, type SeededMerchant, type TestDb, sgSeedRules } from "./helpers.js";

let db: TestDb;
let app: App;
let A: SeededMerchant;
let call: ReturnType<typeof api>["call"];
let serverPin: string;
let cashierPin: string;
const ids = { laksa: randomUUID(), kopi: randomUUID(), prawn: randomUUID(), protein: randomUUID(), menu: randomUUID(), posLink: randomUUID(), qrLink: randomUUID(), area: randomUUID(), table12: randomUUID(), table13: randomUUID(), station: randomUUID(), kitchen: randomUUID(), slipPrinter: randomUUID(), cash: randomUUID() };
let qrUrl12: string;
let qrUrl13: string;
const tokenFrom = (url: string) => url.split("/t/")[1]!;

type Session = { guest_token: string; session_id: string; table: { name: string }; order_open: boolean; can_order: boolean; hold_orders: boolean; service_requests: string[] };
type Snap = { id: string; version: number; status: string; lines: { id: string; status: string; source: string; round_id: string | null }[]; totals: { total: number }; checks: { id: string; totals: { total: number } }[] };

const guestCall = <T,>(method: string, path: string, token: string, body?: unknown) => call<T>(method, path, { token, body });

beforeAll(async () => {
  db = await freshDb({ GUEST_APP_URL: "https://order.example.test" });
  app = buildApp();
  call = api(app).call;
  A = await seedMerchant(db.sql, "Alpha");
  await withTransaction(() => seedRulesForMerchant(A.merchantId, sgSeedRules(A)));
  const t = A.admin.token;
  await call("POST", "/v1/products", { token: t, body: { id: ids.prawn, name: "Prawn", price: 200, kind: "component" } });
  await call("POST", "/v1/modifier-groups", { token: t, body: { id: ids.protein, name: "Protein", min_select: 1, max_select: 1, options: [{ product_id: ids.prawn }] } });
  await call("POST", "/v1/products", { token: t, body: { id: ids.laksa, name: "Laksa", price: 1600, tags: ["kitchen"], modifier_group_ids: [ids.protein] } });
  await call("POST", "/v1/products", { token: t, body: { id: ids.kopi, name: "Kopi", price: 180, tags: ["kitchen"] } });
  await call("POST", "/v1/menus", { token: t, body: { id: ids.menu, brand_id: A.brandId, name: "M", sections: [{ name: "All", items: [{ product_id: ids.laksa }, { product_id: ids.kopi }] }] } });
  await call("POST", "/v1/channel-links", { token: t, body: { id: ids.posLink, channel: "pos", outlet_id: A.outletId, brand_id: A.brandId, menu_id: ids.menu } });
  await call("POST", "/v1/printers", { token: t, body: { id: ids.kitchen, outlet_id: A.outletId, name: "Kitchen", ip: "10.0.0.1", include_tags: ["kitchen"] } });
  await call("POST", "/v1/printers", { token: t, body: { id: ids.slipPrinter, outlet_id: A.outletId, name: "Pass", ip: "10.0.0.2", is_default_kitchen: true } });
  await call("POST", "/v1/channel-links", { token: t, body: { id: ids.qrLink, channel: "scan_to_order", outlet_id: A.outletId, brand_id: A.brandId, menu_id: ids.menu, hold_orders: true, service_requests: ["Water", "Cutlery"], service_request_printer_id: ids.slipPrinter } });
  await call("POST", "/v1/areas", { token: t, body: { id: ids.area, outlet_id: A.outletId, name: "Main" } });
  await call("POST", "/v1/tables", { token: t, body: { id: ids.table12, outlet_id: A.outletId, area_id: ids.area, name: "12" } });
  await call("POST", "/v1/tables", { token: t, body: { id: ids.table13, outlet_id: A.outletId, area_id: ids.area, name: "13" } });
  await call("POST", "/v1/tender-types", { token: t, body: { id: ids.cash, name: "Cash", is_cash: true } });
  await call("POST", "/v1/stations", { token: t, body: { id: ids.station, outlet_id: A.outletId, brand_id: A.brandId, name: "Floor" } });
  const code = await call<{ data: { code: string } }>("POST", `/v1/stations/${ids.station}/pairing-code`, { token: t, body: {} });
  const paired = await call<{ data: { station_token: string } }>("POST", "/v1/stations/pair", { body: { code: code.body.data.code, device_label: "iPad" }, idempotencyKey: null });
  const signIn = async (pin: string) => (await call<{ data: { session_token: string } }>("POST", "/v1/stations/sessions", { token: paired.body.data.station_token, body: { pin } })).body.data.session_token;
  serverPin = await signIn("444444");
  cashierPin = await signIn("333333");
  qrUrl12 = (await call<{ data: { url: string } }>("POST", `/v1/tables/${ids.table12}/qr/rotate`, { token: t, body: {} })).body.data.url;
  qrUrl13 = (await call<{ data: { url: string } }>("POST", `/v1/tables/${ids.table13}/qr/rotate`, { token: t, body: {} })).body.data.url;
  await startListener();
});
afterAll(async () => {
  await stopListener();
  await db.drop();
});

describe("Scan to Order", () => {
  it("rotating a token issues a guest-app URL; the QR sheet is a PDF and rotates tokens; only Admin may do either", async () => {
    expect(qrUrl12).toMatch(/^https:\/\/order\.example\.test\/t\/[A-Za-z0-9_-]+$/);
    expect((await call("POST", `/v1/tables/${ids.table12}/qr/rotate`, { token: A.manager.token, body: {} })).status).toBe(403);
    const pdf = await app.request(`/v1/outlets/${A.outletId}/qr-sheet.pdf`, { headers: { authorization: `Bearer ${A.admin.token}` } });
    expect(pdf.status).toBe(200);
    expect(Buffer.from(await pdf.arrayBuffer()).subarray(0, 4).toString()).toBe("%PDF");
    // The sheet rotated every table token: the earlier URLs are dead now.
    const dead = await call<{ code: string }>("POST", "/v1/guest/sessions", { body: { token: tokenFrom(qrUrl12), device_id: "device-dead-0001" }, idempotencyKey: null });
    expect(dead.status).toBe(404);
    qrUrl12 = (await call<{ data: { url: string } }>("POST", `/v1/tables/${ids.table12}/qr/rotate`, { token: A.admin.token, body: {} })).body.data.url;
    qrUrl13 = (await call<{ data: { url: string } }>("POST", `/v1/tables/${ids.table13}/qr/rotate`, { token: A.admin.token, body: {} })).body.data.url;
  });

  it("a photographed QR code for a table with no open order cannot create an order (default setting), but can browse the menu", async () => {
    const s = await call<{ data: Session }>("POST", "/v1/guest/sessions", { body: { token: tokenFrom(qrUrl12), device_id: "device-aaaa-0001" }, idempotencyKey: null });
    expect(s.status, JSON.stringify(s.body)).toBe(201);
    expect(s.body.data).toMatchObject({ order_open: false, can_order: false, hold_orders: true, service_requests: ["Water", "Cutlery"] });
    expect(s.body.data.table.name).toBe("12");
    const g = s.body.data.guest_token;
    const menu = await guestCall<{ data: { products: Record<string, { price: number }>; channel_link: { channel: string } } }>("GET", `/v1/channel-links/${ids.qrLink}/menu`, g);
    expect(menu.status, JSON.stringify(menu.body)).toBe(200);
    expect(menu.body.data.products[ids.laksa]!.price).toBe(1600);
    expect(menu.body.data.channel_link.channel).toBe("scan_to_order");
    const round = await guestCall<{ code: string; details: Record<string, unknown> }>("POST", "/v1/guest/rounds", g, { round_id: randomUUID(), lines: [{ line_id: randomUUID(), product_id: ids.kopi, quantity: 1 }] });
    expect(round.status).toBe(409);
    expect(round.body.details).toMatchObject({ table_not_open: true });
    // Guests cannot touch staff endpoints or other tables.
    expect((await guestCall("GET", `/v1/outlets/${A.outletId}/orders`, g)).status).toBe(403);
    expect((await guestCall("GET", "/v1/staff", g)).status).toBe(403);
    expect((await guestCall("GET", `/v1/channel-links/${ids.posLink}/menu`, g)).status).toBe(200); // same outlet's POS menu is still just a menu
  });

  it("a guest who scanned before the table was seated is bound to the table's order on the next read, without a new session", async () => {
    const s = await call<{ data: Session }>("POST", "/v1/guest/sessions", { body: { token: tokenFrom(qrUrl12), device_id: "device-aaaa-0001-early" }, idempotencyKey: null });
    const g = s.body.data.guest_token;
    const before = await guestCall<{ data: { can_order: boolean; order_open: boolean; order: null } }>("GET", "/v1/guest/order", g);
    expect(before.body.data).toMatchObject({ can_order: false, order_open: false, order: null });
    expect((await guestCall("GET", "/v1/guest/stream", g)).status).toBe(409);
    const seated = await call<{ data: Snap }>("POST", "/v1/orders", { token: serverPin, body: { order_id: randomUUID(), order_type: "dine_in", table_id: ids.table12, pax: 2 } });
    expect(seated.status).toBe(201);
    const after = await guestCall<{ data: { can_order: boolean; order_open: boolean; order: { id: string } } }>("GET", "/v1/guest/order", g);
    expect(after.body.data).toMatchObject({ can_order: true, order_open: true });
    expect(after.body.data.order.id).toBe(seated.body.data.id);
    const round = await guestCall<{ data: { status: string } }>("POST", "/v1/guest/rounds", g, { round_id: randomUUID(), lines: [{ line_id: randomUUID(), product_id: ids.kopi, quantity: 1 }] });
    expect(round.status, JSON.stringify(round.body)).toBe(201);
    const stream = await app.request("/v1/guest/stream", { headers: { authorization: `Bearer ${g}` } });
    expect(stream.status).toBe(200);
    expect((await readSse(stream, 1, 2000))[0]!.event).toBe("hello");
    // Leave table 12 free for the next scenario.
    for (const r of (await call<{ data: { id: string }[] }>("GET", `/v1/outlets/${A.outletId}/rounds?status=pending`, { token: serverPin })).body.data) await call("POST", `/v1/rounds/${r.id}/reject`, { token: serverPin, body: { reason: "test" } });
    expect((await call("POST", `/v1/orders/${seated.body.data.id}/cancel`, { token: serverPin, body: { reason: "test" } })).status).toBe(200);
  });

  it("with the table seated, a guest round waits for acceptance, staff accept it, it fires and prints, and the guest sees statuses; a QR order reaches the POS stream", async () => {
    const seated = await call<{ data: Snap }>("POST", "/v1/orders", { token: serverPin, body: { order_id: randomUUID(), order_type: "dine_in", table_id: ids.table12, pax: 2 } });
    expect(seated.status).toBe(201);
    const s = await call<{ data: Session }>("POST", "/v1/guest/sessions", { body: { token: tokenFrom(qrUrl12), device_id: "device-bbbb-0002", guest_name: "Wei" }, idempotencyKey: null });
    expect(s.body.data).toMatchObject({ order_open: true, can_order: true });
    const g = s.body.data.guest_token;

    const posStream = await app.request(`/v1/outlets/${A.outletId}/stream`, { headers: { authorization: `Bearer ${serverPin}` } });
    const pending = readSse(posStream, 3, 5000);
    await new Promise((r) => setTimeout(r, 100));

    const bad = await guestCall<{ code: string; message: string }>("POST", "/v1/guest/rounds", g, { round_id: randomUUID(), lines: [{ line_id: randomUUID(), product_id: ids.laksa, quantity: 1 }] });
    expect(bad.status).toBe(400);
    expect(bad.body.message).toMatch(/Choose 1 more: Protein/);
    const roundId = randomUUID();
    const t0 = Date.now();
    const round = await guestCall<{ data: { status: string; lines: { status: string; source: string; mine: boolean }[]; rounds: { id: string; status: string; mine: boolean }[] } }>("POST", "/v1/guest/rounds", g, { round_id: roundId, lines: [{ line_id: randomUUID(), product_id: ids.laksa, quantity: 1, modifiers: [{ group_id: ids.protein, product_id: ids.prawn }], notes: "less spicy" }, { line_id: randomUUID(), product_id: ids.kopi, quantity: 2 }] });
    expect(round.status, JSON.stringify(round.body)).toBe(201);
    expect(round.body.data.status).toBe("pending");
    expect(round.body.data.lines.map((l) => [l.status, l.source, l.mine])).toEqual([["held", "guest", true], ["held", "guest", true]]);
    const got = await pending;
    expect(Date.now() - t0).toBeLessThan(2000); // the QR round reaches the POS within 2 s
    expect(got.map((e) => (e.data as { type?: string }).type ?? e.event)).toEqual(["hello", "round.submitted", "order.repriced"]);

    // Staff see the pending round on the floor and in the list; a server accepts; it fires and prints.
    const floor = await call<{ data: { tables: { id: string; order: { pending_rounds: number } | null }[] } }>("GET", `/v1/outlets/${A.outletId}/floor`, { token: serverPin });
    expect(floor.body.data.tables.find((t) => t.id === ids.table12)!.order!.pending_rounds).toBe(1);
    const list = await call<{ data: { id: string; table_name: string; lines: { name: string; notes: string | null }[] }[] }>("GET", `/v1/outlets/${A.outletId}/rounds?status=pending`, { token: serverPin });
    expect(list.body.data[0]).toMatchObject({ id: roundId, table_name: "12" });
    expect(list.body.data[0]!.lines.map((l) => l.name)).toEqual(["Laksa", "Kopi"]);
    const accepted = await call<{ data: Snap; events: { type: string }[] }>("POST", `/v1/rounds/${roundId}/accept`, { token: serverPin, body: {} });
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    expect(accepted.body.data.lines.filter((l) => l.round_id === roundId).every((l) => l.status === "fired")).toBe(true);
    expect(accepted.body.data.status).toBe("fired");
    const jobs = await call<{ data: { kind: string; text: string }[] }>("GET", `/v1/outlets/${A.outletId}/print-jobs?order_id=${seated.body.data.id}`, { token: serverPin });
    expect(jobs.body.data.filter((j) => j.kind === "kitchen")).toHaveLength(1);
    expect(jobs.body.data[0]!.text).toMatch(/LESS SPICY/i);
    const view = await guestCall<{ data: { rounds: { status: string }[]; order: { status: string } } }>("GET", "/v1/guest/order", g);
    expect(view.body.data.rounds[0]!.status).toBe("fired");
    expect(view.body.data.order.status).toBe("fired");
    expect(JSON.stringify(view.body)).not.toMatch(/"total"/); // guests see no totals or payments
    // The guest stream signals order changes.
    const gs = await app.request("/v1/guest/stream", { headers: { authorization: `Bearer ${g}` } });
    expect(gs.status).toBe(200);
    const gPending = readSse(gs, 2, 4000);
    await new Promise((r) => setTimeout(r, 100));
    await call("POST", `/v1/orders/${seated.body.data.id}/ready`, { token: serverPin, body: {} });
    const gGot = await gPending;
    expect(gGot[0]!.event).toBe("hello");
    expect((gGot[1]!.data as { type: string }).type).toBe("order.status_changed");
    // Accepting twice is a clean state conflict; rejecting a second round removes its lines.
    expect((await call("POST", `/v1/rounds/${roundId}/accept`, { token: serverPin, body: {} })).status).toBe(409);
    resetGuestRateLimitsForTests();
    const round2 = randomUUID();
    await guestCall("POST", "/v1/guest/rounds", g, { round_id: round2, lines: [{ line_id: randomUUID(), product_id: ids.kopi, quantity: 1 }] });
    const rejected = await call<{ data: Snap }>("POST", `/v1/rounds/${round2}/reject`, { token: serverPin, body: { reason: "Kitchen closed" } });
    expect(rejected.status).toBe(200);
    expect(rejected.body.data.lines.filter((l) => l.round_id === round2).every((l) => l.status === "voided")).toBe(true);
    const view2 = await guestCall<{ data: { rounds: { id: string; status: string; reject_reason: string | null }[] } }>("GET", "/v1/guest/order", g);
    expect(view2.body.data.rounds.find((r) => r.id === round2)).toMatchObject({ status: "rejected", reject_reason: "Kitchen closed" });
  });

  it("table requests reach the POS, print a slip, and call-for-bill marks the table; rate limits hold", async () => {
    const s = await call<{ data: Session }>("POST", "/v1/guest/sessions", { body: { token: tokenFrom(qrUrl12), device_id: "device-cccc-0003" }, idempotencyKey: null });
    const g = s.body.data.guest_token;
    expect((await guestCall<{ code: string }>("POST", "/v1/guest/requests", g, { type: "Champagne" })).status).toBe(400);
    const water = await guestCall<{ data: { id: string; type: string; status: string } }>("POST", "/v1/guest/requests", g, { type: "Water" });
    expect(water.status, JSON.stringify(water.body)).toBe(201);
    const again = await guestCall<{ code: string; details: { retry_after_seconds: number } }>("POST", "/v1/guest/requests", g, { type: "Water" });
    expect(again.status).toBe(429);
    expect(again.body.details.retry_after_seconds).toBeGreaterThan(0);
    const bill = await guestCall<{ data: { id: string } }>("POST", "/v1/guest/requests", g, { type: "call_for_bill" });
    expect(bill.status).toBe(201);
    const floor = await call<{ data: { tables: { id: string; status: string; requests_waiting: number }[] } }>("GET", `/v1/outlets/${A.outletId}/floor`, { token: serverPin });
    const t12 = floor.body.data.tables.find((t) => t.id === ids.table12)!;
    expect(t12.status).toBe("bill_requested");
    expect(t12.requests_waiting).toBe(2);
    const slips = await call<{ data: { kind: string; printer_id: string; text: string }[] }>("GET", `/v1/outlets/${A.outletId}/print-jobs?status=queued`, { token: serverPin });
    const slip = slips.body.data.filter((j) => j.kind === "service_slip");
    expect(slip.length).toBe(2);
    expect(slip.every((j) => j.printer_id === ids.slipPrinter)).toBe(true);
    const open = await call<{ data: { id: string; type: string; table_name: string }[] }>("GET", `/v1/outlets/${A.outletId}/service-requests?status=open`, { token: cashierPin });
    expect(open.body.data.map((r) => r.type)).toEqual(["Water", "call_for_bill"]);
    const ack = await call<{ data: { status: string } }>("POST", `/v1/service-requests/${water.body.data.id}/acknowledge`, { token: serverPin, body: {} });
    expect(ack.body.data.status).toBe("acknowledged");
    expect((await call("POST", `/v1/service-requests/${water.body.data.id}/acknowledge`, { token: serverPin, body: {} })).status).toBe(404);
    // Burst of sign-ins from one device is rate-limited.
    resetGuestRateLimitsForTests();
    let limited = 0;
    for (let i = 0; i < 12; i++) {
      const r = await call("POST", "/v1/guest/sessions", { body: { token: tokenFrom(qrUrl13), device_id: "device-burst-0009" }, idempotencyKey: null });
      if (r.status === 429) limited++;
    }
    expect(limited).toBe(2);
    resetGuestRateLimitsForTests();
  });

  it("a guest and a station adding to the same order at once both succeed with no lost lines; the session ends when the order is paid", async () => {
    const orderId = (await call<{ data: Snap[] }>("GET", `/v1/outlets/${A.outletId}/orders?table_id=${ids.table12}&open_only=true`, { token: serverPin })).body.data[0]!.id;
    const s = await call<{ data: Session }>("POST", "/v1/guest/sessions", { body: { token: tokenFrom(qrUrl12), device_id: "device-dddd-0004" }, idempotencyKey: null });
    const g = s.body.data.guest_token;
    const [guestRound, staffAdd] = await Promise.all([
      guestCall<{ data: { status: string } }>("POST", "/v1/guest/rounds", g, { round_id: randomUUID(), lines: [{ line_id: randomUUID(), product_id: ids.kopi, quantity: 1 }] }),
      call<{ data: Snap }>("POST", `/v1/orders/${orderId}/lines`, { token: serverPin, body: { lines: [{ line_id: randomUUID(), product_id: ids.kopi, quantity: 3 }] } }),
    ]);
    expect(guestRound.status).toBe(201);
    expect(staffAdd.status).toBe(200);
    const snap = await call<{ data: Snap }>("GET", `/v1/orders/${orderId}`, { token: serverPin });
    const live = snap.body.data.lines.filter((l) => l.status !== "voided");
    expect(live.filter((l) => l.source === "guest")).toHaveLength(3); // 2 from the accepted round + 1 held
    expect(live.filter((l) => l.source === "pos")).toHaveLength(1);
    // Pay and close: guest session revoked.
    const pendingRounds = await call<{ data: { id: string }[] }>("GET", `/v1/outlets/${A.outletId}/rounds?status=pending`, { token: serverPin });
    for (const r of pendingRounds.body.data) await call("POST", `/v1/rounds/${r.id}/accept`, { token: serverPin, body: {} });
    await call("POST", `/v1/orders/${orderId}/fire`, { token: serverPin, body: {} });
    const current = await call<{ data: Snap }>("GET", `/v1/orders/${orderId}`, { token: cashierPin });
    const paid = await call<{ data: Snap }>("POST", `/v1/checks/${current.body.data.checks[0]!.id}/payments`, { token: cashierPin, body: { payment_id: randomUUID(), tender_type_id: ids.cash, amount: current.body.data.checks[0]!.totals.total } });
    expect(paid.status, JSON.stringify(paid.body)).toBe(200);
    expect(paid.body.data.status).toBe("completed");
    const afterClose = await guestCall<{ code: string; remedy: string }>("GET", "/v1/guest/order", g);
    expect(afterClose.status).toBe(401);
    expect(afterClose.body.remedy).toMatch(/Scan the table/);
    expect(await withTransaction(() => revokeStaleSessions())).toBe(0); // the hook already revoked them
  });

  it("open on first scan lets a guest open the table's order", async () => {
    await call("PATCH", `/v1/channel-links/${ids.qrLink}`, { token: A.admin.token, body: { open_on_first_scan: true, hold_orders: false } });
    const s = await call<{ data: Session }>("POST", "/v1/guest/sessions", { body: { token: tokenFrom(qrUrl13), device_id: "device-eeee-0005" }, idempotencyKey: null });
    expect(s.body.data).toMatchObject({ order_open: false, can_order: true });
    const round = await guestCall<{ data: { status: string; order_opened: boolean; order: { order_no: string; status: string } } }>("POST", "/v1/guest/rounds", s.body.data.guest_token, { round_id: randomUUID(), lines: [{ line_id: randomUUID(), product_id: ids.kopi, quantity: 1 }] });
    expect(round.status, JSON.stringify(round.body)).toBe(201);
    expect(round.body.data.order_opened).toBe(true);
    expect(round.body.data.status).toBe("accepted");
    expect(round.body.data.order.order_no).toMatch(/^QR-\d{4}$/);
    expect(round.body.data.order.status).toBe("fired");
    const floor = await call<{ data: { tables: { id: string; status: string }[] } }>("GET", `/v1/outlets/${A.outletId}/floor`, { token: serverPin });
    expect(floor.body.data.tables.find((t) => t.id === ids.table13)!.status).toBe("sent");
  });
});
