import { bigint, index, integer, jsonb, pgEnum, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { tenderTypes } from "./catalogue.js";
import { orders } from "./orders.js";
import type { EventActor } from "./system.js";

/**
 * Payments taken through a provider (a card terminal): the intent that is in flight for a bill, the outbox of calls
 * the worker makes to the provider, each merchant's provider account (its webhook secret) and the webhook events
 * already seen. The register never calls a provider inside a request transaction.
 */
export const paymentIntentStateEnum = pgEnum("payment_intent_state", ["pending", "approved", "declined", "cancelled", "expired"]);

export const paymentIntents = pgTable(
  "payment_intents",
  {
    /** Client-generated, and the reference the provider is given. */
    id: uuid("id").primaryKey(),
    merchantId: uuid("merchant_id").notNull(),
    outletId: uuid("outlet_id").notNull(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id),
    /** No foreign key: re-splitting an unpaid bill deletes and rebuilds its checks, and an intent outlives that (it is then refused as a changed bill). */
    checkId: uuid("check_id").notNull(),
    tenderTypeId: uuid("tender_type_id")
      .notNull()
      .references(() => tenderTypes.id),
    provider: text("provider").notNull(),
    terminalId: text("terminal_id").notNull(),
    /** Applied to the bill's balance; the provider charges amount + tip. */
    amount: bigint("amount", { mode: "number" }).notNull(),
    tipCents: bigint("tip_cents", { mode: "number" }).notNull().default(0),
    currency: text("currency").notNull(),
    state: paymentIntentStateEnum("state").notNull().default("pending"),
    /** Why it ended other than approved: declined by the provider, cancelled by staff, bill_changed, expired. */
    outcomeReason: text("outcome_reason"),
    providerRef: text("provider_ref"),
    /** The Idempotency-Key of the payments.start request. */
    idempotencyKey: text("idempotency_key").notNull(),
    /** Reserved at start, so applying an approval twice can only ever insert one payment row. */
    paymentId: uuid("payment_id").notNull(),
    /** The bill as it was at start. An approval is applied only to the same bill. */
    pinnedOrderVersion: integer("pinned_order_version").notNull(),
    pinnedCheckTotal: bigint("pinned_check_total", { mode: "number" }).notNull(),
    pinnedPaidTotal: bigint("pinned_paid_total", { mode: "number" }).notNull(),
    startedBy: uuid("started_by"),
    startedByName: text("started_by_name"),
    stationId: uuid("station_id"),
    actor: jsonb("actor").$type<EventActor>().notNull(),
    /** A void of the recorded payment was asked for (payments.void) and waits for the provider. */
    voidRequestedAt: timestamp("void_requested_at", { withTimezone: true }),
    voidRequest: jsonb("void_request").$type<{ reason: string; requested_by: string; requested_by_name: string | null; approver_id: string | null; approver_name: string | null; override_id: string | null; actor: EventActor } | null>(),
    /** The provider confirmed the money went back (a void of an approval that was not applied, or of a voided payment). */
    providerVoidedAt: timestamp("provider_voided_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // One payment in flight per bill: concurrent starts serialise on the order lock, and this is the database's guard.
    uniqueIndex("payment_intents_one_pending_per_check").on(t.checkId).where(sql`state = 'pending'`),
    uniqueIndex("payment_intents_provider_ref_uq").on(t.merchantId, t.provider, t.providerRef),
    uniqueIndex("payment_intents_payment_uq").on(t.paymentId),
    index("payment_intents_order_idx").on(t.orderId),
    index("payment_intents_pending_idx").on(t.state, t.expiresAt),
  ],
);

/** Calls to the provider, made by the worker after the transaction that asked for them has committed. */
export const paymentOutbox = pgTable(
  "payment_outbox",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    merchantId: uuid("merchant_id").notNull(),
    intentId: uuid("intent_id")
      .notNull()
      .references(() => paymentIntents.id),
    /** start: send to the terminal; cancel: stop it; void: give an approved payment back. */
    kind: text("kind").$type<"start" | "cancel" | "void">().notNull(),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    lastError: text("last_error"),
    doneAt: timestamp("done_at", { withTimezone: true }),
    /** Gave up after the last attempt; a person has to look. */
    failedAt: timestamp("failed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("payment_outbox_intent_kind_uq").on(t.intentId, t.kind), index("payment_outbox_due_idx").on(t.nextAttemptAt).where(sql`done_at IS NULL`)],
);

/** A merchant's account with a provider. The webhook secret signs what the provider sends; it is never returned. */
export const paymentProviderAccounts = pgTable(
  "payment_provider_accounts",
  {
    merchantId: uuid("merchant_id").notNull(),
    provider: text("provider").notNull(),
    webhookSecret: text("webhook_secret").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.merchantId, t.provider] })],
);

/** Webhook events already accepted, so a replayed delivery is recognised and applied at most once. */
export const paymentWebhookEvents = pgTable(
  "payment_webhook_events",
  {
    merchantId: uuid("merchant_id").notNull(),
    provider: text("provider").notNull(),
    eventId: text("event_id").notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.merchantId, t.provider, t.eventId] })],
);

export type PaymentIntent = typeof paymentIntents.$inferSelect;
