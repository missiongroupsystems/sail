CREATE TYPE "public"."station_kind" AS ENUM('pos', 'display');--> statement-breakpoint
CREATE TYPE "public"."kitchen_ticket_status" AS ENUM('new', 'in_progress', 'ready', 'recalled', 'cancelled');--> statement-breakpoint
CREATE TABLE "display_destinations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"merchant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"name" text NOT NULL,
	"include_tags" text[] DEFAULT '{}' NOT NULL,
	"exclude_tags" text[] DEFAULT '{}' NOT NULL,
	"order_types" text[] DEFAULT '{}' NOT NULL,
	"sources" text[] DEFAULT '{}' NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kitchen_ticket_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"merchant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"ticket_id" uuid NOT NULL,
	"order_line_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"name" text NOT NULL,
	"quantity" integer NOT NULL,
	"voided_quantity" integer DEFAULT 0 NOT NULL,
	"modifiers" text[] DEFAULT '{}' NOT NULL,
	"notes" text,
	"seat_no" integer,
	"source" text DEFAULT 'pos' NOT NULL,
	"sort" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kitchen_tickets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"merchant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"destination_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"round_no" integer NOT NULL,
	"server_name" text,
	"status" "kitchen_ticket_status" DEFAULT 'new' NOT NULL,
	"changed" boolean DEFAULT false NOT NULL,
	"fired_at" timestamp with time zone NOT NULL,
	"started_at" timestamp with time zone,
	"bumped_at" timestamp with time zone,
	"recalled_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"changed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "merchant_settings" ADD COLUMN "kitchen_warn_minutes" integer DEFAULT 8 NOT NULL;--> statement-breakpoint
ALTER TABLE "merchant_settings" ADD COLUMN "kitchen_late_minutes" integer DEFAULT 15 NOT NULL;--> statement-breakpoint
ALTER TABLE "stations" ADD COLUMN "kind" "station_kind" DEFAULT 'pos' NOT NULL;--> statement-breakpoint
ALTER TABLE "stations" ADD COLUMN "display_destination_ids" uuid[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "display_destinations" ADD CONSTRAINT "display_destinations_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "display_destinations" ADD CONSTRAINT "display_destinations_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kitchen_ticket_lines" ADD CONSTRAINT "kitchen_ticket_lines_ticket_id_kitchen_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."kitchen_tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kitchen_tickets" ADD CONSTRAINT "kitchen_tickets_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kitchen_tickets" ADD CONSTRAINT "kitchen_tickets_destination_id_display_destinations_id_fk" FOREIGN KEY ("destination_id") REFERENCES "public"."display_destinations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kitchen_tickets" ADD CONSTRAINT "kitchen_tickets_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "display_destinations_outlet_idx" ON "display_destinations" USING btree ("outlet_id");--> statement-breakpoint
CREATE INDEX "kitchen_ticket_lines_ticket_idx" ON "kitchen_ticket_lines" USING btree ("ticket_id");--> statement-breakpoint
CREATE INDEX "kitchen_ticket_lines_order_line_idx" ON "kitchen_ticket_lines" USING btree ("order_line_id");--> statement-breakpoint
CREATE INDEX "kitchen_tickets_destination_idx" ON "kitchen_tickets" USING btree ("destination_id","bumped_at","fired_at");--> statement-breakpoint
CREATE UNIQUE INDEX "kitchen_tickets_order_round_destination_key" ON "kitchen_tickets" USING btree ("order_id","round_no","destination_id");