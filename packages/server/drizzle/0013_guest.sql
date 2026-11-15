CREATE TYPE "public"."round_status" AS ENUM('pending', 'accepted', 'rejected', 'fired');--> statement-breakpoint
CREATE TYPE "public"."service_request_status" AS ENUM('open', 'acknowledged');--> statement-breakpoint
CREATE TABLE "guest_rounds" (
	"id" uuid PRIMARY KEY NOT NULL,
	"merchant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"guest_session_id" uuid NOT NULL,
	"table_id" uuid NOT NULL,
	"status" "round_status" DEFAULT 'pending' NOT NULL,
	"line_ids" uuid[] DEFAULT '{}' NOT NULL,
	"guest_name" text,
	"notes" text,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	"decided_by" uuid,
	"decided_by_name" text,
	"reject_reason" text
);
--> statement-breakpoint
CREATE TABLE "guest_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"merchant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"brand_id" uuid NOT NULL,
	"table_id" uuid NOT NULL,
	"channel_link_id" uuid NOT NULL,
	"order_id" uuid,
	"device_hash" text NOT NULL,
	"guest_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "service_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"merchant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"table_id" uuid NOT NULL,
	"order_id" uuid,
	"guest_session_id" uuid,
	"type" text NOT NULL,
	"status" "service_request_status" DEFAULT 'open' NOT NULL,
	"guest_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"acknowledged_at" timestamp with time zone,
	"acknowledged_by" uuid,
	"acknowledged_by_name" text,
	"print_job_id" uuid
);
--> statement-breakpoint
CREATE TABLE "table_qr_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"merchant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"table_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"rotated_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "guest_rounds" ADD CONSTRAINT "guest_rounds_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guest_rounds" ADD CONSTRAINT "guest_rounds_guest_session_id_guest_sessions_id_fk" FOREIGN KEY ("guest_session_id") REFERENCES "public"."guest_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guest_sessions" ADD CONSTRAINT "guest_sessions_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guest_sessions" ADD CONSTRAINT "guest_sessions_table_id_tables_id_fk" FOREIGN KEY ("table_id") REFERENCES "public"."tables"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guest_sessions" ADD CONSTRAINT "guest_sessions_channel_link_id_channel_links_id_fk" FOREIGN KEY ("channel_link_id") REFERENCES "public"."channel_links"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guest_sessions" ADD CONSTRAINT "guest_sessions_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_requests" ADD CONSTRAINT "service_requests_guest_session_id_guest_sessions_id_fk" FOREIGN KEY ("guest_session_id") REFERENCES "public"."guest_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "table_qr_tokens" ADD CONSTRAINT "table_qr_tokens_table_id_tables_id_fk" FOREIGN KEY ("table_id") REFERENCES "public"."tables"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "guest_rounds_order_idx" ON "guest_rounds" USING btree ("order_id","status");--> statement-breakpoint
CREATE INDEX "guest_rounds_outlet_idx" ON "guest_rounds" USING btree ("outlet_id","status");--> statement-breakpoint
CREATE INDEX "guest_sessions_table_idx" ON "guest_sessions" USING btree ("table_id","revoked_at");--> statement-breakpoint
CREATE INDEX "guest_sessions_order_idx" ON "guest_sessions" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "service_requests_outlet_idx" ON "service_requests" USING btree ("outlet_id","status");--> statement-breakpoint
CREATE INDEX "service_requests_table_idx" ON "service_requests" USING btree ("table_id","status");--> statement-breakpoint
CREATE INDEX "table_qr_tokens_table_idx" ON "table_qr_tokens" USING btree ("table_id");--> statement-breakpoint
CREATE INDEX "table_qr_tokens_hash_idx" ON "table_qr_tokens" USING btree ("token_hash");