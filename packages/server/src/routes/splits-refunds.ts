import type { OpenAPIHono } from "@hono/zod-openapi";
import { and, desc, eq, isNull } from "drizzle-orm";
import { AmountSchema, PERMISSIONS, registerOperations, type OperationSpec } from "@sail/shared";
import { db, markDryRun, settleInvariants } from "../db/client.js";
import { checks, printers, refunds, stations } from "../db/schema/index.js";
import { AppError } from "../lib/errors.js";
import type { AppEnv } from "../lib/context.js";
import { dataResponse, defineOp, errorResponses, jsonBody, jsonResponse, listResponse, mutationResponse, z, untrusted, secret } from "../lib/openapi.js";
import { appendEvent } from "../lib/events.js";
import { recordAudit } from "../lib/audit.js";
import { principalRole, type Principal } from "../auth/principal.js";
import { bumpVersion, getOrderRow, loadSnapshot, lockOrder } from "../services/orders.js";
import { requireRoleOrOverride } from "../services/overrides.js";
import { allocateLines, splitBySeat, splitEven, unsplit } from "../services/splits.js";
import { createRefund, quote, refundableFor } from "../services/refunds.js";
import { voidsPendingOn } from "../services/payment-intents.js";
import { createDigitalReceipt, renderInvoicePdf, type InvoiceDocument } from "../services/documents.js";
import { insertJob } from "../services/printing.js";
import { businessDayInputs } from "../services/business-day.js";

const op = (o: Partial<OperationSpec> & { op: string; summary: string; description: string }): OperationSpec => ({ tier: "T1", minRole: "server", overrideAllowed: false, reasonRequired: false, dryRun: true, principals: ["staff", "agent"], emits: [], mcp: { expose: true, toolsets: ["pos.order"] }, ...o });

registerOperations({
  "checks.split_even": op({ op: "checks.split_even", summary: "Split the bill evenly", description: "N bills, every item shared 1/N. Bills add up to the order to the cent (largest remainder; bill order breaks ties). Only before the first payment.", emits: ["checks.split"] }),
  "checks.split_by_seat": op({ op: "checks.split_by_seat", summary: "Split the bill by seat", description: "One bill per seat number; items without a seat are shared evenly across the seats, or put on a separate Shared bill with `shared: manual`.", emits: ["checks.split"] }),
  "checks.allocate": op({ op: "checks.allocate", summary: "Move or share items between bills", description: "Put each listed item wholly on one bill, or share it equally between the listed bills (a bottle three ways). A paid bill's allocations are locked.", emits: ["checks.allocated"] }),
  "checks.unsplit": op({ op: "checks.unsplit", summary: "Back to one bill", description: "Only before the first payment.", emits: ["checks.split"] }),
  "refunds.quote": op({ op: "refunds.quote", summary: "Quote a refund", description: "Reversal per line, adjustment and tax component, plus the split across the original payments with per-payment caps and cash rounding. Pure: writes nothing. Agents must show these figures, never their own.", tier: "T0", dryRun: false, principals: ["staff", "station", "agent"], mcp: { expose: true, toolsets: ["pos.refund", "pos.read"] } }),
  "refunds.create": op({ op: "refunds.create", summary: "Refund a bill", description: "Full, by lines and quantities, or by amount. Manager, Finance or Admin, or a lower role with a manager override. Reason required. Produces a numbered refund receipt and, when the bill was invoiced, a numbered credit note. Each line's refunds never exceed its paid amount; each payment's refunds never exceed what it paid. Refunded items do not restore daily caps.", tier: "T3", ...PERMISSIONS["refunds.create"], reasonRequired: true, emits: ["refund.created", "check.refunded", "print_job.created"], mcp: { expose: true, toolsets: ["pos.refund"] } }),
  "refunds.list": op({ op: "refunds.list", summary: "Refunds of an order", description: "Refunds with their lines, tenders and document numbers.", tier: "T0", dryRun: false, principals: ["staff", "station", "agent"], mcp: { expose: true, toolsets: ["pos.read", "reports"] } }),
  "refunds.credit_note_pdf": op({ op: "refunds.credit_note_pdf", summary: "Download a credit note PDF", description: "The credit note for a refund against an invoiced bill.", tier: "T0", dryRun: false, principals: ["staff", "station", "agent"], mcp: { expose: false, toolsets: [] } }),
  "refunds.receipt_print": op({ op: "refunds.receipt_print", summary: "Print a refund receipt", description: "Reprints the refund receipt on the station's receipt printer.", emits: ["print_job.created"] }),
  "refunds.receipt_send": op({ op: "refunds.receipt_send", summary: "Send a refund receipt digitally", description: "A public link (QR) for the refund receipt.", tier: "T2", minRole: "cashier", emits: ["receipt.sent"] }),
});

const Mutation = z.object({ expected_version: z.number().int().optional(), dry_run: z.boolean().optional(), override_id: z.uuid().optional() });
const Snapshot = z.record(z.string(), z.unknown());
const OrderMutationResponse = z.object({ data: Snapshot, events: z.array(z.object({ id: z.string(), seq: z.number().int(), type: z.string(), occurredAt: z.string(), businessDate: z.string() })), warnings: z.array(z.string()) });
export const RefundRequestSchema = z.discriminatedUnion("kind", [z.object({ kind: z.literal("full") }), z.object({ kind: z.literal("lines"), lines: z.array(z.object({ line_id: z.uuid(), quantity: z.number().int().min(1) })).min(1) }), z.object({ kind: z.literal("amount"), amount: AmountSchema.min(1) })]);
export const TenderSplit = z.array(z.object({ payment_id: z.uuid(), amount: AmountSchema })).optional();

function dryRunFrom(c: { set(k: "dryRun", v: boolean): void }, body: { dry_run?: boolean }) {
  if (body.dry_run) {
    markDryRun();
    c.set("dryRun", true);
  }
}

const toRefund = (r: typeof refunds.$inferSelect) => ({ id: r.id, order_id: r.orderId, check_id: r.checkId, kind: r.kind, reason: r.reason, refunded_by: r.refundedByName, approved_by: r.approvedByName, business_date: r.businessDate, totals: { base: r.base, discount: r.discount, fee: r.fee, tax: r.tax, taxes: r.taxes, total: r.total }, refund_receipt_no: r.refundReceiptNo, credit_note_no: r.creditNoteNo, created_at: r.createdAt.toISOString() });

export function splitRefundRoutes(app: OpenAPIHono<AppEnv>) {
  const splitRoute = (opId: string, path: string, body: z.ZodTypeAny, run: (order: Awaited<ReturnType<typeof lockOrder>>, b: Record<string, unknown>) => Promise<unknown>, eventType: string) =>
    defineOp(app, { op: opId, method: "post", path, tags: ["bills"], request: { params: z.object({ id: z.uuid() }), body: jsonBody(Mutation.and(body)) }, responses: { 200: jsonResponse(OrderMutationResponse), ...errorResponses } }, async (c) => {
      const p = c.get("principal");
      const { id } = c.req.valid("param");
      const b = c.req.valid("json") as Record<string, unknown> & { expected_version?: number; dry_run?: boolean };
      dryRunFrom(c, b);
      const order = await lockOrder(id, b.expected_version);
      if (order.status === "completed" || order.status === "cancelled") throw AppError.state(`The order is ${order.status}`, []);
      const payload = await run(order, b);
      const version = await bumpVersion(id);
      const snapshot = await loadSnapshot(id);
      await settleInvariants();
      const ev = await appendEvent({ merchantId: order.merchantId, outletId: order.outletId, type: eventType, aggregate: { kind: "order", id, version: order.version }, operationId: opId, payload, correlationId: c.get("correlationId"), idempotencyKey: c.get("idempotencyKey"), businessDay: await businessDayInputs(order.merchantId, order.outletId) }, p);
      return c.json({ data: { ...snapshot, version }, events: [ev], warnings: [] }, 200);
    });

  splitRoute("checks.split_even", "/v1/orders/{id}/checks/split-even", z.object({ n: z.number().int().min(1).max(20) }), async (o, b) => ({ mode: "even", n: b.n, checks: (await splitEven(o, b.n as number)).length }), "checks.split");
  splitRoute("checks.split_by_seat", "/v1/orders/{id}/checks/split-by-seat", z.object({ shared: z.enum(["even", "manual"]).default("even") }), async (o, b) => ({ mode: "seat", shared: b.shared, checks: (await splitBySeat(o, (b.shared as "even" | "manual") ?? "even")).length }), "checks.split");
  splitRoute("checks.allocate", "/v1/orders/{id}/checks/allocate", z.object({ moves: z.array(z.object({ line_id: z.uuid(), check_ids: z.array(z.uuid()).min(1).max(20) })).min(0), add_checks: z.number().int().min(0).max(20).optional() }), async (o, b) => ({ mode: "item", moves: b.moves, checks: (await allocateLines(o, b.moves as { line_id: string; check_ids: string[] }[], (b.add_checks as number) ?? 0)).length }), "checks.allocated");
  splitRoute("checks.unsplit", "/v1/orders/{id}/checks/unsplit", z.object({}), async (o) => ({ mode: "one", checks: (await unsplit(o)).length }), "checks.split");

  defineOp(app, { op: "refunds.quote", method: "post", path: "/v1/checks/{id}/refunds/quote", tags: ["refunds"], request: { params: z.object({ id: z.uuid() }), body: jsonBody(z.object({ request: RefundRequestSchema, tender_split: TenderSplit })) }, responses: { 200: jsonResponse(dataResponse(z.record(z.string(), z.unknown()))), ...errorResponses } }, async (c) => {
    const { id } = c.req.valid("param");
    const b = c.req.valid("json");
    const ref = await refundableFor(id);
    const q = quote(ref, b.request, b.tender_split);
    return c.json({ data: { ...q, check_id: id, remaining_after: { total: ref.check.total - ref.check.refundedTotal - q.totals.total }, payments: ref.paymentsList } }, 200);
  });

  defineOp(
    app,
    { op: "refunds.create", method: "post", path: "/v1/checks/{id}/refunds", tags: ["refunds"], request: { params: z.object({ id: z.uuid() }), body: jsonBody(Mutation.extend({ refund_id: z.uuid(), request: RefundRequestSchema, tender_split: TenderSplit, reason: untrusted(z.string().min(1).max(200)), reference: untrusted(z.string().max(80).nullable().optional()), print: z.boolean().optional() })) }, responses: { 201: jsonResponse(OrderMutationResponse.extend({ refund: z.record(z.string(), z.unknown()) })), ...errorResponses } },
    async (c) => {
      const p = c.get("principal");
      const { id } = c.req.valid("param");
      const b = c.req.valid("json");
      dryRunFrom(c, b);
      const [check] = await db().select().from(checks).where(eq(checks.id, id)).limit(1);
      if (!check) throw AppError.notFound("bill", id);
      const order = await lockOrder(check.orderId, b.expected_version);
      // A void waiting for the provider is already giving money back; a refund on top would give it twice.
      if ((await voidsPendingOn(order.id)) > 0) throw AppError.state("A void of a payment on this order is waiting for the provider", [], "Wait for the terminal to confirm the void, then refund what is still owed back.");
      // The approval covers this request and the total the approver was quoted.
      const total = quote(await refundableFor(id), b.request, b.tender_split).totals.total;
      const approval = await requireRoleOrOverride(p, principalRole(p), PERMISSIONS["refunds.create"].minRole, { action: "refunds.create", targetId: id, args: { request: b.request, tender_split: b.tender_split, total }, overrideId: b.override_id, overrideAllowed: PERMISSIONS["refunds.create"].overrideAllowed });
      const created = await createRefund({ refundId: b.refund_id, checkId: id, request: b.request, tenderSplit: b.tender_split, reason: b.reason, reference: b.reference ?? null, principal: p, approver: approval, overrideId: b.override_id ?? null, stationId: p.type === "staff" ? (p.stationId ?? null) : null });
      const version = await bumpVersion(order.id);
      const snapshot = await loadSnapshot(order.id);
      await settleInvariants();
      const bd = await businessDayInputs(order.merchantId, order.outletId);
      const events = [
        await appendEvent({ merchantId: order.merchantId, outletId: order.outletId, type: "refund.created", aggregate: { kind: "order", id: order.id, version: order.version }, operationId: "refunds.create", payload: { refund_id: created.refund.id, check_id: id, kind: b.request.kind, total: created.quote.totals.total, tenders: created.quote.tenders, refund_receipt_no: created.refund.refundReceiptNo, credit_note_no: created.refund.creditNoteNo }, reason: { text: b.reason }, approval: approval ? { override_id: b.override_id, approver_id: approval.id, approver_name: approval.name ?? undefined } : null, correlationId: c.get("correlationId"), idempotencyKey: c.get("idempotencyKey"), businessDay: bd }, p),
      ];
      events.push(await appendEvent({ merchantId: order.merchantId, outletId: order.outletId, type: "check.refunded", aggregate: { kind: "order", id: order.id, version: order.version }, operationId: "refunds.create", payload: { check_id: id, refunded_total: check.refundedTotal + created.quote.totals.total, total: check.total }, correlationId: c.get("correlationId"), idempotencyKey: c.get("idempotencyKey"), businessDay: bd }, p));
      await recordAudit(p, { action: "refunds.create", targetKind: "check", targetId: id, outletId: order.outletId, reason: b.reason, approver: approval, overrideId: b.override_id ?? null, details: { refund_id: created.refund.id, kind: b.request.kind, total: created.quote.totals.total, refund_receipt_no: created.refund.refundReceiptNo, credit_note_no: created.refund.creditNoteNo } });
      const warnings: string[] = [];
      if (b.print !== false) {
        try {
          const target = await receiptPrinterFor(p, order.outletId);
          await insertJob({ merchantId: order.merchantId, outletId: order.outletId, printer: target, kind: "refund_receipt", payload: { template: "bill", data: created.receipt }, orderId: order.id, checkId: id, refundId: created.refund.id, principal: p, correlationId: c.get("correlationId") });
        } catch (e) {
          warnings.push(`Refund recorded; the receipt did not print: ${(e as AppError).message}`);
        }
      }
      return c.json({ data: { ...snapshot, version }, refund: { ...toRefund(created.refund), quote: created.quote }, events, warnings }, 201);
    },
  );

  defineOp(app, { op: "refunds.list", method: "get", path: "/v1/orders/{id}/refunds", tags: ["refunds"], request: { params: z.object({ id: z.uuid() }) }, responses: { 200: jsonResponse(listResponse(z.record(z.string(), z.unknown()))), ...errorResponses } }, async (c) => {
    const { id } = c.req.valid("param");
    await getOrderRow(id); // 404 for an order the caller cannot see, not an empty list
    const rows = await db().select().from(refunds).where(eq(refunds.orderId, id)).orderBy(desc(refunds.createdAt));
    return c.json({ data: rows.map(toRefund), next_cursor: null }, 200);
  });

  defineOp(app, { op: "refunds.credit_note_pdf", method: "get", path: "/v1/refunds/{id}/credit-note.pdf", tags: ["refunds"], request: { params: z.object({ id: z.uuid() }) }, responses: { 200: { description: "PDF", content: { "application/pdf": { schema: z.string() } } }, ...errorResponses } }, async (c) => {
    const { id } = c.req.valid("param");
    const [r] = await db().select().from(refunds).where(eq(refunds.id, id)).limit(1);
    if (!r?.creditNoteDocument || !r.creditNoteNo) throw AppError.notFound("credit note for refund", id);
    const doc = r.creditNoteDocument as InvoiceDocument;
    const pdf = await renderInvoicePdf(doc, "CREDIT NOTE", { credit_note_no: r.creditNoteNo, original_invoice_no: doc.invoice_no, reason: r.reason });
    return c.body(pdf as unknown as ArrayBuffer, 200, { "content-type": "application/pdf", "content-disposition": `inline; filename="${r.creditNoteNo}.pdf"` });
  });

  defineOp(app, { op: "refunds.receipt_print", method: "post", path: "/v1/refunds/{id}/receipt/print", tags: ["refunds"], request: { params: z.object({ id: z.uuid() }), body: jsonBody(Mutation) }, responses: { 200: jsonResponse(mutationResponse(z.array(z.record(z.string(), z.unknown())))), ...errorResponses } }, async (c) => {
    const p = c.get("principal");
    const { id } = c.req.valid("param");
    const [r] = await db().select().from(refunds).where(eq(refunds.id, id)).limit(1);
    if (!r) throw AppError.notFound("refund", id);
    const target = await receiptPrinterFor(p, r.outletId);
    const job = await insertJob({ merchantId: r.merchantId, outletId: r.outletId, printer: target, kind: "refund_receipt", payload: { template: "bill", data: r.receiptDocument as never }, orderId: r.orderId, checkId: r.checkId, refundId: r.id, principal: p, correlationId: c.get("correlationId") });
    return c.json({ data: [job], events: [], warnings: [] }, 200);
  });

  defineOp(app, { op: "refunds.receipt_send", method: "post", path: "/v1/refunds/{id}/receipt/send", tags: ["refunds"], request: { params: z.object({ id: z.uuid() }), body: jsonBody(Mutation.extend({ channel: z.enum(["qr", "link", "email", "sms"]), destination: untrusted(z.string().max(120).optional()) })) }, responses: { 200: jsonResponse(mutationResponse(z.object({ token: secret(z.string()), url: secret(z.string()), delivery_status: z.string() }))), ...errorResponses } }, async (c) => {
    const p = c.get("principal");
    const { id } = c.req.valid("param");
    const b = c.req.valid("json");
    const [r] = await db().select().from(refunds).where(eq(refunds.id, id)).limit(1);
    if (!r) throw AppError.notFound("refund", id);
    const receipt = await createDigitalReceipt({ merchantId: r.merchantId, outletId: r.outletId, checkId: r.checkId, refundId: r.id, document: r.receiptDocument, channel: b.channel, destination: b.destination ?? null });
    const ev = await appendEvent({ merchantId: r.merchantId, outletId: r.outletId, type: "receipt.sent", aggregate: { kind: "order", id: r.orderId }, operationId: "refunds.receipt_send", payload: { refund_id: id, channel: b.channel }, correlationId: c.get("correlationId"), idempotencyKey: c.get("idempotencyKey"), businessDay: await businessDayInputs(r.merchantId, r.outletId) }, p);
    return c.json({ data: receipt, events: [ev], warnings: receipt.delivery_status === "provider_not_configured" ? [`${b.channel} delivery is not configured; show the QR code or copy the link instead`] : [] }, 200);
  });
}

async function receiptPrinterFor(p: Principal, outletId: string) {
  if (p.type === "staff" && p.stationId) {
    const [st] = await db().select().from(stations).where(eq(stations.id, p.stationId)).limit(1);
    if (st?.receiptPrinterId) {
      const [pr] = await db().select().from(printers).where(and(eq(printers.id, st.receiptPrinterId), isNull(printers.archivedAt))).limit(1);
      if (pr) return pr;
    }
  }
  const [pr] = await db().select().from(printers).where(and(eq(printers.outletId, outletId), eq(printers.role, "receipt"), isNull(printers.archivedAt))).limit(1);
  if (!pr) throw AppError.invariant("no_receipt_printer", "No receipt printer is configured for this station or outlet", "Add a receipt printer in Printing and set it on the station.");
  return pr;
}
