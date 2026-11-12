import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bootWorld, orderHelpers, type Call, type World } from "./world.js";
import type { TestDb } from "./helpers.js";

/**
 * Money review: regression tests for the findings of the adversarial money
 * review (totals, tax, documents and reports). Each test names the defect it
 * guards against.
 */
let db: TestDb;
let call: Call;
let w: World;
let h: ReturnType<typeof orderHelpers>;
beforeAll(async () => {
  ({ db, call, w } = await bootWorld());
  h = orderHelpers(call, w);
});
afterAll(async () => db?.drop());

type Amounts = { base: number; discount: number; net: number; fee: number; tax: number; total: number };
type Bill = { id: string; balance: number; totals: { total: number; tax_total: number } };
type Snap = { id: string; lines: { id: string; amounts: Amounts }[]; checks: Bill[]; totals: { total: number; tax_total: number } };
const mgr = () => w.pins.manager;
const snapshot = async (orderId: string) => (await call<{ data: Snap }>("GET", `/v1/orders/${orderId}`, { token: mgr() })).body.data;

describe("frozen discounts after a payment", () => {
  it("cutting and comping a line on an unpaid bill never takes it below zero (the frozen bill discount is capped at what the line is worth)", async () => {
    const s = await h.orderWith(mgr(), [{ product_id: w.ids.laksa, quantity: 1 }, { product_id: w.ids.kopi, quantity: 5 }, { product_id: w.ids.laksa, quantity: 1 }]);
    const kopi = s.lines[1]!.id;
    const laksa2 = s.lines[2]!.id;
    expect((await call("POST", `/v1/orders/${s.id}/adjustments`, { token: mgr(), body: { application_id: randomUUID(), rule_key: "seed:percent-off-bill", entered_value: 5000, reason: "regular" } })).status).toBe(200);
    await call("POST", `/v1/orders/${s.id}/checks/allocate`, { token: mgr(), body: { moves: [], add_checks: 1 } });
    const bill2 = (await snapshot(s.id)).checks[1]!.id;
    const moved = await call<{ data: Snap }>("POST", `/v1/orders/${s.id}/checks/allocate`, { token: mgr(), body: { moves: [{ line_id: kopi, check_ids: [bill2] }, { line_id: laksa2, check_ids: [bill2] }] } });
    const bill1 = moved.body.data.checks[0]!;
    expect((await h.pay(mgr(), bill1.id, { tender_type_id: w.ids.card, amount: bill1.balance })).status).toBe(200);

    expect((await call("PATCH", `/v1/orders/${s.id}/lines/${kopi}`, { token: mgr(), body: { quantity: 1 } })).status).toBe(200);
    let after = await snapshot(s.id);
    const kopiAfterCut = after.lines.find((l) => l.id === kopi)!.amounts;
    expect(kopiAfterCut.net).toBe(0);
    expect(kopiAfterCut.total).toBe(0);

    expect((await call("POST", `/v1/orders/${s.id}/adjustments`, { token: mgr(), body: { application_id: randomUUID(), rule_key: "seed:manager-comp", line_ids: [kopi], reason: "spilt" } })).status).toBe(200);
    after = await snapshot(s.id);
    for (const l of after.lines) {
      expect(l.amounts.net).toBeGreaterThanOrEqual(0);
      expect(l.amounts.tax).toBeGreaterThanOrEqual(0);
    }
    // Bill 2 is the second laksa at half price plus GST, and nothing comes off it for the comped kopi.
    expect(after.checks[1]!.totals.total).toBe(Math.round(800 * 1.09));
    const [neg] = await db.sql<{ n: number }[]>`select count(*)::int as n from order_lines where order_id = ${s.id} and (net_amount < 0 or tax_amount < 0 or total < 0)`;
    expect(neg!.n).toBe(0);
  });
});
