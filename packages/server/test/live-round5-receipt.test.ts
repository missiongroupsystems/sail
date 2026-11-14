import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bootWorld, orderHelpers, type Call, type World } from "./world.js";
import type { TestDb } from "./helpers.js";

/** M4: the POS receipt sheet shows the tip and what was charged, so the bill snapshot carries the register's figures. */
let db: TestDb;
let call: Call;
let w: World;
let h: ReturnType<typeof orderHelpers>;

beforeAll(async () => {
  ({ db, call, w } = await bootWorld());
  h = orderHelpers(call, w);
  expect((await call("PATCH", "/v1/merchant/settings", { token: w.m.admin.token, body: { tips_enabled: true } })).status).toBe(200);
});
afterAll(async () => db.drop());

type Check = { paid_total: number; tip_total: number; charged_total: number };

describe("a bill's tip and charged figures (M4)", () => {
  it("a card payment with a tip: the bill carries the tip and what the card was charged; a bill with no tip charges what was paid", async () => {
    const s = await h.orderWith(w.pins.cashier, [{ product_id: w.ids.kopi }]);
    await h.fire(w.pins.cashier, s.id);
    const paid = await h.pay(w.pins.cashier, s.checks[0]!.id, { tender_type_id: w.ids.card, amount: s.balance, tip_cents: 100 });
    expect(paid.status, JSON.stringify(paid.body)).toBe(200);
    const check = (paid.body.data as unknown as { checks: Check[] }).checks[0]!;
    expect(check).toMatchObject({ paid_total: s.balance, tip_total: 100, charged_total: s.balance + 100 });

    const plain = await h.paidOrder(w.pins.cashier, [{ product_id: w.ids.kopi }]);
    const c2 = (plain as unknown as { checks: Check[] }).checks[0]!;
    expect(c2).toMatchObject({ tip_total: 0, charged_total: c2.paid_total });
  });
});
