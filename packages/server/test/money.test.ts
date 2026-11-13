import { randomUUID } from "node:crypto";
import { inflateSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { buildBillDocument, documentToText, renderBill, type BillDocument } from "@sail/shared";
import { withTransaction } from "../src/db/client.js";
import { billDocumentFor } from "../src/services/checks.js";
import { renderInvoicePdf, type InvoiceDocument } from "../src/services/documents.js";
import { MAX_AMOUNT, presetSeedRules, REGION_PRESETS, type RegionPresetKey } from "@sail/shared";
import { seedRulesForMerchant } from "../src/services/pricing-rules.js";
import type { MerchantSettingsInput } from "../src/bootstrap.js";
import { bootWorld, orderHelpers, type Call, type World } from "./world.js";
import { seedMerchant, type TestDb } from "./helpers.js";

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

    // Cutting the kopi from 5 to 1 would leave the frozen half-price share of five on one: a free kopi. Refused.
    const cut = await call<{ code: string }>("PATCH", `/v1/orders/${s.id}/lines/${kopi}`, { token: mgr(), body: { quantity: 1 } });
    expect([cut.status, cut.body.code]).toEqual([422, "invariant_violation"]);
    let after = await snapshot(s.id);
    const kopiNow = after.lines.find((l) => l.id === kopi)!.amounts;
    expect(-kopiNow.discount * 2).toBeLessThanOrEqual(kopiNow.base);

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

describe("a bill discount frozen by a payment keeps its rate on the unpaid bills", () => {
  it("a sent line on an unpaid bill cannot be part-voided down to its frozen discount either; voiding it whole is fine", async () => {
    const s = await h.orderWith(mgr(), [{ product_id: w.ids.laksa, quantity: 1 }, { product_id: w.ids.kopi, quantity: 4 }, { product_id: w.ids.laksa, quantity: 1 }]);
    const kopi = s.lines[1]!.id;
    expect((await call("POST", `/v1/orders/${s.id}/adjustments`, { token: mgr(), body: { application_id: randomUUID(), rule_key: "seed:percent-off-bill", entered_value: 5000, reason: "regular" } })).status).toBe(200);
    await call("POST", `/v1/orders/${s.id}/checks/allocate`, { token: mgr(), body: { moves: [], add_checks: 1 } });
    const bill2 = (await snapshot(s.id)).checks[1]!.id;
    const moved = await call<{ data: Snap }>("POST", `/v1/orders/${s.id}/checks/allocate`, { token: mgr(), body: { moves: [{ line_id: kopi, check_ids: [bill2] }, { line_id: s.lines[2]!.id, check_ids: [bill2] }] } });
    const bill1 = moved.body.data.checks[0]!;
    expect((await h.fire(mgr(), s.id)).status).toBe(200);
    expect((await h.pay(mgr(), bill1.id, { tender_type_id: w.ids.card, amount: bill1.balance })).status).toBe(200);
    const part = await call<{ code: string }>("POST", `/v1/orders/${s.id}/lines/${kopi}/void`, { token: mgr(), body: { quantity: 3, reason_text: "sent back" } });
    expect(part.status).toBe(422);
    for (const l of (await snapshot(s.id)).lines) if (l.amounts.base > 0) expect(-l.amounts.discount * 2).toBeLessThanOrEqual(l.amounts.base);
    expect((await call("POST", `/v1/orders/${s.id}/lines/${kopi}/void`, { token: mgr(), body: { reason_text: "sent back" } })).status).toBe(200);
    const after = await snapshot(s.id);
    expect(after.checks[1]!.totals.total).toBe(Math.round(800 * 1.09));
  });
});

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
      // The POS shows each line of a bill at its share of the menu price (the allocation's base): the receipt's line amounts.
      const shownOnPos = async () => (await call<{ data: { checks: { id: string; allocations: { base: number }[] }[] } }>("GET", `/v1/orders/${s.id}`, { token: mgr() })).body.data.checks.find((c) => c.id === bill1.id)!.allocations.map((a) => a.base).sort((a, b) => a - b);
      const shownBefore = await shownOnPos();
      expect(shownBefore).toEqual(before.lines.map((l) => l.amount).sort((a, b) => a - b));
      expect(shownBefore.reduce((a, b) => a + b, 0)).toBe(before.totals.subtotal);

      // Re-price the order in several ways: a line for the second guest, an item discount on it, and taking it off again.
      const add = await h.add(mgr(), s.id, [{ product_id: w.ids.kopi, quantity: 1 }]);
      expect(add.status).toBe(200);
      const kopi3 = add.body.data.lines.at(-1)!.id;
      const app = randomUUID();
      expect((await call("POST", `/v1/orders/${s.id}/adjustments`, { token: mgr(), body: { application_id: app, rule_key: "seed:percent-off-item", entered_value: 2000, line_ids: [kopi3], reason: "x" } })).status).toBe(200);
      const mid = await receipt();
      expect((await call("DELETE", `/v1/orders/${s.id}/adjustments/${app}`, { token: mgr(), body: { reason: "x" } })).status).toBe(200);
      const after = await receipt();

      expect(await shownOnPos()).toEqual(shownBefore);
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

describe("currencies on PDF documents", () => {
  /** The strings a PDF draws, decoded from its content streams as WinAnsi bytes. */
  const pdfStrings = (pdf: Uint8Array) => {
    const raw = Buffer.from(pdf).toString("latin1");
    const streams = [...raw.matchAll(/stream\r?\n([\s\S]*?)endstream/g)].map((m) => {
      try {
        return inflateSync(Buffer.from(m[1]!, "latin1")).toString("latin1");
      } catch {
        return m[1]!;
      }
    });
    return (streams.join("\n").match(/<([0-9A-Fa-f]+)> Tj/g) ?? []).map((x) => Buffer.from(x.slice(1, x.indexOf(">")), "hex").toString("latin1"));
  };
  const invoice = (currency: string, exponent: number, locale: string): InvoiceDocument => ({
    header: { outlet_name: "O", brand_name: "B", order_no: "P-0001", order_type: "takeaway", printed_at: "2026-01-01T00:00:00Z", job_id: "j", time_zone: "UTC", locale },
    kind: "receipt",
    currency,
    currency_exponent: exponent,
    check_label: "Bill 1",
    lines: [{ quantity: 1, name: "Item", unit_price: 2125, amount: 2125, modifiers: [] }],
    adjustments: [],
    totals: { subtotal: 2125, discount_total: 0, fee_total: 0, tax_total: 0, taxes: [], total: 2125, tax_mode: "exclusive" },
    payments: [],
    invoice_no: "INV-000001",
    invoice: { number: "INV-000001", issued_at: "2026-01-01T00:00:00Z", merchant_name: "M", outlet_address: null },
  });
  for (const [currency, exponent, locale, shows] of [["EUR", 2, "de-DE", "21,25\u00a0\u0080"], ["EUR", 2, "fr-FR", "21,25\u00a0\u0080"], ["JPY", 0, "ja-JP", "\u00a52,125"], ["KWD", 3, "ar-KW", "2.125"], ["SGD", 2, "en-SG", "$21.25"]] as const) {
    it(`${currency} in ${locale} prints its amounts and symbol, never a "?"`, async () => {
      const strings = pdfStrings(await renderInvoicePdf(invoice(currency, exponent, locale)));
      const amounts = strings.filter((x) => /\d/.test(x) && x.includes("2"));
      expect(amounts.some((x) => x.includes(shows)), JSON.stringify(strings)).toBe(true);
      expect(strings.filter((x) => x.includes("?"))).toEqual([]);
    });
  }
  it("a cash payment's rounding, tip and change are rows on the PDF, as on the thermal and the digital receipt", async () => {
    const doc = { ...invoice("CHF", 2, "de-CH"), payments: [{ tender: "Cash", amount: 2125, rounding_cents: 0, tip: 300, change: 575 }] };
    const pdf = pdfStrings(await renderInvoicePdf(doc));
    const thermal = documentToText(buildBillDocument(doc, 48), 48);
    for (const label of ["Tip", "Change"]) {
      expect(pdf, label).toContain(label);
      expect(thermal, label).toContain(label);
    }
    expect(pdf.indexOf("Tip")).toBeLessThan(pdf.indexOf("Change"));
    expect(thermal.indexOf("Tip")).toBeLessThan(thermal.indexOf("Change"));
  });
});

describe("split bills print rows that add up", () => {
  it("a 0.04 item with two 25% item discounts split three ways: each bill's discount rows add up to its discount", async () => {
    const s = await h.orderWith(mgr(), [{ product_id: w.ids.openItem, quantity: 1, open_price: 4 }]);
    for (const v of [2500, 2500]) expect((await call("POST", `/v1/orders/${s.id}/adjustments`, { token: mgr(), body: { application_id: randomUUID(), rule_key: "seed:percent-off-item", entered_value: v, line_ids: [s.lines[0]!.id], reason: "x" } })).status).toBe(200);
    const split = await call<{ data: Snap }>("POST", `/v1/orders/${s.id}/checks/split-even`, { token: mgr(), body: { n: 3 } });
    const docs = await withTransaction(() => Promise.all(split.body.data.checks.map((c) => billDocumentFor(c.id, "prebill"))));
    for (const d of docs) {
      expect(d.adjustments.filter((a) => a.kind === "discount").reduce((x, a) => x + a.amount, 0)).toBe(d.totals.discount_total);
      expect(rowsAddUp(d)).toBe(d.totals.total);
      expect(d.totals.total).toBeGreaterThanOrEqual(0);
    }
  });
});

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

  it("pricing.simulate refuses lines above the largest amount with a validation error, as an order does", async () => {
    const simulate = (lines: unknown[]) => call<Body>("POST", "/v1/pricing/simulate", { token: w.m.admin.token, body: { outlet_id: w.m.outletId, brand_id: w.m.brandId, order_type: "takeaway", lines } });
    expect((await simulate([{ product_id: w.ids.openItem, quantity: 100_000, open_price: MAX_AMOUNT }])).status).toBe(400);
    const tooMany = await simulate([{ product_id: w.ids.openItem, quantity: 999, open_price: MAX_AMOUNT }]);
    expect([tooMany.status, tooMany.body.message]).toEqual([400, expect.stringMatching(/largest/)]);
    const full = { line_id: "x", product_id: "p", tax_class_id: "t", quantity: 3, prices: { base: MAX_AMOUNT } };
    expect((await simulate([full])).status).toBe(400);
    expect((await simulate([{ ...full, prices: { base: MAX_AMOUNT + 1 }, quantity: 1 }])).status).toBe(400);
    expect((await simulate([{ product_id: w.ids.openItem, quantity: 1, open_price: MAX_AMOUNT }])).status).toBe(200);
  });
});

describe("refunds", () => {
  const refund = (checkId: string, request: unknown, tender_split?: unknown) => call<Body & { refund: { totals: { total: number }; quote: { cash_out: number; tenders: { payment_id: string; amount: number }[] } } }>("POST", `/v1/checks/${checkId}/refunds`, { token: mgr(), body: { refund_id: randomUUID(), request, tender_split, reason: "returned", print: false } });

  it("refunding the units of a line one at a time gives back the whole line and refunds the bill", async () => {
    const s = await h.orderWith(mgr(), [{ product_id: w.ids.openItem, quantity: 3, open_price: 1004 }]);
    await h.fire(mgr(), s.id);
    expect((await h.pay(mgr(), s.checks[0]!.id, { tender_type_id: w.ids.card, amount: s.balance })).status).toBe(200);
    for (let i = 0; i < 3; i++) expect((await refund(s.checks[0]!.id, { kind: "lines", lines: [{ line_id: s.lines[0]!.id, quantity: 1 }] })).status).toBe(201);
    const [chk] = await db.sql<{ total: number; refunded_total: number; status: string }[]>`select total, refunded_total, status from checks where id = ${s.checks[0]!.id}`;
    expect(chk).toEqual({ total: 3283, refunded_total: 3283, status: "refunded" });
  });

  it("a tender split naming one payment twice is refused as more than that payment took, in the quote and the refund", async () => {
    const s = await h.orderWith(mgr(), [{ product_id: w.ids.laksa, quantity: 1 }]);
    await h.fire(mgr(), s.id);
    const half = Math.floor(s.balance / 2);
    const card = randomUUID();
    await h.pay(mgr(), s.checks[0]!.id, { payment_id: card, tender_type_id: w.ids.card, amount: half });
    await h.pay(mgr(), s.checks[0]!.id, { tender_type_id: w.ids.card, amount: s.balance - half });
    const split = [{ payment_id: card, amount: half }, { payment_id: card, amount: s.balance - half }];
    const quote = await call<Body>("POST", `/v1/checks/${s.checks[0]!.id}/refunds/quote`, { token: mgr(), body: { request: { kind: "full" }, tender_split: split } });
    expect(quote.status).toBe(422);
    const r = await refund(s.checks[0]!.id, { kind: "full" }, split);
    expect(r.status).toBe(422);
    expect(r.body.message).toMatch(/at most/);
  });

  it("repeated small cash refunds never hand out more cash than was taken (eu-vat, 0.05 rounding)", async () => {
    const r = await regionMerchant("Euro5", { preset: "eu-vat", timeZone: "Europe/Amsterdam", cashRoundingIncrement: 5 }, [1002]);
    await r.must("POST", "/v1/shifts", { outlet_id: r.m.outletId, station_id: null, float_cents: 0 });
    const s = await r.order([{ p: 0 }]);
    await r.must("POST", `/v1/checks/${s.checks[0]!.id}/payments`, { payment_id: randomUUID(), tender_type_id: r.ids.cash, amount: 1002, tendered: 1000 });
    let cashOut = 0;
    for (let n = 0; n < 40; n++) {
      const res = await call<{ refund: { quote: { cash_out: number } } }>("POST", `/v1/checks/${s.checks[0]!.id}/refunds`, { token: r.t, body: { refund_id: randomUUID(), request: { kind: "amount", amount: 3 }, reason: "goodwill", print: false } });
      expect(res.status).toBe(201);
      cashOut += res.body.refund.quote.cash_out;
    }
    // 40 × 0.03 = 1.20 refunded: the drawer pays out 1.20, rounded on the running total, not 40 × 0.05 = 2.00.
    expect(cashOut).toBe(120);
    const z = await r.must<{ data: ZReport & { cash: { refunds: number } } }>("GET", `/v1/outlets/${r.m.outletId}/z-report`);
    expect(z.data.cash.refunds).toBe(120);
  });
});

type Recon = { tenders: number; sales_total: number; paid_on_other_orders: number; paid_elsewhere: number };
type Z = ZReport & { reversals: { count: number; amount: number; cash_amount: number; items: { payment_id: string; amount: number; tender: string; reason: string | null; reversed_by: string | null }[] }; reconciliation: Recon; scope: { business_date: string } };
const tendersOf = (z: Z) => z.tenders.reduce((a, t) => a + t.amount, 0);
const reconciles = (z: Z) => {
  expect(z.reconciliation.tenders).toBe(tendersOf(z));
  expect(z.reconciliation.sales_total).toBe(z.sales.total);
  expect(z.reconciliation.tenders).toBe(z.reconciliation.sales_total + z.reconciliation.paid_on_other_orders - z.reconciliation.paid_elsewhere);
};

describe("shifts, business days and the Z-report", () => {
  it("the Z-report and sales summary give refunded tax by component, so the tax due can be read off them", async () => {
    const r = await regionMerchant("VatBack", { preset: "eu-vat", timeZone: "Europe/Amsterdam" }, [1210]);
    const s = await r.order([{ p: 0, quantity: 2 }]);
    await r.must("POST", `/v1/checks/${s.checks[0]!.id}/payments`, { payment_id: randomUUID(), tender_type_id: r.ids.card, amount: s.balance });
    const lineId = (await db.sql<{ id: string }[]>`select id from order_lines where order_id = ${s.id}`)[0]!.id;
    await r.must("POST", `/v1/checks/${s.checks[0]!.id}/refunds`, { refund_id: randomUUID(), request: { kind: "lines", lines: [{ line_id: lineId, quantity: 1 }] }, reason: "returned", print: false });
    const [refund] = await db.sql<{ taxes: { name: string; bps: number; amount: number }[] }[]>`select taxes from refunds where order_id = ${s.id}`;
    expect(refund!.taxes.reduce((a, t) => a + t.amount, 0)).toBeGreaterThan(0);
    const z = (await r.must<{ data: Z & { refunds: { taxes: { name: string; bps: number; amount: number }[] } } }>("GET", `/v1/outlets/${r.m.outletId}/z-report`)).data;
    expect(z.refunds.taxes).toEqual(refund!.taxes);
    const sum = (await r.must<{ data: { refunds: { taxes: { name: string; bps: number; amount: number }[] } } }>("GET", `/v1/reports/sales-summary?outlet_id=${r.m.outletId}`)).data;
    expect(sum.refunds.taxes).toEqual(refund!.taxes);
  });

  it("orders.reopen refuses to reverse a payment whose shift or business day is closed, as payments.void does", async () => {
    const r = await regionMerchant("Reopen", { preset: "sg", timeZone: "Asia/Singapore" }, [2000]);
    const shift = await r.must<{ data: { id: string } }>("POST", "/v1/shifts", { outlet_id: r.m.outletId, station_id: null, float_cents: 10_000 });
    const s = await r.order([{ p: 0 }]);
    const pid = randomUUID();
    await r.must("POST", `/v1/checks/${s.checks[0]!.id}/payments`, { payment_id: pid, tender_type_id: r.ids.cash, amount: s.balance });
    await r.must("POST", `/v1/shifts/${shift.data.id}/close`, { counted_cash_cents: 10_000 + s.balance });
    const voidTry = await call<{ details: { invariant: string } }>("POST", `/v1/payments/${pid}/void`, { token: r.t, body: { reason: "x" } });
    expect([voidTry.status, voidTry.body.details.invariant]).toEqual([422, "shift_closed"]);
    const reopen = await call<{ details: { invariant: string } }>("POST", `/v1/orders/${s.id}/reopen`, { token: r.t, body: { reason: "changed order" } });
    expect([reopen.status, reopen.body.details.invariant]).toEqual([422, "shift_closed"]);
    const [p] = await db.sql<{ status: string }[]>`select status from payments where id = ${pid}`;
    expect(p!.status).toBe("recorded");
    await r.must("POST", `/v1/outlets/${r.m.outletId}/business-days/close`, {});
    const afterClose = await call<{ details: { invariant: string } }>("POST", `/v1/orders/${s.id}/reopen`, { token: r.t, body: { reason: "changed order" } });
    expect(afterClose.status).toBe(422);
  });

  it("a voided payment shows in the Z-report and the exceptions report, with who reversed it and why", async () => {
    const r = await regionMerchant("Voids", { preset: "sg", timeZone: "Asia/Singapore" }, [1600]);
    await r.must("POST", "/v1/shifts", { outlet_id: r.m.outletId, station_id: null, float_cents: 0 });
    const s = await r.order([{ p: 0 }]);
    const pid = randomUUID();
    await r.must("POST", `/v1/checks/${s.checks[0]!.id}/payments`, { payment_id: pid, tender_type_id: r.ids.cash, amount: s.balance });
    await r.must("POST", `/v1/payments/${pid}/void`, { reason: "wrong bill" });
    const z = (await r.must<{ data: Z }>("GET", `/v1/outlets/${r.m.outletId}/z-report`)).data;
    expect(z.cash.cash_payments).toBe(0);
    expect(z.reversals).toMatchObject({ count: 1, amount: s.balance, cash_amount: s.balance });
    expect(z.reversals.items[0]).toMatchObject({ payment_id: pid, amount: s.balance, tender: "Cash", reversed_by: "Ada Admin" });
    expect(z.reversals.items[0]!.reason).toMatch(/wrong bill/);
    const ex = (await r.must<{ data: { payment_reversals: { order_no: string; amount: number; reason: string; reversed_by: string }[] } }>("GET", `/v1/reports/exceptions?outlet_id=${r.m.outletId}`)).data;
    expect(ex.payment_reversals).toHaveLength(1);
    expect(ex.payment_reversals[0]).toMatchObject({ amount: s.balance, reversed_by: "Ada Admin" });
  });

  it("an order opened before the cutoff and paid after it counts on its shift's business day: the day closes with no false variance", async () => {
    const r = await regionMerchant("Cutoff", { preset: "sg", timeZone: "Asia/Singapore" }, [1600]);
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const real = Date.now();
      const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Singapore" }).format(new Date(real));
      let cut = Date.parse(`${today}T04:00:00+08:00`);
      if (cut > real - 11 * 60_000) cut -= 86_400_000;
      const day1 = new Date(cut - 86_400_000 + 8 * 3_600_000).toISOString().slice(0, 10);
      vi.setSystemTime(new Date(cut - 10 * 60_000)); // 03:50
      const shift = await r.must<{ data: { id: string; business_date: string } }>("POST", "/v1/shifts", { outlet_id: r.m.outletId, station_id: null, float_cents: 20_000 });
      expect(shift.data.business_date).toBe(day1);
      const s = await r.order([{ p: 0 }]);
      vi.setSystemTime(new Date(cut + 10 * 60_000)); // 04:10, the next business day by the clock
      await r.must("POST", `/v1/checks/${s.checks[0]!.id}/payments`, { payment_id: randomUUID(), tender_type_id: r.ids.cash, amount: s.balance });
      const [pay] = await db.sql<{ business_date: string }[]>`select business_date::text from payments where order_id = ${s.id}`;
      expect(pay!.business_date).toBe(day1);
      const closed = await r.must<{ data: { variance_cents: number } }>("POST", `/v1/shifts/${shift.data.id}/close`, { counted_cash_cents: 20_000 + s.balance });
      expect(closed.data.variance_cents).toBe(0);
      const day = await r.must<{ data: { report: Z } }>("POST", `/v1/outlets/${r.m.outletId}/business-days/close`, { business_date: day1 });
      expect(day.data.report.sales.total).toBe(s.balance);
      expect(tendersOf(day.data.report)).toBe(s.balance);
      expect(day.data.report.cash).toMatchObject({ expected: 20_000 + s.balance, counted: 20_000 + s.balance, variance: 0 });
      reconciles(day.data.report);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a sale opened on one station and paid on another: each station's Z-report says where its tenders and sales went", async () => {
    const o = await h.open(mgr());
    const a = await h.add(mgr(), o.body.data.id, [{ product_id: w.ids.laksa, quantity: 1 }]);
    await h.fire(mgr(), o.body.data.id);
    expect((await call("POST", `/v1/checks/${a.body.data.checks[0]!.id}/payments`, { token: w.pins.cashierStation2, body: { payment_id: randomUUID(), tender_type_id: w.ids.card, amount: a.body.data.balance } })).status).toBe(200);
    for (const station of [w.ids.station, w.ids.station2]) {
      const z = (await call<{ data: Z }>("GET", `/v1/outlets/${w.m.outletId}/z-report?station_id=${station}`, { token: w.m.admin.token })).body.data;
      reconciles(z);
    }
    const z2 = (await call<{ data: Z }>("GET", `/v1/outlets/${w.m.outletId}/z-report?station_id=${w.ids.station2}`, { token: w.m.admin.token })).body.data;
    expect(z2.reconciliation.paid_on_other_orders).toBeGreaterThanOrEqual(a.body.data.balance);
    const z1 = (await call<{ data: Z }>("GET", `/v1/outlets/${w.m.outletId}/z-report?station_id=${w.ids.station}`, { token: w.m.admin.token })).body.data;
    expect(z1.reconciliation.paid_elsewhere).toBeGreaterThanOrEqual(a.body.data.balance);
    const all = (await call<{ data: Z }>("GET", `/v1/outlets/${w.m.outletId}/z-report`, { token: w.m.admin.token })).body.data;
    reconciles(all);
  });

  it("a payment with no station or no shift still counts as paid elsewhere, so the station's and the shift's Z-reports reconcile", async () => {
    // Opened on station 1, paid by card by an admin signed in with no station.
    const o = await h.open(mgr());
    const a = await h.add(mgr(), o.body.data.id, [{ product_id: w.ids.laksa, quantity: 1 }]);
    await h.fire(mgr(), o.body.data.id);
    expect((await call("POST", `/v1/checks/${a.body.data.checks[0]!.id}/payments`, { token: w.m.admin.token, body: { payment_id: randomUUID(), tender_type_id: w.ids.card, amount: a.body.data.balance } })).status).toBe(200);
    const [row] = await db.sql<{ station_id: string | null }[]>`select station_id from payments where order_id = ${o.body.data.id}`;
    expect(row!.station_id).toBeNull();
    reconciles((await call<{ data: Z }>("GET", `/v1/outlets/${w.m.outletId}/z-report?station_id=${w.ids.station}`, { token: w.m.admin.token })).body.data);
    // Paid by card before any shift opened, then a shift opens and closes.
    const r = await regionMerchant("NoShiftCard", { preset: "sg", timeZone: "Asia/Singapore" }, [1940]);
    const s = await r.order([{ p: 0 }]);
    await r.must("POST", `/v1/checks/${s.checks[0]!.id}/payments`, { payment_id: randomUUID(), tender_type_id: r.ids.card, amount: s.balance });
    const shift = await r.must<{ data: { id: string } }>("POST", "/v1/shifts", { outlet_id: r.m.outletId, station_id: null, float_cents: 0 });
    const closed = await r.must<{ data: { report: Z } }>("POST", `/v1/shifts/${shift.data.id}/close`, { counted_cash_cents: 0 });
    reconciles(closed.data.report);
  });

  it("yesterday's business day still closes after the morning crew has opened today's shift", async () => {
    const r = await regionMerchant("Morning", { preset: "sg", timeZone: "Asia/Singapore" }, [180]);
    const night = await r.must<{ data: { id: string; business_date: string } }>("POST", "/v1/shifts", { outlet_id: r.m.outletId, station_id: null, float_cents: 0 });
    const s = await r.order([{ p: 0 }]);
    await r.must("POST", `/v1/checks/${s.checks[0]!.id}/payments`, { payment_id: randomUUID(), tender_type_id: r.ids.cash, amount: s.balance });
    await r.must("POST", `/v1/shifts/${night.data.id}/close`, { counted_cash_cents: s.balance });
    // Past the cutoff the next day's crew opens its drawer before anyone has closed the night.
    const morning = await r.must<{ data: { id: string } }>("POST", "/v1/shifts", { outlet_id: r.m.outletId, station_id: null, float_cents: 0 });
    const next = new Date(Date.parse(`${night.data.business_date}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
    await db.sql`update shifts set business_date = ${next} where id = ${morning.data.id}`;
    const closed = await call<{ data: { business_date: string; report: Z } }>("POST", `/v1/outlets/${r.m.outletId}/business-days/close`, { token: r.t, body: { business_date: night.data.business_date } });
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    expect(closed.body.data.report.sales.total).toBe(s.balance);
  });

  it("cash needs an open shift; a business day closes once, only with its orders settled, and later activity goes to the next day", async () => {
    const r = await regionMerchant("Close", { preset: "sg", timeZone: "Asia/Singapore" }, [180, 12_000]);
    const s1 = await r.order([{ p: 0 }]);
    const noShift = await call<{ details: { invariant: string } }>("POST", `/v1/checks/${s1.checks[0]!.id}/payments`, { token: r.t, body: { payment_id: randomUUID(), tender_type_id: r.ids.cash, amount: s1.balance } });
    expect([noShift.status, noShift.body.details.invariant]).toEqual([422, "no_open_shift"]);
    // A card needs no drawer.
    await r.must("POST", `/v1/checks/${s1.checks[0]!.id}/payments`, { payment_id: randomUUID(), tender_type_id: r.ids.card, amount: s1.balance });
    const open = await r.order([{ p: 1 }]);
    const refused = await call<{ details: { invariant: string } }>("POST", `/v1/outlets/${r.m.outletId}/business-days/close`, { token: r.t, body: {} });
    expect([refused.status, refused.body.details.invariant]).toEqual([422, "open_orders"]);
    await r.must("POST", `/v1/checks/${open.checks[0]!.id}/payments`, { payment_id: randomUUID(), tender_type_id: r.ids.card, amount: open.balance });
    const closed = await r.must<{ data: { business_date: string; report: Z } }>("POST", `/v1/outlets/${r.m.outletId}/business-days/close`, {});
    const day = closed.data.business_date;
    expect(closed.data.report.sales.total).toBe(s1.balance + open.balance);
    expect((await call("POST", `/v1/outlets/${r.m.outletId}/business-days/close`, { token: r.t, body: {} })).status).toBe(409);
    // After the early close, a new order, shift and payment are dated on the next business day; the closed day's report stands.
    const late = await r.order([{ p: 1 }]);
    const shift = await r.must<{ data: { id: string; business_date: string } }>("POST", "/v1/shifts", { outlet_id: r.m.outletId, station_id: null, float_cents: 0 });
    await r.must("POST", `/v1/checks/${late.checks[0]!.id}/payments`, { payment_id: randomUUID(), tender_type_id: r.ids.cash, amount: late.balance });
    const [row] = await db.sql<{ order_day: string; pay_day: string }[]>`select o.business_date::text as order_day, p.business_date::text as pay_day from orders o join payments p on p.order_id = o.id where o.id = ${late.id}`;
    expect(row!.order_day).not.toBe(day);
    expect(row!.pay_day).toBe(row!.order_day);
    expect(shift.data.business_date).toBe(row!.order_day);
    // The POS lists today's orders and the back office its reports by the floor's business date: it must be the day the
    // late order is dated on, or the order taken after the early close cannot be found to reprint, refund or reopen.
    const floor = await r.must<{ data: { business_date: string } }>("GET", `/v1/outlets/${r.m.outletId}/floor`);
    expect(floor.data.business_date).toBe(row!.order_day);
    const stored = await r.must<{ data: Z }>("GET", `/v1/outlets/${r.m.outletId}/z-report?business_date=${day}`);
    expect(stored.data.sales.total).toBe(closed.data.report.sales.total);
    expect(tendersOf(stored.data)).toBe(tendersOf(closed.data.report));
    // The next day has not started on the clock, so it cannot be closed yet.
    expect((await call("POST", `/v1/outlets/${r.m.outletId}/business-days/close`, { token: r.t, body: { business_date: row!.order_day } })).status).toBe(409);
  });
});
