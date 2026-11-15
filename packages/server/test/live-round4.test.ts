import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bootWorld, orderHelpers, type Call, type World } from "./world.js";
import type { TestDb } from "./helpers.js";

/** Findings from the fourth live test that live in the register. */
let db: TestDb;
let call: Call;
let w: World;
let h: ReturnType<typeof orderHelpers>;

beforeAll(async () => {
  ({ db, call, w } = await bootWorld());
  h = orderHelpers(call, w);
});
afterAll(async () => db.drop());

type Voids = { count: number; quantity: number; value: number };
const zVoids = async () => (await call<{ data: { voids: Voids } }>("GET", `/v1/outlets/${w.m.outletId}/z-report`, { token: w.pins.manager })).body.data.voids;
const stationZVoids = async () => (await call<{ data: { voids: Voids } }>("GET", `/v1/outlets/${w.m.outletId}/z-report?station_id=${w.ids.station}`, { token: w.pins.manager })).body.data.voids;
const salesVoids = async () => (await call<{ data: { voids: Voids } }>("GET", `/v1/reports/sales-summary?outlet_id=${w.m.outletId}`, { token: w.m.admin.token })).body.data.voids;
const exceptionVoids = async () => (await call<{ data: { voids: { product_name: string; after_firing: boolean }[] } }>("GET", `/v1/reports/exceptions?outlet_id=${w.m.outletId}`, { token: w.m.admin.token })).body.data.voids;

describe("a void is a line taken off after it was sent to the kitchen (L2)", () => {
  it("cancelling an order with only unsent lines, or removing an unsent line, is no void in the Z-report, the sales summary or the exceptions report; a sent line voided is", async () => {
    const none = { count: 0, quantity: 0, value: 0 };
    // The tester's case: one unsent line, then the order is cancelled.
    const cancelled = await h.orderWith(w.pins.server, [{ product_id: w.ids.kopi }]);
    const c = await call("POST", `/v1/orders/${cancelled.id}/cancel`, { token: w.pins.server, body: { reason: "Guest left" } });
    expect(c.status, JSON.stringify(c.body)).toBe(200);
    // An unsent line removed with a reason on an order that carries on.
    const kept = await h.orderWith(w.pins.server, [{ product_id: w.ids.kopi }, { product_id: w.ids.laksa }]);
    const unsent = (kept.lines as unknown as { id: string; product_id: string }[]).find((l) => l.product_id === w.ids.kopi)!;
    expect((await call("POST", `/v1/orders/${kept.id}/lines/${unsent.id}/void`, { token: w.pins.server, body: { reason_id: w.ids.voidReason } })).status).toBe(200);
    expect(await zVoids()).toEqual(none);
    expect(await stationZVoids()).toEqual(none);
    expect(await salesVoids()).toEqual(none);
    expect(await exceptionVoids()).toEqual([]);

    // A line sent to the kitchen and then voided (Manager) is a void everywhere, at its value.
    await h.fire(w.pins.server, kept.id);
    const sent = (kept.lines as unknown as { id: string; product_id: string }[]).find((l) => l.product_id === w.ids.laksa)!;
    const v = await call("POST", `/v1/orders/${kept.id}/lines/${sent.id}/void`, { token: w.pins.manager, body: { reason_id: w.ids.voidReason } });
    expect(v.status, JSON.stringify(v.body)).toBe(200);
    const one = { count: 1, quantity: 1, value: 1600 };
    expect(await zVoids()).toEqual(one);
    expect(await stationZVoids()).toEqual(one);
    expect(await salesVoids()).toEqual(one);
    expect(await exceptionVoids()).toEqual([expect.objectContaining({ product_name: "Laksa", after_firing: true })]);

    // An order with a sent line is cancelled only once that line is voided: that void counts, its unsent lines do not.
    const mixed = await h.orderWith(w.pins.server, [{ product_id: w.ids.kopi }]);
    await h.fire(w.pins.server, mixed.id);
    await call("POST", `/v1/orders/${mixed.id}/lines`, { token: w.pins.server, body: { lines: [{ line_id: randomUUID(), product_id: w.ids.laksa, quantity: 1 }] } });
    const refused = await call<{ code: string; details?: { invariant?: string } }>("POST", `/v1/orders/${mixed.id}/cancel`, { token: w.pins.server, body: { reason: "Guest left" } });
    expect(refused.status).toBe(422);
    expect(JSON.stringify(refused.body)).toContain("fired_lines_present");
    const firedLine = mixed.lines[0]!;
    expect((await call("POST", `/v1/orders/${mixed.id}/lines/${firedLine.id}/void`, { token: w.pins.manager, body: { reason_id: w.ids.voidReason } })).status).toBe(200);
    expect((await call("POST", `/v1/orders/${mixed.id}/cancel`, { token: w.pins.manager, body: { reason: "Guest left" } })).status).toBe(200);
    expect(await zVoids()).toEqual({ count: 2, quantity: 2, value: 1780 });
    expect(await salesVoids()).toEqual({ count: 2, quantity: 2, value: 1780 });
  });
});
