CREATE TYPE "public"."station_home" AS ENUM('floor', 'takeaway');--> statement-breakpoint
CREATE TYPE "public"."tax_mode" AS ENUM('inclusive', 'exclusive');--> statement-breakpoint
CREATE TYPE "public"."staff_role" AS ENUM('server', 'cashier', 'manager', 'finance', 'admin');--> statement-breakpoint
CREATE TABLE "brands" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"merchant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"accent_color" text,
	"display_font" text,
	"logo_url" text,
	"legacy_id" text,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "merchant_settings" (
	"merchant_id" uuid PRIMARY KEY NOT NULL,
	"tax_mode" "tax_mode" DEFAULT 'exclusive' NOT NULL,
	"gst_bps" integer DEFAULT 900 NOT NULL,
	"cash_rounding_increment" integer,
	"business_day_cutoff" text DEFAULT '04:00' NOT NULL,
	"timezone" text DEFAULT 'Asia/Singapore' NOT NULL,
	"currency" text DEFAULT 'SGD' NOT NULL,
	"receipt_footer" text,
	"receipt_show_outlet_phone" boolean DEFAULT true NOT NULL,
	"busy_mode_threshold" integer DEFAULT 12 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "merchants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outlets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"merchant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"address" text,
	"phone" text,
	"uen" text,
	"business_day_cutoff" text,
	"hours" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"service_theme_from" text DEFAULT '18:00',
	"legacy_id" text,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"merchant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"name" text NOT NULL,
	"layout_id" uuid,
	"brand_id" uuid,
	"pay_before_firing" boolean DEFAULT false NOT NULL,
	"seats_enabled" boolean DEFAULT false NOT NULL,
	"home" "station_home" DEFAULT 'floor' NOT NULL,
	"receipt_printer_id" uuid,
	"text_size" text DEFAULT 'standard' NOT NULL,
	"paired_at" timestamp with time zone,
	"device_label" text,
	"token_hash" text,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "staff" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"merchant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"initials" text,
	"email" text,
	"auth_subject" text,
	"role" "staff_role" NOT NULL,
	"pin_hash" text,
	"pin_failed_attempts" integer DEFAULT 0 NOT NULL,
	"pin_locked_until" timestamp with time zone,
	"outlet_ids" uuid[] DEFAULT '{}' NOT NULL,
	"brand_ids" uuid[] DEFAULT '{}' NOT NULL,
	"risk_ceiling" text,
	"left_handed" boolean DEFAULT false NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"legacy_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "staff_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"merchant_id" uuid NOT NULL,
	"staff_id" uuid NOT NULL,
	"station_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"merchant_id" uuid NOT NULL,
	"outlet_id" uuid,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text NOT NULL,
	"actor_name" text,
	"actor_role" text,
	"on_behalf_of" text,
	"action" text NOT NULL,
	"target_kind" text NOT NULL,
	"target_id" text,
	"approver_id" text,
	"approver_name" text,
	"override_id" uuid,
	"reason" text,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"merchant_id" uuid NOT NULL,
	"outlet_id" uuid,
	"seq" bigint NOT NULL,
	"business_date" date NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"type" text NOT NULL,
	"aggregate_kind" text NOT NULL,
	"aggregate_id" uuid NOT NULL,
	"aggregate_version" integer DEFAULT 0 NOT NULL,
	"operation_id" text NOT NULL,
	"idempotency_key" text,
	"actor" jsonb NOT NULL,
	"approval" jsonb,
	"reason" jsonb,
	"causation_id" uuid,
	"correlation_id" uuid NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "idempotency_keys" (
	"merchant_id" uuid,
	"principal_id" text NOT NULL,
	"key" text NOT NULL,
	"request_hash" text NOT NULL,
	"status" integer,
	"body" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "idempotency_keys_principal_id_key_pk" PRIMARY KEY("principal_id","key")
);
--> statement-breakpoint
CREATE TABLE "merchant_sequences" (
	"merchant_id" uuid PRIMARY KEY NOT NULL,
	"next_seq" bigint DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outlet_sequences" (
	"outlet_id" uuid PRIMARY KEY NOT NULL,
	"merchant_id" uuid NOT NULL,
	"next_seq" bigint DEFAULT 1 NOT NULL,
	"next_order_no" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "brands" ADD CONSTRAINT "brands_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merchant_settings" ADD CONSTRAINT "merchant_settings_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outlets" ADD CONSTRAINT "outlets_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stations" ADD CONSTRAINT "stations_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stations" ADD CONSTRAINT "stations_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stations" ADD CONSTRAINT "stations_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff" ADD CONSTRAINT "staff_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_sessions" ADD CONSTRAINT "staff_sessions_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_sessions" ADD CONSTRAINT "staff_sessions_staff_id_staff_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."staff"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_sessions" ADD CONSTRAINT "staff_sessions_station_id_stations_id_fk" FOREIGN KEY ("station_id") REFERENCES "public"."stations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merchant_sequences" ADD CONSTRAINT "merchant_sequences_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outlet_sequences" ADD CONSTRAINT "outlet_sequences_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "brands_merchant_idx" ON "brands" USING btree ("merchant_id");--> statement-breakpoint
CREATE INDEX "outlets_merchant_idx" ON "outlets" USING btree ("merchant_id");--> statement-breakpoint
CREATE INDEX "stations_outlet_idx" ON "stations" USING btree ("merchant_id","outlet_id");--> statement-breakpoint
CREATE INDEX "staff_merchant_idx" ON "staff" USING btree ("merchant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "staff_auth_subject_uq" ON "staff" USING btree ("auth_subject");--> statement-breakpoint
CREATE UNIQUE INDEX "staff_merchant_email_uq" ON "staff" USING btree ("merchant_id","email");--> statement-breakpoint
CREATE INDEX "staff_sessions_station_idx" ON "staff_sessions" USING btree ("station_id","ended_at");--> statement-breakpoint
CREATE INDEX "audit_merchant_time_idx" ON "audit_log" USING btree ("merchant_id","occurred_at");--> statement-breakpoint
CREATE INDEX "audit_target_idx" ON "audit_log" USING btree ("target_kind","target_id");--> statement-breakpoint
CREATE UNIQUE INDEX "events_outlet_seq_uq" ON "events" USING btree ("outlet_id","seq");--> statement-breakpoint
CREATE INDEX "events_merchant_seq_idx" ON "events" USING btree ("merchant_id","seq");--> statement-breakpoint
CREATE INDEX "events_aggregate_idx" ON "events" USING btree ("aggregate_kind","aggregate_id");--> statement-breakpoint
CREATE INDEX "events_business_date_idx" ON "events" USING btree ("merchant_id","outlet_id","business_date");--> statement-breakpoint
CREATE INDEX "idempotency_created_idx" ON "idempotency_keys" USING btree ("created_at");