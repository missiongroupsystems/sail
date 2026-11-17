CREATE TABLE "invoice_cancellations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"merchant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"check_id" uuid NOT NULL,
	"invoice_no" text NOT NULL,
	"invoice_issued_at" timestamp with time zone,
	"invoice_document" jsonb NOT NULL,
	"credit_note_no" text NOT NULL,
	"credit_note_document" jsonb NOT NULL,
	"reason" text NOT NULL,
	"cancelled_by" uuid,
	"cancelled_by_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "invoice_cancellations" ADD CONSTRAINT "invoice_cancellations_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_cancellations" ADD CONSTRAINT "invoice_cancellations_check_id_checks_id_fk" FOREIGN KEY ("check_id") REFERENCES "public"."checks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "invoice_cancellations_check_idx" ON "invoice_cancellations" USING btree ("check_id");--> statement-breakpoint
CREATE UNIQUE INDEX "invoice_cancellations_invoice_uq" ON "invoice_cancellations" USING btree ("merchant_id","invoice_no");--> statement-breakpoint
-- Hand-written: RLS as for refunds (tenant and outlet, the order's brand scope, the agent's mirror policy); immutable.
ALTER TABLE invoice_cancellations ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY invoice_cancellations_tenant ON invoice_cancellations FOR ALL TO app_authenticated USING (merchant_id = sail.merchant_id() AND sail.outlet_allowed(outlet_id)) WITH CHECK (merchant_id = sail.merchant_id() AND sail.outlet_allowed(outlet_id));
--> statement-breakpoint
GRANT SELECT, INSERT ON invoice_cancellations TO app_agent;
--> statement-breakpoint
CREATE POLICY invoice_cancellations_agent ON invoice_cancellations FOR ALL TO app_agent USING (merchant_id = sail.merchant_id() AND sail.outlet_allowed(outlet_id)) WITH CHECK (merchant_id = sail.merchant_id() AND sail.outlet_allowed(outlet_id));
--> statement-breakpoint
CREATE POLICY invoice_cancellations_brand_scope ON invoice_cancellations AS RESTRICTIVE FOR ALL TO app_authenticated, app_agent USING (current_setting('app.current_brands', true) = '*' OR EXISTS (SELECT 1 FROM orders o WHERE o.id = order_id)) WITH CHECK (current_setting('app.current_brands', true) = '*' OR EXISTS (SELECT 1 FROM orders o WHERE o.id = order_id));
--> statement-breakpoint
CREATE TRIGGER invoice_cancellations_immutable BEFORE UPDATE OR DELETE ON invoice_cancellations FOR EACH ROW EXECUTE FUNCTION sail.forbid_change();
--> statement-breakpoint
-- Same-merchant twins of the two foreign keys, as 0051 gave every other table.
ALTER TABLE invoice_cancellations ADD CONSTRAINT invoice_cancellations_order_id_same_merchant FOREIGN KEY (order_id, merchant_id) REFERENCES orders (id, merchant_id);
--> statement-breakpoint
ALTER TABLE invoice_cancellations ADD CONSTRAINT invoice_cancellations_check_id_same_merchant FOREIGN KEY (check_id, merchant_id) REFERENCES checks (id, merchant_id);
