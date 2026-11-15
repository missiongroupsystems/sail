CREATE TYPE "public"."payment_intent_state" AS ENUM('pending', 'approved', 'declined', 'cancelled', 'expired');--> statement-breakpoint
CREATE TABLE "payment_intents" (
	"id" uuid PRIMARY KEY NOT NULL,
	"merchant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"check_id" uuid NOT NULL,
	"tender_type_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"terminal_id" text NOT NULL,
	"amount" integer NOT NULL,
	"tip_cents" integer DEFAULT 0 NOT NULL,
	"currency" text NOT NULL,
	"state" "payment_intent_state" DEFAULT 'pending' NOT NULL,
	"outcome_reason" text,
	"provider_ref" text,
	"idempotency_key" text NOT NULL,
	"payment_id" uuid NOT NULL,
	"pinned_order_version" integer NOT NULL,
	"pinned_check_total" integer NOT NULL,
	"pinned_paid_total" integer NOT NULL,
	"started_by" uuid,
	"started_by_name" text,
	"station_id" uuid,
	"actor" jsonb NOT NULL,
	"void_requested_at" timestamp with time zone,
	"void_request" jsonb,
	"provider_voided_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payment_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"merchant_id" uuid NOT NULL,
	"intent_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text,
	"done_at" timestamp with time zone,
	"failed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payment_provider_accounts" (
	"merchant_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"webhook_secret" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_provider_accounts_merchant_id_provider_pk" PRIMARY KEY("merchant_id","provider")
);
--> statement-breakpoint
CREATE TABLE "payment_webhook_events" (
	"merchant_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"event_id" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_webhook_events_merchant_id_provider_event_id_pk" PRIMARY KEY("merchant_id","provider","event_id")
);
--> statement-breakpoint
ALTER TABLE "tender_types" ADD COLUMN "provider" text;--> statement-breakpoint
ALTER TABLE "tender_types" ADD COLUMN "terminal_id" text;--> statement-breakpoint
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_tender_type_id_tender_types_id_fk" FOREIGN KEY ("tender_type_id") REFERENCES "public"."tender_types"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_outbox" ADD CONSTRAINT "payment_outbox_intent_id_payment_intents_id_fk" FOREIGN KEY ("intent_id") REFERENCES "public"."payment_intents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "payment_intents_one_pending_per_check" ON "payment_intents" USING btree ("check_id") WHERE state = 'pending';--> statement-breakpoint
CREATE UNIQUE INDEX "payment_intents_provider_ref_uq" ON "payment_intents" USING btree ("merchant_id","provider","provider_ref");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_intents_payment_uq" ON "payment_intents" USING btree ("payment_id");--> statement-breakpoint
CREATE INDEX "payment_intents_order_idx" ON "payment_intents" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "payment_intents_pending_idx" ON "payment_intents" USING btree ("state","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_outbox_intent_kind_uq" ON "payment_outbox" USING btree ("intent_id","kind");--> statement-breakpoint
CREATE INDEX "payment_outbox_due_idx" ON "payment_outbox" USING btree ("next_attempt_at") WHERE done_at IS NULL;