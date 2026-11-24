CREATE SCHEMA "ext_fixture";
--> statement-breakpoint
CREATE TABLE "ext_fixture"."notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"merchant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"brand_id" uuid,
	"number" serial NOT NULL,
	"body" text NOT NULL,
	"email" text
);
--> statement-breakpoint
ALTER TABLE "ext_fixture"."notes" ADD CONSTRAINT "notes_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ext_fixture"."notes" ADD CONSTRAINT "notes_outlet_same_merchant" FOREIGN KEY ("outlet_id","merchant_id") REFERENCES "public"."outlets"("id","merchant_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ext_fixture"."notes" ADD CONSTRAINT "notes_brand_same_merchant" FOREIGN KEY ("brand_id","merchant_id") REFERENCES "public"."brands"("id","merchant_id") ON DELETE no action ON UPDATE no action;