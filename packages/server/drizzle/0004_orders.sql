CREATE TYPE "public"."line_source" AS ENUM('pos', 'guest');--> statement-breakpoint
CREATE TYPE "public"."line_status" AS ENUM('pending', 'held', 'fired', 'voided');--> statement-breakpoint
CREATE TYPE "public"."order_status" AS ENUM('open', 'fired', 'ready', 'out_for_delivery', 'completed', 'cancelled');--> statement-breakpoint
CREATE TABLE "order_adjustment_lines" (
	"merchant_id" uuid NOT NULL,
	"adjustment_id" uuid NOT NULL,
	"order_line_id" uuid NOT NULL,
	"amount" integer NOT NULL,
	"gst_amount" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "order_adjustments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"merchant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"rule_key" text NOT NULL,
	"rule_version" integer NOT NULL,
	"rule_snapshot" jsonb NOT NULL,
	"kind" text NOT NULL,
	"level" text NOT NULL,
	"name" text NOT NULL,
	"report_class" text NOT NULL,
	"gst_applicable" boolean NOT NULL,
	"total" integer NOT NULL,
	"gst_total" integer NOT NULL,
	"capped" boolean DEFAULT false NOT NULL,
	"frozen" boolean DEFAULT false NOT NULL,
	"manual_application_id" uuid,
	"entered_value" integer,
	"applied_by" uuid,
	"approved_by" uuid,
	"override_id" uuid,
	"reason" text,
	"sort" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "order_lines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"merchant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kitchen_name" text,
	"sku" text,
	"category_id" uuid,
	"parent_category_id" uuid,
	"tags" text[] DEFAULT '{}' NOT NULL,
	"is_bcrs" boolean DEFAULT false NOT NULL,
	"quantity" integer NOT NULL,
	"unit_price" integer NOT NULL,
	"base_price" integer NOT NULL,
	"prices_by_order_type" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"open_price" integer,
	"modifiers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"notes" text,
	"seat_no" integer,
	"source" "line_source" DEFAULT 'pos' NOT NULL,
	"round_id" uuid,
	"status" "line_status" DEFAULT 'pending' NOT NULL,
	"fire_round" integer,
	"fired_at" timestamp with time zone,
	"fired_by" uuid,
	"fired_from_station_id" uuid,
	"voided_at" timestamp with time zone,
	"void_reason_id" uuid,
	"void_reason" text,
	"voided_by" uuid,
	"void_approved_by" uuid,
	"void_override_id" uuid,
	"base_amount" integer DEFAULT 0 NOT NULL,
	"discount_amount" integer DEFAULT 0 NOT NULL,
	"net_amount" integer DEFAULT 0 NOT NULL,
	"fee_amount" integer DEFAULT 0 NOT NULL,
	"gst_amount" integer DEFAULT 0 NOT NULL,
	"total" integer DEFAULT 0 NOT NULL,
	"sort" integer DEFAULT 0 NOT NULL,
	"added_by" uuid,
	"added_by_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "order_manual_applications" (
	"id" uuid PRIMARY KEY NOT NULL,
	"merchant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"rule_key" text NOT NULL,
	"entered_value" integer,
	"line_ids" uuid[],
	"applied_by" uuid,
	"applied_by_name" text,
	"approved_by" uuid,
	"approved_by_name" text,
	"override_id" uuid,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"removed_at" timestamp with time zone,
	"removed_by" uuid
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" uuid PRIMARY KEY NOT NULL,
	"merchant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"brand_id" uuid NOT NULL,
	"channel_link_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"order_type" text NOT NULL,
	"order_no" text NOT NULL,
	"status" "order_status" DEFAULT 'open' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"table_id" uuid,
	"pax" integer,
	"customer_id" uuid,
	"customer_ref" jsonb,
	"delivery_address" text,
	"delivery_notes" text,
	"ready_by" timestamp with time zone,
	"notes" text,
	"station_id" uuid,
	"opened_by" uuid,
	"opened_by_name" text,
	"business_date" text NOT NULL,
	"tax_mode" text NOT NULL,
	"gst_bps" integer NOT NULL,
	"subtotal" integer DEFAULT 0 NOT NULL,
	"discount_total" integer DEFAULT 0 NOT NULL,
	"fee_total" integer DEFAULT 0 NOT NULL,
	"gst_total" integer DEFAULT 0 NOT NULL,
	"total" integer DEFAULT 0 NOT NULL,
	"pricing_frozen_at" timestamp with time zone,
	"frozen_adjustments" jsonb,
	"bill_requested_at" timestamp with time zone,
	"round_count" integer DEFAULT 0 NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"first_fired_at" timestamp with time zone,
	"ready_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"cancel_reason" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "overrides" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"merchant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"action" text NOT NULL,
	"target_kind" text NOT NULL,
	"target_id" text NOT NULL,
	"approver_id" uuid NOT NULL,
	"approver_name" text,
	"approver_role" text NOT NULL,
	"requester_id" text NOT NULL,
	"requester_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"used_by" text
);
--> statement-breakpoint
CREATE TABLE "station_pairing_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"merchant_id" uuid NOT NULL,
	"station_id" uuid NOT NULL,
	"code_hash" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "order_adjustment_lines" ADD CONSTRAINT "order_adjustment_lines_adjustment_id_order_adjustments_id_fk" FOREIGN KEY ("adjustment_id") REFERENCES "public"."order_adjustments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_adjustment_lines" ADD CONSTRAINT "order_adjustment_lines_order_line_id_order_lines_id_fk" FOREIGN KEY ("order_line_id") REFERENCES "public"."order_lines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_adjustments" ADD CONSTRAINT "order_adjustments_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_void_reason_id_void_reasons_id_fk" FOREIGN KEY ("void_reason_id") REFERENCES "public"."void_reasons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_manual_applications" ADD CONSTRAINT "order_manual_applications_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_channel_link_id_channel_links_id_fk" FOREIGN KEY ("channel_link_id") REFERENCES "public"."channel_links"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_table_id_tables_id_fk" FOREIGN KEY ("table_id") REFERENCES "public"."tables"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_station_id_stations_id_fk" FOREIGN KEY ("station_id") REFERENCES "public"."stations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_opened_by_staff_id_fk" FOREIGN KEY ("opened_by") REFERENCES "public"."staff"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "station_pairing_codes" ADD CONSTRAINT "station_pairing_codes_station_id_stations_id_fk" FOREIGN KEY ("station_id") REFERENCES "public"."stations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "order_adjustment_lines_uq" ON "order_adjustment_lines" USING btree ("adjustment_id","order_line_id");--> statement-breakpoint
CREATE INDEX "order_adjustment_lines_line_idx" ON "order_adjustment_lines" USING btree ("order_line_id");--> statement-breakpoint
CREATE INDEX "order_adjustments_order_idx" ON "order_adjustments" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "order_lines_order_idx" ON "order_lines" USING btree ("order_id","status");--> statement-breakpoint
CREATE INDEX "order_lines_outlet_idx" ON "order_lines" USING btree ("outlet_id");--> statement-breakpoint
CREATE INDEX "order_manual_applications_order_idx" ON "order_manual_applications" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "orders_outlet_status_idx" ON "orders" USING btree ("outlet_id","status");--> statement-breakpoint
CREATE INDEX "orders_outlet_business_date_idx" ON "orders" USING btree ("outlet_id","business_date");--> statement-breakpoint
CREATE UNIQUE INDEX "orders_outlet_no_uq" ON "orders" USING btree ("outlet_id","order_no");--> statement-breakpoint
CREATE INDEX "orders_table_idx" ON "orders" USING btree ("table_id","status");--> statement-breakpoint
CREATE INDEX "orders_ready_by_idx" ON "orders" USING btree ("outlet_id","ready_by");--> statement-breakpoint
CREATE INDEX "overrides_outlet_idx" ON "overrides" USING btree ("outlet_id","expires_at");--> statement-breakpoint
CREATE INDEX "station_pairing_codes_station_idx" ON "station_pairing_codes" USING btree ("station_id");