import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { renderBill, type BillDocument } from "@sail/shared";
import { withTransaction } from "../src/db/client.js";
import { billDocumentFor } from "../src/services/checks.js";
import { renderInvoicePdf, type InvoiceDocument } from "../src/services/documents.js";
import { MAX_AMOUNT, presetSeedRules, REGION_PRESETS, type RegionPresetKey } from "@sail/shared";
import { seedRulesForMerchant } from "../src/services/pricing-rules.js";
import type { MerchantSettingsInput } from "../src/bootstrap.js";
import { bootWorld, orderHelpers, type Call, type World } from "./world.js";
import { seedMerchant, type SeededMerchant, type TestDb } from "./helpers.js";

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

type Body = { data: Snap & { id: string; balance: number; checks: Bill[] }; code?: string; message?: string };
type Res<T = Body> = { status: number; body: T };

/** A second merchant in another region, with one product per price given, a cash tender, a card tender and printers. */
async function regionMerchant(name: string, region: { preset: RegionPresetKey } & MerchantSettingsInput, prices: number[]) {
  const m = await seedMerchant(db.sql, name, region);
  await withTransaction(() => seedRulesForMerchant(m.merchantId, presetSeedRules(REGION_PRESETS[region.preset], m.taxClassIds)));
  const t = m.admin.token;
  const must = async <T = Body>(method: string, path: string, body?: unknown): Promise<T> => {
    const r = await call<T>(method, path, { token: t, body });
    if (r.status >= 300) throw new Error(`${method} ${path} -> ${r.status} ${JSON.stringify(r.body)}`);
    return r.body;
  };
  const products = prices.map(() => randomUUID());
  const ids = { menu: randomUUID(), link: randomUUID(), cash: randomUUID(), card: randomUUID() };
  for (const [i, price] of prices.entries()) await must("POST", "/v1/products", { id: products[i], name: `Item ${i + 1}`, price });
  await must("POST", "/v1/menus", { id: ids.menu, brand_id: m.brandId, name: "M", sections: [{ name: "All", items: products.map((product_id) => ({ product_id })) }] });
  await must("POST", "/v1/channel-links", { id: ids.link, channel: "pos", outlet_id: m.outletId, brand_id: m.brandId, menu_id: ids.menu });
  await must("POST", "/v1/printers", { outlet_id: m.outletId, name: "K", ip: "10.0.0.1", is_default_kitchen: true });
  await must("POST", "/v1/printers", { outlet_id: m.outletId, name: "R", ip: "10.0.0.2", role: "receipt" });
  await must("POST", "/v1/tender-types", { id: ids.cash, name: "Cash", is_cash: true });
  await must("POST", "/v1/tender-types", { id: ids.card, name: "Card", is_terminal: true });
  /** A takeaway with the given products (by index), sent to the kitchen. */
  const order = async (lines: { p: number; quantity?: number }[]) => {
    const id = randomUUID();
    await must("POST", "/v1/orders", { order_id: id, order_type: "takeaway", takeaway_ref: "T", outlet_id: m.outletId, brand_id: m.brandId });
    const s = await must("POST", `/v1/orders/${id}/lines`, { lines: lines.map((l) => ({ line_id: randomUUID(), product_id: products[l.p], quantity: l.quantity ?? 1 })) });
    await must("POST", `/v1/orders/${id}/fire`, {});
    return s.data;
  };
  return { m, t, must, call: (method: string, path: string, body?: unknown) => call<Body>(method, path, { token: t, body }), products, ids, order };
}
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

/** What a bill's printed rows add up to: subtotal, the adjustment rows and, in exclusive mode, the tax rows. */
const PROFILE = { width: "80mm", code_page_cjk: false, cut: true } as const;
const rowsAddUp = (d: BillDocument) => d.totals.subtotal + d.adjustments.reduce((x, a) => x + a.amount, 0) + (d.totals.tax_mode === "exclusive" ? d.totals.tax_total : 0);

describe("documents of a paid bill", () => {
  it("the receipt, tax invoice and refund receipt of a paid bill do not change when the rest of the order is re-priced", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() });
    try {
      const s = await h.orderWith(mgr(), [{ product_id: w.ids.laksa, quantity: 1 }, { product_id: w.ids.kopi, quantity: 2 }]);
      expect((await call("POST", `/v1/orders/${s.id}/adjustments`, { token: mgr(), body: { application_id: randomUUID(), rule_key: "seed:percent-off-bill", entered_value: 1000, reason: "regular" } })).status).toBe(200);
      const split = await call<{ data: Snap }>("POST", `/v1/orders/${s.id}/checks/split-even`, { token: mgr(), body: { n: 2 } });
      const bill1 = split.body.data.checks[0]!;
      expect((await h.pay(mgr(), bill1.id, { tender_type_id: w.ids.card, amount: bill1.balance })).status).toBe(200);
      const receipt = () => withTransaction(() => billDocumentFor(bill1.id, "receipt", { jobId: "j1" }));
      const before = await receipt();
      expect(before.adjustments.map((a) => a.name)).toEqual(["% off bill"]);
      expect(rowsAddUp(before)).toBe(before.totals.total);

      // Re-price the order in several ways: a line for the second guest, an item discount on it, and taking it off again.
      const add = await h.add(mgr(), s.id, [{ product_id: w.ids.kopi, quantity: 1 }]);
      expect(add.status).toBe(200);
      const kopi3 = add.body.data.lines.at(-1)!.id;
      const app = randomUUID();
      expect((await call("POST", `/v1/orders/${s.id}/adjustments`, { token: mgr(), body: { application_id: app, rule_key: "seed:percent-off-item", entered_value: 2000, line_ids: [kopi3], reason: "x" } })).status).toBe(200);
      const mid = await receipt();
      expect((await call("DELETE", `/v1/orders/${s.id}/adjustments/${app}`, { token: mgr(), body: { reason: "x" } })).status).toBe(200);
      const after = await receipt();

      for (const d of [mid, after]) {
        expect(JSON.stringify(d)).toBe(JSON.stringify(before));
        expect(Buffer.from(renderBill(d, PROFILE).bytes).equals(Buffer.from(renderBill(before, PROFILE).bytes))).toBe(true);
      }

      // A tax invoice issued after the re-prices is the bill as paid.
      const inv = await call<{ data: { invoice_no: string } }>("POST", `/v1/checks/${bill1.id}/invoice`, { token: mgr(), body: {} });
      expect(inv.status).toBe(200);
      const [row] = await db.sql<{ invoice_document: InvoiceDocument }[]>`select invoice_document from checks where id = ${bill1.id}`;
      const invoice = row!.invoice_document;
      expect(invoice.adjustments).toEqual(before.adjustments);
      expect(invoice.lines).toEqual(before.lines);
      expect(invoice.totals).toEqual(before.totals);
      expect(Buffer.from(await renderInvoicePdf(invoice)).equals(Buffer.from(await renderInvoicePdf(invoice)))).toBe(true);

      // A refund of the whole bill gives back its discount row too.
      const refundId = randomUUID();
      expect((await call("POST", `/v1/checks/${bill1.id}/refunds`, { token: mgr(), body: { refund_id: refundId, request: { kind: "full" }, reason: "returned", print: false } })).status).toBe(201);
      const [stored] = await db.sql<{ receipt_document: BillDocument }[]>`select receipt_document from refunds where id = ${refundId}`;
      const rr = stored!.receipt_document;
      expect(rr.adjustments.map((a) => [a.name, a.amount])).toEqual(before.adjustments.map((a) => [a.name, -a.amount]));
      expect(rowsAddUp(rr)).toBe(rr.totals.total);
    } finally {
      vi.useRealTimers();
    }
  });
});

type ZReport = { sales: { total: number; net: number; tax: number }; tenders: { amount: number }[]; cash: { expected: number; counted: number | null; variance: number | null; cash_payments: number } };

describe("amounts beyond 32 bits", () => {
  for (const [currency, locale, price, zone] of [["IDR", "id-ID", 1_200_000_000, "Asia/Jakarta"], ["VND", "vi-VN", 1_500_000_000, "Asia/Ho_Chi_Minh"]] as const) {
    it(`${currency}: orders, payments, shift close, Z-report, day close and sales summary past 2^31 minor units`, async () => {
      const r = await regionMerchant(`Big ${currency}`, { preset: "blank", timeZone: zone, currency, locale }, [price]);
      const shift = await r.must<{ data: { id: string } }>("POST", "/v1/shifts", { outlet_id: r.m.outletId, station_id: null, float_cents: 0 });
      let taken = 0;
      for (let i = 0; i < 2; i++) {
        const s = await r.order([{ p: 0, quantity: 2 }]);
        expect(s.balance).toBe(2 * price);
        await r.must("POST", `/v1/checks/${s.checks[0]!.id}/payments`, { payment_id: randomUUID(), tender_type_id: r.ids.cash, amount: s.balance });
        taken += s.balance;
      }
      expect(taken).toBeGreaterThan(2 ** 31);
      const z = await r.must<{ data: ZReport }>("GET", `/v1/outlets/${r.m.outletId}/z-report`);
      expect(z.data.sales.total).toBe(taken);
      expect(z.data.tenders.reduce((a, t) => a + t.amount, 0)).toBe(taken);
      expect(z.data.cash.expected).toBe(taken);
      const sum = await r.must<{ data: { totals: { total: number } } }>("GET", `/v1/reports/sales-summary?outlet_id=${r.m.outletId}`);
      expect(sum.data.totals.total).toBe(taken);
      const closed = await r.must<{ data: { variance_cents: number; expected_cash_cents: number } }>("POST", `/v1/shifts/${shift.data.id}/close`, { counted_cash_cents: taken });
      expect(closed.data.expected_cash_cents).toBe(taken);
      expect(closed.data.variance_cents).toBe(0);
      const day = await r.must<{ data: { report: ZReport } }>("POST", `/v1/outlets/${r.m.outletId}/business-days/close`, {});
      expect(day.data.report.sales.total).toBe(taken);
    });
  }

  it("refuses an amount above the largest the register accepts with a validation error, not a 500", async () => {
    const tooBig = await call<Body>("POST", "/v1/products", { token: w.m.admin.token, body: { id: randomUUID(), name: "Too big", price: MAX_AMOUNT + 1 } });
    expect(tooBig.status).toBe(400);
    expect((await call<Body>("POST", "/v1/products", { token: w.m.admin.token, body: { id: randomUUID(), name: "At the limit", price: MAX_AMOUNT } })).status).toBe(201);
    // Each value within the limit, but the line is not: 999 open items at the largest price.
    const o = await h.open(mgr());
    const addLine = (quantity: number, open_price: number): Promise<Res> => call<Body>("POST", `/v1/orders/${o.body.data.id}/lines`, { token: mgr(), body: { lines: [{ line_id: randomUUID(), product_id: w.ids.openItem, quantity, open_price }] } });
    const add = await addLine(999, MAX_AMOUNT);
    expect(add.status).toBe(400);
    expect(add.body.message).toMatch(/largest/);
    const ok = await addLine(1, 2 ** 31);
    expect(ok.status).toBe(200);
    expect(ok.body.data.totals.total).toBe(Math.round(2 ** 31 * 1.09));
  });
});
