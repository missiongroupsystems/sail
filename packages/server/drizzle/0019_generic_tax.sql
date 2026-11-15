-- Generic tax, currency and locale (docs/pricing-semantics.md §8). Columns named after one country's tax are renamed,
-- so stored amounts are kept. Existing merchants (all priced with one merchant-wide rate until now) get one default
-- tax class at that rate, and every stored order, bill and refund gets its tax breakdown from it.
CREATE TYPE "public"."tax_rounding" AS ENUM('per_line', 'per_rate');--> statement-breakpoint
CREATE TABLE "tax_classes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"merchant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tax_rates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"merchant_id" uuid NOT NULL,
	"tax_class_id" uuid NOT NULL,
	"outlet_id" uuid,
	"order_type" text,
	"components" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tax_rates_scope_uq" UNIQUE NULLS NOT DISTINCT("tax_class_id","outlet_id","order_type")
);
--> statement-breakpoint
ALTER TABLE "tax_classes" ADD CONSTRAINT "tax_classes_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_rates" ADD CONSTRAINT "tax_rates_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_rates" ADD CONSTRAINT "tax_rates_tax_class_id_tax_classes_id_fk" FOREIGN KEY ("tax_class_id") REFERENCES "public"."tax_classes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_rates" ADD CONSTRAINT "tax_rates_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tax_classes_merchant_idx" ON "tax_classes" USING btree ("merchant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tax_classes_default_uq" ON "tax_classes" USING btree ("merchant_id") WHERE "tax_classes"."is_default";--> statement-breakpoint
CREATE INDEX "tax_rates_merchant_idx" ON "tax_rates" USING btree ("merchant_id");--> statement-breakpoint
-- Merchant settings: no default time zone or currency any more; locale, rounding and labels are set at creation.
ALTER TABLE "merchant_settings" ALTER COLUMN "timezone" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "merchant_settings" ALTER COLUMN "currency" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "merchant_settings" ADD COLUMN "tax_rounding" "tax_rounding" DEFAULT 'per_line' NOT NULL;--> statement-breakpoint
ALTER TABLE "merchant_settings" ALTER COLUMN "tax_rounding" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "merchant_settings" ADD COLUMN "cash_denominations" integer[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "merchant_settings" ADD COLUMN "locale" text DEFAULT 'en-SG' NOT NULL;--> statement-breakpoint
ALTER TABLE "merchant_settings" ALTER COLUMN "locale" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "merchant_settings" ADD COLUMN "business_registration_label" text DEFAULT 'UEN' NOT NULL;--> statement-breakpoint
ALTER TABLE "merchant_settings" ALTER COLUMN "business_registration_label" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "merchant_settings" ADD COLUMN "tax_registration_label" text DEFAULT 'GST Reg No' NOT NULL;--> statement-breakpoint
ALTER TABLE "merchant_settings" ALTER COLUMN "tax_registration_label" DROP DEFAULT;--> statement-breakpoint
-- One default class per existing merchant at the rate it used.
INSERT INTO "tax_classes" ("merchant_id", "name", "is_default") SELECT "merchant_id", 'Standard-rated', true FROM "merchant_settings";--> statement-breakpoint
INSERT INTO "tax_rates" ("merchant_id", "tax_class_id", "components")
SELECT c."merchant_id", c."id", jsonb_build_array(jsonb_build_object('name', 'GST ' || trim_scale(s."gst_bps" / 100.0) || '%', 'bps', s."gst_bps"))
FROM "tax_classes" c JOIN "merchant_settings" s ON s."merchant_id" = c."merchant_id";--> statement-breakpoint
-- Outlets.
ALTER TABLE "outlets" RENAME COLUMN "uen" TO "business_registration_no";--> statement-breakpoint
ALTER TABLE "outlets" ADD COLUMN "tax_registration_no" text;--> statement-breakpoint
-- Products: a generic deposit flag and an optional tax class (null = the merchant default).
ALTER TABLE "products" RENAME COLUMN "is_bcrs" TO "has_deposit";--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "tax_class_id" uuid;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_tax_class_id_tax_classes_id_fk" FOREIGN KEY ("tax_class_id") REFERENCES "public"."tax_classes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- Orders keep the tax table they were opened with.
ALTER TABLE "orders" RENAME COLUMN "gst_total" TO "tax_total";--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "tax_rounding" text DEFAULT 'per_line' NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ALTER COLUMN "tax_rounding" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "tax_rates" jsonb;--> statement-breakpoint
UPDATE "orders" o SET "tax_rates" = jsonb_build_array(jsonb_build_object('tax_class_id', c."id", 'outlet_id', null, 'order_type', null,
  'components', jsonb_build_array(jsonb_build_object('name', 'GST ' || trim_scale(o."gst_bps" / 100.0) || '%', 'bps', o."gst_bps"))))
FROM "tax_classes" c WHERE c."merchant_id" = o."merchant_id" AND c."is_default";--> statement-breakpoint
ALTER TABLE "orders" ALTER COLUMN "tax_rates" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "taxes" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
-- Lines.
ALTER TABLE "order_lines" RENAME COLUMN "is_bcrs" TO "has_deposit";--> statement-breakpoint
ALTER TABLE "order_lines" RENAME COLUMN "gst_amount" TO "tax_amount";--> statement-breakpoint
ALTER TABLE "order_lines" ADD COLUMN "tax_class_id" uuid;--> statement-breakpoint
UPDATE "order_lines" l SET "tax_class_id" = c."id" FROM "tax_classes" c WHERE c."merchant_id" = l."merchant_id" AND c."is_default";--> statement-breakpoint
ALTER TABLE "order_lines" ALTER COLUMN "tax_class_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "order_lines" ADD COLUMN "taxes" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
-- Adjustments: a fee's tax class replaces the yes/no flag.
ALTER TABLE "order_adjustments" RENAME COLUMN "gst_total" TO "tax_total";--> statement-breakpoint
ALTER TABLE "order_adjustments" ADD COLUMN "tax_class_id" uuid;--> statement-breakpoint
UPDATE "order_adjustments" a SET "tax_class_id" = c."id" FROM "tax_classes" c WHERE c."merchant_id" = a."merchant_id" AND c."is_default" AND a."kind" = 'fee' AND a."gst_applicable";--> statement-breakpoint
ALTER TABLE "order_adjustment_lines" RENAME COLUMN "gst_amount" TO "tax_amount";--> statement-breakpoint
-- Each line's breakdown: its net amount plus its taxed fees (less the tax itself when inclusive).
UPDATE "order_lines" l SET "taxes" = jsonb_build_array(jsonb_build_object('name', 'GST ' || trim_scale(o."gst_bps" / 100.0) || '%', 'bps', o."gst_bps", 'amount', l."tax_amount",
  'taxable', l."net_amount"
           + COALESCE((SELECT SUM(al."amount") FROM "order_adjustment_lines" al JOIN "order_adjustments" a ON a."id" = al."adjustment_id" WHERE al."order_line_id" = l."id" AND a."tax_class_id" IS NOT NULL), 0)
           - CASE WHEN o."tax_mode" = 'inclusive' THEN l."tax_amount" ELSE 0 END))
FROM "orders" o WHERE o."id" = l."order_id";--> statement-breakpoint
-- The order's breakdown: taxed amounts are the line nets plus the taxed fees (less the tax itself when inclusive).
UPDATE "orders" o SET "taxes" = jsonb_build_array(jsonb_build_object('name', 'GST ' || trim_scale(o."gst_bps" / 100.0) || '%', 'bps', o."gst_bps", 'amount', o."tax_total",
  'taxable', COALESCE((SELECT SUM(l."net_amount") FROM "order_lines" l WHERE l."order_id" = o."id" AND l."status" <> 'voided'), 0)
           + COALESCE((SELECT SUM(al."amount") FROM "order_adjustment_lines" al JOIN "order_adjustments" a ON a."id" = al."adjustment_id" WHERE a."order_id" = o."id" AND a."tax_class_id" IS NOT NULL), 0)
           - CASE WHEN o."tax_mode" = 'inclusive' THEN o."tax_total" ELSE 0 END));--> statement-breakpoint
ALTER TABLE "order_adjustments" DROP COLUMN "gst_applicable";--> statement-breakpoint
-- Bills and allocations.
ALTER TABLE "checks" RENAME COLUMN "gst_total" TO "tax_total";--> statement-breakpoint
ALTER TABLE "checks" ADD COLUMN "taxes" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
UPDATE "checks" k SET "taxes" = jsonb_build_array(jsonb_build_object('name', 'GST ' || trim_scale(o."gst_bps" / 100.0) || '%', 'bps', o."gst_bps", 'amount', k."tax_total"))
FROM "orders" o WHERE o."id" = k."order_id";--> statement-breakpoint
ALTER TABLE "check_allocations" RENAME COLUMN "gst" TO "tax";--> statement-breakpoint
ALTER TABLE "check_allocations" ADD COLUMN "taxes" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
UPDATE "check_allocations" x SET
  "taxes" = jsonb_build_array(jsonb_build_object('name', 'GST ' || trim_scale(o."gst_bps" / 100.0) || '%', 'bps', o."gst_bps", 'amount', x."tax")),
  "adjustments" = COALESCE((SELECT jsonb_object_agg(e.key, jsonb_build_object('amount', e.value->'amount', 'tax', e.value->'gst')) FROM jsonb_each(x."adjustments") e), '{}'::jsonb)
FROM "checks" k JOIN "orders" o ON o."id" = k."order_id" WHERE k."id" = x."check_id";--> statement-breakpoint
-- Refunds are immutable; the rename and backfill are the only change ever made to them.
ALTER TABLE "refunds" DISABLE TRIGGER "refunds_immutable";--> statement-breakpoint
ALTER TABLE "refund_lines" DISABLE TRIGGER "refund_lines_immutable";--> statement-breakpoint
ALTER TABLE "refunds" RENAME COLUMN "gst" TO "tax";--> statement-breakpoint
ALTER TABLE "refunds" ADD COLUMN "taxes" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
UPDATE "refunds" r SET "taxes" = jsonb_build_array(jsonb_build_object('name', 'GST ' || trim_scale(o."gst_bps" / 100.0) || '%', 'bps', o."gst_bps", 'amount', r."tax"))
FROM "orders" o WHERE o."id" = r."order_id";--> statement-breakpoint
ALTER TABLE "refund_lines" RENAME COLUMN "gst" TO "tax";--> statement-breakpoint
ALTER TABLE "refund_lines" ADD COLUMN "taxes" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
UPDATE "refund_lines" x SET
  "taxes" = jsonb_build_array(jsonb_build_object('name', 'GST ' || trim_scale(o."gst_bps" / 100.0) || '%', 'bps', o."gst_bps", 'amount', x."tax")),
  "adjustments" = COALESCE((SELECT jsonb_object_agg(e.key, jsonb_build_object('amount', e.value->'amount', 'tax', e.value->'gst')) FROM jsonb_each(x."adjustments") e), '{}'::jsonb)
FROM "refunds" r JOIN "orders" o ON o."id" = r."order_id" WHERE r."id" = x."refund_id";--> statement-breakpoint
ALTER TABLE "refunds" ENABLE TRIGGER "refunds_immutable";--> statement-breakpoint
ALTER TABLE "refund_lines" ENABLE TRIGGER "refund_lines_immutable";--> statement-breakpoint
-- Rule bodies: fees name their tax class instead of a yes/no flag; the container-deposit scope is the generic deposit scope.
ALTER TABLE "pricing_rules" DISABLE TRIGGER "pricing_rules_immutable";--> statement-breakpoint
UPDATE "pricing_rules" r SET "body" = (r."body" - 'gst_applicable')
  || CASE WHEN r."body"->>'kind' = 'fee' THEN jsonb_build_object('tax_class_id', CASE WHEN COALESCE((r."body"->>'gst_applicable')::boolean, true) THEN to_jsonb(c."id") ELSE 'null'::jsonb END) ELSE '{}'::jsonb END
  || CASE WHEN r."body"->'scope'->>'type' = 'bcrs' THEN jsonb_build_object('scope', jsonb_build_object('type', 'deposit')) ELSE '{}'::jsonb END
FROM "tax_classes" c WHERE c."merchant_id" = r."merchant_id" AND c."is_default";--> statement-breakpoint
ALTER TABLE "pricing_rules" ENABLE TRIGGER "pricing_rules_immutable";--> statement-breakpoint
ALTER TABLE "orders" DROP COLUMN "gst_bps";--> statement-breakpoint
ALTER TABLE "merchant_settings" DROP COLUMN "gst_bps";
