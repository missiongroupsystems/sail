import { randomUUID } from "node:crypto";
import { and, asc, eq, isNull, lt, sql } from "drizzle-orm";
import type { Role } from "@sail/shared";
import { db, settleInvariants, tx, withOwnTransaction, withTransaction } from "../db/client.js";
import { businessDayCloses, checks, merchantSettings, paymentIntents, paymentOutbox, paymentProviderAccounts, payments, refunds, tenderTypes, type EventActor, type PaymentIntent } from "../db/schema/index.js";
import { AppError } from "../lib/errors.js";
import { appendEvent } from "../lib/events.js";
import { recordAudit } from "../lib/audit.js";
import { actorOf, type Principal } from "../auth/principal.js";
import { logger } from "../logger.js";
import { paymentProvider, WebhookRejected, type PaymentProvider, type ProviderAccount, type ProviderPaymentStatus } from "../payments/provider.js";
import { bumpVersion, lockOrder } from "./orders.js";
import { assertTipAllowed, recordPayment, reversePayment } from "./payments.js";
import { businessDayInputs } from "./business-day.js";
import { enforceLimit } from "./guest.js";

/**
 * Payments taken through a provider. A request writes an intent and an outbox row and commits; the worker calls the
 * provider; the outcome (a webhook or the worker's poll) is applied in a transaction of its own that records the
 * payment through `recordPayment`, so every money rule of a by-hand payment applies. The bill is pinned at start, and
 * an approval for a bill that changed is given back at the provider, never applied.
 */
export const INTENT_TTL_SECONDS = 120;
export const OUTBOX_MAX_ATTEMPTS = 8;
/** How long a claimed outbox row is hidden from other workers while its call runs. Longer than any provider call. */
const OUTBOX_LEASE_SECONDS = 60;
const outboxBackoffMs = (attempts: number) => Math.min(2 ** attempts * 1000, 5 * 60_000);
/** Verified deliveries per merchant and provider, and refused ones, counted apart so forged traffic cannot crowd out real webhooks. */
export const WEBHOOK_RATE = [300, 60_000] as const;
export const WEBHOOK_REFUSED_RATE = [60, 60_000] as const;

type OutboxKind = "start" | "cancel" | "void";

/** The staff member who started an intent (or asked for its void), as the principal its later writes are recorded under. */
function principalFor(intent: PaymentIntent, actor: EventActor): Principal {
  return { type: "staff", id: actor.principal_id, merchantId: intent.merchantId, role: (actor.role ?? "cashier") as Role, name: actor.name ?? "", outletIds: [intent.outletId], brandIds: [], stationId: actor.station_id, outletId: intent.outletId, riskCeiling: null, via: "pin" };
}

export const toIntent = (i: PaymentIntent) => ({
  id: i.id,
  order_id: i.orderId,
  check_id: i.checkId,
  tender_type_id: i.tenderTypeId,
  provider: i.provider,
  terminal_id: i.terminalId,
  amount: i.amount,
  tip_cents: i.tipCents,
  /** What the terminal asks the guest for: the amount and the tip. */
  due_cents: i.amount + i.tipCents,
  currency: i.currency,
  state: i.state,
  outcome_reason: i.outcomeReason,
  provider_ref: i.providerRef,
  payment_id: i.state === "approved" ? i.paymentId : null,
  void_requested_at: i.voidRequestedAt?.toISOString() ?? null,
  provider_voided_at: i.providerVoidedAt?.toISOString() ?? null,
  started_by: i.startedByName,
  expires_at: i.expiresAt.toISOString(),
  decided_at: i.decidedAt?.toISOString() ?? null,
  created_at: i.createdAt.toISOString(),
});

/** One row per intent and kind. A row that gave up after its last attempt is armed again; one still working or done is left alone. */
async function enqueue(intent: Pick<PaymentIntent, "id" | "merchantId">, kind: OutboxKind) {
  await db()
    .insert(paymentOutbox)
    .values({ merchantId: intent.merchantId, intentId: intent.id, kind })
    .onConflictDoUpdate({ target: [paymentOutbox.intentId, paymentOutbox.kind], set: { attempts: 0, nextAttemptAt: new Date(), doneAt: null, failedAt: null, lastError: null }, setWhere: sql`${paymentOutbox.failedAt} is not null` });
}

export async function lockIntent(id: string): Promise<PaymentIntent> {
  await tx()`select id from payment_intents where id = ${id} for update`;
  const [row] = await db().select().from(paymentIntents).where(eq(paymentIntents.id, id)).limit(1);
  if (!row) throw AppError.notFound("payment", id);
  return row;
}

function intentEvent(intent: PaymentIntent, type: string, payload: Record<string, unknown>, opts: { actor: EventActor; operationId: string; correlationId?: string; idempotencyKey?: string | null; version?: number; businessDay?: { cutoff: string; timeZone: string } }) {
  return appendEvent({ merchantId: intent.merchantId, outletId: intent.outletId, type, aggregate: { kind: "order", id: intent.orderId, version: opts.version }, operationId: opts.operationId, payload: { intent_id: intent.id, check_id: intent.checkId, ...payload }, actor: opts.actor, correlationId: opts.correlationId ?? intent.id, idempotencyKey: opts.idempotencyKey ?? null, businessDay: opts.businessDay });
}

/* ---- In the request transaction --------------------------------------------------------------------------------- */

export type StartInput = { intentId: string; checkId: string; tenderTypeId: string; amount: number; tipCents: number; idempotencyKey: string; stationId: string | null };

/** payments.start: pin the bill, write the intent and the outbox row. Never calls the provider. */
export async function startIntent(order: Awaited<ReturnType<typeof lockOrder>>, input: StartInput, p: Principal): Promise<PaymentIntent> {
  if (order.status === "cancelled" || order.status === "completed") throw AppError.state(`The order is ${order.status}`, []);
  const [check] = await db().select().from(checks).where(and(eq(checks.id, input.checkId), eq(checks.orderId, order.id))).limit(1);
  if (!check) throw AppError.notFound("bill", input.checkId);
  const [tender] = await db().select().from(tenderTypes).where(and(eq(tenderTypes.id, input.tenderTypeId), eq(tenderTypes.merchantId, order.merchantId))).limit(1);
  if (!tender || tender.archivedAt) throw AppError.notFound("payment method", input.tenderTypeId);
  if (!tender.provider || !tender.terminalId) throw AppError.validation(`${tender.name} is recorded by hand, not sent to a terminal`, { remedy: "Record the payment with payments.record instead.", details: { tender_type_id: tender.id } });
  if (!paymentProvider(tender.provider)) throw AppError.invariant("provider_unknown", `${tender.name} names the payment provider "${tender.provider}", which this register does not have`, "Ask an Admin to correct the payment method.");
  const [account] = await db().select({ provider: paymentProviderAccounts.provider }).from(paymentProviderAccounts).where(and(eq(paymentProviderAccounts.merchantId, order.merchantId), eq(paymentProviderAccounts.provider, tender.provider))).limit(1);
  if (!account) throw AppError.invariant("provider_not_configured", `The ${tender.provider} provider is not set up for this merchant`, "Ask an Admin to configure the provider's webhook secret (payment_providers.configure).");
  if (!Number.isInteger(input.amount) || input.amount <= 0) throw AppError.validation("amount must be a positive number of minor units");
  if (!Number.isInteger(input.tipCents) || input.tipCents < 0) throw AppError.validation("tip_cents must be zero or a positive number of minor units");
  const balance = check.total - check.paidTotal;
  if (balance <= 0) throw AppError.state(`${check.label} is already paid`, [], "Nothing is owed on this bill.");
  if (input.amount > balance) throw AppError.validation(`${tender.name} payments cannot exceed the balance`, { remedy: "Enter the balance or a smaller part payment.", details: { balance, check_id: check.id } });
  const [existing] = await db().select().from(paymentIntents).where(eq(paymentIntents.id, input.intentId)).limit(1);
  if (existing) throw new AppError("state_conflict", "This payment was already sent to the terminal", { remedy: "Use a new intent_id for a new payment.", details: { intent_id: existing.id, state: existing.state } });
  const [pending] = await db().select({ id: paymentIntents.id }).from(paymentIntents).where(and(eq(paymentIntents.checkId, check.id), eq(paymentIntents.state, "pending"))).limit(1);
  if (pending) throw new AppError("state_conflict", `A payment for ${check.label} is already on the terminal`, { remedy: "Wait for the terminal, or cancel the payment that is waiting.", details: { intent_id: pending.id } });
  const [settings] = await db().select({ currency: merchantSettings.currency, tipsEnabled: merchantSettings.tipsEnabled }).from(merchantSettings).where(eq(merchantSettings.merchantId, order.merchantId)).limit(1);
  if (!settings) throw AppError.notFound("merchant settings", order.merchantId);
  assertTipAllowed(settings.tipsEnabled, input.tipCents);
  const [intent] = await db()
    .insert(paymentIntents)
    .values({
      id: input.intentId,
      merchantId: order.merchantId,
      outletId: order.outletId,
      orderId: order.id,
      checkId: check.id,
      tenderTypeId: tender.id,
      provider: tender.provider,
      terminalId: tender.terminalId,
      amount: input.amount,
      tipCents: input.tipCents,
      currency: settings.currency,
      idempotencyKey: input.idempotencyKey,
      paymentId: randomUUID(),
      pinnedOrderVersion: order.version,
      pinnedCheckTotal: check.total,
      pinnedPaidTotal: check.paidTotal,
      startedBy: p.id,
      startedByName: "name" in p ? p.name : null,
      stationId: input.stationId,
      actor: actorOf(p) as EventActor,
      expiresAt: new Date(Date.now() + INTENT_TTL_SECONDS * 1000),
    })
    .returning();
  await enqueue(intent!, "start");
  return intent!;
}

/** payments.cancel: stop a payment that is waiting on the terminal. An approval that still arrives is given back. */
export async function cancelIntent(intent: PaymentIntent): Promise<PaymentIntent> {
  if (intent.state !== "pending") throw AppError.state(`This payment is already ${intent.state}`, []);
  const [row] = await db().update(paymentIntents).set({ state: "cancelled", outcomeReason: "cancelled", decidedAt: new Date() }).where(eq(paymentIntents.id, intent.id)).returning();
  await enqueue(intent, "cancel");
  return row!;
}

/** payments.void of a provider payment: the money goes back at the provider first; the record is reversed when it confirms. */
export async function requestProviderVoid(intent: PaymentIntent, request: NonNullable<PaymentIntent["voidRequest"]>): Promise<PaymentIntent> {
  const [row] = await db().update(paymentIntents).set({ voidRequestedAt: new Date(), voidRequest: request }).where(eq(paymentIntents.id, intent.id)).returning();
  await enqueue(intent, "void");
  return row!;
}

/** The intent behind a recorded payment, when it came from a provider. */
export async function intentForPayment(paymentId: string): Promise<PaymentIntent | null> {
  const [row] = await db().select().from(paymentIntents).where(eq(paymentIntents.paymentId, paymentId)).limit(1);
  return row && row.state === "approved" ? row : null;
}

/** Payments on this order whose void is waiting for the provider: nothing else may move the money until it answers. */
export async function voidsPendingOn(orderId: string): Promise<number> {
  const [row] = await db().select({ n: sql<number>`count(*)::int` }).from(paymentIntents).where(and(eq(paymentIntents.orderId, orderId), sql`${paymentIntents.voidRequestedAt} is not null`, isNull(paymentIntents.providerVoidedAt)));
  return row?.n ?? 0;
}

/* ---- Outside any request: the worker and the webhook route --------------------------------------------------------- */

async function accountFor(merchantId: string, provider: string): Promise<ProviderAccount | null> {
  const [row] = await db().select().from(paymentProviderAccounts).where(and(eq(paymentProviderAccounts.merchantId, merchantId), eq(paymentProviderAccounts.provider, provider))).limit(1);
  return row ? { merchantId, webhookSecret: row.webhookSecret } : null;
}

export type Outcome = { status: ProviderPaymentStatus; providerRef: string; amount: number };
export type Applied = "recorded" | "declined" | "cancelled" | "bill_changed" | "void_queued" | "unchanged";

class BillChanged extends Error {}

/**
 * Apply what the provider says about an intent, exactly once. The order and then the intent are locked, so a webhook,
 * its duplicate and the worker's poll queue behind one another; whichever comes second finds the intent decided.
 */
export async function applyOutcome(merchantId: string, intentId: string, outcome: Outcome, source: { operationId: string; webhookEvent?: { provider: string; eventId: string } }): Promise<Applied> {
  const seen = async () => {
    if (!source.webhookEvent) return false;
    const rows = await tx()`insert into payment_webhook_events (merchant_id, provider, event_id) values (${merchantId}, ${source.webhookEvent.provider}, ${source.webhookEvent.eventId}) on conflict do nothing returning event_id`;
    return rows.length === 0;
  };
  try {
    return await withTransaction(async () => {
      const [found] = await db().select({ orderId: paymentIntents.orderId }).from(paymentIntents).where(and(eq(paymentIntents.id, intentId), eq(paymentIntents.merchantId, merchantId))).limit(1);
      if (!found) return "unchanged";
      const order = await lockOrder(found.orderId);
      const intent = await lockIntent(intentId);
      if (await seen()) return "unchanged";
      if (intent.providerRef && intent.providerRef !== outcome.providerRef) {
        logger.warn({ intent: intent.id, provider_ref: outcome.providerRef }, "provider outcome for a different provider payment ignored");
        return "unchanged";
      }
      const bd = await businessDayInputs(intent.merchantId, intent.outletId);
      const meta = { actor: intent.actor, operationId: source.operationId, businessDay: bd };
      if (outcome.status === "pending" || outcome.status === "voided") return "unchanged";
      if (intent.state !== "pending") {
        // Money the register did not apply (declined, cancelled, expired or a bill that changed): give it back.
        if (outcome.status === "approved" && intent.state !== "approved" && !intent.providerVoidedAt) {
          await db().update(paymentIntents).set({ providerRef: intent.providerRef ?? outcome.providerRef }).where(eq(paymentIntents.id, intent.id));
          await enqueue(intent, "void");
          return "void_queued";
        }
        return "unchanged";
      }
      if (outcome.status === "declined" || outcome.status === "cancelled") {
        const [row] = await db().update(paymentIntents).set({ state: outcome.status, outcomeReason: outcome.status === "declined" ? "declined" : "cancelled_on_terminal", providerRef: outcome.providerRef, decidedAt: new Date() }).where(eq(paymentIntents.id, intent.id)).returning();
        await settleInvariants();
        await intentEvent(row!, `payment_intent.${outcome.status}`, { amount: intent.amount, reason: row!.outcomeReason }, meta);
        return outcome.status;
      }
      // Approved. The provider must have taken exactly what was pinned, for exactly the bill that was pinned.
      if (outcome.amount !== intent.amount + intent.tipCents) throw new BillChanged("amount_mismatch");
      const [check] = await db().select().from(checks).where(eq(checks.id, intent.checkId)).limit(1);
      if (!check || order.status === "cancelled" || order.status === "completed" || check.total !== intent.pinnedCheckTotal || check.paidTotal !== intent.pinnedPaidTotal) throw new BillChanged("bill_changed");
      const recorder = principalFor(intent, intent.actor);
      const result = await recordPayment(order, { paymentId: intent.paymentId, checkId: intent.checkId, tenderTypeId: intent.tenderTypeId, amount: intent.amount, tipCents: intent.tipCents, reference: outcome.providerRef, stationId: intent.stationId }, recorder);
      // The first payment re-prices before it freezes; a total that moved means the guest was charged for another bill.
      if (result.check.total !== intent.pinnedCheckTotal) throw new BillChanged("bill_changed");
      const [row] = await db().update(paymentIntents).set({ state: "approved", providerRef: outcome.providerRef, decidedAt: new Date() }).where(eq(paymentIntents.id, intent.id)).returning();
      await recordAudit(recorder, { action: "payments.record", targetKind: "order", targetId: order.id, outletId: order.outletId, details: { payment_id: result.payment.id, tender: result.payment.tenderName, amount: result.payment.amount, tip_cents: result.payment.tipCents, provider: intent.provider, provider_ref: outcome.providerRef, intent_id: intent.id } });
      const version = await bumpVersion(order.id);
      await settleInvariants();
      const ev = (type: string, payload: unknown) => appendEvent({ merchantId: order.merchantId, outletId: order.outletId, type, aggregate: { kind: "order", id: order.id, version }, operationId: source.operationId, payload, actor: intent.actor, correlationId: intent.id, businessDay: bd });
      await ev("payment.recorded", { payment_id: result.payment.id, check_id: intent.checkId, tender: result.payment.tenderName, amount: result.payment.amount, rounding_cents: result.payment.roundingCents, tip_cents: result.payment.tipCents, change_cents: 0, reference: result.payment.reference, first_payment: result.firstPayment, intent_id: intent.id });
      if (result.check.status === "paid") await ev("check.paid", { check_id: intent.checkId, total: result.check.total, paid_total: result.check.paidTotal });
      if (result.orderCompleted) await ev("order.completed", { order_no: order.orderNo });
      await intentEvent(row!, "payment_intent.approved", { amount: intent.amount, tip_cents: intent.tipCents, payment_id: intent.paymentId }, { ...meta, version });
      return "recorded";
    });
  } catch (e) {
    if (!(e instanceof BillChanged) && !(e instanceof AppError)) throw e;
    // Nothing was applied (the transaction rolled back). Mark the intent and give the money back at the provider.
    const reason = e instanceof BillChanged ? e.message : "bill_changed";
    if (e instanceof AppError) logger.warn({ intent: intentId, err: e.message }, "provider approval could not be recorded; voiding it at the provider");
    return withTransaction(async () => {
      const [found] = await db().select({ orderId: paymentIntents.orderId }).from(paymentIntents).where(and(eq(paymentIntents.id, intentId), eq(paymentIntents.merchantId, merchantId))).limit(1);
      if (!found) return "unchanged";
      await lockOrder(found.orderId);
      const intent = await lockIntent(intentId);
      await seen();
      if (intent.state !== "pending") {
        // Decided meanwhile (expired, cancelled): the approval is still money the register did not apply.
        if (intent.state === "approved" || intent.providerVoidedAt) return "unchanged";
        await db().update(paymentIntents).set({ providerRef: intent.providerRef ?? outcome.providerRef }).where(eq(paymentIntents.id, intent.id));
        await enqueue(intent, "void");
        return "void_queued" as const;
      }
      const [row] = await db().update(paymentIntents).set({ state: "cancelled", outcomeReason: reason, providerRef: outcome.providerRef, decidedAt: new Date() }).where(eq(paymentIntents.id, intent.id)).returning();
      await enqueue(intent, "void");
      await settleInvariants();
      await intentEvent(row!, "payment_intent.cancelled", { amount: intent.amount, reason }, { actor: intent.actor, operationId: source.operationId });
      return "bill_changed" as const;
    });
  }
}

/** The provider confirmed a void: record it, and reverse the payment when a person asked for the void. */
async function completeVoid(intentId: string): Promise<void> {
  await withTransaction(async () => {
    const [found] = await db().select({ orderId: paymentIntents.orderId }).from(paymentIntents).where(eq(paymentIntents.id, intentId)).limit(1);
    if (!found) return;
    const order = await lockOrder(found.orderId);
    const intent = await lockIntent(intentId);
    if (intent.providerVoidedAt) return;
    await db().update(paymentIntents).set({ providerVoidedAt: new Date() }).where(eq(paymentIntents.id, intent.id));
    const request = intent.voidRequest;
    const bd = await businessDayInputs(intent.merchantId, intent.outletId);
    if (!request || intent.state !== "approved") {
      await settleInvariants();
      await intentEvent(intent, "payment_intent.voided", { amount: intent.amount + intent.tipCents, reason: intent.outcomeReason }, { actor: intent.actor, operationId: "payments.provider_void", businessDay: bd });
      return;
    }
    const [payment] = await db().select().from(payments).where(eq(payments.id, intent.paymentId)).limit(1);
    if (!payment || payment.status !== "recorded") return;
    const [shift] = payment.shiftId ? await tx()<{ status: string }[]>`select status from shifts where id = ${payment.shiftId} for update` : [];
    const [dayClosed] = await db().select({ id: businessDayCloses.id }).from(businessDayCloses).where(and(eq(businessDayCloses.outletId, payment.outletId), eq(businessDayCloses.businessDate, payment.businessDate))).limit(1);
    const [refunded] = await db().select({ n: sql<number>`count(*)::int` }).from(refunds).where(eq(refunds.checkId, payment.checkId));
    // The same conditions as assertVoidable: the register gave up waiting, and since then the bill was refunded or the
    // order cancelled (the guest already has money back), or the shift or day closed (a closed day never changes,
    // pricing-semantics §10). The payment stands, and the event says why, for staff to settle with the guest.
    const notApplied = order.status === "cancelled" ? "order_cancelled" : (refunded?.n ?? 0) > 0 ? "refunded" : shift && shift.status !== "open" ? "shift_closed" : dayClosed ? "business_day_closed" : null;
    if (notApplied) {
      await settleInvariants();
      await intentEvent(intent, "payment_intent.voided_not_applied", { amount: intent.amount + intent.tipCents, payment_id: payment.id, reason: notApplied }, { actor: request.actor, operationId: "payments.provider_void", businessDay: bd });
      return;
    }
    const by = principalFor(intent, request.actor);
    await reversePayment(order, payment, request.reason, by);
    await recordAudit(by, { action: "payments.void", targetKind: "payment", targetId: payment.id, outletId: order.outletId, reason: request.reason, approver: request.approver_id ? { id: request.approver_id, name: request.approver_name } : null, overrideId: request.override_id, details: { amount: payment.amount, tender: payment.tenderName, provider: intent.provider, provider_ref: intent.providerRef } });
    const version = await bumpVersion(order.id);
    await settleInvariants();
    await appendEvent({ merchantId: order.merchantId, outletId: order.outletId, type: "payment.voided", aggregate: { kind: "order", id: order.id, version }, operationId: "payments.void", payload: { payment_id: payment.id, check_id: payment.checkId, amount: payment.amount, tip_cents: payment.tipCents, tender: payment.tenderName, intent_id: intent.id }, reason: { text: request.reason }, approval: request.approver_id ? { override_id: request.override_id ?? undefined, approver_id: request.approver_id, approver_name: request.approver_name ?? undefined } : null, actor: request.actor, correlationId: intent.id, businessDay: bd });
  });
}

type OutboxRow = { id: string; intent_id: string; merchant_id: string; kind: OutboxKind; attempts: number };

async function runOutboxRow(row: OutboxRow, provider: PaymentProvider, intent: PaymentIntent, account: ProviderAccount): Promise<void> {
  const ref = { account, reference: intent.id, providerRef: intent.providerRef };
  if (row.kind === "start") {
    // Cancelled or expired before the worker got to it: the terminal never sees it.
    if (intent.state !== "pending") return;
    const { providerRef } = await provider.startPayment({ account, reference: intent.id, terminalId: intent.terminalId, amount: intent.amount + intent.tipCents, currency: intent.currency });
    await withTransaction(() => db().update(paymentIntents).set({ providerRef }).where(and(eq(paymentIntents.id, intent.id), isNull(paymentIntents.providerRef))));
    return;
  }
  if (row.kind === "cancel") {
    const status = await provider.cancelPayment(ref);
    // Too late to stop: the guest paid, and the register will not apply it. Give it back.
    if (status === "approved") await withTransaction(() => enqueue(intent, "void"));
    // Still on the terminal: not settled yet, so the row tries again (and the poll keeps asking).
    else if (status === "pending") throw new Error("the payment is still on the terminal");
    return;
  }
  const payment = intent.providerRef ? null : await provider.getPayment(ref);
  const providerRef = intent.providerRef ?? payment?.providerRef ?? null;
  if (providerRef && payment?.status !== "cancelled" && payment?.status !== "declined") await provider.voidPayment({ account, reference: intent.id, providerRef, amount: intent.amount + intent.tipCents });
  await completeVoid(intent.id);
}

/**
 * A row out of attempts: say so where people look. A failed void is an event on the order (money the provider still
 * holds), and a void a person asked for can be asked for again; the poll arms an unapplied approval's void again.
 */
async function giveUp(row: OutboxRow, intent: PaymentIntent | null, error: string) {
  logger.error({ outbox: row.id, intent: row.intent_id, kind: row.kind, error }, "payment provider call failed for good");
  if (!intent || row.kind !== "void") return;
  await withTransaction(async () => {
    // The register stops waiting (the shift and day can close, the void can be asked for again), but it keeps who asked
    // and why: the provider may have voided although no answer came back, and the poll applies that void when it says so.
    if (intent.voidRequest) await db().update(paymentIntents).set({ voidRequestedAt: null }).where(eq(paymentIntents.id, intent.id));
    await settleInvariants();
    await intentEvent(intent, "payment_intent.void_failed", { amount: intent.amount + intent.tipCents, error: error.slice(0, 200) }, { actor: intent.voidRequest?.actor ?? intent.actor, operationId: "payments.provider_void" });
  });
}

/**
 * Work through due outbox rows. Each row is claimed under a lease and then handled on its own: a failure moves that
 * row's next attempt back (doubling each time) and never stops the rows after it.
 */
export async function drainPaymentOutbox(limit = 20): Promise<{ done: number; retried: number; failed: number }> {
  const tally = { done: 0, retried: 0, failed: 0 };
  // One row per claim, so each row's lease starts when its own call does: a slow row never ages the rows behind it.
  const seenIds = new Set<string>();
  for (let i = 0; i < limit; i++) {
    const [row] = await withOwnTransaction(
      (s) => s<OutboxRow[]>`update payment_outbox set attempts = attempts + 1, next_attempt_at = now() + make_interval(secs => ${OUTBOX_LEASE_SECONDS})
        where id = (select id from payment_outbox where done_at is null and next_attempt_at <= now() order by next_attempt_at limit 1 for update skip locked)
        returning id, intent_id, merchant_id, kind, attempts`,
    );
    if (!row || seenIds.has(row.id)) break;
    seenIds.add(row.id);
    let intent: PaymentIntent | null = null;
    try {
      const loaded = await withTransaction(async () => {
        const [i] = await db().select().from(paymentIntents).where(eq(paymentIntents.id, row.intent_id)).limit(1);
        return { intent: i ?? null, account: i ? await accountFor(i.merchantId, i.provider) : null };
      });
      intent = loaded.intent;
      if (!intent) throw new Error("intent not found");
      const provider = paymentProvider(intent.provider);
      if (!provider) throw new Error(`payment provider ${intent.provider} is not registered`);
      if (!loaded.account) throw new Error(`payment provider ${intent.provider} is not configured for the merchant`);
      await runOutboxRow(row, provider, intent, loaded.account);
      await withOwnTransaction((s) => s`update payment_outbox set done_at = now(), last_error = null where id = ${row.id}`);
      tally.done++;
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      if (row.attempts >= OUTBOX_MAX_ATTEMPTS) {
        await withOwnTransaction((s) => s`update payment_outbox set done_at = now(), failed_at = now(), last_error = ${error} where id = ${row.id}`);
        await giveUp(row, intent, error).catch((err: unknown) => logger.error({ err, outbox: row.id }, "could not record the failed provider call"));
        tally.failed++;
      } else {
        await withOwnTransaction((s) => s`update payment_outbox set next_attempt_at = now() + make_interval(secs => ${outboxBackoffMs(row.attempts) / 1000}), last_error = ${error} where id = ${row.id}`);
        logger.warn({ outbox: row.id, kind: row.kind, attempts: row.attempts, error }, "payment provider call failed; will retry");
        tally.retried++;
      }
    }
  }
  return tally;
}

/**
 * Ask the provider about intents that are waiting, for when a webhook is late or never comes, and about intents the
 * register gave up on (declined, cancelled, expired) in the last hour without a confirmed void: a guest can still
 * complete one of those on the terminal, and that approval must be given back even if its webhook is lost.
 */
export async function pollPendingIntents(limit = 50): Promise<number> {
  const pending = await withTransaction(() =>
    db()
      .select()
      .from(paymentIntents)
      .where(
        sql`(${paymentIntents.state} = 'pending' and ${paymentIntents.providerRef} is not null) or (${paymentIntents.state} in ('declined', 'cancelled', 'expired') and ${paymentIntents.providerVoidedAt} is null and ${paymentIntents.decidedAt} > now() - interval '1 hour') or (${paymentIntents.state} = 'approved' and ${paymentIntents.voidRequest} is not null and ${paymentIntents.providerVoidedAt} is null and ${paymentIntents.decidedAt} > now() - interval '1 day')`,
      )
      .orderBy(asc(paymentIntents.createdAt))
      .limit(limit),
  );
  let applied = 0;
  for (const intent of pending) {
    try {
      const provider = paymentProvider(intent.provider);
      const account = await withTransaction(() => accountFor(intent.merchantId, intent.provider));
      if (!provider || !account) continue;
      const p = await provider.getPayment({ account, reference: intent.id, providerRef: intent.providerRef });
      // A void that was asked for: the provider says the money is back, so the register applies it.
      if (intent.state === "approved") {
        if (p?.status === "voided") {
          await completeVoid(intent.id);
          applied++;
        }
        continue;
      }
      if (!p || p.status === "pending" || (intent.state !== "pending" && p.status !== "approved")) continue;
      const r = await applyOutcome(intent.merchantId, intent.id, { status: p.status, providerRef: p.providerRef, amount: p.amount }, { operationId: "payments.poll" });
      if (r !== "unchanged") applied++;
    } catch (e) {
      logger.warn({ err: e, intent: intent.id }, "polling the provider failed");
    }
  }
  return applied;
}

/** Intents past their time: expired, and stopped at the provider. An approval that arrives later is given back. */
export async function expireIntents(now = new Date()): Promise<number> {
  const due = await withTransaction(() => db().select({ id: paymentIntents.id, orderId: paymentIntents.orderId }).from(paymentIntents).where(and(eq(paymentIntents.state, "pending"), lt(paymentIntents.expiresAt, now))).limit(100));
  let n = 0;
  for (const d of due) {
    try {
      await withTransaction(async () => {
        await lockOrder(d.orderId);
        const intent = await lockIntent(d.id);
        if (intent.state !== "pending") return;
        const [row] = await db().update(paymentIntents).set({ state: "expired", outcomeReason: "expired", decidedAt: new Date() }).where(eq(paymentIntents.id, intent.id)).returning();
        await enqueue(intent, "cancel");
        await settleInvariants();
        await intentEvent(row!, "payment_intent.expired", { amount: intent.amount }, { actor: intent.actor, operationId: "payments.expire" });
        n++;
      });
    } catch (e) {
      logger.warn({ err: e, intent: d.id }, "expiring a payment intent failed");
    }
  }
  return n;
}

/** Webhook events older than a day are beyond any provider's retry window and the signature tolerance. */
export async function pruneWebhookEvents(): Promise<void> {
  await withOwnTransaction((s) => s`delete from payment_webhook_events where received_at < now() - interval '1 day'`);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A webhook from a provider. Unauthenticated until its signature checks out against the merchant's secret (a cheap
 * HMAC, checked first). Verified and refused deliveries count against separate per-merchant limits, so a flood of
 * unsigned requests is throttled without starving the provider's real webhooks. Applied at most once per event and intent.
 */
export async function receiveWebhook(providerName: string, merchantId: string, headers: Headers, body: string): Promise<{ applied: Applied }> {
  const refused = () => new AppError("unauthenticated", "Webhook signature not accepted", { remedy: "Sign the webhook with the merchant's secret for this provider." });
  const provider = paymentProvider(providerName);
  if (!provider || !UUID.test(merchantId)) throw refused();
  const account = await withTransaction(() => accountFor(merchantId, providerName));
  if (!account) throw refused();
  let event;
  try {
    event = provider.verifyWebhook({ headers, body, secret: account.webhookSecret, now: new Date() });
  } catch (e) {
    if (e instanceof WebhookRejected) {
      logger.warn({ provider: providerName, merchant: merchantId, reason: e.message }, "webhook refused");
      await enforceLimit(merchantId, `webhook-refused:${providerName}`, WEBHOOK_REFUSED_RATE, "refused webhook deliveries");
      throw refused();
    }
    throw e;
  }
  await enforceLimit(merchantId, `webhook:${providerName}`, WEBHOOK_RATE, "webhook deliveries");
  const [intent] = await withTransaction(() => db().select({ id: paymentIntents.id }).from(paymentIntents).where(and(eq(paymentIntents.id, event.reference), eq(paymentIntents.merchantId, merchantId), eq(paymentIntents.provider, providerName))).limit(1));
  if (!intent) {
    logger.warn({ provider: providerName, merchant: merchantId, reference: event.reference }, "webhook for an unknown payment acknowledged and ignored");
    return { applied: "unchanged" };
  }
  const applied = await applyOutcome(merchantId, intent.id, { status: event.status, providerRef: event.providerRef, amount: event.amount }, { operationId: "payments.webhook", webhookEvent: { provider: providerName, eventId: event.eventId } });
  return { applied };
}
