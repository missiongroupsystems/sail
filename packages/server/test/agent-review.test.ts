// Agent and MCP safety: each describe block holds the repro of one finding from the agent-safety review, asserting
// the behaviour the register must have.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bootWorld, type Call, type World } from "./world.js";
import type { TestDb } from "./helpers.js";

let db: TestDb;
let call: Call;
let w: World;

type Snap = { id: string; version: number; status: string; totals: { total: number }; lines: { id: string; status: string }[]; checks: { id: string }[]; balance: number };

async function identity(body: Record<string, unknown>) {
  const r = await call<{ data: { id: string; credential: string } }>("POST", "/v1/agent-identities", { token: w.m.admin.token, body: { name: `a-${randomUUID().slice(0, 6)}`, ...body } });
  if (r.status !== 201) throw new Error(JSON.stringify(r.body));
  return r.body.data;
}
async function session(credential: string, extra: Record<string, unknown> = {}) {
  const r = await call<{ data: { agent_token: string } }>("POST", "/v1/agent-sessions", { body: { credential, ...extra }, idempotencyKey: null });
  if (r.status !== 201) throw new Error(JSON.stringify(r.body));
  return r.body.data.agent_token;
}
const delegate = async (token: string, identityId: string) => {
  const r = await call<{ data: { grant: string } }>("POST", `/v1/agent-identities/${identityId}/delegations`, { token, body: {} });
  if (r.status !== 201) throw new Error(JSON.stringify(r.body));
  return r.body.data.grant;
};
const openTakeaway = (token: string) => call<{ data: Snap }>("POST", "/v1/orders", { token, body: { order_id: randomUUID(), order_type: "takeaway", takeaway_ref: "R", outlet_id: w.m.outletId, brand_id: w.m.brandId } });
const addLine = (token: string, orderId: string, line: Record<string, unknown>) => call<{ data: Snap; code?: string }>("POST", `/v1/orders/${orderId}/lines`, { token, body: { lines: [{ line_id: randomUUID(), quantity: 1, ...line }] } });

beforeAll(async () => {
  ({ db, call, w } = await bootWorld());
}, 120_000);
afterAll(async () => db.drop());

describe("A1: approval comes only from a person's own session, never from the agent's runner", () => {
  it("on_behalf_of refuses a person's bearer token; a delegation grant works once; that person cannot approve the agent's proposal", async () => {
    const id = await identity({ role: "manager", toolsets: ["pos.order"], risk_ceiling: "T2" });
    await expect(session(id.credential, { on_behalf_of: w.pins.manager })).rejects.toThrow(/validation/);
    const grant = await delegate(w.pins.manager, id.id);
    const tok = await session(id.credential, { on_behalf_of: grant });
    await expect(session(id.credential, { on_behalf_of: grant })).rejects.toThrow(/validation/);
    const [stored] = await db.sql<{ n: number }[]>`select count(*)::int as n from agent_delegations where grant_hash = ${grant.split(".")[1]!}`;
    expect(stored!.n).toBe(0); // only a hash is stored

    const o = await openTakeaway(tok);
    await addLine(tok, o.body.data.id, { product_id: w.ids.kopi });
    const p = await call<{ data: { id: string } }>("POST", `/v1/orders/${o.body.data.id}/fire`, { token: tok, body: {} });
    expect(p.status).toBe(202);
    const byPerson = await call<{ code: string }>("POST", `/v1/proposals/${p.body.data.id}/approve`, { token: w.pins.manager, body: {} });
    expect(byPerson.status).toBe(403);
    const byAgent = await call("POST", `/v1/proposals/${p.body.data.id}/approve`, { token: tok, body: {} });
    expect(byAgent.status).toBe(403);
    const byOther = await call<{ data: { status: string } }>("POST", `/v1/proposals/${p.body.data.id}/approve`, { token: w.pins.admin, body: {} });
    expect(byOther.status).toBe(200);
    expect(byOther.body.data.status).not.toBe("pending");
  });
});

describe("A13: an on_behalf_of session ends with the person's session", () => {
  it("the agent stops acting for a person once they sign out", async () => {
    const pin = (await call<{ data: { session_token: string } }>("POST", "/v1/stations/sessions", { token: w.stationToken, body: { pin: "333333" } })).body.data.session_token;
    const id = await identity({ role: "manager", toolsets: ["pos.order"], risk_ceiling: "T1" });
    const tok = await session(id.credential, { on_behalf_of: await delegate(pin, id.id) });
    expect((await openTakeaway(tok)).status).toBe(201);
    expect((await call("POST", "/v1/stations/sessions/end", { token: pin, body: {} })).status).toBeLessThan(300);
    expect((await openTakeaway(tok)).status).toBe(401);
  });
});

describe("A3: toolsets and MCP exposure are enforced by the API", () => {
  it("a reports-only identity cannot edit orders or stock over plain HTTP, nor propose a configuration change MCP does not expose", async () => {
    const id = await identity({ role: "admin", toolsets: ["reports"], risk_ceiling: "T1" });
    const tok = await session(id.credential);
    expect((await openTakeaway(tok)).status).toBe(403);
    expect((await call("POST", "/v1/stock/sold-out", { token: tok, body: { outlet_id: w.m.outletId, product_id: w.ids.kopi, until: "today" } })).status).toBe(403);
    expect((await call("GET", `/v1/reports/sales-summary?outlet_id=${w.m.outletId}`, { token: tok })).status).toBe(200);
    expect((await call("GET", "/v1/me", { token: tok })).status).toBe(200);
    const all = await identity({ role: "admin", toolsets: ["pos.read", "pos.order", "pos.payment", "pos.refund", "kitchen", "guest", "config.author", "reports", "watch"], risk_ceiling: "T1" });
    const atok = await session(all.credential);
    const before = (await db.sql<{ n: number }[]>`select count(*)::int as n from proposals`)[0]!.n;
    expect((await call("PATCH", `/v1/products/${w.ids.wine}`, { token: atok, body: { price: 1 } })).status).toBe(403);
    expect((await call("PATCH", `/v1/staff/${w.m.admin.id}`, { token: atok, body: { pin: "135790" } })).status).toBe(403);
    expect((await db.sql<{ n: number }[]>`select count(*)::int as n from proposals`)[0]!.n).toBe(before);
  });
});

describe("A9: an override header means nothing for an agent", () => {
  it("a server-role agent is refused a Manager operation with or without x-override-id", async () => {
    const id = await identity({ role: "server", toolsets: ["pos.order", "pos.refund"], risk_ceiling: "T1" });
    const tok = await session(id.credential);
    const o = await openTakeaway(w.pins.manager);
    expect((await call("POST", `/v1/orders/${o.body.data.id}/reopen`, { token: tok, body: { reason: "x" } })).status).toBe(403);
    expect((await call("POST", `/v1/orders/${o.body.data.id}/reopen`, { token: tok, body: { reason: "x" }, headers: { "x-override-id": "anything" } })).status).toBe(403);
  });
});

describe("A4: operation and proposal budgets hold under failures, concurrency and new sessions", () => {
  it("failed calls count, concurrent calls cannot overshoot, and a new session does not reset the hour's budget", async () => {
    const id = await identity({ role: "cashier", toolsets: ["pos.read"], risk_ceiling: "T1", max_ops_per_hour: 5 });
    const tok = await session(id.credential);
    for (let i = 0; i < 3; i++) expect((await call("GET", `/v1/orders/${randomUUID()}`, { token: tok })).status).toBe(404);
    const rs = await Promise.all(Array.from({ length: 10 }, () => call("GET", `/v1/outlets/${w.m.outletId}/floor`, { token: tok })));
    expect(rs.filter((r) => r.status === 200).length).toBe(2);
    expect(rs.filter((r) => r.status === 429).length).toBe(8);
    const tok2 = await session(id.credential);
    expect((await call("GET", `/v1/outlets/${w.m.outletId}/floor`, { token: tok2 })).status).toBe(429);
  });

  it("max_proposals_per_day holds when proposals arrive at once", async () => {
    const id = await identity({ role: "cashier", toolsets: ["pos.order"], risk_ceiling: "T1", max_proposals_per_day: 1 });
    const tok = await session(id.credential);
    const orders: string[] = [];
    for (let i = 0; i < 6; i++) {
      const o = await openTakeaway(w.pins.cashier);
      await addLine(w.pins.cashier, o.body.data.id, { product_id: w.ids.kopi });
      orders.push(o.body.data.id);
    }
    const rs = await Promise.all(orders.map((oid) => call("POST", `/v1/orders/${oid}/fire`, { token: tok, body: {} })));
    expect(rs.filter((r) => r.status === 202).length).toBe(1);
    const [n] = await db.sql<{ n: number }[]>`select count(*)::int as n from proposals where agent_identity_id = ${id.id}`;
    expect(n!.n).toBe(1);
    const tok2 = await session(id.credential);
    expect((await call("POST", `/v1/orders/${orders[0]}/fire`, { token: tok2, body: {} })).status).toBe(429);
  });
});

describe("A2: an agent call that lowers the amount due, or changes tax or fees, is a proposal showing before and after", () => {
  type Proposal = { id: string; status: string; effect: { reason: string; before: { total: number } | null; after: { total: number } } | null };
  const agentFor = async (role: string) => session((await identity({ role, toolsets: ["pos.order", "pos.read"], risk_ceiling: "T1" })).credential);
  const totalOf = async (orderId: string) => (await call<{ data: Snap }>("GET", `/v1/orders/${orderId}`, { token: w.pins.manager })).body.data.totals.total;

  it("attaching a customer in a discount group (the R1.2 comp) proposes instead of comping", async () => {
    const group = await call<{ data: { id: string } }>("POST", "/v1/customer-groups", { token: w.m.manager.token, body: { name: "Friends" } });
    await call("POST", "/v1/pricing-rules", { token: w.m.admin.token, body: { rule_key: "promo:friends", body: { kind: "discount", name: "Friends 100%", calc: "percent", value: { type: "fixed", amount: 10000 }, scope: { type: "all" }, conditions: { customer_group_ids: [group.body.data.id] }, priority: 30, application: "auto", report_class: "promo" }, effective_from: "2026-01-01T00:00:00Z" } });
    const vip = await call<{ data: { id: string } }>("PUT", "/v1/customers", { token: w.pins.manager, body: { name: "Friend", mobile: "+6500007777", group_ids: [group.body.data.id] } });
    const tok = await agentFor("server");
    const o = await openTakeaway(tok);
    const a = await addLine(tok, o.body.data.id, { product_id: w.ids.wine });
    expect(a.status).toBe(200);
    const att = await call<{ code: string; data: Proposal }>("POST", `/v1/orders/${o.body.data.id}/customer`, { token: tok, body: { customer_id: vip.body.data.id } });
    expect(att.status, JSON.stringify(att.body)).toBe(202);
    expect(att.body.code).toBe("requires_confirmation");
    expect(att.body.data.effect).toMatchObject({ before: { total: a.body.data.totals.total }, after: { total: 0 } });
    expect(await totalOf(o.body.data.id)).toBe(a.body.data.totals.total);
    // Opening an order with that customer has no "before" to compare with, so it is a proposal too.
    const open = await call<{ code: string }>("POST", "/v1/orders", { token: tok, body: { order_id: randomUUID(), order_type: "takeaway", takeaway_ref: "C", outlet_id: w.m.outletId, brand_id: w.m.brandId, customer_id: vip.body.data.id } });
    expect(open.status).toBe(202);
    // Opening one with the customer's number would link the customer too; an agent cannot read mobiles, so it is refused.
    const byMobile = await call<{ code: string }>("POST", "/v1/orders", { token: tok, body: { order_id: randomUUID(), order_type: "takeaway", outlet_id: w.m.outletId, brand_id: w.m.brandId, customer_ref: { name: "F", mobile: "+6500007777" } } });
    expect(byMobile.status, JSON.stringify(byMobile.body)).toBe(403);
    // Attaching the customer to an order with nothing on it yet moves no money today, but every later line would be discounted.
    const empty = await openTakeaway(tok);
    expect((await call("POST", `/v1/orders/${empty.body.data.id}/customer`, { token: tok, body: { customer_id: vip.body.data.id } })).status).toBe(202);
    // A person approves it and it runs as them.
    const ap = await call<{ data: { status: string } }>("POST", `/v1/proposals/${att.body.data.id}/approve`, { token: w.pins.manager, body: {} });
    expect(ap.body.data.status).toBe("approved");
    expect(await totalOf(o.body.data.id)).toBe(0);
  });

  it("an open price set by an agent (the R1.3 1-cent price) is a proposal, whatever the agent's role", async () => {
    const tok = await agentFor("manager");
    const o = await openTakeaway(tok);
    const a = await addLine(tok, o.body.data.id, { product_id: w.ids.openItem, open_price: 1 });
    expect(a.status, JSON.stringify(a.body)).toBe(202);
    expect(await totalOf(o.body.data.id)).toBe(0);
  });

  it("changing dine-in to takeaway (the R1.4 dropped service charge) and changing the guest count are proposals when fees or the total move", async () => {
    const areaId = randomUUID();
    const tableId = randomUUID();
    await call("POST", "/v1/areas", { token: w.m.admin.token, body: { id: areaId, outlet_id: w.m.outletId, name: "Main" } });
    await call("POST", "/v1/tables", { token: w.m.admin.token, body: { id: tableId, outlet_id: w.m.outletId, area_id: areaId, name: "T1" } });
    const tok = await agentFor("server");
    const o = await call<{ data: Snap }>("POST", "/v1/orders", { token: w.pins.server, body: { order_id: randomUUID(), order_type: "dine_in", table_id: tableId, pax: 2, outlet_id: w.m.outletId, brand_id: w.m.brandId } });
    const a = await addLine(w.pins.server, o.body.data.id, { product_id: w.ids.wine });
    const ct = await call<{ data: Proposal }>("POST", `/v1/orders/${o.body.data.id}/change-type`, { token: tok, body: { order_type: "takeaway" } });
    expect(ct.status, JSON.stringify(ct.body)).toBe(202);
    expect(ct.body.data.effect!.after.total).toBeLessThan(a.body.data.totals.total);
    expect(await totalOf(o.body.data.id)).toBe(a.body.data.totals.total);
    // Routine edits that raise the amount due still run.
    expect((await addLine(tok, o.body.data.id, { product_id: w.ids.kopi })).status).toBe(200);
    // Removing an unsent line lowers what the guest owes, so an agent proposes it.
    const s = (await call<{ data: Snap }>("GET", `/v1/orders/${o.body.data.id}`, { token: tok })).body.data;
    const v = await call("POST", `/v1/orders/${o.body.data.id}/lines/${s.lines.at(-1)!.id}/void`, { token: tok, body: { reason_text: "guest changed mind" } });
    expect(v.status, JSON.stringify(v.body)).toBe(202);
  });
});

describe("A2: the money-effect rule itself", () => {
  const m = (total: number, extra: Partial<Record<"subtotal" | "discount_total" | "fee_total" | "tax_total", number>> & { customer_id?: string | null; order_type?: string; pax?: number | null } = {}) => ({ subtotal: 1000, discount_total: 0, fee_total: 100, tax_total: 99, total, customer_id: null, order_type: "dine_in", pax: 2, ...extra });
  it("flags a lower amount due, a tax or fee change with the same lines, an open price and an order opened for a customer; lets ordinary growth through", async () => {
    const { moneyEffect } = await import("../src/services/agents.js");
    expect(moneyEffect(m(1199), m(1100, { fee_total: 0 }), {})).toBe("lowers the amount due");
    expect(moneyEffect(m(1199), m(1299, { fee_total: 200 }), { pax: 4 })).toBe("changes tax, fees or discounts"); // a per-guest fee raised by a guest count
    expect(moneyEffect(m(1199), m(1199, { tax_total: 0, fee_total: 199 }), {})).toBe("changes tax, fees or discounts");
    expect(moneyEffect(m(1199), m(2398, { subtotal: 2000, fee_total: 200, tax_total: 198 }), {})).toBeNull(); // a line added
    expect(moneyEffect(m(0), m(1), { lines: [{ open_price: 1 }] })).toBe("sets an open price");
    const customer = randomUUID();
    expect(moneyEffect(null, m(0, { subtotal: 0, customer_id: customer }), {})).toMatch(/customer/); // opened for a customer, by id or by mobile
    expect(moneyEffect(m(0, { subtotal: 0 }), m(0, { subtotal: 0, customer_id: customer }), {})).toMatch(/customer/); // attached to an empty order
    expect(moneyEffect(m(1199, { customer_id: customer }), m(2398, { subtotal: 2000, fee_total: 200, tax_total: 198, customer_id: customer }), {})).toBeNull(); // lines added for an approved customer
    expect(moneyEffect(null, m(0, { subtotal: 0 }), {})).toBeNull();
    // The order's terms, judged even on an empty order where no total moves yet.
    expect(moneyEffect(m(0, { subtotal: 0 }), m(0, { subtotal: 0, order_type: "takeaway" }), {})).toMatch(/order type/);
    expect(moneyEffect(m(0, { subtotal: 0 }), m(0, { subtotal: 0, pax: 6 }), {})).toMatch(/guest count/);
  });
});

describe("A11: proposals outside an order are pinned to the state the approver saw", () => {
  it("a shifts.close proposal fails once more cash lands on the shift, and the shift stays open", async () => {
    const shift = await call<{ data: { id: string } }>("POST", "/v1/shifts", { token: w.pins.cashierStation2, body: { outlet_id: w.m.outletId, float_cents: 0 } });
    expect(shift.status, JSON.stringify(shift.body)).toBe(201);
    const tok = await session((await identity({ role: "cashier", toolsets: ["pos.payment"], risk_ceiling: "T1" })).credential);
    const p = await call<{ data: { id: string; outlet_id: string | null } }>("POST", `/v1/shifts/${shift.body.data.id}/close`, { token: tok, body: { counted_cash_cents: 0, variance_reason: "counted" } });
    expect(p.status, JSON.stringify(p.body)).toBe(202);
    expect(p.body.data.outlet_id).toBe(w.m.outletId); // A10: staff at the outlet see it
    const o = await openTakeaway(w.pins.cashierStation2);
    const a = await addLine(w.pins.cashierStation2, o.body.data.id, { product_id: w.ids.wine });
    const pay = await call("POST", `/v1/checks/${a.body.data.checks[0]!.id}/payments`, { token: w.pins.cashierStation2, body: { payment_id: randomUUID(), tender_type_id: w.ids.cash, amount: a.body.data.balance, tendered: a.body.data.balance } });
    expect(pay.status, JSON.stringify(pay.body)).toBe(200);
    const ap = await call<{ data: { status: string; result: { body: { code: string } } } }>("POST", `/v1/proposals/${p.body.data.id}/approve`, { token: w.pins.manager, body: {} });
    expect(ap.body.data.status).toBe("failed");
    expect(ap.body.data.result.body.code).toBe("version_conflict");
    const [s] = await db.sql<{ status: string }[]>`select status from shifts where id = ${shift.body.data.id}`;
    expect(s!.status).toBe("open");
  });
});

describe("A12: the kill switch also withdraws the agent's pending proposals", () => {
  it("disabling an identity rejects its pending proposals, so nobody can approve them later", async () => {
    const id = await identity({ role: "cashier", toolsets: ["pos.order"], risk_ceiling: "T1" });
    const tok = await session(id.credential);
    const o = await openTakeaway(w.pins.cashier);
    await addLine(w.pins.cashier, o.body.data.id, { product_id: w.ids.kopi });
    const p = await call<{ data: { id: string } }>("POST", `/v1/orders/${o.body.data.id}/fire`, { token: tok, body: {} });
    expect(p.status).toBe(202);
    expect((await call("PATCH", `/v1/agent-identities/${id.id}`, { token: w.m.admin.token, body: { enabled: false } })).status).toBe(200);
    const got = await call<{ data: { status: string } }>("GET", `/v1/proposals/${p.body.data.id}`, { token: w.pins.manager });
    expect(got.body.data.status).toBe("rejected");
    expect((await call("POST", `/v1/proposals/${p.body.data.id}/approve`, { token: w.pins.manager, body: {} })).status).toBe(409);
  });
});

describe("A10: a proposal with no outlet still reaches the people who can approve it", () => {
  it("a configuration proposal by a person with a risk ceiling is listed at every outlet", async () => {
    await db.sql`update staff set risk_ceiling = 'T1' where id = ${w.m.admin.id}`;
    try {
      const p = await call<{ data: { id: string; outlet_id: string | null } }>("PATCH", `/v1/products/${w.ids.wine}`, { token: w.m.admin.token, body: { price: 1 } });
      expect(p.status).toBe(202);
      expect(p.body.data.outlet_id).toBeNull();
      const list = await call<{ data: { id: string }[] }>("GET", `/v1/outlets/${w.m.outletId}/proposals?status=pending`, { token: w.pins.manager });
      expect(list.body.data.some((x) => x.id === p.body.data.id)).toBe(true);
    } finally {
      await db.sql`update staff set risk_ceiling = null where id = ${w.m.admin.id}`;
    }
  });
});

describe("operations whose tier was too low", () => {
  const spec = async (path: string, method: string) => ((await (await (await import("../src/app.js")).buildApp().request("/openapi.json")).json()) as { paths: Record<string, Record<string, { "x-sail": { tier: string } }>> }).paths[path]?.[method];

  it("closing a business day is T3, and the QR sheet that rotates every token is a POST", async () => {
    expect((await spec("/v1/outlets/{id}/business-days/close", "post"))!["x-sail"].tier).toBe("T3");
    expect(await spec("/v1/outlets/{id}/qr-sheet.pdf", "get")).toBeUndefined();
    expect((await spec("/v1/outlets/{id}/qr-sheet.pdf", "post"))!["x-sail"].tier).toBe("T3");
  });

  it("an agent marks at most 20 products sold out an hour, and acknowledges at most 60 table requests", async () => {
    const tok = await session((await identity({ role: "cashier", toolsets: ["kitchen"], risk_ceiling: "T1" })).credential);
    const statuses: number[] = [];
    for (let i = 0; i < 21; i++) statuses.push((await call("POST", "/v1/stock/sold-out", { token: tok, body: { outlet_id: w.m.outletId, product_id: w.ids.kopi, until: "today" } })).status);
    expect(statuses.slice(0, 20).every((s) => s === 200)).toBe(true);
    expect(statuses[20]).toBe(429);
    await call("POST", "/v1/stock/restore", { token: w.pins.manager, body: { outlet_id: w.m.outletId, product_id: w.ids.kopi } });
  });

  it("an agent cannot reprint a kitchen ticket (food cooked twice); a person can", async () => {
    const o = await openTakeaway(w.pins.server);
    await addLine(w.pins.server, o.body.data.id, { product_id: w.ids.laksa });
    expect((await call("POST", `/v1/orders/${o.body.data.id}/fire`, { token: w.pins.server, body: {} })).status).toBe(200);
    const jobs = await call<{ data: { id: string; kind: string }[] }>("GET", `/v1/outlets/${w.m.outletId}/print-jobs?order_id=${o.body.data.id}`, { token: w.pins.server });
    const kitchen = jobs.body.data.find((j) => j.kind === "kitchen")!;
    const tok = await session((await identity({ role: "server", toolsets: ["kitchen"], risk_ceiling: "T1" })).credential);
    expect((await call("POST", `/v1/print-jobs/${kitchen.id}/reprint`, { token: tok, body: {} })).status).toBe(403);
    expect((await call("POST", `/v1/print-jobs/${kitchen.id}/reprint`, { token: w.pins.server, body: {} })).status).toBe(201);
  });

  it("customers.upsert with group_ids is the same approval step as customer_groups.set_members for a person with a ceiling", async () => {
    const group = await call<{ data: { id: string } }>("POST", "/v1/customer-groups", { token: w.m.manager.token, body: { name: `G-${randomUUID().slice(0, 4)}` } });
    await db.sql`update staff set risk_ceiling = 'T1' where id = ${w.m.manager.id}`;
    try {
      expect((await call("PUT", "/v1/customers", { token: w.m.manager.token, body: { name: "Grouped", group_ids: [group.body.data.id] } })).status).toBe(403);
      expect((await call("PUT", "/v1/customers", { token: w.m.manager.token, body: { name: "Ungrouped" } })).status).toBe(200);
    } finally {
      await db.sql`update staff set risk_ceiling = null where id = ${w.m.manager.id}`;
    }
  });
});

describe("A5, A6: no proposal or idempotency record holds a secret", () => {
  type Doc = { paths: Record<string, Record<string, { operationId: string; requestBody?: { content?: Record<string, { schema?: S }> }; responses?: Record<string, { content?: Record<string, { schema?: S }> }> }>>; components?: { schemas?: Record<string, S> } };
  type S = Record<string, unknown>;

  it("every secret-looking field in a request or response is marked secret(), or is listed here with the reason it is not a secret", async () => {
    const NOT_SECRET: Record<string, string> = {
      has_pin: "a boolean",
      code_page_cjk: "a printer setting",
      logo_url: "a public image address",
      pdf_url: "a path the caller fetches with its own token",
      credential_rotated_at: "a timestamp",
      channel_link_id: "an id",
      "pricing_rules.validate code": "a validation issue code",
      "staff.access link": "the state of the open link, never its token",
      "staff.revoke_access link": "the state of the open link, never its token",
      "receipts.read token": "a path parameter, compared with the stored hash",
    };
    const doc = (await (await (await import("../src/app.js")).buildApp().request("/openapi.json")).json()) as Doc;
    const deref = (s: S | undefined): S | undefined => (s && typeof s.$ref === "string" ? deref(doc.components!.schemas![s.$ref.split("/").pop()!]) : s);
    const LOOKS_SECRET = /(^|_)(pin|password|secret|credential|token|code|grant|link|url)($|_)/;
    const unmarked: string[] = [];
    const walk = (raw: S | undefined, op: string, marked: boolean, depth = 0) => {
      const s = deref(raw);
      if (!s || depth > 30) return;
      const m = marked || s["x-sail-secret"] === true;
      for (const k of ["anyOf", "oneOf", "allOf"]) for (const x of (s[k] as S[] | undefined) ?? []) walk(x, op, m, depth + 1);
      if (s.items) walk(s.items as S, op, m, depth + 1);
      for (const [k, v] of Object.entries((s.properties as Record<string, S> | undefined) ?? {})) {
        const vs = deref(v)!;
        const isMarked = m || vs["x-sail-secret"] === true || ((vs.anyOf ?? vs.oneOf) as S[] | undefined)?.some((x) => deref(x)?.["x-sail-secret"] === true);
        if (LOOKS_SECRET.test(k) && !isMarked && !(k in NOT_SECRET) && !(`${op} ${k}` in NOT_SECRET)) unmarked.push(`${op} ${k}`);
        walk(v, op, m, depth + 1);
      }
    };
    for (const methods of Object.values(doc.paths))
      for (const o of Object.values(methods)) {
        for (const c of Object.values(o.requestBody?.content ?? {})) walk(c.schema, o.operationId, false);
        for (const [st, r] of Object.entries(o.responses ?? {})) if (st.startsWith("2")) for (const c of Object.values(r.content ?? {})) walk(c.schema, o.operationId, false);
      }
    expect(unmarked, "mark these with secret() in their route, or list them in NOT_SECRET with a reason").toEqual([]);
  });

  it("a staff.update carrying a PIN (the R1.9 proposal) is refused, not stored, for anyone above their ceiling", async () => {
    await db.sql`update staff set risk_ceiling = 'T1' where id = ${w.m.admin.id}`;
    try {
      const before = (await db.sql<{ n: number }[]>`select count(*)::int as n from proposals`)[0]!.n;
      const r = await call<{ code: string }>("PATCH", `/v1/staff/${w.m.server.id}`, { token: w.m.admin.token, body: { pin: "135790" } });
      expect(r.status, JSON.stringify(r.body)).toBe(403);
      expect((await db.sql<{ n: number }[]>`select count(*)::int as n from proposals`)[0]!.n).toBe(before);
      // Without the PIN the same change is an ordinary proposal.
      expect((await call("PATCH", `/v1/staff/${w.m.server.id}`, { token: w.m.admin.token, body: { name: "Sam S" } })).status).toBe(202);
      const leaked = await db.sql`select id from proposals where body::text like '%135790%'`;
      expect(leaked).toEqual([]);
    } finally {
      await db.sql`update staff set risk_ceiling = null where id = ${w.m.admin.id}`;
    }
  });

  it("an agent credential, a delegation grant and a pairing code are shown once: a retry is refused and the database never holds them (R1.12)", async () => {
    const key = randomUUID();
    const body = { name: "replay-me", role: "server", toolsets: ["pos.read"] };
    const r1 = await call<{ data: { id: string; credential: string } }>("POST", "/v1/agent-identities", { token: w.m.admin.token, body, idempotencyKey: key });
    expect(r1.status).toBe(201);
    const r2 = await call<{ code: string }>("POST", "/v1/agent-identities", { token: w.m.admin.token, body, idempotencyKey: key });
    expect(r2.status).toBe(409);
    const grantKey = randomUUID();
    const g = await call<{ data: { grant: string } }>("POST", `/v1/agent-identities/${r1.body.data.id}/delegations`, { token: w.pins.manager, body: {}, idempotencyKey: grantKey });
    expect((await call("POST", `/v1/agent-identities/${r1.body.data.id}/delegations`, { token: w.pins.manager, body: {}, idempotencyKey: grantKey })).status).toBe(409);
    const code = await call<{ data: { code: string } }>("POST", `/v1/stations/${w.ids.station2}/pairing-code`, { token: w.m.admin.token, body: {} });
    const stored = (await db.sql<{ b: string }[]>`select coalesce(body::text, '') || request_hash as b from idempotency_keys`).map((r) => r.b).join("\n");
    for (const s of [r1.body.data.credential, r1.body.data.credential.split(".")[1]!, g.body.data.grant.split(".")[1]!, code.body.data.code]) expect(stored).not.toContain(s);
  });
});

describe("A7: brand scope is enforced, for agents and for staff", () => {
  it("an identity scoped to another brand cannot open or read this brand's orders, and disjoint scopes never widen to every brand", async () => {
    const b2 = randomUUID();
    expect((await call("POST", "/v1/brands", { token: w.m.admin.token, body: { id: b2, name: "Other brand" } })).status).toBe(201);
    const id = await identity({ role: "cashier", toolsets: ["pos.order", "pos.read"], risk_ceiling: "T1", brand_ids: [b2] });
    const tok = await session(id.credential);
    const refused = await openTakeaway(tok);
    expect([403, 404, 422], JSON.stringify(refused.body)).toContain(refused.status);
    expect(JSON.stringify(refused.body)).not.toContain("internal");
    const own = await openTakeaway(w.pins.cashier);
    expect((await call("GET", `/v1/orders/${own.body.data.id}`, { token: tok })).status).toBe(404);
    // A person scoped to brand B1 delegating to a B2 agent shares no brand: refused, not "all brands".
    await db.sql`update staff set brand_ids = ${db.sql.array([w.m.brandId])}::uuid[] where id = ${w.m.manager.id}`;
    try {
      const pin = (await call<{ data: { session_token: string } }>("POST", "/v1/stations/sessions", { token: w.stationToken, body: { pin: "222222" } })).body.data.session_token;
      await expect(session(id.credential, { on_behalf_of: await delegate(pin, id.id) })).rejects.toThrow(/share no brand/);
    } finally {
      await db.sql`update staff set brand_ids = '{}' where id = ${w.m.manager.id}`;
    }
  });

  it("a staff member scoped to another brand cannot open an order on this one", async () => {
    const b3 = randomUUID();
    await call("POST", "/v1/brands", { token: w.m.admin.token, body: { id: b3, name: "Third brand" } });
    await db.sql`update staff set brand_ids = ${db.sql.array([b3])}::uuid[] where id = ${w.m.server.id}`;
    try {
      const pin = (await call<{ data: { session_token: string } }>("POST", "/v1/stations/sessions", { token: w.station2Token, body: { pin: "444444" } })).body.data.session_token;
      expect([403, 404]).toContain((await openTakeaway(pin)).status);
    } finally {
      await db.sql`update staff set brand_ids = '{}' where id = ${w.m.server.id}`;
    }
  });
});

describe("A8: staff contact details never reach the audit log or events", () => {
  it("changing, inviting or creating staff with an email records that it changed, not the address (R5.1)", async () => {
    const addr = `sam.private.${randomUUID().slice(0, 6)}@example.com`;
    expect((await call("PATCH", `/v1/staff/${w.m.server.id}`, { token: w.m.admin.token, body: { email: addr } })).status).toBe(200);
    const created = await call<{ data: { id: string } }>("POST", "/v1/staff", { token: w.m.admin.token, body: { name: "New", role: "server", email: `new.${addr}` } });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const tok = await session((await identity({ role: "manager", toolsets: ["reports"], risk_ceiling: "T1" })).credential);
    const audit = await call("GET", "/v1/audit?limit=200", { token: tok });
    expect(audit.status).toBe(200);
    expect(JSON.stringify(audit.body)).not.toContain(addr);
    const stored = await db.sql`select id from events where payload::text like ${"%" + addr + "%"} union all select id from audit_log where details::text like ${"%" + addr + "%"}`;
    expect(stored).toEqual([]);
  });
});

describe("review follow-ups", () => {
  it("an agent cannot propose on an order outside its brand or outlet: the target is not found, and nothing is stored", async () => {
    const b2 = randomUUID();
    await call("POST", "/v1/brands", { token: w.m.admin.token, body: { id: b2, name: "Brand two" } });
    const tok = await session((await identity({ role: "manager", toolsets: ["pos.order"], risk_ceiling: "T1", brand_ids: [b2] })).credential);
    const o = await openTakeaway(w.pins.cashier);
    await addLine(w.pins.cashier, o.body.data.id, { product_id: w.ids.kopi });
    const before = (await db.sql<{ n: number }[]>`select count(*)::int as n from proposals`)[0]!.n;
    expect((await call("POST", `/v1/orders/${o.body.data.id}/fire`, { token: tok, body: {} })).status).toBe(404);
    expect((await call("POST", `/v1/orders/${o.body.data.id}/cancel`, { token: tok, body: { reason: "x" } })).status).toBe(404);
    expect((await db.sql<{ n: number }[]>`select count(*)::int as n from proposals`)[0]!.n).toBe(before);
  });

  it("changing an empty dine-in order to takeaway is a proposal, so the service charge cannot be dropped before the lines go on", async () => {
    const areaId = randomUUID();
    const tableId = randomUUID();
    await call("POST", "/v1/areas", { token: w.m.admin.token, body: { id: areaId, outlet_id: w.m.outletId, name: "Patio" } });
    await call("POST", "/v1/tables", { token: w.m.admin.token, body: { id: tableId, outlet_id: w.m.outletId, area_id: areaId, name: "P1" } });
    const tok = await session((await identity({ role: "server", toolsets: ["pos.order"], risk_ceiling: "T1" })).credential);
    const o = await call<{ data: Snap }>("POST", "/v1/orders", { token: w.pins.server, body: { order_id: randomUUID(), order_type: "dine_in", table_id: tableId, pax: 2, outlet_id: w.m.outletId, brand_id: w.m.brandId } });
    expect((await call("POST", `/v1/orders/${o.body.data.id}/change-type`, { token: tok, body: { order_type: "takeaway" } })).status).toBe(202);
    expect((await call("PATCH", `/v1/orders/${o.body.data.id}`, { token: tok, body: { pax: 8 } })).status).toBe(202);
  });

  it("the before figure is today's price: a discount that has ended cannot mask a removal", async () => {
    const tok = await session((await identity({ role: "server", toolsets: ["pos.order"], risk_ceiling: "T1" })).credential);
    const rule = await call("POST", "/v1/pricing-rules", { token: w.m.admin.token, body: { rule_key: "promo:window", body: { kind: "discount", name: "Window 20%", calc: "percent", value: { type: "fixed", amount: 2000 }, scope: { type: "all" }, priority: 40, application: "auto", report_class: "promo" }, effective_from: "2026-01-01T00:00:00Z" } });
    expect(rule.status, JSON.stringify(rule.body)).toBeLessThan(300);
    const o = await openTakeaway(w.pins.server);
    const a = await addLine(w.pins.server, o.body.data.id, { product_id: w.ids.wine });
    const s = (await addLine(w.pins.server, o.body.data.id, { product_id: w.ids.laksa })).body.data;
    // The discount ends (as a time window does) without anything repricing the order: its stored totals still carry it.
    await db.sql`update pricing_rules set archived_at = now() where rule_key = 'promo:window'`;
    const laksa = s.lines.find((l) => l.id !== a.body.data.lines[0]!.id)!;
    const v = await call("POST", `/v1/orders/${o.body.data.id}/lines/${laksa.id}/void`, { token: tok, body: { reason_text: "not wanted" } });
    expect(v.status, JSON.stringify(v.body)).toBe(202);
  });

});
