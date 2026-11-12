import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import "../src/modules.js";
import { buildApp, type App } from "../src/app.js";
import { withTransaction } from "../src/db/client.js";
import { seedRulesForMerchant } from "../src/services/pricing-rules.js";
import { startListener, stopListener } from "../src/sse/listener.js";
import { api, freshDb, readSse, seedMerchant, sgSeedRules, type SeededMerchant, type TestDb } from "./helpers.js";

/**
 * Kitchen display. A display destination routes like a kitchen printer; a fire makes one ticket per destination it
 * reaches, beside the print jobs; later voids and cancels change the tickets instead of editing them silently; display
 * stations see and bump only their destinations, without a PIN; guests and relays never reach them; agents read only.
 */

let db: TestDb;
let app: App;
let call: ReturnType<typeof api>["call"];
let A: SeededMerchant;
let B: SeededMerchant;
const KEYS = ["laksa", "kopi", "bread", "menu", "link", "area", "table", "reason", "pos", "kitchenPrinter", "passPrinter", "hot", "bar", "d1", "d2", "dOutlet2", "hotOutlet2", "dB", "hotB", "relay", "bMenu", "bLink", "bLaksa", "bPrinter"] as const;
const ids = Object.fromEntries(KEYS.map((k) => [k, randomUUID()])) as Record<(typeof KEYS)[number], string>;
const tokens: Record<"d1" | "d2" | "dOutlet2" | "dB" | "pos" | "server" | "manager" | "guest" | "relay" | "agent", string> = {} as never;

type Line = { id: string; order_line_id: string; name: string; quantity: number; voided_quantity: number; modifiers: string[]; notes: string | null; seat_no: number | null };
type Ticket = { id: string; destination_id: string; order_id: string; round_no: number; status: string; changed: boolean; bumped_at: string | null; table_name: string | null; lines: Line[] };
type List = { data: Ticket[]; last_bumped: Ticket | null };
type Ev = { seq: number; type: string; aggregate: { id: string }; payload: Record<string, unknown> };

const must = async <T = unknown>(method: string, path: string, token: string, body?: unknown) => {
  const r = await call<T>(method, path, { token, body });
  if (r.status >= 300) throw new Error(`${method} ${path} -> ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
};
const pair = async (stationId: string, adminToken: string) => {
  const code = await must<{ data: { code: string } }>("POST", `/v1/stations/${stationId}/pairing-code`, adminToken, {});
  return (await call<{ data: { station_token: string } }>("POST", "/v1/stations/pair", { body: { code: code.data.code, device_label: "Wall screen" }, idempotencyKey: null })).body.data.station_token;
};
const list = (token: string, query = "", outletId = A.outletId) => call<List>("GET", `/v1/outlets/${outletId}/kitchen-tickets${query}`, { token });
const act = (token: string, ticketId: string, action: "start" | "bump" | "recall", key?: string) => call<{ data: Ticket; events: { type: string }[]; code?: string }>("POST", `/v1/kitchen-tickets/${ticketId}/${action}`, { token, body: {}, idempotencyKey: key });
const ticketEvents = async (after: number) => (await must<{ data: Ev[] }>("GET", `/v1/outlets/${A.outletId}/events?after=${after}&types=kitchen_ticket.created,kitchen_ticket.changed,kitchen_ticket.cancelled,kitchen_ticket.started,kitchen_ticket.bumped,kitchen_ticket.recalled`, A.admin.token)).data;
const latestSeq = async () => (await must<{ latest_seq: number }>("GET", `/v1/outlets/${A.outletId}/events?after=0&limit=1`, A.admin.token)).latest_seq;

/** Add the lines to the order (a new takeaway, or dine-in at table 12 for `atTable`) and send them. */
async function sendOrder(lines: { product_id: string; quantity?: number; notes?: string; seat_no?: number }[], orderId?: string, atTable = false) {
  const opened = atTable ? { order_type: "dine_in", table_id: ids.table, pax: 2 } : { order_type: "takeaway", takeaway_ref: "Bag 7" };
  const id = orderId ?? (await must<{ data: { id: string } }>("POST", "/v1/orders", tokens.server, { order_id: randomUUID(), ...opened })).data.id;
  const lineIds = lines.map(() => randomUUID());
  await must("POST", `/v1/orders/${id}/lines`, tokens.server, { lines: lines.map((l, i) => ({ line_id: lineIds[i], quantity: 1, ...l })) });
  const fired = await must<{ warnings: string[] }>("POST", `/v1/orders/${id}/fire`, tokens.server, {});
  return { orderId: id, lineIds, warnings: fired.warnings };
}

beforeAll(async () => {
  db = await freshDb();
  app = buildApp();
  call = api(app).call;
  A = await seedMerchant(db.sql, "Alpha");
  B = await seedMerchant(db.sql, "Bravo");
  await withTransaction(() => seedRulesForMerchant(A.merchantId, sgSeedRules(A)));
  const t = A.admin.token;
  await must("POST", "/v1/products", t, { id: ids.laksa, name: "Laksa", kitchen_name: "LAKSA", price: 1600, tags: ["kitchen"] });
  await must("POST", "/v1/products", t, { id: ids.kopi, name: "Kopi", price: 180, tags: ["bar"] });
  await must("POST", "/v1/products", t, { id: ids.bread, name: "Bread", price: 300 });
  await must("POST", "/v1/menus", t, { id: ids.menu, brand_id: A.brandId, name: "M", sections: [{ name: "All", items: [ids.laksa, ids.kopi, ids.bread].map((product_id) => ({ product_id })) }] });
  await must("POST", "/v1/channel-links", t, { id: ids.link, channel: "pos", outlet_id: A.outletId, brand_id: A.brandId, menu_id: ids.menu });
  await must("POST", "/v1/areas", t, { id: ids.area, outlet_id: A.outletId, name: "Main" });
  await must("POST", "/v1/tables", t, { id: ids.table, outlet_id: A.outletId, area_id: ids.area, name: "12" });
  await must("POST", "/v1/void-reasons", t, { id: ids.reason, name: "Mistake" });
  // Printers as before: Kitchen takes the kitchen tag, Pass is the default for the rest.
  await must("POST", "/v1/printers", t, { id: ids.kitchenPrinter, outlet_id: A.outletId, name: "Kitchen", ip: "10.0.0.1", include_tags: ["kitchen"] });
  await must("POST", "/v1/printers", t, { id: ids.passPrinter, outlet_id: A.outletId, name: "Pass", ip: "10.0.0.2", is_default_kitchen: true });
  // Displays: Hot takes the kitchen tag and the leftovers; Bar takes the bar tag.
  await must("POST", "/v1/display-destinations", t, { id: ids.hot, outlet_id: A.outletId, name: "Hot line", include_tags: ["kitchen"], is_default: true });
  await must("POST", "/v1/display-destinations", t, { id: ids.bar, outlet_id: A.outletId, name: "Bar", include_tags: ["bar"] });
  await must("POST", "/v1/display-destinations", t, { id: ids.hotOutlet2, outlet_id: A.outlet2Id, name: "Outlet 2 kitchen" });
  await must("POST", "/v1/stations", t, { id: ids.pos, outlet_id: A.outletId, brand_id: A.brandId, name: "Floor" });
  await must("POST", "/v1/stations", t, { id: ids.d1, outlet_id: A.outletId, name: "Pass screen", kind: "display", display_destination_ids: [ids.hot, ids.bar] });
  await must("POST", "/v1/stations", t, { id: ids.d2, outlet_id: A.outletId, name: "Wok screen", kind: "display", display_destination_ids: [ids.hot] });
  await must("POST", "/v1/stations", t, { id: ids.dOutlet2, outlet_id: A.outlet2Id, name: "Outlet 2 screen", kind: "display", display_destination_ids: [ids.hotOutlet2] });
  tokens.pos = await pair(ids.pos, t);
  tokens.d1 = await pair(ids.d1, t);
  tokens.d2 = await pair(ids.d2, t);
  tokens.dOutlet2 = await pair(ids.dOutlet2, t);
  const signIn = async (pin: string) => (await call<{ data: { session_token: string } }>("POST", "/v1/stations/sessions", { token: tokens.pos, body: { pin } })).body.data.session_token;
  tokens.server = await signIn("444444");
  tokens.manager = await signIn("222222");
  // Merchant B: a display station of its own.
  await must("POST", "/v1/display-destinations", B.admin.token, { id: ids.hotB, outlet_id: B.outletId, name: "B kitchen" });
  await must("POST", "/v1/stations", B.admin.token, { id: ids.dB, outlet_id: B.outletId, name: "B screen", kind: "display", display_destination_ids: [ids.hotB] });
  tokens.dB = await pair(ids.dB, B.admin.token);
  // A guest at table 12, a relay and an agent of merchant A.
  await must("POST", "/v1/channel-links", t, { channel: "scan_to_order", outlet_id: A.outletId, brand_id: A.brandId, menu_id: ids.menu, hold_orders: true });
  const qr = await must<{ data: { url: string } }>("POST", `/v1/tables/${ids.table}/qr/rotate`, t, {});
  tokens.guest = (await call<{ data: { guest_token: string } }>("POST", "/v1/guest/sessions", { body: { token: qr.data.url.split("/t/")[1], device_id: "device-kds-0001" }, idempotencyKey: null })).body.data.guest_token;
  await must("POST", "/v1/relays", t, { id: ids.relay, outlet_id: A.outletId, name: "Relay" });
  const rcode = await must<{ data: { code: string } }>("POST", `/v1/relays/${ids.relay}/pairing-code`, t, {});
  tokens.relay = (await call<{ data: { relay_token: string } }>("POST", "/v1/relays/pair", { body: { code: rcode.data.code }, idempotencyKey: null })).body.data.relay_token;
  const identity = await must<{ data: { credential: string } }>("POST", "/v1/agent-identities", t, { name: "Kitchen watcher", role: "manager", outlet_ids: [A.outletId], toolsets: ["kitchen", "pos.read"], risk_ceiling: "T1" });
  tokens.agent = (await call<{ data: { agent_token: string } }>("POST", "/v1/agent-sessions", { body: { credential: identity.data.credential, task_id: "kds" }, idempotencyKey: null })).body.data.agent_token;
  await startListener();
});
afterAll(async () => {
  await stopListener();
  await db.drop();
});

let first: { orderId: string; lineIds: string[]; warnings: string[] };
let hotTicket: Ticket;
let barTicket: Ticket;

describe("tickets from the fire", () => {
  it("one ticket per destination the routing reaches, beside unchanged print jobs: a display and a printer share a tag", async () => {
    first = await sendOrder([{ product_id: ids.laksa, quantity: 2, notes: "less spicy", seat_no: 1 }, { product_id: ids.kopi }, { product_id: ids.bread }], undefined, true);
    expect(first.warnings).toEqual([]);
    // The fire appends one event for both tickets, so the fire path gains one append however many displays it reaches.
    const created = (await ticketEvents(0)).filter((e) => e.type === "kitchen_ticket.created");
    expect(created).toHaveLength(1);
    expect((created[0]!.payload.tickets as unknown[]).length).toBe(2);
    const tickets = (await list(tokens.d1)).body.data.filter((x) => x.order_id === first.orderId);
    expect(tickets.map((x) => x.destination_id).sort()).toEqual([ids.hot, ids.bar].sort());
    hotTicket = tickets.find((x) => x.destination_id === ids.hot)!;
    barTicket = tickets.find((x) => x.destination_id === ids.bar)!;
    // Hot takes its tag and, as the default, the untagged bread; Bar takes only the bar tag.
    expect(hotTicket.lines.map((l) => [l.name, l.quantity])).toEqual([["LAKSA", 2], ["Bread", 1]]);
    expect(hotTicket.lines[0]).toMatchObject({ notes: "less spicy", seat_no: 1, voided_quantity: 0, order_line_id: first.lineIds[0] });
    expect(barTicket.lines.map((l) => l.name)).toEqual(["Kopi"]);
    expect(hotTicket).toMatchObject({ status: "new", changed: false, round_no: 1, table_name: "12" });
    // Printing is exactly what it was: laksa on Kitchen, kopi and bread on the default Pass printer.
    const jobs = (await must<{ data: { printer_id: string; text: string }[] }>("GET", `/v1/outlets/${A.outletId}/print-jobs?order_id=${first.orderId}`, A.admin.token)).data;
    expect(jobs.filter((j) => j.printer_id === ids.kitchenPrinter).map((j) => /LAKSA/.test(j.text))).toEqual([true]);
    expect(jobs.filter((j) => j.printer_id === ids.passPrinter)).toHaveLength(1);
  });

  it("a ticket keeps the table it was sent to when the order moves", async () => {
    const moved = await sendOrder([{ product_id: ids.bread }], undefined, false);
    const table2 = randomUUID();
    await must("POST", "/v1/tables", A.admin.token, { id: table2, outlet_id: A.outletId, area_id: ids.area, name: "14" });
    const dineIn = await must<{ data: { id: string } }>("POST", "/v1/orders", tokens.server, { order_id: randomUUID(), order_type: "dine_in", table_id: table2, pax: 2 });
    const sent = await sendOrder([{ product_id: ids.bread }], dineIn.data.id);
    const table3 = randomUUID();
    await must("POST", "/v1/tables", A.admin.token, { id: table3, outlet_id: A.outletId, area_id: ids.area, name: "15" });
    await must("POST", `/v1/orders/${sent.orderId}/move-table`, tokens.server, { table_id: table3 });
    const t = (await list(tokens.d2)).body.data.find((x) => x.order_id === sent.orderId)!;
    expect(t.table_name).toBe("14");
    for (const x of (await list(tokens.d2)).body.data.filter((y) => y.order_id === sent.orderId || y.order_id === moved.orderId)) await act(tokens.d2, x.id, "bump");
  });

  it("a second fire on the order makes a second ticket and leaves the first as it was", async () => {
    await sendOrder([{ product_id: ids.laksa }], first.orderId);
    const hot = (await list(tokens.d2)).body.data.filter((x) => x.order_id === first.orderId);
    expect(hot.map((x) => x.round_no)).toEqual([1, 2]);
    expect(hot[0]!.lines).toHaveLength(2);
    expect(hot[1]!.lines.map((l) => l.name)).toEqual(["LAKSA"]);
  });

  it("a void after the send strikes the voided quantity on the ticket and flags it changed", async () => {
    const after = await latestSeq();
    // Partial void: one of the two laksa.
    const v = await call("POST", `/v1/orders/${first.orderId}/lines/${first.lineIds[0]}/void`, { token: tokens.manager, body: { quantity: 1, reason_id: ids.reason } });
    expect(v.status, JSON.stringify(v.body)).toBe(200);
    let t = (await list(tokens.d1)).body.data.find((x) => x.id === hotTicket.id)!;
    expect(t.changed).toBe(true);
    expect(t.lines[0]).toMatchObject({ quantity: 2, voided_quantity: 1 });
    expect((await list(tokens.d1)).body.data.find((x) => x.id === barTicket.id)!.changed).toBe(false);
    // The rest of the line: now fully struck.
    await must("POST", `/v1/orders/${first.orderId}/lines/${first.lineIds[0]}/void`, tokens.manager, { reason_id: ids.reason });
    t = (await list(tokens.d1)).body.data.find((x) => x.id === hotTicket.id)!;
    expect(t.lines[0]).toMatchObject({ quantity: 2, voided_quantity: 2 });
    const evs = await ticketEvents(after);
    // One event per void, naming the tickets it changed: only Hot carries the laksa.
    expect(evs.map((e) => [e.type, (e.payload.tickets as { ticket_id: string }[]).map((x) => x.ticket_id)])).toEqual([["kitchen_ticket.changed", [hotTicket.id]], ["kitchen_ticket.changed", [hotTicket.id]]]);
    // The all-day count no longer asks for the struck laksa: one laksa from round 2, one bread, one kopi.
    const day = (await must<{ data: { name: string; quantity: number }[] }>("GET", `/v1/outlets/${A.outletId}/kitchen-tickets/all-day`, tokens.d1)).data;
    expect(Object.fromEntries(day.map((d) => [d.name, d.quantity]))).toEqual({ LAKSA: 1, Bread: 1, Kopi: 1 });
  });

  it("cancelling the order cancels its tickets; they stay on the display marked cancelled until bumped", async () => {
    const o = await must<{ data: { id: string } }>("POST", "/v1/orders", tokens.server, { order_id: randomUUID(), order_type: "takeaway", takeaway_ref: "Bag 4" });
    const sent = await sendOrder([{ product_id: ids.laksa }], o.data.id);
    await must("POST", `/v1/orders/${o.data.id}/lines/${sent.lineIds[0]}/void`, tokens.manager, { reason_id: ids.reason });
    const after = await latestSeq();
    await must("POST", `/v1/orders/${o.data.id}/cancel`, tokens.manager, { reason: "Guest left" });
    const t = (await list(tokens.d1)).body.data.find((x) => x.order_id === o.data.id)!;
    expect(t.status).toBe("cancelled");
    expect((await ticketEvents(after)).map((e) => e.type)).toEqual(["kitchen_ticket.cancelled"]);
    // Bumping a cancelled ticket only clears it from the display; it stays cancelled and cannot be recalled.
    const bumped = await act(tokens.d1, t.id, "bump");
    expect(bumped.body.data).toMatchObject({ status: "cancelled" });
    expect((await list(tokens.d1)).body.data.some((x) => x.id === t.id)).toBe(false);
    expect((await act(tokens.d1, t.id, "recall")).status).toBe(409);
  });
});

describe("start, bump and recall", () => {
  it("start moves a new ticket in progress once; a repeat is a no-op without an event", async () => {
    const after = await latestSeq();
    const s1 = await act(tokens.d1, barTicket.id, "start");
    expect(s1.status).toBe(200);
    expect(s1.body.data.status).toBe("in_progress");
    const s2 = await act(tokens.d1, barTicket.id, "start");
    expect(s2.status).toBe(200);
    expect(s2.body.events).toEqual([]);
    expect((await ticketEvents(after)).map((e) => e.type)).toEqual(["kitchen_ticket.started"]);
  });

  it("two displays showing the same destination bump the same ticket at once: it is bumped exactly once", async () => {
    const after = await latestSeq();
    const [a, b, c] = await Promise.all([act(tokens.d1, hotTicket.id, "bump"), act(tokens.d2, hotTicket.id, "bump"), act(tokens.d1, hotTicket.id, "bump")]);
    expect([a.status, b.status, c.status]).toEqual([200, 200, 200]);
    expect([a, b, c].map((r) => r.body.data.status)).toEqual(["ready", "ready", "ready"]);
    expect([a, b, c].flatMap((r) => r.body.events.map((e) => e.type))).toEqual(["kitchen_ticket.bumped"]);
    expect((await ticketEvents(after)).map((e) => e.type)).toEqual(["kitchen_ticket.bumped"]);
    const l = (await list(tokens.d2)).body;
    expect(l.data.some((x) => x.id === hotTicket.id)).toBe(false);
    expect(l.last_bumped?.id).toBe(hotTicket.id);
    // A ready ticket cannot be started.
    expect((await act(tokens.d1, hotTicket.id, "start")).status).toBe(409);
  });

  it("the same tap retried with its idempotency key replays the stored answer", async () => {
    const key = randomUUID();
    const r1 = await act(tokens.d1, barTicket.id, "bump", key);
    const r2 = await act(tokens.d1, barTicket.id, "bump", key);
    expect(r1.body.events.map((e) => e.type)).toEqual(["kitchen_ticket.bumped"]);
    expect(r2.headers.get("idempotent-replayed")).toBe("true");
    expect(r2.body).toEqual(r1.body);
  });

  it("recall puts a bumped ticket back once, even when both displays recall it together", async () => {
    const after = await latestSeq();
    const [a, b] = await Promise.all([act(tokens.d1, hotTicket.id, "recall"), act(tokens.d2, hotTicket.id, "recall")]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(a.body.data.status).toBe("recalled");
    expect((await ticketEvents(after)).map((e) => e.type)).toEqual(["kitchen_ticket.recalled"]);
    const back = (await list(tokens.d1)).body.data.find((x) => x.id === hotTicket.id)!;
    expect(back).toMatchObject({ status: "recalled", bumped_at: null, changed: true });
    // A recalled ticket starts and bumps again like a new one.
    expect((await act(tokens.d1, hotTicket.id, "start")).body.data.status).toBe("in_progress");
    expect((await act(tokens.d1, hotTicket.id, "bump")).body.data.status).toBe("ready");
  });

  it("only the last ticket bumped at a destination can be recalled; recalling again walks back one at a time", async () => {
    const a = await sendOrder([{ product_id: ids.bread }]);
    const b = await sendOrder([{ product_id: ids.bread }]);
    const open = (await list(tokens.d2)).body.data;
    const ta = open.find((x) => x.order_id === a.orderId)!;
    const tb = open.find((x) => x.order_id === b.orderId)!;
    await act(tokens.d2, ta.id, "bump");
    await act(tokens.d2, tb.id, "bump");
    expect((await list(tokens.d2)).body.last_bumped?.id).toBe(tb.id);
    const early = await act(tokens.d2, ta.id, "recall");
    expect(early.status).toBe(409);
    expect((await act(tokens.d2, tb.id, "recall")).body.data.status).toBe("recalled");
    expect((await act(tokens.d2, ta.id, "recall")).body.data.status).toBe("recalled");
    await act(tokens.d2, ta.id, "bump");
    await act(tokens.d2, tb.id, "bump");
  });

  it("the POS reads every ticket of an order, so it can show a line ready when its tickets are bumped", async () => {
    const r = await list(tokens.server, `?order_id=${first.orderId}`);
    expect(r.status).toBe(200);
    const kopiTickets = r.body.data.filter((x) => x.lines.some((l) => l.order_line_id === first.lineIds[1]));
    expect(kopiTickets.map((x) => x.status)).toEqual(["ready"]);
  });
});

describe("who may see and bump", () => {
  it("a display sees only its destinations; another outlet's or merchant's display sees nothing of this outlet", async () => {
    // The wok screen shows Hot only, so the bar ticket is not there and cannot be bumped from it.
    const fresh = await sendOrder([{ product_id: ids.kopi }]);
    const bar = (await list(tokens.d1)).body.data.find((x) => x.order_id === fresh.orderId)!;
    expect((await list(tokens.d2)).body.data.some((x) => x.id === bar.id)).toBe(false);
    expect((await act(tokens.d2, bar.id, "bump")).status).toBe(404);
    expect((await list(tokens.d2, `?destination_id=${ids.bar}`)).body.data).toEqual([]);
    // Outlet 2's display and merchant B's display: the outlet is not theirs, and neither is the ticket.
    expect((await list(tokens.dOutlet2)).status).toBe(404);
    expect((await act(tokens.dOutlet2, bar.id, "bump")).status).toBe(404);
    expect((await list(tokens.dB)).status).toBe(404);
    expect((await act(tokens.dB, bar.id, "bump")).status).toBe(404);
    expect((await call("GET", `/v1/outlets/${A.outletId}/kitchen-tickets/all-day`, { token: tokens.dB })).status).toBe(404);
    expect((await list(tokens.dB, "", B.outletId)).body.data).toEqual([]);
    // A POS station with nobody signed in is not a display.
    expect((await list(tokens.pos)).status).toBe(403);
    expect((await act(tokens.pos, bar.id, "bump")).status).toBe(403);
  });

  it("a guest or relay token can neither read nor bump, and their database roles cannot read the tables", async () => {
    const any = (await list(tokens.d1)).body.data[0]!;
    for (const tk of [tokens.guest, tokens.relay]) {
      expect((await list(tk)).status).toBe(403);
      expect((await call("GET", `/v1/outlets/${A.outletId}/kitchen-tickets/all-day`, { token: tk })).status).toBe(403);
      expect((await act(tk, any.id, "bump")).status).toBe(403);
    }
    for (const role of ["app_guest", "app_relay"]) {
      const denied = await db.sql
        .begin(async (tx) => {
          await tx`select set_config('app.current_merchant', ${A.merchantId}, true), set_config('app.current_outlets', ${A.outletId}, true)`;
          await tx.unsafe(`set local role ${role}`);
          await tx`select count(*) from kitchen_tickets`;
          return false;
        })
        .catch((e: { code?: string }) => e.code === "42501");
      expect(denied, role).toBe(true);
    }
  });

  it("an agent may list tickets and the all-day count but not start, bump or recall", async () => {
    const r = await list(tokens.agent);
    expect(r.status).toBe(200);
    expect(r.body.data.length).toBeGreaterThan(0);
    expect((await call("GET", `/v1/outlets/${A.outletId}/kitchen-tickets/all-day`, { token: tokens.agent })).status).toBe(200);
    for (const action of ["start", "bump", "recall"] as const) expect((await act(tokens.agent, r.body.data[0]!.id, action)).status).toBe(403);
    const tools = (await import("../mcp-tools.json", { with: { type: "json" } })).default as unknown as { tools: { name: string }[] } | { name: string }[];
    const names = (Array.isArray(tools) ? tools : tools.tools).map((x) => x.name);
    expect(names).toContain("kitchen_tickets_list");
    expect(names.some((n) => /kitchen_tickets_(start|bump|recall)/.test(n))).toBe(false);
  });

  it("staff signed in on a display station see only that display's destinations", async () => {
    const session = await call<{ data: { session_token: string } }>("POST", "/v1/stations/sessions", { token: tokens.d2, body: { pin: "444444" } });
    expect(session.status).toBe(201);
    const seen = (await list(session.body.data.session_token)).body.data;
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((x) => x.destination_id === ids.hot)).toBe(true);
  });

  it("a kitchen display cannot pair with a POS station's code, and the POS iPad stays paired", async () => {
    const code = await must<{ data: { code: string } }>("POST", `/v1/stations/${ids.pos}/pairing-code`, A.admin.token, {});
    const r = await call<{ code: string }>("POST", "/v1/stations/pair", { body: { code: code.data.code, device_label: "Wall screen", kind: "display" }, idempotencyKey: null });
    expect(r.status).toBe(400);
    expect((await call("GET", "/v1/merchant", { token: tokens.pos })).status).toBe(200);
  });

  it("a display station may only show destinations of its own outlet, and a POS station none", async () => {
    expect((await call("PATCH", `/v1/stations/${ids.d1}`, { token: A.admin.token, body: { display_destination_ids: [ids.hotOutlet2] } })).status).toBe(404);
    expect((await call("PATCH", `/v1/stations/${ids.pos}`, { token: A.admin.token, body: { display_destination_ids: [ids.hot] } })).status).toBe(400);
    expect((await call("PATCH", `/v1/stations/${ids.d1}`, { token: A.admin.token, body: { display_destination_ids: [ids.hotB] } })).status).toBe(404);
  });
});

describe("events", () => {
  it("every change appends an event; a display that was away catches up from events.list, and the stream signals it live", async () => {
    const before = await latestSeq();
    // Offline: a fire, a start and a bump happen while the display is disconnected.
    const sent = await sendOrder([{ product_id: ids.kopi }]);
    const t = (await list(tokens.d1)).body.data.find((x) => x.order_id === sent.orderId)!;
    await act(tokens.d1, t.id, "start");
    await act(tokens.d1, t.id, "bump");
    // On reconnect the display asks for everything after the last sequence it applied.
    const missed = await must<{ data: Ev[] }>("GET", `/v1/outlets/${A.outletId}/events?after=${before}`, tokens.d1);
    expect(missed.data.filter((e) => e.type.startsWith("kitchen_ticket.")).map((e) => e.type)).toEqual(["kitchen_ticket.created", "kitchen_ticket.started", "kitchen_ticket.bumped"]);
    expect(missed.data.find((e) => e.type === "kitchen_ticket.created")!.payload).toMatchObject({ order_id: sent.orderId, tickets: [{ ticket_id: t.id, destination_id: ids.bar }] });
    // Live: the display's stream says something changed when a ticket is recalled.
    const stream = await app.request(`/v1/outlets/${A.outletId}/stream`, { headers: { authorization: `Bearer ${tokens.d1}` } });
    expect(stream.status).toBe(200);
    const got = readSse(stream, 2, 5000);
    await new Promise((r) => setTimeout(r, 150));
    await act(tokens.d1, t.id, "recall");
    const evs = await got;
    expect(evs[0]!.event).toBe("hello");
    expect(evs[1]!.event).toBe("change");
  });
});

describe("merchants without a display", () => {
  it("firing prints as before and creates no tickets and no ticket events", async () => {
    const tb = B.admin.token;
    await must("POST", "/v1/products", tb, { id: ids.bLaksa, name: "Laksa", price: 1600, tags: ["kitchen"] });
    await must("POST", "/v1/menus", tb, { id: ids.bMenu, brand_id: B.brandId, name: "M", sections: [{ name: "All", items: [{ product_id: ids.bLaksa }] }] });
    await must("POST", "/v1/channel-links", tb, { id: ids.bLink, channel: "pos", outlet_id: B.outlet2Id, brand_id: B.brandId, menu_id: ids.bMenu });
    await must("POST", "/v1/printers", tb, { id: ids.bPrinter, outlet_id: B.outlet2Id, name: "Kitchen", ip: "10.0.1.1", is_default_kitchen: true });
    const o = await must<{ data: { id: string } }>("POST", "/v1/orders", tb, { order_id: randomUUID(), order_type: "takeaway", takeaway_ref: "Bag 9", outlet_id: B.outlet2Id, brand_id: B.brandId });
    await must("POST", `/v1/orders/${o.data.id}/lines`, tb, { lines: [{ line_id: randomUUID(), product_id: ids.bLaksa, quantity: 1 }] });
    const fired = await must<{ warnings: string[]; events: { type: string }[] }>("POST", `/v1/orders/${o.data.id}/fire`, tb, {});
    expect(fired.warnings).toEqual([]);
    const jobs = (await must<{ data: { printer_id: string }[] }>("GET", `/v1/outlets/${B.outlet2Id}/print-jobs?order_id=${o.data.id}`, tb)).data;
    expect(jobs.map((j) => j.printer_id)).toEqual([ids.bPrinter]);
    const [n] = await db.sql<{ n: number }[]>`select count(*)::int as n from kitchen_tickets where order_id = ${o.data.id}`;
    expect(n!.n).toBe(0);
    const evs = await must<{ data: Ev[] }>("GET", `/v1/outlets/${B.outlet2Id}/events?after=0`, tb);
    expect(evs.data.some((e) => e.type.startsWith("kitchen_ticket."))).toBe(false);
  });
});

describe("settings", () => {
  it("the elapsed-time thresholds default to 8 and 15 minutes and must rise", async () => {
    const m = await must<{ data: { settings: { kitchen_warn_minutes: number; kitchen_late_minutes: number } } }>("GET", "/v1/merchant", tokens.d1);
    expect(m.data.settings).toMatchObject({ kitchen_warn_minutes: 8, kitchen_late_minutes: 15 });
    expect((await call("PATCH", "/v1/merchant/settings", { token: A.admin.token, body: { kitchen_warn_minutes: 20 } })).status).toBe(400);
    const ok = await call<{ data: { settings: { kitchen_warn_minutes: number; kitchen_late_minutes: number } } }>("PATCH", "/v1/merchant/settings", { token: A.admin.token, body: { kitchen_warn_minutes: 5, kitchen_late_minutes: 10 } });
    expect(ok.body.data.settings).toMatchObject({ kitchen_warn_minutes: 5, kitchen_late_minutes: 10 });
  });
});
