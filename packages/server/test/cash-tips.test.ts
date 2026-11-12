import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import "../src/modules.js";
import { buildApp } from "../src/app.js";
import { api, freshDb, seedMerchant, type TestDb } from "./helpers.js";

/**
 * A cash tip is part of what the guest hands over and stays in the drawer: the change never gives it back, and the
 * payment, the receipt, the Z-report and the shift's expected cash all count it once.
 */
let db: TestDb;
let call: ReturnType<typeof api>["call"];

beforeAll(async () => {
  db = await freshDb();
  call = api(buildApp()).call;
});
afterAll(async () => db.drop());

type Cash = { float: number; cash_payments: number; rounding: number; tips: number; refunds: number; expected: number };

async function merchant(name: string, currency: string, rounding: number | null, price: number) {
  const m = await seedMerchant(db.sql, name, { preset: "blank", timeZone: "Europe/London", currency, locale: "en-GB", cashRoundingIncrement: rounding });
  const t = m.admin.token;
  const ids = { item: randomUUID(), menu: randomUUID(), link: randomUUID(), cash: randomUUID() };
  const must = async (path: string, body: unknown) => {
    const r = await call("POST", path, { token: t, body });
    if (r.status >= 300) throw new Error(`${path} -> ${r.status} ${JSON.stringify(r.body)}`);
  };
  await must("/v1/products", { id: ids.item, name: "Set lunch", price });
  await must("/v1/menus", { id: ids.menu, brand_id: m.brandId, name: "M", sections: [{ name: "All", items: [{ product_id: ids.item }] }] });
  await must("/v1/channel-links", { id: ids.link, channel: "pos", outlet_id: m.outletId, brand_id: m.brandId, menu_id: ids.menu });
  await must("/v1/tender-types", { id: ids.cash, name: "Cash", is_cash: true });
  return { m, ids, token: m.cashier.token };
}

async function tippedCashSale(w: Awaited<ReturnType<typeof merchant>>, pay: { amount?: number; tendered?: number; tip: number }) {
  const shift = await call<{ data: { id: string } }>("POST", "/v1/shifts", { token: w.token, body: { outlet_id: w.m.outletId, float_cents: 10_000 } });
  expect(shift.status, JSON.stringify(shift.body)).toBe(201);
  const o = await call<{ data: { id: string } }>("POST", "/v1/orders", { token: w.token, body: { order_id: randomUUID(), order_type: "takeaway", takeaway_ref: "T", outlet_id: w.m.outletId, brand_id: w.m.brandId } });
  const s = await call<{ data: { checks: { id: string; balance: number }[] } }>("POST", `/v1/orders/${o.body.data.id}/lines`, { token: w.token, body: { lines: [{ line_id: randomUUID(), product_id: w.ids.item, quantity: 1 }] } });
  const check = s.body.data.checks[0]!;
  const paid = await call<{ payment: { amount: number; rounding_cents: number; tip_cents: number; change_due: number; due_cents: number }; code?: string; message?: string; details?: { due_cents: number } }>("POST", `/v1/checks/${check.id}/payments`, { token: w.token, body: { payment_id: randomUUID(), tender_type_id: w.ids.cash, amount: pay.amount ?? check.balance, tendered: pay.tendered, tip_cents: pay.tip } });
  return { shiftId: shift.body.data.id, checkId: check.id, balance: check.balance, paid };
}

async function receiptPayment(w: Awaited<ReturnType<typeof merchant>>, checkId: string) {
  const sent = await call<{ data: { token: string } }>("POST", `/v1/checks/${checkId}/receipt/send`, { token: w.token, body: { channel: "link" } });
  expect(sent.status, JSON.stringify(sent.body)).toBe(200);
  const doc = await call<{ data: { document: { payments: { tender: string; amount: number; rounding_cents?: number; tip?: number; change?: number }[] } } }>("GET", `/v1/receipts/${sent.body.data.token}`, {});
  return doc.body.data.document.payments[0]!;
}

async function closeAgrees(w: Awaited<ReturnType<typeof merchant>>, shiftId: string, drawer: number) {
  const z = await call<{ data: { cash: Cash } }>("GET", `/v1/outlets/${w.m.outletId}/z-report`, { token: w.token });
  expect(z.body.data.cash.expected).toBe(drawer);
  const closed = await call<{ data: { variance_cents: number; report: { cash: Cash } } }>("POST", `/v1/shifts/${shiftId}/close`, { token: w.token, body: { counted_cash_cents: drawer } });
  expect(closed.status, JSON.stringify(closed.body)).toBe(200);
  expect(closed.body.data.variance_cents).toBe(0);
  const c = closed.body.data.report.cash;
  expect(c.expected).toBe(c.float + c.cash_payments + c.rounding + c.tips - c.refunds);
  return c;
}

describe("cash tips stay in the drawer", () => {
  it("two decimals, no cash rounding: the change leaves the tip in, and receipt, Z-report and shift agree", async () => {
    const w = await merchant("Two decimals", "EUR", null, 1744);
    const { shiftId, checkId, paid } = await tippedCashSale(w, { tendered: 3000, tip: 500 });
    expect(paid.status, JSON.stringify(paid.body)).toBe(200);
    expect(paid.body.payment).toMatchObject({ amount: 1744, rounding_cents: 0, tip_cents: 500, change_due: 3000 - 1744 - 500 });
    const r = await receiptPayment(w, checkId);
    expect(r).toMatchObject({ tender: "Cash", amount: 1744, tip: 500, change: 756 });
    expect(r.amount + (r.rounding_cents ?? 0) + r.tip! + r.change!).toBe(3000);
    expect(await closeAgrees(w, shiftId, 10_000 + 1744 + 500)).toMatchObject({ cash_payments: 1744, tips: 500 });
  });

  it("two decimals with 5-cent rounding: the tip goes on top of the rounded bill; cash short of bill and tip is refused", async () => {
    const w = await merchant("Rounded", "CHF", 5, 1743);
    const { shiftId, checkId, paid, balance } = await tippedCashSale(w, { tendered: 2244, tip: 500 });
    expect(balance).toBe(1743);
    expect(paid.body).toMatchObject({ code: "validation" });
    expect(paid.body.details!.due_cents).toBe(1745 + 500);
    // Change in 5-cent coins cannot pay out a 3-cent tip.
    const odd = await call<{ code: string }>("POST", `/v1/checks/${checkId}/payments`, { token: w.token, body: { payment_id: randomUUID(), tender_type_id: w.ids.cash, amount: balance, tendered: 2250, tip_cents: 503 } });
    expect(odd.body).toMatchObject({ code: "validation" });
    const again = await call<{ payment: { rounding_cents: number; change_due: number } }>("POST", `/v1/checks/${checkId}/payments`, { token: w.token, body: { payment_id: randomUUID(), tender_type_id: w.ids.cash, amount: balance, tendered: 2250, tip_cents: 500 } });
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect(again.body.payment).toMatchObject({ rounding_cents: 2, change_due: 5 });
    expect(await receiptPayment(w, checkId)).toMatchObject({ amount: 1743, rounding_cents: 2, tip: 500, change: 5 });
    await closeAgrees(w, shiftId, 10_000 + 1745 + 500);
  });

  it("no decimals with rounding to 10: cash handed over as the amount is split into bill, tip and change", async () => {
    const w = await merchant("No decimals", "JPY", 10, 1234);
    const { shiftId, checkId, paid } = await tippedCashSale(w, { amount: 2000, tip: 100 });
    expect(paid.status, JSON.stringify(paid.body)).toBe(200);
    expect(paid.body.payment).toMatchObject({ amount: 1234, rounding_cents: -4, tip_cents: 100, change_due: 2000 - 1230 - 100 });
    expect(await receiptPayment(w, checkId)).toMatchObject({ amount: 1234, rounding_cents: -4, tip: 100, change: 670 });
    await closeAgrees(w, shiftId, 10_000 + 1230 + 100);
  });

  it("three decimals: exact cash for bill and tip gives no change", async () => {
    const w = await merchant("Three decimals", "KWD", null, 2750);
    const { shiftId, checkId, paid } = await tippedCashSale(w, { tendered: 3000, tip: 250 });
    expect(paid.status, JSON.stringify(paid.body)).toBe(200);
    expect(paid.body.payment).toMatchObject({ amount: 2750, tip_cents: 250, change_due: 0 });
    const r = await receiptPayment(w, checkId);
    expect(r).toMatchObject({ amount: 2750, tip: 250 });
    expect(r.change).toBeUndefined();
    await closeAgrees(w, shiftId, 10_000 + 2750 + 250);
  });

  it("a percentage tip is worked out by the register on the amount applied, rounded to the cash step in cash; the dry run shows it before anything is taken", async () => {
    const w = await merchant("Percent tip", "CHF", 5, 1744);
    const shift = await call<{ data: { id: string } }>("POST", "/v1/shifts", { token: w.token, body: { outlet_id: w.m.outletId, float_cents: 10_000 } });
    expect(shift.status).toBe(201);
    const o = await call<{ data: { id: string } }>("POST", "/v1/orders", { token: w.token, body: { order_id: randomUUID(), order_type: "takeaway", takeaway_ref: "T", outlet_id: w.m.outletId, brand_id: w.m.brandId } });
    const s = await call<{ data: { checks: { id: string; balance: number }[] } }>("POST", `/v1/orders/${o.body.data.id}/lines`, { token: w.token, body: { lines: [{ line_id: randomUUID(), product_id: w.ids.item, quantity: 1 }] } });
    const check = s.body.data.checks[0]!;
    type Paid = { payment: { amount: number; rounding_cents: number; tip_cents: number; due_cents: number; change_due: number }; data: { checks: { paid_total: number }[] }; code?: string };
    // 18% of 17.44 is 3.1392: 3.14, then 3.15 in 5-centime coins. The bill rounds to 17.45, so the guest hands over 20.60.
    const preview = await call<Paid>("POST", `/v1/checks/${check.id}/payments`, { token: w.token, body: { payment_id: randomUUID(), tender_type_id: w.ids.cash, amount: check.balance, tip_bps: 1800, dry_run: true } });
    expect(preview.status, JSON.stringify(preview.body)).toBe(200);
    expect(preview.body.payment).toMatchObject({ amount: 1744, rounding_cents: 1, tip_cents: 315, due_cents: 1745 + 315 });
    expect(preview.body.data.checks[0]!.paid_total).toBe(1744);
    const both = await call<Paid>("POST", `/v1/checks/${check.id}/payments`, { token: w.token, body: { payment_id: randomUUID(), tender_type_id: w.ids.cash, amount: check.balance, tip_bps: 1800, tip_cents: 315, dry_run: true } });
    expect(both.status).toBe(400);
    // A percentage is a preview: a real payment carries the cents, so an approval covers the exact tip.
    const real = await call<Paid>("POST", `/v1/checks/${check.id}/payments`, { token: w.token, body: { payment_id: randomUUID(), tender_type_id: w.ids.cash, amount: check.balance, tip_bps: 1800 } });
    expect(real.status).toBe(400);
    // Nothing was recorded by the dry runs: the payment the cashier confirms carries the previewed tip.
    const paid = await call<Paid>("POST", `/v1/checks/${check.id}/payments`, { token: w.token, body: { payment_id: randomUUID(), tender_type_id: w.ids.cash, amount: check.balance, tendered: 2100, tip_cents: preview.body.payment.tip_cents } });
    expect(paid.status, JSON.stringify(paid.body)).toBe(200);
    expect(paid.body.payment).toMatchObject({ tip_cents: 315, change_due: 2100 - 1745 - 315 });
    await closeAgrees(w, shift.body.data.id, 10_000 + 1745 + 315);
  });
});

describe("tipping is a merchant setting", () => {
  it("the us preset offers tips on the POS; the presets where tipping is not customary do not; a merchant can switch it", async () => {
    const us = await seedMerchant(db.sql, "Tips US", { preset: "us", timeZone: "America/Chicago" });
    const sg = await seedMerchant(db.sql, "Tips SG", { preset: "sg", timeZone: "Asia/Singapore" });
    const read = async (token: string) => (await call<{ data: { settings: { tips_enabled: boolean } } }>("GET", "/v1/merchant", { token })).body.data.settings.tips_enabled;
    expect(await read(us.admin.token)).toBe(true);
    expect(await read(sg.admin.token)).toBe(false);
    const on = await call<{ data: { settings: { tips_enabled: boolean } } }>("PATCH", "/v1/merchant/settings", { token: sg.admin.token, body: { tips_enabled: true } });
    expect(on.status, JSON.stringify(on.body)).toBe(200);
    expect(on.body.data.settings.tips_enabled).toBe(true);
  });
});
