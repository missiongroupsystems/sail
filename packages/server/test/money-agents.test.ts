// Where the money fixes meet the agent-safety rules: the figures an approver is shown, the limits an agent's call is
// priced under, and what a brand-scoped agent reads in the reports.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bootWorld, orderHelpers, type Call, type Snap, type World } from "./world.js";
import type { TestDb } from "./helpers.js";

let db: TestDb;
let call: Call;
let w: World;
let h: ReturnType<typeof orderHelpers>;

type Money = { subtotal: number; discount_total: number; fee_total: number; tax_total: number; total: number };
type Proposal = { id: string; status: string; effect: { reason: string; before: Money | null; after: Money | null } | null; result: { status: number; body: { code: string; message: string; details: Record<string, unknown> } } | null };

const agent = async (body: Record<string, unknown> = {}) => {
  const id = await call<{ data: { credential: string } }>("POST", "/v1/agent-identities", { token: w.m.admin.token, body: { name: `a-${randomUUID().slice(0, 6)}`, role: "server", toolsets: ["pos.order", "pos.read", "reports"], risk_ceiling: "T1", ...body } });
  if (id.status !== 201) throw new Error(JSON.stringify(id.body));
  const s = await call<{ data: { agent_token: string } }>("POST", "/v1/agent-sessions", { body: { credential: id.body.data.credential }, idempotencyKey: null });
  return s.body.data.agent_token;
};
const snap = async (orderId: string) => (await call<{ data: Snap & { totals: Money } }>("GET", `/v1/orders/${orderId}`, { token: w.pins.manager })).body.data;
const approve = (id: string) => call<{ data: Proposal }>("POST", `/v1/proposals/${id}/approve`, { token: w.pins.manager, body: {} });
const voidLine = (token: string, orderId: string, lineId: string) => call<{ data: Proposal }>("POST", `/v1/orders/${orderId}/lines/${lineId}/void`, { token, body: { reason_text: "not wanted" } });
const money = (t: Money) => ({ subtotal: t.subtotal, discount_total: t.discount_total, fee_total: t.fee_total, tax_total: t.tax_total, total: t.total });

beforeAll(async () => {
  ({ db, call, w } = await bootWorld());
  h = orderHelpers(call, w);
}, 120_000);
afterAll(async () => db.drop());

describe("approval re-quotes the money effect the approver was shown", () => {
  it("a discount that starts between proposal and approval leaves the order's version alone, so approval refuses on the figures", async () => {
    const tok = await agent();
    const s = await h.orderWith(w.pins.server, [{ product_id: w.ids.laksa }, { product_id: w.ids.wine }]);
    const p = await voidLine(tok, s.id, s.lines[1]!.id);
    expect(p.status, JSON.stringify(p.body)).toBe(202);
    const shown = p.body.data.effect!;
    expect(shown.after!.total).toBeLessThan(shown.before!.total);
    // A happy-hour style rule starts. Nothing reprices the order, so its version is what the approver saw.
    const rule = await call("POST", "/v1/pricing-rules", { token: w.m.admin.token, body: { rule_key: "promo:late", body: { kind: "discount", name: "Late 10%", calc: "percent", value: { type: "fixed", amount: 1000 }, scope: { type: "all" }, priority: 40, application: "auto", report_class: "promo" }, effective_from: "2026-01-01T00:00:00Z" } });
    expect(rule.status, JSON.stringify(rule.body)).toBeLessThan(300);
    expect((await snap(s.id)).version).toBe(s.version);
    const ap = await approve(p.body.data.id);
    expect(ap.body.data.status).toBe("failed");
    expect(ap.body.data.result!.body.code).toBe("version_conflict");
    expect(ap.body.data.result!.body.message).toMatch(/amounts have changed/);
    expect(ap.body.data.result!.body.details).toMatchObject({ shown: { before: { total: shown.before!.total }, after: { total: shown.after!.total } } });
    // Nothing ran: the line is still on the order.
    expect((await snap(s.id)).lines.find((l) => l.id === s.lines[1]!.id)!.status).not.toBe("voided");
    await db.sql`update pricing_rules set archived_at = now() where rule_key = 'promo:late'`;
  });

  it("a customer who leaves a discount group between proposal and approval is refused the same way", async () => {
    const group = await call<{ data: { id: string } }>("POST", "/v1/customer-groups", { token: w.m.manager.token, body: { name: "Regulars" } });
    await call("POST", "/v1/pricing-rules", { token: w.m.admin.token, body: { rule_key: "promo:regulars", body: { kind: "discount", name: "Regulars 5%", calc: "percent", value: { type: "fixed", amount: 500 }, scope: { type: "all" }, conditions: { customer_group_ids: [group.body.data.id] }, priority: 30, application: "auto", report_class: "promo" }, effective_from: "2026-01-01T00:00:00Z" } });
    const cust = await call<{ data: { id: string } }>("PUT", "/v1/customers", { token: w.pins.manager, body: { name: "Regular", mobile: "+6500005555", group_ids: [group.body.data.id] } });
    const s = await h.orderWith(w.pins.server, [{ product_id: w.ids.laksa }, { product_id: w.ids.wine }]);
    expect((await call("POST", `/v1/orders/${s.id}/customer`, { token: w.pins.manager, body: { customer_id: cust.body.data.id } })).status).toBe(200);
    const linked = await snap(s.id);
    expect(linked.totals.discount_total).toBeLessThan(0);
    const p = await voidLine(await agent(), s.id, linked.lines[1]!.id);
    expect(p.status, JSON.stringify(p.body)).toBe(202);
    expect((await call("PUT", "/v1/customers", { token: w.pins.manager, body: { name: "Regular", mobile: "+6500005555", group_ids: [] } })).status).toBeLessThan(300);
    expect((await snap(s.id)).version).toBe(linked.version);
    const ap = await approve(p.body.data.id);
    expect(ap.body.data.status).toBe("failed");
    expect(ap.body.data.result!.body.message).toMatch(/amounts have changed/);
    await db.sql`update pricing_rules set archived_at = now() where rule_key = 'promo:regulars'`;
  });

  it("when nothing has changed, approval runs and the order ends at exactly the figures shown", async () => {
    const s = await h.orderWith(w.pins.server, [{ product_id: w.ids.laksa }, { product_id: w.ids.wine }]);
    const p = await voidLine(await agent(), s.id, s.lines[1]!.id);
    expect(p.status).toBe(202);
    const ap = await approve(p.body.data.id);
    expect(ap.body.data.status, JSON.stringify(ap.body.data.result)).toBe("approved");
    expect(money((await snap(s.id)).totals)).toEqual(money(p.body.data.effect!.after!));
  });
});

describe("the agent money rule and the money fixes", () => {
  it("prices above 2^31 keep exact before and after figures, and approval lands on the after figure", async () => {
    const big = randomUUID();
    expect((await call("POST", "/v1/products", { token: w.m.admin.token, body: { id: big, name: "Banquet", price: 3_000_000_001 } })).status).toBe(201);
    await addToMenu(big);
    const s = await h.orderWith(w.pins.server, [{ product_id: big }, { product_id: big }, { product_id: w.ids.kopi }]);
    const p = await voidLine(await agent(), s.id, s.lines[0]!.id);
    expect(p.status, JSON.stringify(p.body)).toBe(202);
    const { before, after } = p.body.data.effect!;
    expect(money(before!)).toEqual(money(s.totals as Money));
    expect(before!.subtotal).toBe(2 * 3_000_000_001 + 180);
    expect(after!.subtotal).toBe(3_000_000_001 + 180);
    // The stored proposal holds the same figures as the response: nothing was narrowed or rounded on the way.
    const [stored] = await db.sql<{ effect: { before: Money; after: Money }; order_total: number }[]>`select effect, order_total from proposals where id = ${p.body.data.id}`;
    expect(money(stored!.effect.after)).toEqual(money(after!));
    expect(stored!.order_total).toBe(s.totals.total);
    expect((await approve(p.body.data.id)).body.data.status).toBe("approved");
    expect(money((await snap(s.id)).totals)).toEqual(money(after!));
  });

  it("an agent's call that would take an order above MAX_AMOUNT is refused by the same guard as a person's, and proposes nothing", async () => {
    const huge = randomUUID();
    expect((await call("POST", "/v1/products", { token: w.m.admin.token, body: { id: huge, name: "Estate", price: 900_000_000_000 } })).status).toBe(201);
    await addToMenu(huge);
    const tok = await agent();
    const s = await h.orderWith(w.pins.server, [{ product_id: huge }]);
    const [{ n: before }] = await db.sql<[{ n: number }]>`select count(*)::int as n from proposals`;
    const byAgent = await h.add(tok, s.id, [{ product_id: huge }]);
    const byPerson = await h.add(w.pins.server, s.id, [{ product_id: huge }]);
    expect(byAgent.status).toBe(400);
    expect(byPerson.status).toBe(400);
    expect((byAgent.body as unknown as { message: string }).message).toBe((byPerson.body as unknown as { message: string }).message);
    const [{ n: after }] = await db.sql<[{ n: number }]>`select count(*)::int as n from proposals`;
    expect(after).toBe(before);
  });

  it("after a payment, an agent cannot shrink a line under the frozen discount; voiding it whole is a proposal whose approval leaves what it showed", async () => {
    const mgr = w.pins.manager;
    const s = await h.orderWith(mgr, [{ product_id: w.ids.laksa }, { product_id: w.ids.kopi, quantity: 5 }, { product_id: w.ids.laksa }]);
    const kopi = s.lines[1]!.id;
    expect((await call("POST", `/v1/orders/${s.id}/adjustments`, { token: mgr, body: { application_id: randomUUID(), rule_key: "seed:percent-off-bill", entered_value: 5000, reason: "regular" } })).status).toBe(200);
    await call("POST", `/v1/orders/${s.id}/checks/allocate`, { token: mgr, body: { moves: [], add_checks: 1 } });
    const bill2 = (await snap(s.id)).checks[1]!.id;
    const moved = await call<{ data: Snap }>("POST", `/v1/orders/${s.id}/checks/allocate`, { token: mgr, body: { moves: [{ line_id: kopi, check_ids: [bill2] }, { line_id: s.lines[2]!.id, check_ids: [bill2] }] } });
    const bill1 = moved.body.data.checks[0]!;
    // Paying bill 1 freezes the bill discount with its per-line shares.
    expect((await h.pay(mgr, bill1.id, { tender_type_id: w.ids.card, amount: bill1.balance })).status).toBe(200);
    const frozen = await snap(s.id);
    // Cutting the kopi from five to one would leave the frozen half-price share of five on one: refused, nothing proposed.
    const tok = await agent();
    const cut = await call<{ code: string }>("PATCH", `/v1/orders/${s.id}/lines/${kopi}`, { token: tok, body: { quantity: 1 } });
    expect([cut.status, cut.body.code]).toEqual([422, "invariant_violation"]);
    expect((await db.sql`select id from proposals where order_id = ${s.id}`).length).toBe(0);
    const gone = await voidLine(tok, s.id, kopi);
    expect(gone.status, JSON.stringify(gone.body)).toBe(202);
    const { before, after } = gone.body.data.effect!;
    expect(money(before!)).toEqual(money(frozen.totals));
    expect(after!.total).toBeLessThan(before!.total);
    expect((await approve(gone.body.data.id)).body.data.status).toBe("approved");
    const done = await snap(s.id);
    expect(money(done.totals)).toEqual(money(after!));
    const [neg] = await db.sql<{ n: number }[]>`select count(*)::int as n from order_lines where order_id = ${s.id} and (net_amount < 0 or tax_amount < 0 or total < 0)`;
    expect(neg!.n).toBe(0);
  });
});

describe("cash needs an open shift, and a day closes only with no open orders", () => {
  it("an agent's cash payment proposal fails on approval while no shift is open, with the register's reason, and runs once one is", async () => {
    const tok = await agent({ role: "cashier", toolsets: ["pos.order", "pos.read", "pos.payment"] });
    const s = await h.orderWith(w.pins.server, [{ product_id: w.ids.kopi }]);
    const propose = () => call<{ data: Proposal }>("POST", `/v1/checks/${s.checks[0]!.id}/payments`, { token: tok, body: { payment_id: randomUUID(), tender_type_id: w.ids.cash, amount: s.balance, tendered: s.balance } });
    const p1 = await propose();
    expect(p1.status, JSON.stringify(p1.body)).toBe(202);
    const a1 = await approve(p1.body.data.id);
    expect(a1.body.data.status).toBe("failed");
    expect(a1.body.data.result!.body.details).toMatchObject({ invariant: "no_open_shift" });
    const shift = await call<{ data: { id: string } }>("POST", "/v1/shifts", { token: w.pins.cashier, body: { outlet_id: w.m.outletId, station_id: null, float_cents: 0 } });
    expect(shift.status).toBe(201);
    const a2 = await approve((await propose()).body.data.id);
    expect(a2.body.data.status, JSON.stringify(a2.body.data.result)).toBe("approved");
    expect((await snap(s.id)).balance).toBe(0);
    expect((await call("POST", `/v1/shifts/${shift.body.data.id}/close`, { token: w.pins.manager, body: { counted_cash_cents: s.balance } })).status).toBe(200);
  });

  it("a shift-close proposal whose figures have not moved is approved: the stored pin is compared by value, whatever order jsonb gives its keys", async () => {
    const shift = await call<{ data: { id: string } }>("POST", "/v1/shifts", { token: w.pins.cashier, body: { outlet_id: w.m.outletId, station_id: null, float_cents: 0 } });
    expect(shift.status).toBe(201);
    const tok = await agent({ role: "cashier", toolsets: ["pos.payment"] });
    const p = await call<{ data: Proposal }>("POST", `/v1/shifts/${shift.body.data.id}/close`, { token: tok, body: { counted_cash_cents: 0 } });
    expect(p.status, JSON.stringify(p.body)).toBe(202);
    const ap = await approve(p.body.data.id);
    expect(ap.body.data.status, JSON.stringify(ap.body.data.result)).toBe("approved");
  });

  it("an agent's business-day close proposal is refused at approval while an order is still open on the kitchen display", async () => {
    const s = await h.orderWith(w.pins.server, [{ product_id: w.ids.laksa }]);
    expect((await h.fire(w.pins.server, s.id)).status).toBe(200);
    const tickets = await call<{ data: unknown[] }>("GET", `/v1/outlets/${w.m.outletId}/kitchen-tickets`, { token: w.pins.server });
    expect(tickets.status).toBeLessThan(500);
    const tok = await agent({ role: "admin", toolsets: ["pos.payment", "pos.read"], risk_ceiling: "T1" });
    const p = await call<{ data: Proposal }>("POST", `/v1/outlets/${w.m.outletId}/business-days/close`, { token: tok, body: {} });
    expect(p.status, JSON.stringify(p.body)).toBe(202);
    const ap = await call<{ data: Proposal }>("POST", `/v1/proposals/${p.body.data.id}/approve`, { token: w.pins.admin, body: {} });
    expect(ap.body.data.status).toBe("failed");
    expect(ap.body.data.result!.body.details, JSON.stringify(ap.body.data.result)).toMatchObject({ invariant: "open_orders" });
  });
});

describe("a brand-scoped agent's report figures", () => {
  it("cover its brand only, and still reconcile: net + refunds + fees + tax = total, and the tenders to the sales", async () => {
    const outlet = w.m.outlet2Id;
    const other = randomUUID();
    const menu2 = randomUUID();
    const must = async (method: string, path: string, body: unknown) => {
      const r = await call(method, path, { token: w.m.admin.token, body });
      if (r.status >= 300) throw new Error(`${path} ${r.status} ${JSON.stringify(r.body)}`);
      return r.body as { data: Snap };
    };
    await must("POST", "/v1/brands", { id: other, name: "Second brand" });
    await must("POST", "/v1/menus", { id: menu2, brand_id: other, name: "M2", sections: [{ name: "All", items: [{ product_id: w.ids.laksa }, { product_id: w.ids.wine }] }] });
    await must("POST", "/v1/channel-links", { channel: "pos", outlet_id: outlet, brand_id: w.m.brandId, menu_id: w.ids.menu });
    await must("POST", "/v1/channel-links", { channel: "pos", outlet_id: outlet, brand_id: other, menu_id: menu2 });
    await must("POST", "/v1/shifts", { outlet_id: outlet, station_id: null, float_cents: 0 });
    const sale = async (brand: string, product: string, tender: string) => {
      const o = await must("POST", "/v1/orders", { order_id: randomUUID(), order_type: "takeaway", takeaway_ref: "B", outlet_id: outlet, brand_id: brand });
      const s = (await must("POST", `/v1/orders/${o.data.id}/lines`, { lines: [{ line_id: randomUUID(), product_id: product, quantity: 1 }] })).data;
      await must("POST", `/v1/orders/${s.id}/fire`, {});
      await must("POST", `/v1/checks/${s.checks[0]!.id}/payments`, { payment_id: randomUUID(), tender_type_id: tender, amount: s.balance, tendered: s.balance });
      return s.totals.total;
    };
    const mine = (await sale(w.m.brandId, w.ids.laksa, w.ids.cash)) + (await sale(w.m.brandId, w.ids.kopi, w.ids.card));
    const theirs = await sale(other, w.ids.wine, w.ids.card);

    type Z = { sales: { net: number; refunds: number; fees: number; tax: number; total: number }; tenders_summary: { cash: number; non_cash: number }; reconciliation: { tenders: number; sales_total: number; paid_on_other_orders: number; paid_elsewhere: number } };
    const z = async (token: string) => {
      const r = await call<{ data: Z }>("GET", `/v1/outlets/${outlet}/z-report`, { token });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      return r.body.data;
    };
    const scoped = await agent({ role: "manager", toolsets: ["reports", "pos.read"], brand_ids: [w.m.brandId] });
    const all = await z(w.m.admin.token);
    const own = await z(scoped);
    expect(all.sales.total).toBe(mine + theirs);
    expect(own.sales.total).toBe(mine);
    for (const r of [all, own]) {
      expect(r.sales.net + r.sales.refunds + r.sales.fees + r.sales.tax).toBe(r.sales.total);
      expect(r.reconciliation.tenders).toBe(r.tenders_summary.cash + r.tenders_summary.non_cash);
      expect(r.reconciliation.tenders).toBe(r.reconciliation.sales_total + r.reconciliation.paid_on_other_orders - r.reconciliation.paid_elsewhere);
    }
    expect(own.reconciliation).toMatchObject({ tenders: mine, sales_total: mine, paid_on_other_orders: 0, paid_elsewhere: 0 });
    const summary = await call<{ data: { totals?: { total?: number }; total?: number } }>("GET", `/v1/reports/sales-summary?outlet_id=${outlet}`, { token: scoped });
    expect(summary.status).toBe(200);
    expect(JSON.stringify(summary.body.data)).not.toContain(String(theirs + mine));
  });
});

describe("a brand-scoped manager at an outlet two brands share", () => {
  it("cannot close the shared drawer or the business day on one brand's figures, nor with the other brand's order still open", async () => {
    const outlet = randomUUID();
    const other = randomUUID();
    const menu2 = randomUUID();
    const must = async (method: string, path: string, body: unknown, token = w.m.admin.token) => {
      const r = await call(method, path, { token, body });
      if (r.status >= 300) throw new Error(`${path} ${r.status} ${JSON.stringify(r.body)}`);
      return r.body as { data: Snap & { id: string } };
    };
    await must("POST", "/v1/outlets", { id: outlet, name: "Food hall" });
    await must("POST", "/v1/brands", { id: other, name: "Hall brand" });
    await must("POST", "/v1/menus", { id: menu2, brand_id: other, name: "M2", sections: [{ name: "All", items: [{ product_id: w.ids.wine }] }] });
    await must("POST", "/v1/channel-links", { channel: "pos", outlet_id: outlet, brand_id: w.m.brandId, menu_id: w.ids.menu });
    await must("POST", "/v1/channel-links", { channel: "pos", outlet_id: outlet, brand_id: other, menu_id: menu2 });
    const shift = await must("POST", "/v1/shifts", { outlet_id: outlet, station_id: null, float_cents: 0 });
    const order = async (brand: string, product: string) => {
      const o = await must("POST", "/v1/orders", { order_id: randomUUID(), order_type: "takeaway", takeaway_ref: "H", outlet_id: outlet, brand_id: brand });
      const s = (await must("POST", `/v1/orders/${o.data.id}/lines`, { lines: [{ line_id: randomUUID(), product_id: product, quantity: 1 }] })).data;
      await must("POST", `/v1/orders/${s.id}/fire`, {});
      return s;
    };
    const pay = (s: Snap) => must("POST", `/v1/checks/${s.checks[0]!.id}/payments`, { payment_id: randomUUID(), tender_type_id: w.ids.cash, amount: s.balance, tendered: s.balance });
    const mine = await order(w.m.brandId, w.ids.laksa);
    const theirs = await order(other, w.ids.wine);
    await pay(mine);
    await pay(theirs);
    const drawer = mine.balance + theirs.balance;
    await db.sql`update staff set brand_ids = ${db.sql.array([w.m.brandId])}::uuid[] where id = ${w.m.manager.id}`;
    try {
      // The drawer holds both brands' cash: closed on this brand's figures, the shift would store a false expected cash.
      const shiftClose = await call<{ data: { expected_cash_cents: number } }>("POST", `/v1/shifts/${shift.data.id}/close`, { token: w.m.manager.token, body: { counted_cash_cents: drawer, variance_reason: "count" } });
      expect(shiftClose.status, JSON.stringify(shiftClose.body)).not.toBe(200);
      await must("POST", `/v1/shifts/${shift.data.id}/close`, { counted_cash_cents: drawer });
      // The other brand still has an order open: the day must not close, and never on one brand's sales.
      await order(other, w.ids.wine);
      const dayClose = await call("POST", `/v1/outlets/${outlet}/business-days/close`, { token: w.m.manager.token, body: {} });
      expect(dayClose.status, JSON.stringify(dayClose.body)).not.toBe(200);
      const [stored] = await db.sql<{ n: number }[]>`select count(*)::int as n from business_day_closes where outlet_id = ${outlet}`;
      expect(stored!.n).toBe(0);
    } finally {
      await db.sql`update staff set brand_ids = '{}' where id = ${w.m.manager.id}`;
    }
  });
});

describe("tips and QR codes are a person's call", () => {
  it("an agent cannot rotate every QR code or switch tips on; a tip an agent adds is a proposal, refused at approval while tips are off", async () => {
    const tok = await agent({ role: "admin", toolsets: ["pos.order", "pos.read", "pos.payment", "config.author", "guest"] });
    expect((await call("POST", `/v1/outlets/${w.m.outletId}/qr/rotate`, { token: tok, body: {} })).status).toBe(403);
    expect((await call("PATCH", "/v1/merchant/settings", { token: tok, body: { tips_enabled: true } })).status).toBe(403);
    const s = await h.orderWith(w.pins.server, [{ product_id: w.ids.kopi }]);
    const tipped = () => call<{ data: Proposal }>("POST", `/v1/checks/${s.checks[0]!.id}/payments`, { token: tok, body: { payment_id: randomUUID(), tender_type_id: w.ids.card, amount: s.balance, tip_cents: 50 } });
    // Recording a payment is T2: an agent's payment, tip and all, always waits for a person.
    const off = await tipped();
    expect(off.status, JSON.stringify(off.body)).toBe(202);
    const refused = await approve(off.body.data.id);
    expect(refused.body.data.status).toBe("failed");
    expect(refused.body.data.result!.body.message).toMatch(/Tips are turned off/);
    expect((await call("PATCH", "/v1/merchant/settings", { token: w.m.admin.token, body: { tips_enabled: true } })).status).toBe(200);
    try {
      const on = await tipped();
      expect(on.status).toBe(202);
      const ap = await approve(on.body.data.id);
      expect(ap.body.data.status, JSON.stringify(ap.body.data.result)).toBe("approved");
      const [pay] = await db.sql<{ tip_cents: number; amount: number }[]>`select tip_cents, amount from payments where check_id = ${s.checks[0]!.id} and status = 'recorded'`;
      expect(pay).toMatchObject({ tip_cents: 50, amount: s.balance });
    } finally {
      await call("PATCH", "/v1/merchant/settings", { token: w.m.admin.token, body: { tips_enabled: false } });
    }
  });
});

describe("request amounts", () => {
  it("every integer amount a request carries is bounded by MAX_AMOUNT, including the agent-safety operations'", async () => {
    const { MAX_AMOUNT } = await import("@sail/shared");
    const doc = JSON.parse((await import("node:fs")).readFileSync(new URL("../openapi.json", import.meta.url), "utf8")) as { paths: Record<string, Record<string, { operationId: string; requestBody?: { content: Record<string, { schema: S }> } }>>; components: { schemas: Record<string, S> } };
    type S = { type?: string; maximum?: number; properties?: Record<string, S>; items?: S; anyOf?: S[]; oneOf?: S[]; allOf?: S[]; $ref?: string };
    const AMOUNT = /(amount|total|price|cents|(^|_)tip|float|tendered|override|entered_value)$/;
    const unbounded: string[] = [];
    let seen = 0;
    const walk = (s: S | undefined, op: string, key: string, depth = 0): void => {
      if (!s || depth > 12) return;
      if (s.$ref) return walk(doc.components.schemas[s.$ref.split("/").pop()!], op, key, depth + 1);
      if (s.type === "integer" && AMOUNT.test(key)) {
        seen++;
        if (s.maximum !== MAX_AMOUNT) unbounded.push(`${op} ${key}`);
      }
      for (const [k, v] of Object.entries(s.properties ?? {})) walk(v, op, k, depth + 1);
      for (const v of [s.items, ...(s.anyOf ?? []), ...(s.oneOf ?? []), ...(s.allOf ?? [])]) walk(v, op, key, depth + 1);
    };
    for (const methods of Object.values(doc.paths)) for (const o of Object.values(methods)) walk(o.requestBody?.content["application/json"]?.schema, o.operationId, "");
    expect(seen).toBeGreaterThan(10);
    expect(unbounded).toEqual([]);
  });
});

async function addToMenu(productId: string) {
  const menu = await call<{ data: { sections: { name: string; items: { product_id: string }[] }[] } }>("GET", `/v1/menus/${w.ids.menu}`, { token: w.m.admin.token });
  const sections = menu.body.data.sections.map((s, i) => ({ name: s.name, items: [...s.items.map((it) => ({ product_id: it.product_id })), ...(i === 0 ? [{ product_id: productId }] : [])] }));
  const r = await call("PATCH", `/v1/menus/${w.ids.menu}`, { token: w.m.admin.token, body: { sections } });
  if (r.status >= 300) throw new Error(JSON.stringify(r.body));
}
