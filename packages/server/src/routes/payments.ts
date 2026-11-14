import type { OpenAPIHono } from "@hono/zod-openapi";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { AmountSchema, PERMISSIONS, registerOperations, roleAtLeast, type OperationSpec } from "@sail/shared";
import { db, markDryRun, settleInvariants, withTransaction } from "../db/client.js";
import { checks, orders, paymentIntents, payments, printers, shifts, stations, tenderTypes } from "../db/schema/index.js";
import { AppError } from "../lib/errors.js";
import type { AppEnv } from "../lib/context.js";
import { dataResponse, defineOp, errorResponses, jsonBody, jsonResponse, listResponse, mutationResponse, z, untrusted, secret } from "../lib/openapi.js";
import { appendEvent, type AppendedEvent } from "../lib/events.js";
import { recordAudit } from "../lib/audit.js";
import { outletVisible, principalRole, type Principal } from "../auth/principal.js";
import { bumpVersion, loadSnapshot, lockOrder, repriceOrder } from "../services/orders.js";
import { requireRoleOrOverride } from "../services/overrides.js";
import { billDocumentFor, syncAllocations } from "../services/checks.js";
import { maybeComplete, paymentRole, recordPayment, reopenOrder } from "../services/payments.js";
import { createDigitalReceipt, issueInvoice, readDigitalReceipt, renderInvoicePdf, type InvoiceDocument } from "../services/documents.js";
import { closeBusinessDay, closeShift, openShift, zReport } from "../services/shifts.js";
import { insertJob } from "../services/printing.js";
import { businessDayInputs, currentBusinessDate } from "../services/business-day.js";
import { businessDateFor } from "../lib/time.js";
import { LocaleSettingsSchema, localeSettingsFor } from "./org.js";

const op = (o: Partial<OperationSpec> & { op: string; summary: string; description: string }): OperationSpec => ({ tier: "T2", minRole: "cashier", overrideAllowed: false, reasonRequired: false, dryRun: true, principals: ["staff", "agent"], emits: [], mcp: { expose: true, toolsets: ["pos.payment"] }, ...o });

registerOperations({
  "payments.record": op({ op: "payments.record", summary: "Record a payment on a bill", description: "Applies a tender to the bill's balance. Non-cash amounts cannot exceed the balance. Cash rounding applies only to a cash tender that settles the balance and is returned as rounding_cents; the register computes change due. A tip is `tip_cents`, or, on a dry run only, `tip_bps` (a percentage of the amount applied, which the dry run turns into `tip_cents`; in cash it is rounded to the cash rounding step); the reply's `payment.due_cents` is what the guest hands over (amount, cash rounding and tip). The first payment freezes order-level pricing and locks the bill's allocations. When every bill is paid and every item is sent, the order completes. Idempotent by payment_id.", ...PERMISSIONS["payments.record"], emits: ["payment.recorded", "check.paid", "order.completed"] }),
  "orders.complete": op({ op: "orders.complete", summary: "Complete an order", description: "Every bill paid (balance 0) and every item sent or removed.", minRole: "server", tier: "T2", emits: ["order.completed"], mcp: { expose: true, toolsets: ["pos.order"] } }),
  "orders.reopen": op({ op: "orders.reopen", summary: "Reopen a completed order", description: "Same business day, Manager+ (or override). Reverses the order's payments as events and unlocks the bills; the order is then recharged.", tier: "T3", ...PERMISSIONS["orders.reopen"], reasonRequired: true, emits: ["order.reopened", "payment.reversed"], mcp: { expose: true, toolsets: ["pos.order"] } }),
  "checks.print_prebill": op({ op: "checks.print_prebill", summary: "Print a pre-bill", description: "Prints the bill (or every bill of the order) on the station's receipt printer and marks the table as bill requested.", tier: "T1", minRole: "server", emits: ["print_job.created", "order.bill_requested"], mcp: { expose: true, toolsets: ["pos.order"] } }),
  "receipts.print": op({ op: "receipts.print", summary: "Print a receipt", description: "Prints the receipt for a paid bill on the station's receipt printer.", tier: "T1", minRole: "server", emits: ["print_job.created"] }),
  "receipts.send": op({ op: "receipts.send", summary: "Send a digital receipt", description: "Creates a receipt link (for a QR code on screen) or queues an email/SMS. Email and SMS need a provider, which is not configured yet; the link always works.", tier: "T2", minRole: "cashier", emits: ["receipt.sent"] }),
  "receipts.read": op({ op: "receipts.read", summary: "Read a digital receipt", description: "Public, by token: the receipt document for the guest's phone.", tier: "T0", minRole: null, principals: [], dryRun: false, mcp: { expose: false, toolsets: [] } }),
  "documents.issue_invoice": op({ op: "documents.issue_invoice", summary: "Issue a tax invoice", description: "Numbered PDF tax invoice for a paid bill, including the outlet's business and tax registration numbers. Gap-free numbering per merchant. Issued once; later calls return the same number.", ...PERMISSIONS["documents.issue_invoice"], emits: ["invoice.issued"] }),
  "documents.invoice_pdf": op({ op: "documents.invoice_pdf", summary: "Download an invoice PDF", description: "The PDF for an issued invoice.", tier: "T0", minRole: "server", dryRun: false, principals: ["staff", "station", "agent"], mcp: { expose: false, toolsets: [] } }),
  "checks.list": op({ op: "checks.list", summary: "Bills of an order", description: "Checks with allocations, payments and balances.", tier: "T0", minRole: "server", dryRun: false, principals: ["staff", "station", "agent"], mcp: { expose: true, toolsets: ["pos.read"] } }),
  "shifts.open": op({ op: "shifts.open", summary: "Open a shift", description: "With a counted float. One open shift per station (or per outlet when no station).", ...PERMISSIONS["shifts.open"], emits: ["shift.opened"] }),
  "shifts.close": op({ op: "shifts.close", summary: "Close a shift", description: "With the counted cash. Returns expected vs counted cash including rounding, and the shift's Z figures. A variance above the merchant's `cash_variance_threshold` needs `variance_reason`; without one the close is refused (400, `details` has expected, counted, variance and variance_threshold). Cashier+ for own shift; Manager+ for another's.", ...PERMISSIONS["shifts.close"], emits: ["shift.closed"] }),
  "shifts.list": op({ op: "shifts.list", summary: "Shifts of an outlet", description: "Open and closed shifts with their summaries.", tier: "T0", minRole: "server", dryRun: false, principals: ["staff", "station", "agent"], mcp: { expose: true, toolsets: ["pos.read", "reports"] } }),
  "business_days.z_report": op({ op: "business_days.z_report", summary: "Z-report", description: "Sales, tenders, expected vs counted cash, rounding, voids and covers for an outlet (or station) and business date. Figures come from the register. `voids` are lines voided after they were sent to the kitchen; a line removed before sending, or by cancelling an order with nothing sent, is not a void. `sales.net` is net sales: items after discounts, without tax and fees, less `sales.refunds` (the refunds' net); `sales.fees` excludes tax; `sales.total` is what was collected before refunds (`net + refunds + fees + tax = total`), and `refunds.amount` is the money refunded. While any shift at the outlet is still open, a caller below Manager gets `withheld: \"open_shift\"` with only the scope, order counts, void and refund counts, and the open drawers' number and floats (a blind count).", tier: "T0", minRole: "cashier", dryRun: false, principals: ["staff", "station", "agent"], mcp: { expose: true, toolsets: ["reports", "pos.read"] } }),
  "business_days.close": op({ op: "business_days.close", summary: "Close a business day", description: "Snapshots the Z-report once every shift is closed. Manager+. T3: it cannot be undone and closes the day for the whole outlet.", tier: "T3", ...PERMISSIONS["business_days.close"], emits: ["business_day.closed"], mcp: { expose: true, toolsets: ["pos.payment"] } }),
});

const Mutation = z.object({ expected_version: z.number().int().min(0).max(2_147_483_647).optional(), dry_run: z.boolean().optional(), override_id: z.uuid().optional() });
const Snapshot = z.record(z.string(), z.unknown());
const OrderMutationResponse = z.object({ data: Snapshot, events: z.array(z.object({ id: z.string(), seq: z.number().int(), type: z.string(), occurredAt: z.string(), businessDate: z.string() })), warnings: z.array(z.string()) });

function dryRunFrom(c: { set(k: "dryRun", v: boolean): void }, body: { dry_run?: boolean }) {
  if (body.dry_run) {
    markDryRun();
    c.set("dryRun", true);
  }
}

async function receiptPrinterFor(p: Principal, outletId: string) {
  if (p.type === "staff" && p.stationId) {
    const [st] = await db().select().from(stations).where(eq(stations.id, p.stationId)).limit(1);
    if (st?.receiptPrinterId) {
      const [pr] = await db().select().from(printers).where(and(eq(printers.id, st.receiptPrinterId), isNull(printers.archivedAt))).limit(1);
      if (pr) return { printer: pr, station: st };
    }
  }
  const [pr] = await db().select().from(printers).where(and(eq(printers.outletId, outletId), eq(printers.role, "receipt"), isNull(printers.archivedAt))).limit(1);
  if (!pr) throw AppError.invariant("no_receipt_printer", "No receipt printer is configured for this station or outlet", "Add a receipt printer in Printing and set it on the station.");
  return { printer: pr, station: null };
}

export function paymentRoutes(app: OpenAPIHono<AppEnv>) {
  defineOp(app, { op: "checks.list", method: "get", path: "/v1/orders/{id}/checks", tags: ["payments"], request: { params: z.object({ id: z.uuid() }) }, responses: { 200: jsonResponse(listResponse(Snapshot)), ...errorResponses } }, async (c) => {
    const { id } = c.req.valid("param");
    const snap = await loadSnapshot(id);
    return c.json({ data: snap.checks as Record<string, unknown>[], next_cursor: null }, 200);
  });

  defineOp(
    app,
    {
      op: "payments.record",
      method: "post",
      path: "/v1/checks/{id}/payments",
      tags: ["payments"],
      request: { params: z.object({ id: z.uuid() }), body: jsonBody(Mutation.extend({ payment_id: z.uuid(), tender_type_id: z.uuid(), amount: AmountSchema.min(1), tendered: AmountSchema.nullable().optional(), tip_cents: AmountSchema.optional(), tip_bps: z.number().int().min(0).max(10_000).optional(), reference: untrusted(z.string().max(80).nullable().optional()) })) },
      responses: { 200: jsonResponse(OrderMutationResponse.extend({ payment: z.record(z.string(), z.unknown()) })), ...errorResponses },
    },
    async (c) => {
      const p = c.get("principal");
      const { id } = c.req.valid("param");
      const b = c.req.valid("json");
      dryRunFrom(c, b);
      // A percentage is previewed only: the payment records the tip_cents the dry run returned, so an approval for it covers the exact tip.
      if (b.tip_bps != null && !b.dry_run) throw AppError.validation("tip_bps is for a dry run", { remedy: "Preview with tip_bps and dry_run, then record the payment with the tip_cents it returned." });
      const [check] = await db().select().from(checks).where(eq(checks.id, id)).limit(1);
      if (!check) throw AppError.notFound("bill", id);
      const order = await lockOrder(check.orderId, b.expected_version);
      if (order.status === "cancelled") throw AppError.state("The order is cancelled", []);
      // A terminal payment is recorded when the provider approves it, never by hand (a dry run still previews it).
      const [linked] = await db().select({ provider: tenderTypes.provider, name: tenderTypes.name }).from(tenderTypes).where(eq(tenderTypes.id, b.tender_type_id)).limit(1);
      if (linked?.provider && !b.dry_run) throw AppError.validation(`${linked.name} payments are taken on the terminal`, { remedy: "Send the payment to the terminal (payments.start) instead of recording it.", details: { tender_type_id: b.tender_type_id } });
      // A dry run changes nothing (its transaction is rolled back), so staff who may see the bill get the quote: a
      // Server's Pay screen shows the cash change before asking for approval, on every method alike (live-test B-F4).
      // Only staff: an agent or any other principal is held to the role check even for a dry run.
      const approval = b.dry_run && !b.override_id && p.type === "staff" ? null : await requireRoleOrOverride(p, principalRole(p), await paymentRole(order.merchantId, b.tender_type_id), { action: "payments.record", targetId: check.orderId, args: { check_id: id, tender_type_id: b.tender_type_id, amount: b.amount, tip_cents: b.tip_cents ?? 0, reference: b.reference ?? null }, overrideId: b.override_id, overrideAllowed: PERMISSIONS["payments.record"].overrideAllowed });
      const result = await recordPayment(order, { paymentId: b.payment_id, checkId: id, tenderTypeId: b.tender_type_id, amount: b.amount, tendered: b.tendered ?? null, tipCents: b.tip_cents, tipBps: b.tip_bps, reference: b.reference ?? null, stationId: p.type === "staff" ? (p.stationId ?? null) : null }, p);
      await recordAudit(p, { action: "payments.record", targetKind: "order", targetId: order.id, outletId: order.outletId, approver: approval, overrideId: b.override_id ?? null, details: { payment_id: result.payment.id, tender: result.payment.tenderName, amount: result.payment.amount, rounding_cents: result.payment.roundingCents } });
      const version = await bumpVersion(order.id);
      const snapshot = { ...(await loadSnapshot(order.id)), version };
      // Invariants first, events last: the first append locks the outlet's sequence counter until commit (see orders.ts `finish`).
      await settleInvariants();
      const events: AppendedEvent[] = [];
      const bd = await businessDayInputs(order.merchantId, order.outletId);
      const approvalRef = approval ? { override_id: b.override_id, approver_id: approval.id, approver_name: approval.name ?? undefined } : null;
      const ev = (type: string, payload: unknown) => appendEvent({ merchantId: order.merchantId, outletId: order.outletId, type, aggregate: { kind: "order", id: order.id, version: order.version }, operationId: "payments.record", payload, approval: type === "payment.recorded" ? approvalRef : null, correlationId: c.get("correlationId"), idempotencyKey: c.get("idempotencyKey"), businessDay: bd }, p);
      events.push(await ev("payment.recorded", { payment_id: result.payment.id, check_id: id, tender: result.payment.tenderName, amount: result.payment.amount, rounding_cents: result.payment.roundingCents, tip_cents: result.payment.tipCents, change_cents: result.payment.changeCents, reference: result.payment.reference, first_payment: result.firstPayment }));
      if (result.check.status === "paid") events.push(await ev("check.paid", { check_id: id, total: result.check.total, paid_total: result.check.paidTotal }));
      if (result.orderCompleted) events.push(await ev("order.completed", { order_no: order.orderNo }));
      const payment = snapshot.checks.flatMap((ch) => (ch as { payments: { id: string }[] }).payments).find((x) => x.id === result.payment.id) ?? {};
      // `due_cents` is what the customer actually hands over for this tender (amount applied, cash rounding and tip); clients show it, never compute it.
      return c.json({ data: snapshot, payment: { ...payment, change_due: result.changeDue, due_cents: result.payment.amount + result.payment.roundingCents + result.payment.tipCents }, events, warnings: [] }, 200);
    },
  );

  defineOp(app, { op: "orders.complete", method: "post", path: "/v1/orders/{id}/complete", tags: ["payments"], request: { params: z.object({ id: z.uuid() }), body: jsonBody(Mutation) }, responses: { 200: jsonResponse(OrderMutationResponse), ...errorResponses } }, async (c) => {
    const p = c.get("principal");
    const { id } = c.req.valid("param");
    const b = c.req.valid("json");
    dryRunFrom(c, b);
    const order = await lockOrder(id, b.expected_version);
    if (order.status === "completed") throw AppError.state("The order is already completed", []);
    if (order.status === "cancelled") throw AppError.state("The order is cancelled", []);
    await syncAllocations(id);
    const done = await maybeComplete(id);
    if (!done) {
      const snap = await loadSnapshot(id);
      const unpaid = snap.checks.filter((ch) => (ch as { balance: number }).balance > 0).map((ch) => (ch as { label: string }).label);
      const unsent = snap.lines.filter((l) => l.status === "pending" || l.status === "held").length;
      throw AppError.invariant("order_not_complete", unpaid.length ? `${unpaid.join(", ")} still ${unpaid.length === 1 ? "has" : "have"} a balance` : `${unsent} item${unsent === 1 ? "" : "s"} not sent`, unpaid.length ? "Take the remaining payment first." : "Send or remove the remaining items first.");
    }
    const version = await bumpVersion(id);
    const snapshot = await loadSnapshot(id);
    await settleInvariants();
    const ev = await appendEvent({ merchantId: order.merchantId, outletId: order.outletId, type: "order.completed", aggregate: { kind: "order", id, version: order.version }, operationId: "orders.complete", payload: { order_no: order.orderNo }, correlationId: c.get("correlationId"), idempotencyKey: c.get("idempotencyKey"), businessDay: await businessDayInputs(order.merchantId, order.outletId) }, p);
    return c.json({ data: { ...snapshot, version }, events: [ev], warnings: [] }, 200);
  });

  defineOp(app, { op: "orders.reopen", method: "post", path: "/v1/orders/{id}/reopen", tags: ["payments"], request: { params: z.object({ id: z.uuid() }), body: jsonBody(Mutation.extend({ reason: untrusted(z.string().min(1).max(200)) })) }, responses: { 200: jsonResponse(OrderMutationResponse), ...errorResponses } }, async (c) => {
    const p = c.get("principal");
    const { id } = c.req.valid("param");
    const b = c.req.valid("json");
    dryRunFrom(c, b);
    const order = await lockOrder(id, b.expected_version);
    // Reopening reverses payments in the register only. A terminal payment would stay charged while the order is paid again.
    const [onTerminal] = await db().select({ id: payments.id }).from(payments).innerJoin(paymentIntents, eq(paymentIntents.paymentId, payments.id)).where(and(eq(payments.orderId, id), eq(payments.status, "recorded"))).limit(1);
    if (onTerminal) throw AppError.invariant("terminal_payment", "This order was paid on a card terminal", "Void the terminal payment (it is given back at the provider), or refund it in the register and give it back on the terminal by hand.");
    const approval = await requireRoleOrOverride(p, principalRole(p), PERMISSIONS["orders.reopen"].minRole, { action: "orders.reopen", targetId: id, args: {}, overrideId: b.override_id, overrideAllowed: PERMISSIONS["orders.reopen"].overrideAllowed });
    const reversed = await reopenOrder(order, p, b.reason);
    const version = await bumpVersion(id);
    const snapshot = await loadSnapshot(id);
    await settleInvariants();
    const bd = await businessDayInputs(order.merchantId, order.outletId);
    const events: AppendedEvent[] = [];
    for (const r of reversed) events.push(await appendEvent({ merchantId: order.merchantId, outletId: order.outletId, type: "payment.reversed", aggregate: { kind: "order", id, version: order.version }, operationId: "orders.reopen", payload: { payment_id: r.id, amount: r.amount, tender: r.tender }, reason: { text: b.reason }, correlationId: c.get("correlationId"), idempotencyKey: c.get("idempotencyKey"), businessDay: bd }, p));
    events.push(await appendEvent({ merchantId: order.merchantId, outletId: order.outletId, type: "order.reopened", aggregate: { kind: "order", id, version: order.version }, operationId: "orders.reopen", payload: { reversed_payments: reversed.length }, reason: { text: b.reason }, approval: approval ? { override_id: b.override_id, approver_id: approval.id, approver_name: approval.name ?? undefined } : null, correlationId: c.get("correlationId"), idempotencyKey: c.get("idempotencyKey"), businessDay: bd }, p));
    await recordAudit(p, { action: "orders.reopen", targetKind: "order", targetId: id, outletId: order.outletId, reason: b.reason, approver: approval, overrideId: b.override_id ?? null, details: { reversed_payments: reversed.length } });
    return c.json({ data: { ...snapshot, version }, events, warnings: [] }, 200);
  });

  const printBill = async (c: Parameters<Parameters<typeof defineOp>[2]>[0], kind: "prebill" | "receipt", checkIds: string[], p: Principal, orderId: string) => {
    const order = await lockOrder(orderId);
    const { printer, station } = await receiptPrinterFor(p, order.outletId);
    const jobs = [];
    for (const checkId of checkIds) {
      const doc = await billDocumentFor(checkId, kind, { stationName: station?.name ?? null, serverName: "name" in p ? p.name : null });
      jobs.push(await insertJob({ merchantId: order.merchantId, outletId: order.outletId, printer, kind, payload: { template: "bill", data: doc }, orderId, checkId, principal: p, correlationId: c.get("correlationId") }));
    }
    return { order, jobs };
  };

  defineOp(app, { op: "checks.print_prebill", method: "post", path: "/v1/orders/{id}/prebill", tags: ["payments"], request: { params: z.object({ id: z.uuid() }), body: jsonBody(Mutation.extend({ check_id: z.uuid().optional() })) }, responses: { 200: jsonResponse(OrderMutationResponse.extend({ jobs: z.array(z.record(z.string(), z.unknown())) })), ...errorResponses } }, async (c) => {
    const p = c.get("principal");
    const { id } = c.req.valid("param");
    const b = c.req.valid("json");
    dryRunFrom(c, b);
    await syncAllocations(id);
    const snap = await loadSnapshot(id);
    const checkIds = b.check_id ? [b.check_id] : snap.checks.map((ch) => (ch as { id: string }).id);
    await settleInvariants();
    const { order, jobs } = await printBill(c, "prebill", checkIds, p, id);
    if (!order.billRequestedAt) await db().update(orders).set({ billRequestedAt: new Date() }).where(eq(orders.id, id));
    const ev = await appendEvent({ merchantId: order.merchantId, outletId: order.outletId, type: "order.bill_requested", aggregate: { kind: "order", id, version: order.version }, operationId: "checks.print_prebill", payload: { check_ids: checkIds, jobs: jobs.map((j) => j.id) }, correlationId: c.get("correlationId"), idempotencyKey: c.get("idempotencyKey"), businessDay: await businessDayInputs(order.merchantId, order.outletId) }, p);
    const version = await bumpVersion(id);
    return c.json({ data: { ...(await loadSnapshot(id)), version }, jobs, events: [ev], warnings: [] }, 200);
  });

  defineOp(app, { op: "receipts.print", method: "post", path: "/v1/checks/{id}/receipt/print", tags: ["payments"], request: { params: z.object({ id: z.uuid() }), body: jsonBody(Mutation) }, responses: { 200: jsonResponse(mutationResponse(z.array(z.record(z.string(), z.unknown())))), ...errorResponses } }, async (c) => {
    const p = c.get("principal");
    const { id } = c.req.valid("param");
    const b = c.req.valid("json");
    dryRunFrom(c, b);
    const [check] = await db().select().from(checks).where(eq(checks.id, id)).limit(1);
    if (!check) throw AppError.notFound("bill", id);
    const { jobs } = await printBill(c, "receipt", [id], p, check.orderId);
    return c.json({ data: jobs, events: [], warnings: [] }, 200);
  });

  defineOp(app, { op: "receipts.send", method: "post", path: "/v1/checks/{id}/receipt/send", tags: ["payments"], request: { params: z.object({ id: z.uuid() }), body: jsonBody(Mutation.extend({ channel: z.enum(["qr", "link", "email", "sms"]), destination: untrusted(z.string().max(120).optional()) })) }, responses: { 200: jsonResponse(mutationResponse(z.object({ token: secret(z.string()), url: secret(z.string()), delivery_status: z.string() }))), ...errorResponses } }, async (c) => {
    const p = c.get("principal");
    const { id } = c.req.valid("param");
    const b = c.req.valid("json");
    dryRunFrom(c, b);
    const [check] = await db().select().from(checks).where(eq(checks.id, id)).limit(1);
    if (!check) throw AppError.notFound("bill", id);
    if ((b.channel === "email" || b.channel === "sms") && !b.destination) throw AppError.validation(`${b.channel} needs a destination`);
    const doc = await billDocumentFor(id, "receipt", { serverName: "name" in p ? p.name : null });
    const receipt = await createDigitalReceipt({ merchantId: check.merchantId, outletId: check.outletId, checkId: id, document: doc, channel: b.channel, destination: b.destination ?? null });
    const ev = await appendEvent({ merchantId: check.merchantId, outletId: check.outletId, type: "receipt.sent", aggregate: { kind: "order", id: check.orderId }, operationId: "receipts.send", payload: { check_id: id, channel: b.channel, delivery_status: receipt.delivery_status }, correlationId: c.get("correlationId"), idempotencyKey: c.get("idempotencyKey"), businessDay: await businessDayInputs(check.merchantId, check.outletId) }, p);
    const warnings = receipt.delivery_status === "provider_not_configured" ? [`${b.channel} delivery is not configured; show the QR code or copy the link instead`] : [];
    return c.json({ data: receipt, events: [ev], warnings }, 200);
  });

  defineOp(app, { op: "receipts.read", method: "get", path: "/v1/receipts/{token}", tags: ["payments"], request: { params: z.object({ token: z.string().min(10) }) }, responses: { 200: jsonResponse(dataResponse(z.object({ document: z.record(z.string(), z.unknown()), channel: z.string(), created_at: z.string(), settings: LocaleSettingsSchema }))), ...errorResponses } }, async (c) => {
    const { token } = c.req.valid("param");
    const { row, settings } = await withTransaction(async () => {
      const row = await readDigitalReceipt(token);
      return { row, settings: await localeSettingsFor(row.merchantId) };
    });
    return c.json({ data: { document: row.document, channel: row.channel, created_at: row.createdAt.toISOString(), settings } }, 200);
  });

  defineOp(app, { op: "documents.issue_invoice", method: "post", path: "/v1/checks/{id}/invoice", tags: ["payments"], request: { params: z.object({ id: z.uuid() }), body: jsonBody(Mutation) }, responses: { 200: jsonResponse(mutationResponse(z.object({ invoice_no: z.string(), issued_at: z.string(), reused: z.boolean(), pdf_url: z.string() }))), ...errorResponses } }, async (c) => {
    const p = c.get("principal");
    const { id } = c.req.valid("param");
    const b = c.req.valid("json");
    dryRunFrom(c, b);
    const bill = await billDocumentFor(id, "receipt", { serverName: "name" in p ? p.name : null });
    const { check, document, reused } = await issueInvoice(id, bill);
    const events: AppendedEvent[] = [];
    if (!reused) {
      events.push(await appendEvent({ merchantId: check.merchantId, outletId: check.outletId, type: "invoice.issued", aggregate: { kind: "order", id: check.orderId }, operationId: "documents.issue_invoice", payload: { check_id: id, invoice_no: document.invoice.number }, correlationId: c.get("correlationId"), idempotencyKey: c.get("idempotencyKey"), businessDay: await businessDayInputs(check.merchantId, check.outletId) }, p));
      await recordAudit(p, { action: "documents.issue_invoice", targetKind: "check", targetId: id, outletId: check.outletId, details: { invoice_no: document.invoice.number } });
    }
    return c.json({ data: { invoice_no: document.invoice.number, issued_at: document.invoice.issued_at, reused, pdf_url: `/v1/checks/${id}/invoice.pdf` }, events, warnings: [] }, 200);
  });

  defineOp(app, { op: "documents.invoice_pdf", method: "get", path: "/v1/checks/{id}/invoice.pdf", tags: ["payments"], request: { params: z.object({ id: z.uuid() }) }, responses: { 200: { description: "PDF", content: { "application/pdf": { schema: z.string() } } }, ...errorResponses } }, async (c) => {
    const { id } = c.req.valid("param");
    const [check] = await db().select().from(checks).where(eq(checks.id, id)).limit(1);
    if (!check?.invoiceDocument) throw AppError.notFound("invoice for bill", id);
    const pdf = await renderInvoicePdf(check.invoiceDocument as InvoiceDocument);
    return c.body(pdf as unknown as ArrayBuffer, 200, { "content-type": "application/pdf", "content-disposition": `inline; filename="${check.invoiceNo}.pdf"` });
  });

  /* Shifts and business days */
  const ShiftSchema = z.record(z.string(), z.unknown());
  const toShift = (s: typeof shifts.$inferSelect) => ({ id: s.id, outlet_id: s.outletId, station_id: s.stationId, name: s.name, status: s.status, business_date: s.businessDate, opened_by: s.openedByName, opened_at: s.openedAt.toISOString(), float_cents: s.floatCents, float_counts: s.floatCounts, closed_by: s.closedByName, closed_at: s.closedAt?.toISOString() ?? null, counted_cash_cents: s.countedCashCents, expected_cash_cents: s.expectedCashCents, variance_cents: s.varianceCents, variance_reason: s.varianceReason, summary: s.summary });

  defineOp(app, { op: "shifts.list", method: "get", path: "/v1/outlets/{id}/shifts", tags: ["shifts"], request: { params: z.object({ id: z.uuid() }), query: z.object({ status: z.enum(["open", "closed"]).optional(), station_id: z.uuid().optional(), business_date: z.string().optional() }) }, responses: { 200: jsonResponse(listResponse(ShiftSchema)), ...errorResponses } }, async (c) => {
    const p = c.get("principal");
    const { id } = c.req.valid("param");
    const q = c.req.valid("query");
    if (!(await outletVisible(p, id))) throw AppError.notFound("outlet", id);
    const rows = await db()
      .select()
      .from(shifts)
      .where(and(eq(shifts.outletId, id), q.status ? eq(shifts.status, q.status) : sql`true`, q.station_id ? eq(shifts.stationId, q.station_id) : sql`true`, q.business_date ? eq(shifts.businessDate, q.business_date) : sql`true`))
      .orderBy(desc(shifts.openedAt))
      .limit(200);
    return c.json({ data: rows.map(toShift), next_cursor: null }, 200);
  });

  defineOp(app, { op: "shifts.open", method: "post", path: "/v1/shifts", tags: ["shifts"], request: { body: jsonBody(Mutation.extend({ outlet_id: z.uuid().optional(), station_id: z.uuid().nullable().optional(), name: untrusted(z.string().max(40).nullable().optional(), "name@shifts", "shift_name"), float_cents: AmountSchema, float_counts: z.record(z.string(), z.number().int().min(0)).nullable().optional() })) }, responses: { 201: jsonResponse(mutationResponse(ShiftSchema)), ...errorResponses } }, async (c) => {
    const p = c.get("principal");
    const b = c.req.valid("json");
    dryRunFrom(c, b);
    const outletId = p.type === "staff" && p.outletId ? p.outletId : b.outlet_id;
    if (!outletId || !(await outletVisible(p, outletId))) throw AppError.validation("outlet_id is required when not on a station");
    const stationId = b.station_id === undefined ? (p.type === "staff" ? (p.stationId ?? null) : null) : b.station_id;
    const bd = await businessDayInputs(p.merchantId, outletId);
    const shift = await openShift(p, { outletId, stationId, name: b.name ?? null, floatCents: b.float_cents, floatCounts: b.float_counts ?? null, businessDate: await currentBusinessDate(p.merchantId, outletId) });
    const ev = await appendEvent({ merchantId: p.merchantId, outletId, type: "shift.opened", aggregate: { kind: "shift", id: shift.id }, operationId: "shifts.open", payload: { station_id: stationId, float_cents: b.float_cents, shift_name: b.name ?? null }, correlationId: c.get("correlationId"), idempotencyKey: c.get("idempotencyKey"), businessDay: bd }, p);
    await recordAudit(p, { action: "shifts.open", targetKind: "shift", targetId: shift.id, outletId, details: { float_cents: b.float_cents } });
    return c.json({ data: toShift(shift), events: [ev], warnings: [] }, 201);
  });

  defineOp(app, { op: "shifts.close", method: "post", path: "/v1/shifts/{id}/close", tags: ["shifts"], request: { params: z.object({ id: z.uuid() }), body: jsonBody(Mutation.extend({ counted_cash_cents: AmountSchema, counted_counts: z.record(z.string(), z.number().int().min(0)).nullable().optional(), variance_reason: untrusted(z.string().max(200).nullable().optional()) })) }, responses: { 200: jsonResponse(mutationResponse(ShiftSchema.and(z.object({ report: z.record(z.string(), z.unknown()) })))), ...errorResponses } }, async (c) => {
    const p = c.get("principal");
    const { id } = c.req.valid("param");
    const b = c.req.valid("json");
    dryRunFrom(c, b);
    const [shift] = await db().select().from(shifts).where(eq(shifts.id, id)).limit(1);
    if (!shift) throw AppError.notFound("shift", id);
    if (shift.openedBy !== p.id) await requireRoleOrOverride(p, principalRole(p), "manager", { action: "shifts.close", targetId: id, args: {}, overrideId: b.override_id, overrideAllowed: false });
    // A blind count (S-9): below Manager, a close cannot be tried out first, and a refused count does not say what was expected.
    const closer = principalRole(p);
    const blind = !(closer && roleAtLeast(closer, "manager"));
    if (blind && b.dry_run) throw new AppError("permission_denied", "A shift close cannot be tried out first below Manager", { remedy: "Count the drawer and close the shift." });
    const { shift: closed, report } = await closeShift(p, id, { countedCashCents: b.counted_cash_cents, countedCounts: b.counted_counts ?? null, varianceReason: b.variance_reason ?? null, blind });
    const ev = await appendEvent({ merchantId: p.merchantId, outletId: shift.outletId, type: "shift.closed", aggregate: { kind: "shift", id }, operationId: "shifts.close", payload: { expected: report.cash.expected, counted: report.cash.counted, variance: report.cash.variance }, correlationId: c.get("correlationId"), idempotencyKey: c.get("idempotencyKey"), businessDay: await businessDayInputs(p.merchantId, shift.outletId) }, p);
    await recordAudit(p, { action: "shifts.close", targetKind: "shift", targetId: id, outletId: shift.outletId, details: { expected: report.cash.expected, counted: report.cash.counted, variance: report.cash.variance, variance_reason: b.variance_reason ?? null } });
    return c.json({ data: { ...toShift(closed), report }, events: [ev], warnings: [] }, 200);
  });

  defineOp(app, { op: "business_days.z_report", method: "get", path: "/v1/outlets/{id}/z-report", tags: ["shifts"], request: { params: z.object({ id: z.uuid() }), query: z.object({ business_date: z.string().optional(), station_id: z.uuid().optional() }) }, responses: { 200: jsonResponse(dataResponse(z.record(z.string(), z.unknown()))), ...errorResponses } }, async (c) => {
    const p = c.get("principal");
    const { id } = c.req.valid("param");
    const q = c.req.valid("query");
    if (!(await outletVisible(p, id))) throw AppError.notFound("outlet", id);
    const businessDate = q.business_date ?? (await currentBusinessDate(p.merchantId, id));
    const dayShifts = await db().select().from(shifts).where(and(eq(shifts.outletId, id), eq(shifts.businessDate, businessDate), q.station_id ? eq(shifts.stationId, q.station_id) : sql`true`));
    // Float, expected, counted and variance all cover the closed shifts; a drawer still open is only listed in open_shifts.
    const closed = dayShifts.filter((x) => x.status === "closed");
    const open = dayShifts.filter((x) => x.status !== "closed");
    const float = closed.reduce((s, x) => s + x.floatCents, 0);
    const counted = closed.reduce((s, x) => s + (x.countedCashCents ?? 0), 0);
    const report = await zReport({ outletId: id, businessDate, stationId: q.station_id ?? null, cashShiftIds: closed.map((x) => x.id) }, { float, counted: closed.length ? counted : null, openShifts: { ids: open.map((x) => x.id), float: open.reduce((s, x) => s + x.floatCents, 0) } });
    // The close is a blind count (S-9): while a drawer at the outlet is open, a caller below Manager, who may be the one
    // to count it, gets no money figure the open drawer's expected cash could be read or worked out from (its sales,
    // tenders, cash and refunds all hold that drawer's takings). The floats, that shifts are open, and counts stay.
    // Any drawer open at the outlet counts, not only this report's: a whole-outlet drawer takes this station's cash too.
    const role = principalRole(p);
    if (!(role && roleAtLeast(role, "manager"))) {
      const drawers = await openFloats(id);
      if (drawers.count > 0) return c.json({ data: withheldZReport(report, drawers) }, 200);
    }
    return c.json({ data: report }, 200);
  });

  defineOp(app, { op: "business_days.close", method: "post", path: "/v1/outlets/{id}/business-days/close", tags: ["shifts"], request: { params: z.object({ id: z.uuid() }), body: jsonBody(Mutation.extend({ business_date: z.string().optional() })) }, responses: { 200: jsonResponse(mutationResponse(z.record(z.string(), z.unknown()))), ...errorResponses } }, async (c) => {
    const p = c.get("principal");
    const { id } = c.req.valid("param");
    const b = c.req.valid("json");
    dryRunFrom(c, b);
    if (!(await outletVisible(p, id))) throw AppError.notFound("outlet", id);
    const bd = await businessDayInputs(p.merchantId, id);
    const businessDate = b.business_date ?? businessDateFor(new Date(), bd.cutoff, bd.timeZone);
    const { close, report } = await closeBusinessDay(p, id, businessDate);
    const ev = await appendEvent({ merchantId: p.merchantId, outletId: id, type: "business_day.closed", aggregate: { kind: "business_day", id: close.id }, operationId: "business_days.close", payload: { business_date: businessDate, net_sales: report.sales.net }, correlationId: c.get("correlationId"), idempotencyKey: c.get("idempotencyKey"), businessDay: bd }, p);
    await recordAudit(p, { action: "business_days.close", targetKind: "business_day", targetId: close.id, outletId: id, details: { business_date: businessDate } });
    return c.json({ data: { id: close.id, business_date: businessDate, closed_at: close.closedAt.toISOString(), report }, events: [ev], warnings: [] }, 200);
  });
}

/** A Z-report with the money figures left out while a drawer is still open (see business_days.z_report). */
function withheldZReport(r: Awaited<ReturnType<typeof zReport>>, drawers: { count: number; float: number }) {
  return {
    withheld: "open_shift" as const,
    scope: r.scope,
    orders: r.orders,
    voids: { count: r.voids.count, quantity: r.voids.quantity },
    refunds: { count: r.refunds.count },
    cash: { float: r.cash.float, open_shifts: drawers },
    generated_at: r.generated_at,
  };
}

/** The number and floats of the drawers open at an outlet, whatever business day they opened on (one left open past the cutoff still takes cash). */
async function openFloats(outletId: string) {
  const [r] = await db().select({ count: sql<number>`count(*)::int`, float: sql<number>`coalesce(sum(${shifts.floatCents}),0)::bigint` }).from(shifts).where(and(eq(shifts.outletId, outletId), eq(shifts.status, "open")));
  return { count: r?.count ?? 0, float: Number(r?.float ?? 0) };
}

export { repriceOrder };
