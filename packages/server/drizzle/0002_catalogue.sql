CREATE TYPE "public"."access_level" AS ENUM('everyone', 'cashier', 'manager', 'admin');--> statement-breakpoint
CREATE TYPE "public"."availability_target" AS ENUM('product', 'section');--> statement-breakpoint
CREATE TYPE "public"."channel_type" AS ENUM('pos', 'scan_to_order');--> statement-breakpoint
CREATE TYPE "public"."order_type" AS ENUM('dine_in', 'takeaway', 'pickup', 'delivery');--> statement-breakpoint
CREATE TYPE "public"."product_kind" AS ENUM('product', 'component');--> statement-breakpoint
CREATE TYPE "public"."rule_version_status" AS ENUM('scheduled', 'active', 'superseded', 'archived');--> statement-breakpoint
CREATE TYPE "public"."import_status" AS ENUM('queued', 'running', 'dry_run_complete', 'applied', 'failed');--> statement-breakpoint
CREATE TABLE "areas" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"merchant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"name" text NOT NULL,
	"sort" integer DEFAULT 0 NOT NULL,
	"legacy_id" text
);
--> statement-breakpoint
CREATE TABLE "availability_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"merchant_id" uuid NOT NULL,
	"target_kind" "availability_target" NOT NULL,
	"target_id" uuid NOT NULL,
	"outlet_ids" uuid[] DEFAULT '{}' NOT NULL,
	"channels" text[] DEFAULT '{}' NOT NULL,
	"days_of_week" integer[] DEFAULT '{}' NOT NULL,
	"start_time" text,
	"end_time" text
);
--> statement-breakpoint
CREATE TABLE "channel_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"merchant_id" uuid NOT NULL,
	"channel" "channel_type" NOT NULL,
	"outlet_id" uuid NOT NULL,
	"brand_id" uuid NOT NULL,
	"menu_id" uuid NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"hold_orders" boolean DEFAULT true NOT NULL,
	"open_on_first_scan" boolean DEFAULT false NOT NULL,
	"service_requests" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"service_request_printer_id" uuid
);
--> statement-breakpoint
CREATE TABLE "menu_items" (
	"merchant_id" uuid NOT NULL,
	"menu_id" uuid NOT NULL,
	"section_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"sort" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "menu_items_section_id_product_id_pk" PRIMARY KEY("section_id","product_id")
);
--> statement-breakpoint
CREATE TABLE "menu_sections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"merchant_id" uuid NOT NULL,
	"menu_id" uuid NOT NULL,
	"parent_id" uuid,
	"name" text NOT NULL,
	"sort" integer DEFAULT 0 NOT NULL,
	"legacy_id" text
);
--> statement-breakpoint
CREATE TABLE "menus" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"merchant_id" uuid NOT NULL,
	"brand_id" uuid NOT NULL,
	"name" text NOT NULL,
	"legacy_id" text,
	"archived_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "modifier_groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"merchant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"min_select" integer DEFAULT 0 NOT NULL,
	"max_select" integer,
	"max_per_modifier" integer DEFAULT 1 NOT NULL,
	"legacy_id" text,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "modifier_options" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"merchant_id" uuid NOT NULL,
	"group_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"price_override" integer,
	"child_group_id" uuid,
	"is_default" boolean DEFAULT false NOT NULL,
	"sort" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pos_layouts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"merchant_id" uuid NOT NULL,
	"brand_id" uuid NOT NULL,
	"name" text NOT NULL,
	"pages" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"legacy_id" text,
	"archived_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "product_modifier_groups" (
	"merchant_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"group_id" uuid NOT NULL,
	"sort" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "product_modifier_groups_product_id_group_id_pk" PRIMARY KEY("product_id","group_id")
);
--> statement-breakpoint
CREATE TABLE "product_prices" (
	"merchant_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"order_type" "order_type" NOT NULL,
	"price" integer NOT NULL,
	CONSTRAINT "product_prices_product_id_order_type_pk" PRIMARY KEY("product_id","order_type")
);
--> statement-breakpoint
CREATE TABLE "products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"merchant_id" uuid NOT NULL,
	"brand_id" uuid,
	"kind" "product_kind" DEFAULT 'product' NOT NULL,
	"name" text NOT NULL,
	"sku" text,
	"description" text,
	"price" integer DEFAULT 0 NOT NULL,
	"category_id" uuid,
	"tags" text[] DEFAULT '{}' NOT NULL,
	"is_bcrs" boolean DEFAULT false NOT NULL,
	"open_price" boolean DEFAULT false NOT NULL,
	"kitchen_name" text,
	"legacy_id" text,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "report_categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"merchant_id" uuid NOT NULL,
	"parent_id" uuid,
	"name" text NOT NULL,
	"sort" integer DEFAULT 0 NOT NULL,
	"legacy_id" text,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "stock_status" (
	"merchant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"sold_out_until" timestamp with time zone,
	"daily_cap" integer,
	"cap_remaining" integer,
	"cap_date" date,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_status_outlet_id_product_id_pk" PRIMARY KEY("outlet_id","product_id")
);
--> statement-breakpoint
CREATE TABLE "tables" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"merchant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"area_id" uuid NOT NULL,
	"name" text NOT NULL,
	"seats" integer DEFAULT 4 NOT NULL,
	"shape" text DEFAULT 'rect' NOT NULL,
	"x" integer DEFAULT 0 NOT NULL,
	"y" integer DEFAULT 0 NOT NULL,
	"w" integer DEFAULT 2 NOT NULL,
	"h" integer DEFAULT 2 NOT NULL,
	"legacy_id" text,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "tender_types" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"merchant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"is_cash" boolean DEFAULT false NOT NULL,
	"opens_drawer" boolean DEFAULT false NOT NULL,
	"is_terminal" boolean DEFAULT false NOT NULL,
	"sort" integer DEFAULT 0 NOT NULL,
	"legacy_id" text,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "void_reasons" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"merchant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"for_refunds" boolean DEFAULT true NOT NULL,
	"sort" integer DEFAULT 0 NOT NULL,
	"legacy_id" text,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "customer_group_members" (
	"merchant_id" uuid NOT NULL,
	"group_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_group_members_group_id_customer_id_pk" PRIMARY KEY("group_id","customer_id")
);
--> statement-breakpoint
CREATE TABLE "customer_groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"merchant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "customers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"merchant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"mobile" text,
	"email" text,
	"marketing_consent" boolean DEFAULT false NOT NULL,
	"notes" text,
	"legacy_id" text,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pricing_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"merchant_id" uuid NOT NULL,
	"rule_key" text NOT NULL,
	"version" integer NOT NULL,
	"status" "rule_version_status" DEFAULT 'scheduled' NOT NULL,
	"effective_from" timestamp with time zone NOT NULL,
	"body" jsonb NOT NULL,
	"note" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "import_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"merchant_id" uuid NOT NULL,
	"status" "import_status" DEFAULT 'queued' NOT NULL,
	"dry_run" boolean DEFAULT true NOT NULL,
	"mapping" jsonb NOT NULL,
	"files" jsonb NOT NULL,
	"report" jsonb,
	"error" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "areas" ADD CONSTRAINT "areas_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "availability_rules" ADD CONSTRAINT "availability_rules_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_links" ADD CONSTRAINT "channel_links_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_links" ADD CONSTRAINT "channel_links_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_links" ADD CONSTRAINT "channel_links_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_links" ADD CONSTRAINT "channel_links_menu_id_menus_id_fk" FOREIGN KEY ("menu_id") REFERENCES "public"."menus"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "menu_items" ADD CONSTRAINT "menu_items_menu_id_menus_id_fk" FOREIGN KEY ("menu_id") REFERENCES "public"."menus"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "menu_items" ADD CONSTRAINT "menu_items_section_id_menu_sections_id_fk" FOREIGN KEY ("section_id") REFERENCES "public"."menu_sections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "menu_items" ADD CONSTRAINT "menu_items_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "menu_sections" ADD CONSTRAINT "menu_sections_menu_id_menus_id_fk" FOREIGN KEY ("menu_id") REFERENCES "public"."menus"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "menus" ADD CONSTRAINT "menus_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "menus" ADD CONSTRAINT "menus_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "modifier_groups" ADD CONSTRAINT "modifier_groups_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "modifier_options" ADD CONSTRAINT "modifier_options_group_id_modifier_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."modifier_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "modifier_options" ADD CONSTRAINT "modifier_options_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "modifier_options" ADD CONSTRAINT "modifier_options_child_group_id_modifier_groups_id_fk" FOREIGN KEY ("child_group_id") REFERENCES "public"."modifier_groups"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_layouts" ADD CONSTRAINT "pos_layouts_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_layouts" ADD CONSTRAINT "pos_layouts_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_modifier_groups" ADD CONSTRAINT "product_modifier_groups_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_modifier_groups" ADD CONSTRAINT "product_modifier_groups_group_id_modifier_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."modifier_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_prices" ADD CONSTRAINT "product_prices_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_category_id_report_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."report_categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_categories" ADD CONSTRAINT "report_categories_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_status" ADD CONSTRAINT "stock_status_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_status" ADD CONSTRAINT "stock_status_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tables" ADD CONSTRAINT "tables_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tables" ADD CONSTRAINT "tables_area_id_areas_id_fk" FOREIGN KEY ("area_id") REFERENCES "public"."areas"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tender_types" ADD CONSTRAINT "tender_types_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "void_reasons" ADD CONSTRAINT "void_reasons_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_group_members" ADD CONSTRAINT "customer_group_members_group_id_customer_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."customer_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_group_members" ADD CONSTRAINT "customer_group_members_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_groups" ADD CONSTRAINT "customer_groups_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pricing_rules" ADD CONSTRAINT "pricing_rules_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_jobs" ADD CONSTRAINT "import_jobs_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "areas_outlet_idx" ON "areas" USING btree ("outlet_id");--> statement-breakpoint
CREATE UNIQUE INDEX "areas_legacy_uq" ON "areas" USING btree ("merchant_id","legacy_id");--> statement-breakpoint
CREATE INDEX "availability_target_idx" ON "availability_rules" USING btree ("target_kind","target_id");--> statement-breakpoint
CREATE UNIQUE INDEX "channel_links_uq" ON "channel_links" USING btree ("channel","outlet_id","brand_id");--> statement-breakpoint
CREATE INDEX "channel_links_outlet_idx" ON "channel_links" USING btree ("merchant_id","outlet_id");--> statement-breakpoint
CREATE INDEX "menu_items_menu_idx" ON "menu_items" USING btree ("menu_id");--> statement-breakpoint
CREATE INDEX "menu_sections_menu_idx" ON "menu_sections" USING btree ("menu_id");--> statement-breakpoint
CREATE UNIQUE INDEX "menu_sections_legacy_uq" ON "menu_sections" USING btree ("merchant_id","legacy_id");--> statement-breakpoint
CREATE INDEX "menus_brand_idx" ON "menus" USING btree ("merchant_id","brand_id");--> statement-breakpoint
CREATE UNIQUE INDEX "menus_legacy_uq" ON "menus" USING btree ("merchant_id","legacy_id");--> statement-breakpoint
CREATE INDEX "modifier_groups_merchant_idx" ON "modifier_groups" USING btree ("merchant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "modifier_groups_legacy_uq" ON "modifier_groups" USING btree ("merchant_id","legacy_id");--> statement-breakpoint
CREATE INDEX "modifier_options_group_idx" ON "modifier_options" USING btree ("group_id");--> statement-breakpoint
CREATE UNIQUE INDEX "modifier_options_uq" ON "modifier_options" USING btree ("group_id","product_id");--> statement-breakpoint
CREATE INDEX "pos_layouts_brand_idx" ON "pos_layouts" USING btree ("merchant_id","brand_id");--> statement-breakpoint
CREATE INDEX "products_merchant_idx" ON "products" USING btree ("merchant_id","archived_at");--> statement-breakpoint
CREATE UNIQUE INDEX "products_sku_uq" ON "products" USING btree ("merchant_id","sku");--> statement-breakpoint
CREATE UNIQUE INDEX "products_legacy_uq" ON "products" USING btree ("merchant_id","legacy_id");--> statement-breakpoint
CREATE INDEX "products_name_idx" ON "products" USING btree ("merchant_id","name");--> statement-breakpoint
CREATE INDEX "products_category_idx" ON "products" USING btree ("category_id");--> statement-breakpoint
CREATE INDEX "report_categories_merchant_idx" ON "report_categories" USING btree ("merchant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "report_categories_legacy_uq" ON "report_categories" USING btree ("merchant_id","legacy_id");--> statement-breakpoint
CREATE INDEX "tables_outlet_idx" ON "tables" USING btree ("outlet_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tables_legacy_uq" ON "tables" USING btree ("merchant_id","legacy_id");--> statement-breakpoint
CREATE INDEX "tender_types_merchant_idx" ON "tender_types" USING btree ("merchant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tender_types_legacy_uq" ON "tender_types" USING btree ("merchant_id","legacy_id");--> statement-breakpoint
CREATE INDEX "void_reasons_merchant_idx" ON "void_reasons" USING btree ("merchant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "void_reasons_legacy_uq" ON "void_reasons" USING btree ("merchant_id","legacy_id");--> statement-breakpoint
CREATE INDEX "customer_group_members_customer_idx" ON "customer_group_members" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "customer_groups_merchant_idx" ON "customer_groups" USING btree ("merchant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "customers_mobile_uq" ON "customers" USING btree ("merchant_id","mobile");--> statement-breakpoint
CREATE UNIQUE INDEX "customers_legacy_uq" ON "customers" USING btree ("merchant_id","legacy_id");--> statement-breakpoint
CREATE INDEX "customers_name_idx" ON "customers" USING btree ("merchant_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "pricing_rules_key_version_uq" ON "pricing_rules" USING btree ("merchant_id","rule_key","version");--> statement-breakpoint
CREATE INDEX "pricing_rules_effective_idx" ON "pricing_rules" USING btree ("merchant_id","effective_from");--> statement-breakpoint
CREATE INDEX "import_jobs_merchant_idx" ON "import_jobs" USING btree ("merchant_id","created_at");