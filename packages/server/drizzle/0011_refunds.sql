CREATE TYPE "public"."refund_kind" AS ENUM('full', 'lines', 'amount');--> statement-breakpoint
CREATE TABLE "refund_lines" (
	"merchant_id" uuid NOT NULL,
	"refund_id" uuid NOT NULL,
	"order_line_id" uuid NOT NULL,
	"quantity" integer NOT NULL,
	"base" integer NOT NULL,
	"discount" integer NOT NULL,
	"fee" integer NOT NULL,
	"gst" integer NOT NULL,
	"total" integer NOT NULL,
	"adjustments" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "refund_lines_refund_id_order_line_id_pk" PRIMARY KEY("refund_id","order_line_id")
);
--> statement-breakpoint
CREATE TABLE "refund_tenders" (
	"merchant_id" uuid NOT NULL,
	"refund_id" uuid NOT NULL,
	"payment_id" uuid NOT NULL,
	"tender_name" text NOT NULL,
	"is_cash" boolean NOT NULL,
	"amount" integer NOT NULL,
	"rounding_cents" integer DEFAULT 0 NOT NULL,
	"reference" text,
	CONSTRAINT "refund_tenders_refund_id_payment_id_pk" PRIMARY KEY("refund_id","payment_id")
);
--> statement-breakpoint
CREATE TABLE "refunds" (
	"id" uuid PRIMARY KEY NOT NULL,
	"merchant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"check_id" uuid NOT NULL,
	"kind" "refund_kind" NOT NULL,
	"reason" text NOT NULL,
	"refunded_by" uuid,
	"refunded_by_name" text,
	"approved_by" uuid,
	"approved_by_name" text,
	"override_id" uuid,
	"station_id" uuid,
	"shift_id" uuid,
	"business_date" text NOT NULL,
	"base" integer NOT NULL,
	"discount" integer NOT NULL,
	"fee" integer NOT NULL,
	"gst" integer NOT NULL,
	"total" integer NOT NULL,
	"refund_receipt_no" text NOT NULL,
	"credit_note_no" text,
	"receipt_document" jsonb NOT NULL,
	"credit_note_document" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "refund_lines" ADD CONSTRAINT "refund_lines_refund_id_refunds_id_fk" FOREIGN KEY ("refund_id") REFERENCES "public"."refunds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refund_lines" ADD CONSTRAINT "refund_lines_order_line_id_order_lines_id_fk" FOREIGN KEY ("order_line_id") REFERENCES "public"."order_lines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refund_tenders" ADD CONSTRAINT "refund_tenders_refund_id_refunds_id_fk" FOREIGN KEY ("refund_id") REFERENCES "public"."refunds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refund_tenders" ADD CONSTRAINT "refund_tenders_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_check_id_checks_id_fk" FOREIGN KEY ("check_id") REFERENCES "public"."checks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "refund_lines_line_idx" ON "refund_lines" USING btree ("order_line_id");--> statement-breakpoint
CREATE INDEX "refund_tenders_payment_idx" ON "refund_tenders" USING btree ("payment_id");--> statement-breakpoint
CREATE INDEX "refunds_check_idx" ON "refunds" USING btree ("check_id");--> statement-breakpoint
CREATE INDEX "refunds_outlet_date_idx" ON "refunds" USING btree ("outlet_id","business_date");