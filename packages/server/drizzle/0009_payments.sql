CREATE TYPE "public"."check_status" AS ENUM('open', 'paid', 'partially_refunded', 'refunded');--> statement-breakpoint
CREATE TYPE "public"."payment_status" AS ENUM('recorded', 'reversed');--> statement-breakpoint
CREATE TYPE "public"."shift_status" AS ENUM('open', 'closed');--> statement-breakpoint
CREATE TABLE "business_day_closes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"merchant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"business_date" text NOT NULL,
	"closed_by" uuid,
	"closed_by_name" text,
	"closed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"z_report" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "check_allocations" (
	"merchant_id" uuid NOT NULL,
	"check_id" uuid NOT NULL,
	"order_line_id" uuid NOT NULL,
	"share_num" integer DEFAULT 1 NOT NULL,
	"share_den" integer DEFAULT 1 NOT NULL,
	"base" integer DEFAULT 0 NOT NULL,
	"discount" integer DEFAULT 0 NOT NULL,
	"fee" integer DEFAULT 0 NOT NULL,
	"gst" integer DEFAULT 0 NOT NULL,
	"total" integer DEFAULT 0 NOT NULL,
	"adjustments" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "check_allocations_check_id_order_line_id_pk" PRIMARY KEY("check_id","order_line_id")
);
--> statement-breakpoint
CREATE TABLE "checks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"merchant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"index" integer NOT NULL,
	"label" text NOT NULL,
	"status" "check_status" DEFAULT 'open' NOT NULL,
	"seat_no" integer,
	"subtotal" integer DEFAULT 0 NOT NULL,
	"discount_total" integer DEFAULT 0 NOT NULL,
	"fee_total" integer DEFAULT 0 NOT NULL,
	"gst_total" integer DEFAULT 0 NOT NULL,
	"total" integer DEFAULT 0 NOT NULL,
	"paid_total" integer DEFAULT 0 NOT NULL,
	"rounding_total" integer DEFAULT 0 NOT NULL,
	"refunded_total" integer DEFAULT 0 NOT NULL,
	"locked_at" timestamp with time zone,
	"paid_at" timestamp with time zone,
	"invoice_no" text,
	"invoice_issued_at" timestamp with time zone,
	"invoice_document" jsonb,
	"receipt_no" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "digital_receipts" (
	"token" text PRIMARY KEY NOT NULL,
	"merchant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"check_id" uuid,
	"refund_id" uuid,
	"document" jsonb NOT NULL,
	"channel" text NOT NULL,
	"destination" text,
	"delivery_status" text DEFAULT 'link_only' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "document_sequences" (
	"merchant_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"next_no" integer DEFAULT 1 NOT NULL,
	"prefix" text DEFAULT '' NOT NULL,
	CONSTRAINT "document_sequences_merchant_id_kind_pk" PRIMARY KEY("merchant_id","kind")
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"merchant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"check_id" uuid NOT NULL,
	"tender_type_id" uuid NOT NULL,
	"tender_name" text NOT NULL,
	"is_cash" boolean NOT NULL,
	"amount" integer NOT NULL,
	"rounding_cents" integer DEFAULT 0 NOT NULL,
	"tendered" integer,
	"change_cents" integer DEFAULT 0 NOT NULL,
	"tip_cents" integer DEFAULT 0 NOT NULL,
	"reference" text,
	"status" "payment_status" DEFAULT 'recorded' NOT NULL,
	"recorded_by" uuid,
	"recorded_by_name" text,
	"station_id" uuid,
	"shift_id" uuid,
	"business_date" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reversed_at" timestamp with time zone,
	"reversed_by" uuid,
	"reversed_reason" text
);
--> statement-breakpoint
CREATE TABLE "shifts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"merchant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"station_id" uuid,
	"name" text,
	"status" "shift_status" DEFAULT 'open' NOT NULL,
	"business_date" text NOT NULL,
	"opened_by" uuid,
	"opened_by_name" text,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"float_cents" integer DEFAULT 0 NOT NULL,
	"float_counts" jsonb,
	"closed_by" uuid,
	"closed_by_name" text,
	"closed_at" timestamp with time zone,
	"counted_cash_cents" integer,
	"counted_counts" jsonb,
	"expected_cash_cents" integer,
	"variance_cents" integer,
	"variance_reason" text,
	"summary" jsonb
);
--> statement-breakpoint
ALTER TABLE "business_day_closes" ADD CONSTRAINT "business_day_closes_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "check_allocations" ADD CONSTRAINT "check_allocations_check_id_checks_id_fk" FOREIGN KEY ("check_id") REFERENCES "public"."checks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "check_allocations" ADD CONSTRAINT "check_allocations_order_line_id_order_lines_id_fk" FOREIGN KEY ("order_line_id") REFERENCES "public"."order_lines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checks" ADD CONSTRAINT "checks_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "digital_receipts" ADD CONSTRAINT "digital_receipts_check_id_checks_id_fk" FOREIGN KEY ("check_id") REFERENCES "public"."checks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_sequences" ADD CONSTRAINT "document_sequences_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_check_id_checks_id_fk" FOREIGN KEY ("check_id") REFERENCES "public"."checks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_tender_type_id_tender_types_id_fk" FOREIGN KEY ("tender_type_id") REFERENCES "public"."tender_types"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_station_id_stations_id_fk" FOREIGN KEY ("station_id") REFERENCES "public"."stations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_station_id_stations_id_fk" FOREIGN KEY ("station_id") REFERENCES "public"."stations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "business_day_closes_uq" ON "business_day_closes" USING btree ("outlet_id","business_date");--> statement-breakpoint
CREATE INDEX "check_allocations_line_idx" ON "check_allocations" USING btree ("order_line_id");--> statement-breakpoint
CREATE UNIQUE INDEX "checks_order_index_uq" ON "checks" USING btree ("order_id","index");--> statement-breakpoint
CREATE INDEX "checks_outlet_idx" ON "checks" USING btree ("outlet_id","status");--> statement-breakpoint
CREATE INDEX "digital_receipts_check_idx" ON "digital_receipts" USING btree ("check_id");--> statement-breakpoint
CREATE INDEX "payments_check_idx" ON "payments" USING btree ("check_id");--> statement-breakpoint
CREATE INDEX "payments_outlet_date_idx" ON "payments" USING btree ("outlet_id","business_date");--> statement-breakpoint
CREATE INDEX "payments_shift_idx" ON "payments" USING btree ("shift_id");--> statement-breakpoint
CREATE INDEX "shifts_outlet_idx" ON "shifts" USING btree ("outlet_id","status");--> statement-breakpoint
CREATE INDEX "shifts_station_idx" ON "shifts" USING btree ("station_id","status");