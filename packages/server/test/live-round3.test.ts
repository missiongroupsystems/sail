import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bootWorld, orderHelpers, type Call, type World } from "./world.js";
import type { TestDb } from "./helpers.js";

/** Findings from the third live test that live in the register. */
let db: TestDb;
let call: Call;
let w: World;
let h: ReturnType<typeof orderHelpers>;

beforeAll(async () => {
  ({ db, call, w } = await bootWorld());
  h = orderHelpers(call, w);
});
afterAll(async () => db.drop());

describe("a blind close stays blind (S-9, R A-N3)", () => {
  it("while a drawer is open, the Z-report a Cashier reads carries the floats and counts but no figure the expected cash could be worked out from; a Manager still gets it all", async () => {
    const shift = await call<{ data: { id: string } }>("POST", "/v1/shifts", { token: w.pins.cashier, body: { float_cents: 10_000 } });
    expect(shift.status, JSON.stringify(shift.body)).toBe(201);
    const o = await h.orderWith(w.pins.cashier, [{ product_id: w.ids.laksa }]);
    await h.fire(w.pins.cashier, o.id);
    expect((await h.pay(w.pins.cashier, o.checks[0]!.id, { tender_type_id: w.ids.cash, amount: o.balance })).status).toBe(200);
    await call("POST", `/v1/orders/${o.id}/complete`, { token: w.pins.cashier, body: {} });
    const expected = 10_000 + o.balance;

    for (const path of [`/v1/outlets/${w.m.outletId}/z-report`, `/v1/outlets/${w.m.outletId}/z-report?station_id=${w.ids.station}`]) {
      const z = await call<{ data: Record<string, unknown> & { cash: Record<string, unknown> } }>("GET", path, { token: w.pins.cashier });
      expect(z.status).toBe(200);
      expect(z.body.data.withheld).toBe("open_shift");
      expect(z.body.data.cash).toEqual({ float: 0, open_shifts: { count: 1, float: 10_000 } });
      expect(z.body.data).not.toHaveProperty("sales");
      expect(z.body.data).not.toHaveProperty("tenders");
      expect(z.body.data).not.toHaveProperty("tenders_summary");
      expect(z.body.data).not.toHaveProperty("reconciliation");
      // No figure in the whole answer equals the expected cash or the cash taken.
      const text = JSON.stringify(z.body.data);
      expect(text).not.toContain(String(expected));
      expect(text).not.toContain(String(o.balance));
    }

    const manager = await call<{ data: { withheld?: string; cash: { open_shifts: { expected: number } } } }>("GET", `/v1/outlets/${w.m.outletId}/z-report`, { token: w.pins.manager });
    expect(manager.body.data.withheld).toBeUndefined();
    expect(manager.body.data.cash.open_shifts.expected).toBe(expected);

    // Once the drawer is counted and closed, the Cashier sees the figures again.
    const closed = await call("POST", `/v1/shifts/${shift.body.data.id}/close`, { token: w.pins.cashier, body: { counted_cash_cents: expected } });
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    const after = await call<{ data: { withheld?: string; cash: { expected: number; variance: number } } }>("GET", `/v1/outlets/${w.m.outletId}/z-report`, { token: w.pins.cashier });
    expect(after.body.data.withheld).toBeUndefined();
    expect(after.body.data.cash).toMatchObject({ expected, variance: 0 });
  });
});

describe("a blind close counts every drawer at the outlet (S-9)", () => {
  it("a whole-outlet drawer opened in the back office keeps a station's own report blind for a Cashier", async () => {
    const shift = await call<{ data: { id: string } }>("POST", "/v1/shifts", { token: w.m.admin.token, body: { outlet_id: w.m.outletId, station_id: null, float_cents: 7_500 } });
    expect(shift.status, JSON.stringify(shift.body)).toBe(201);
    try {
      const z = await call<{ data: { withheld?: string; cash: unknown } }>("GET", `/v1/outlets/${w.m.outletId}/z-report?station_id=${w.ids.station}`, { token: w.pins.cashier });
      expect(z.body.data.withheld).toBe("open_shift");
      expect(z.body.data.cash).toMatchObject({ open_shifts: { count: 1, float: 7_500 } });
    } finally {
      await call("POST", `/v1/shifts/${shift.body.data.id}/close`, { token: w.m.admin.token, body: { counted_cash_cents: 7_500 } });
    }
  });
});

describe("a reopened order says its payment was reversed (R B-N2)", () => {
  it("the bill's payment rows mark a payment reversed by a reopen apart from a void", async () => {
    const paid = await h.paidOrder(w.pins.manager, [{ product_id: w.ids.kopi }]);
    await call("POST", `/v1/orders/${paid.id}/complete`, { token: w.pins.manager, body: {} });
    const reopened = await call<{ data: { checks: { balance: number; payments: { status: string; reversal: string | null; amount: number }[] }[] } }>("POST", `/v1/orders/${paid.id}/reopen`, { token: w.pins.manager, body: { reason: "Wrong table" } });
    expect(reopened.status, JSON.stringify(reopened.body)).toBe(200);
    const check = reopened.body.data.checks[0]!;
    expect(check.balance).toBeGreaterThan(0);
    expect(check.payments).toEqual([expect.objectContaining({ status: "reversed", reversal: "reopen", amount: paid.checks[0]!.totals.total })]);
    // Paid again: the new payment is recorded and has no reversal.
    const again = await h.pay(w.pins.manager, paid.checks[0]!.id, { tender_type_id: w.ids.card, amount: check.balance });
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    const rows = (again.body.data as unknown as { checks: { balance: number; payments: { status: string; reversal: string | null }[] }[] }).checks[0]!;
    expect(rows.balance).toBe(0);
    expect(rows.payments.map((p) => [p.status, p.reversal])).toEqual([["reversed", "reopen"], ["recorded", null]]);
  });
});

describe("a PIN sent short of six digits (S-3)", () => {
  it("is refused as not recognised, at sign-in and at approval, like any wrong PIN", async () => {
    const signIn = await call<{ message: string; code: string }>("POST", "/v1/stations/sessions", { token: w.station2Token, body: { pin: "1234" } });
    expect(signIn.status).toBe(401);
    expect(signIn.body).toMatchObject({ message: "PIN not recognised" });
    const o = await h.orderWith(w.pins.server, [{ product_id: w.ids.kopi }]);
    const ask = await call<{ message: string }>("POST", "/v1/overrides", { token: w.pins.server, body: { action: "payments.record", target_kind: "order", target_id: o.id, approver_pin: "22", args: { check_id: o.checks[0]!.id, tender_type_id: w.ids.cash, amount: o.balance, tip_cents: 0, reference: null } } });
    expect(ask.status).toBe(403);
    expect(ask.body).toMatchObject({ message: "PIN not recognised" });
    // A PIN is still set as exactly six digits.
    expect((await call("POST", "/v1/stations/sessions", { token: w.station2Token, body: { pin: "1234567" } })).status).toBe(400);
  });
});

describe("what Pay before sending covers (S other)", () => {
  it("holds a dine-in order sent from that station as well as a takeaway, until it is paid in full", async () => {
    expect((await call("PATCH", `/v1/stations/${w.ids.station2}`, { token: w.m.admin.token, body: { pay_before_firing: true } })).status).toBe(200);
    try {
      const areaId = randomUUID();
      const tableId = randomUUID();
      await call("POST", "/v1/areas", { token: w.m.admin.token, body: { id: areaId, outlet_id: w.m.outletId, name: "Pay first" } });
      await call("POST", "/v1/tables", { token: w.m.admin.token, body: { id: tableId, outlet_id: w.m.outletId, area_id: areaId, name: "PF1" } });
      const dineIn = await call<{ data: { id: string; balance: number; checks: { id: string }[] } }>("POST", "/v1/orders", { token: w.pins.cashierStation2, body: { order_id: randomUUID(), order_type: "dine_in", table_id: tableId, pax: 2, outlet_id: w.m.outletId, brand_id: w.m.brandId } });
      const added = await h.add(w.pins.cashierStation2, dineIn.body.data.id, [{ product_id: w.ids.kopi }]);
      const held = await h.fire(w.pins.cashierStation2, dineIn.body.data.id);
      expect(held.status).toBe(422);
      expect((held.body as unknown as { details: { invariant: string } }).details.invariant).toBe("pay_before_firing");
      const takeaway = await h.orderWith(w.pins.cashierStation2, [{ product_id: w.ids.kopi }]);
      expect((await h.fire(w.pins.cashierStation2, takeaway.id)).status).toBe(422);
      // Paid in full, the dine-in order goes.
      expect((await h.pay(w.pins.cashierStation2, added.body.data.checks[0]!.id, { tender_type_id: w.ids.card, amount: added.body.data.balance })).status).toBe(200);
      expect((await h.fire(w.pins.cashierStation2, dineIn.body.data.id)).status).toBe(200);
    } finally {
      await call("PATCH", `/v1/stations/${w.ids.station2}`, { token: w.m.admin.token, body: { pay_before_firing: false } });
    }
  });
});
