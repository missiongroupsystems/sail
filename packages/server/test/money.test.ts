import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { renderBill, type BillDocument } from "@sail/shared";
import { withTransaction } from "../src/db/client.js";
import { billDocumentFor } from "../src/services/checks.js";
import { renderInvoicePdf, type InvoiceDocument } from "../src/services/documents.js";
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
