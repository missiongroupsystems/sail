import type { OpenAPIHono } from "@hono/zod-openapi";
import { asc, eq } from "drizzle-orm";
import { AmountSchema, PERMISSIONS, registerOperations, type OperationSpec } from "@sail/shared";
import { db, markDryRun, settleInvariants } from "../db/client.js";
import { checks, paymentIntents, paymentProviderAccounts, payments } from "../db/schema/index.js";
import { AppError } from "../lib/errors.js";
import type { AppEnv } from "../lib/context.js";
import { dataResponse, defineOp, errorResponses, jsonBody, jsonResponse, listResponse, mutationResponse, untrusted, z, secret } from "../lib/openapi.js";
import { appendEvent, type AppendedEvent } from "../lib/events.js";
import { recordAudit } from "../lib/audit.js";
import { actorOf, principalRole } from "../auth/principal.js";
import { bumpVersion, getOrderRow, loadSnapshot, lockOrder } from "../services/orders.js";
import { requireRoleOrOverride } from "../services/overrides.js";
import { assertVoidable, paymentRole, reversePayment } from "../services/payments.js";
import { cancelIntent, intentForPayment, lockIntent, receiveWebhook, requestProviderVoid, startIntent, toIntent } from "../services/payment-intents.js";
import { paymentProvider } from "../payments/provider.js";
import { businessDayInputs } from "../services/business-day.js";
import type { EventActor } from "../db/schema/index.js";

const op = (o: Partial<OperationSpec> & { op: string; summary: string; description: string }): OperationSpec => ({ tier: "T2", minRole: "cashier", overrideAllowed: false, reasonRequired: false, dryRun: false, principals: ["staff", "agent"], emits: [], mcp: { expose: true, toolsets: ["pos.payment"] }, ...o });

registerOperations({
  "payments.start": op({ op: "payments.start", summary: "Send a payment to the card terminal", description: "For a payment method linked to a provider and terminal. Pins the bill (its total and what is already paid) and the amount and tip, and returns a pending payment at once; the terminal is asked by the worker, never inside this request. The outcome arrives as `payment_intent.*` events: approved records the payment exactly as payments.record would (with `payment.recorded`, `check.paid`, `order.completed`), declined leaves the bill untouched. If the bill changes or is paid another way before the terminal answers, an approval is given back at the provider and nothing is applied. One payment waits per bill. Never use it for a payment method recorded by hand.", emits: ["payment_intent.started"] }),
  "payments.cancel": op({ op: "payments.cancel", summary: "Cancel a payment waiting on the terminal", description: "Stops a pending terminal payment. If the guest had already paid, the approval is given back at the provider and never applied. An agent's cancel is a proposal, like the start it undoes.", tier: "T2", emits: ["payment_intent.cancelled"] }),
  "payment_intents.list": op({ op: "payment_intents.list", summary: "Terminal payments of an order", description: "Every payment sent to a terminal for the order, newest first, with its state (pending, approved, declined, cancelled, expired), the reason when it did not go through, and whether a void is waiting for the provider.", tier: "T0", minRole: "server", principals: ["staff", "station", "agent"], mcp: { expose: true, toolsets: ["pos.payment", "pos.read"] } }),
  "payments.void": op({ op: "payments.void", summary: "Void a payment recorded in error", description: "Reverses one recorded payment so the bill owes it again (a wrong payment method, a duplicate). Manager+, or a lower role with a manager's approval bound to this payment. Reason required. Only while the payment's shift is open, its business day is not closed and nothing has been refunded from the bill; after that, use a refund. A payment taken on a terminal is voided at the provider first: the response says the void is pending, and the payment is reversed (`payment.voided`) when the provider confirms.", tier: "T3", ...PERMISSIONS["payments.void"], reasonRequired: true, dryRun: true, emits: ["payment.voided", "payment.void_requested"], mcp: { expose: true, toolsets: ["pos.refund"] } }),
  "payments.webhook": op({ op: "payments.webhook", summary: "Payment provider webhook", description: "Called by a payment provider, not by people or agents. The body is verified against the merchant's webhook secret for that provider, must be fresh, is applied at most once, and is rate-limited per merchant.", tier: "T2", minRole: null, principals: [], mcp: { expose: false, toolsets: [] } }),
  "payment_providers.configure": op({ op: "payment_providers.configure", summary: "Set a payment provider's webhook secret", description: "Admin. Stores the secret the provider signs this merchant's webhooks with, and returns the webhook URL path to give the provider. The secret is never returned.", tier: "T3", minRole: "admin", principals: ["staff"], mcp: { expose: false, toolsets: [] }, emits: ["payment_provider.configured"], permission: "config.edit" }),
});

const Mutation = z.object({ expected_version: z.number().int().optional(), dry_run: z.boolean().optional(), override_id: z.uuid().optional() });
const Intent = z.record(z.string(), z.unknown());
const Events = z.array(z.object({ id: z.string(), seq: z.number().int(), type: z.string(), occurredAt: z.string(), businessDate: z.string() }));

export function paymentIntentRoutes(app: OpenAPIHono<AppEnv>) {
  defineOp(
    app,
    {
      op: "payments.start",
      method: "post",
      path: "/v1/checks/{id}/payment-intents",
      tags: ["payments"],
      request: { params: z.object({ id: z.uuid() }), body: jsonBody(z.object({ expected_version: z.number().int().optional(), intent_id: z.uuid(), tender_type_id: z.uuid(), amount: AmountSchema.min(1), tip_cents: AmountSchema.optional() })) },
      responses: { 201: jsonResponse(mutationResponse(Intent)), ...errorResponses },
    },
    async (c) => {
      const p = c.get("principal");
      const { id } = c.req.valid("param");
      const b = c.req.valid("json");
      const [check] = await db().select().from(checks).where(eq(checks.id, id)).limit(1);
      if (!check) throw AppError.notFound("bill", id);
      const order = await lockOrder(check.orderId, b.expected_version);
      await requireRoleOrOverride(p, principalRole(p), await paymentRole(order.merchantId, b.tender_type_id), { action: "payments.start", targetId: order.id, args: {}, overrideAllowed: false });
      const intent = await startIntent(order, { intentId: b.intent_id, checkId: id, tenderTypeId: b.tender_type_id, amount: b.amount, tipCents: b.tip_cents ?? 0, idempotencyKey: c.get("idempotencyKey") ?? b.intent_id, stationId: p.type === "staff" ? (p.stationId ?? null) : null }, p);
      await recordAudit(p, { action: "payments.start", targetKind: "order", targetId: order.id, outletId: order.outletId, details: { intent_id: intent.id, amount: intent.amount, tip_cents: intent.tipCents, provider: intent.provider, terminal_id: intent.terminalId } });
      await settleInvariants();
      const ev = await appendEvent({ merchantId: order.merchantId, outletId: order.outletId, type: "payment_intent.started", aggregate: { kind: "order", id: order.id, version: order.version }, operationId: "payments.start", payload: { intent_id: intent.id, check_id: id, amount: intent.amount, tip_cents: intent.tipCents, terminal_id: intent.terminalId }, correlationId: c.get("correlationId"), idempotencyKey: c.get("idempotencyKey"), businessDay: await businessDayInputs(order.merchantId, order.outletId) }, p);
      return c.json({ data: toIntent(intent), events: [ev], warnings: [] }, 201);
    },
  );

  defineOp(app, { op: "payments.cancel", method: "post", path: "/v1/payment-intents/{id}/cancel", tags: ["payments"], request: { params: z.object({ id: z.uuid() }), body: jsonBody(z.object({})) }, responses: { 200: jsonResponse(mutationResponse(Intent)), ...errorResponses } }, async (c) => {
    const p = c.get("principal");
    const { id } = c.req.valid("param");
    const [found] = await db().select({ orderId: paymentIntents.orderId }).from(paymentIntents).where(eq(paymentIntents.id, id)).limit(1);
    if (!found) throw AppError.notFound("terminal payment", id);
    const order = await lockOrder(found.orderId);
    const cancelled = await cancelIntent(await lockIntent(id));
    await recordAudit(p, { action: "payments.cancel", targetKind: "order", targetId: order.id, outletId: order.outletId, details: { intent_id: id } });
    await settleInvariants();
    const ev = await appendEvent({ merchantId: order.merchantId, outletId: order.outletId, type: "payment_intent.cancelled", aggregate: { kind: "order", id: order.id, version: order.version }, operationId: "payments.cancel", payload: { intent_id: id, check_id: cancelled.checkId, amount: cancelled.amount, reason: "cancelled" }, correlationId: c.get("correlationId"), idempotencyKey: c.get("idempotencyKey"), businessDay: await businessDayInputs(order.merchantId, order.outletId) }, p);
    return c.json({ data: toIntent(cancelled), events: [ev], warnings: [] }, 200);
  });

  defineOp(app, { op: "payment_intents.list", method: "get", path: "/v1/orders/{id}/payment-intents", tags: ["payments"], request: { params: z.object({ id: z.uuid() }) }, responses: { 200: jsonResponse(listResponse(Intent)), ...errorResponses } }, async (c) => {
    const { id } = c.req.valid("param");
    await getOrderRow(id);
    const rows = await db().select().from(paymentIntents).where(eq(paymentIntents.orderId, id)).orderBy(asc(paymentIntents.createdAt));
    return c.json({ data: rows.reverse().map(toIntent), next_cursor: null }, 200);
  });

  defineOp(
    app,
    {
      op: "payments.void",
      method: "post",
      path: "/v1/payments/{id}/void",
      tags: ["payments"],
      request: { params: z.object({ id: z.uuid() }), body: jsonBody(Mutation.extend({ reason: untrusted(z.string().min(1).max(200)) })) },
      responses: { 200: jsonResponse(z.object({ data: z.record(z.string(), z.unknown()), void: z.object({ payment_id: z.string(), status: z.enum(["voided", "pending_provider"]) }), events: Events, warnings: z.array(z.string()) })), ...errorResponses },
    },
    async (c) => {
      const p = c.get("principal");
      const { id } = c.req.valid("param");
      const b = c.req.valid("json");
      if (b.dry_run) {
        markDryRun();
        c.set("dryRun", true);
      }
      const [found] = await db().select().from(payments).where(eq(payments.id, id)).limit(1);
      if (!found) throw AppError.notFound("payment", id);
      const order = await lockOrder(found.orderId, b.expected_version);
      const [payment] = await db().select().from(payments).where(eq(payments.id, id)).limit(1);
      await assertVoidable(order, payment!);
      const intent = await intentForPayment(id);
      if (intent?.voidRequestedAt && !intent.providerVoidedAt) throw AppError.state("A void of this payment is already waiting for the provider", []);
      // The approval names this payment and its amount, so it cannot be spent on another.
      const approval = await requireRoleOrOverride(p, principalRole(p), PERMISSIONS["payments.void"].minRole, { action: "payments.void", targetId: id, args: { amount: payment!.amount }, overrideId: b.override_id, overrideAllowed: PERMISSIONS["payments.void"].overrideAllowed });
      const bd = await businessDayInputs(order.merchantId, order.outletId);
      const audit = { action: "payments.void", targetKind: "payment", targetId: id, outletId: order.outletId, reason: b.reason, approver: approval, overrideId: b.override_id ?? null };
      const approvalRef = approval ? { override_id: b.override_id, approver_id: approval.id, approver_name: approval.name ?? undefined } : null;
      const events: AppendedEvent[] = [];
      if (intent) {
        // A terminal payment: the money goes back at the provider first. Until it confirms, the payment stands.
        if (!paymentProvider(intent.provider)) throw AppError.invariant("provider_unknown", `The payment provider "${intent.provider}" is not available on this register`, "Refund it in the register and give it back on the terminal by hand.");
        // A dry run says what would happen and writes nothing (agents may not write intents at all).
        if (b.dry_run) return c.json({ data: { ...(await loadSnapshot(order.id)) }, void: { payment_id: id, status: "pending_provider" as const }, events, warnings: [] }, 200);
        await requestProviderVoid(intent, { reason: b.reason, requested_by: p.id, requested_by_name: "name" in p ? p.name : null, approver_id: approval?.id ?? null, approver_name: approval?.name ?? null, override_id: b.override_id ?? null, actor: actorOf(p) as EventActor });
        await recordAudit(p, { ...audit, details: { amount: payment!.amount, tender: payment!.tenderName, provider: intent.provider, status: "pending_provider" } });
        await settleInvariants();
        events.push(await appendEvent({ merchantId: order.merchantId, outletId: order.outletId, type: "payment.void_requested", aggregate: { kind: "order", id: order.id, version: order.version }, operationId: "payments.void", payload: { payment_id: id, check_id: payment!.checkId, amount: payment!.amount, intent_id: intent.id }, reason: { text: b.reason }, approval: approvalRef, correlationId: c.get("correlationId"), idempotencyKey: c.get("idempotencyKey"), businessDay: bd }, p));
        return c.json({ data: { ...(await loadSnapshot(order.id)) }, void: { payment_id: id, status: "pending_provider" as const }, events, warnings: [] }, 200);
      }
      await reversePayment(order, payment!, b.reason, p);
      await recordAudit(p, { ...audit, details: { amount: payment!.amount, tender: payment!.tenderName, status: "voided" } });
      const version = await bumpVersion(order.id);
      const snapshot = await loadSnapshot(order.id);
      await settleInvariants();
      events.push(await appendEvent({ merchantId: order.merchantId, outletId: order.outletId, type: "payment.voided", aggregate: { kind: "order", id: order.id, version: order.version }, operationId: "payments.void", payload: { payment_id: id, check_id: payment!.checkId, amount: payment!.amount, tip_cents: payment!.tipCents, tender: payment!.tenderName }, reason: { text: b.reason }, approval: approvalRef, correlationId: c.get("correlationId"), idempotencyKey: c.get("idempotencyKey"), businessDay: bd }, p));
      return c.json({ data: { ...snapshot, version }, void: { payment_id: id, status: "voided" as const }, events, warnings: [] }, 200);
    },
  );

  defineOp(app, { op: "payments.webhook", method: "post", path: "/v1/webhooks/payments/{provider}/{merchant_id}", tags: ["payments"], request: { params: z.object({ provider: z.string().min(1).max(40), merchant_id: z.string().min(1).max(40) }) }, responses: { 200: jsonResponse(dataResponse(z.object({ received: z.boolean(), applied: z.string() }))), ...errorResponses } }, async (c) => {
    const { provider, merchant_id } = c.req.valid("param");
    // The raw bytes, exactly as signed: a parsed and re-serialised body would not verify.
    const body = await c.req.text();
    if (body.length > 64 * 1024) throw AppError.validation("Webhook body too large");
    const { applied } = await receiveWebhook(provider, merchant_id, c.req.raw.headers, body);
    return c.json({ data: { received: true, applied } }, 200);
  });

  defineOp(app, { op: "payment_providers.configure", method: "put", path: "/v1/payment-providers/{provider}", tags: ["payments"], request: { params: z.object({ provider: z.string().min(1).max(40) }), body: jsonBody(z.object({ webhook_secret: secret(z.string().min(24).max(200)) })) }, responses: { 200: jsonResponse(mutationResponse(z.object({ provider: z.string(), webhook_path: z.string() }))), ...errorResponses } }, async (c) => {
    const p = c.get("principal");
    const { provider } = c.req.valid("param");
    const b = c.req.valid("json");
    if (!paymentProvider(provider)) throw AppError.notFound("payment provider", provider);
    await db()
      .insert(paymentProviderAccounts)
      .values({ merchantId: p.merchantId, provider, webhookSecret: b.webhook_secret })
      .onConflictDoUpdate({ target: [paymentProviderAccounts.merchantId, paymentProviderAccounts.provider], set: { webhookSecret: b.webhook_secret, updatedAt: new Date() } });
    await recordAudit(p, { action: "payment_providers.configure", targetKind: "payment_provider", targetId: null, details: { provider } });
    const ev = await appendEvent({ merchantId: p.merchantId, outletId: null, type: "payment_provider.configured", aggregate: { kind: "payment_provider", id: p.merchantId }, operationId: "payment_providers.configure", payload: { provider }, correlationId: c.get("correlationId"), idempotencyKey: c.get("idempotencyKey") }, p);
    return c.json({ data: { provider, webhook_path: `/v1/webhooks/payments/${provider}/${p.merchantId}` }, events: [ev], warnings: [] }, 200);
  });
}
