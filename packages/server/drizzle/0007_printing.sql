CREATE TYPE "public"."print_job_kind" AS ENUM('kitchen', 'void', 'reprint', 'prebill', 'receipt', 'refund_receipt', 'service_slip', 'test');--> statement-breakpoint
CREATE TYPE "public"."print_job_status" AS ENUM('queued', 'claimed', 'printed', 'failed', 'rerouted');--> statement-breakpoint
CREATE TYPE "public"."printer_role" AS ENUM('kitchen', 'receipt');--> statement-breakpoint
CREATE TABLE "print_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"merchant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"printer_id" uuid NOT NULL,
	"kind" "print_job_kind" NOT NULL,
	"order_id" uuid,
	"check_id" uuid,
	"refund_id" uuid,
	"payload" text NOT NULL,
	"text" text DEFAULT '' NOT NULL,
	"document" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"copy_no" integer DEFAULT 1 NOT NULL,
	"copies" integer DEFAULT 1 NOT NULL,
	"status" "print_job_status" DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"claimed_by" uuid,
	"claimed_at" timestamp with time zone,
	"printed_at" timestamp with time zone,
	"failed_at" timestamp with time zone,
	"last_error" text,
	"reprint_of" uuid,
	"rerouted_to" uuid,
	"rerouted_from" uuid,
	"requested_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "print_relays" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"merchant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"name" text NOT NULL,
	"token_hash" text,
	"paired_at" timestamp with time zone,
	"last_seen_at" timestamp with time zone,
	"version" text,
	"printer_status" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "printers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"merchant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"name" text NOT NULL,
	"ip" text NOT NULL,
	"port" integer DEFAULT 9100 NOT NULL,
	"paper_width" text DEFAULT '80mm' NOT NULL,
	"role" "printer_role" DEFAULT 'kitchen' NOT NULL,
	"station_id" uuid,
	"include_tags" text[] DEFAULT '{}' NOT NULL,
	"exclude_tags" text[] DEFAULT '{}' NOT NULL,
	"order_types" text[] DEFAULT '{}' NOT NULL,
	"sources" text[] DEFAULT '{}' NOT NULL,
	"copies" integer DEFAULT 1 NOT NULL,
	"backup_printer_id" uuid,
	"is_default_kitchen" boolean DEFAULT false NOT NULL,
	"supports_status" boolean DEFAULT true NOT NULL,
	"code_page_cjk" boolean DEFAULT false NOT NULL,
	"cut" boolean DEFAULT true NOT NULL,
	"beep" boolean DEFAULT false NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "relay_pairing_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"merchant_id" uuid NOT NULL,
	"relay_id" uuid NOT NULL,
	"code_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "print_jobs" ADD CONSTRAINT "print_jobs_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "print_jobs" ADD CONSTRAINT "print_jobs_printer_id_printers_id_fk" FOREIGN KEY ("printer_id") REFERENCES "public"."printers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "print_relays" ADD CONSTRAINT "print_relays_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "print_relays" ADD CONSTRAINT "print_relays_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "printers" ADD CONSTRAINT "printers_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "printers" ADD CONSTRAINT "printers_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "printers" ADD CONSTRAINT "printers_station_id_stations_id_fk" FOREIGN KEY ("station_id") REFERENCES "public"."stations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relay_pairing_codes" ADD CONSTRAINT "relay_pairing_codes_relay_id_print_relays_id_fk" FOREIGN KEY ("relay_id") REFERENCES "public"."print_relays"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "print_jobs_outlet_status_idx" ON "print_jobs" USING btree ("outlet_id","status","created_at");--> statement-breakpoint
CREATE INDEX "print_jobs_order_idx" ON "print_jobs" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "print_jobs_printer_idx" ON "print_jobs" USING btree ("printer_id","status");--> statement-breakpoint
CREATE INDEX "print_relays_outlet_idx" ON "print_relays" USING btree ("outlet_id");--> statement-breakpoint
CREATE INDEX "printers_outlet_idx" ON "printers" USING btree ("outlet_id");--> statement-breakpoint
CREATE INDEX "relay_pairing_codes_relay_idx" ON "relay_pairing_codes" USING btree ("relay_id");