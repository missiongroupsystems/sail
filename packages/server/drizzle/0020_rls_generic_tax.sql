-- Hand-written: RLS and grants for tax classes and rates, the adjustment-sum invariant and the reporting views under their tax_* names.

--> statement-breakpoint
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['tax_classes','tax_rates'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR ALL TO app_authenticated USING (merchant_id = sail.merchant_id()) WITH CHECK (merchant_id = sail.merchant_id())', t || '_tenant', t);
    -- Guests and agents open orders, which snapshot the tax table: read only.
    EXECUTE format('GRANT SELECT ON %I TO app_guest, app_agent', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR SELECT TO app_guest USING (merchant_id = sail.merchant_id())', t || '_guest', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR SELECT TO app_agent USING (merchant_id = sail.merchant_id())', t || '_agent', t);
  END LOOP;
END $$;
--> statement-breakpoint
-- Invariant: every adjustment's line amounts and line tax add up to its totals (checked at commit).
CREATE OR REPLACE FUNCTION sail.check_adjustment_sum() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, sail AS $$
DECLARE adj uuid; total_lines integer; total_adj integer; tax_lines integer; tax_adj integer;
BEGIN
  adj := COALESCE(NEW.adjustment_id, OLD.adjustment_id);
  SELECT total, tax_total INTO total_adj, tax_adj FROM order_adjustments WHERE id = adj;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT COALESCE(SUM(amount), 0), COALESCE(SUM(tax_amount), 0) INTO total_lines, tax_lines FROM order_adjustment_lines WHERE adjustment_id = adj;
  IF total_lines <> total_adj OR tax_lines <> tax_adj THEN
    RAISE EXCEPTION 'adjustment_lines_sum: lines % / tax % do not add up to adjustment total % / tax %', total_lines, tax_lines, total_adj, tax_adj USING ERRCODE = 'P0001';
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
-- The views keep their old output column names after a column rename; recreate the four that expose tax.
DROP VIEW report_sales_lines, report_orders, report_adjustments, report_refunds;
--> statement-breakpoint
CREATE VIEW report_sales_lines WITH (security_invoker = true) AS
SELECT o.merchant_id, o.outlet_id, o.brand_id, o.business_date, o.id AS order_id, o.order_no, o.order_type, o.channel AS source, o.station_id,
       o.opened_by AS staff_id, o.opened_by_name AS staff_name, o.pax, o.completed_at,
       l.id AS line_id, l.product_id, l.name AS product_name, l.sku, l.category_id, l.parent_category_id, l.quantity,
       l.base_amount, l.discount_amount, l.net_amount, l.fee_amount, l.tax_amount, l.taxes, l.tax_class_id, l.total,
       l.source AS line_source, l.added_by, l.added_by_name
FROM orders o
JOIN order_lines l ON l.order_id = o.id
WHERE o.status = 'completed' AND l.status <> 'voided';
--> statement-breakpoint
CREATE VIEW report_orders WITH (security_invoker = true) AS
SELECT o.merchant_id, o.outlet_id, o.brand_id, o.business_date, o.id AS order_id, o.order_no, o.order_type, o.channel AS source, o.station_id,
       o.opened_by AS staff_id, o.opened_by_name AS staff_name, o.pax, o.status, o.opened_at, o.completed_at,
       o.subtotal, o.discount_total, o.fee_total, o.tax_total, o.taxes, o.total
FROM orders o
WHERE o.status = 'completed';
--> statement-breakpoint
CREATE VIEW report_adjustments WITH (security_invoker = true) AS
SELECT a.merchant_id, a.outlet_id, o.brand_id, o.business_date, o.id AS order_id, o.order_no, o.order_type, o.channel AS source, o.station_id,
       a.rule_key, a.rule_version, a.name, a.kind, a.level, a.report_class, a.total, a.tax_total, a.capped, a.frozen,
       a.manual_application_id, a.entered_value, a.applied_by, a.approved_by, a.override_id, a.reason
FROM order_adjustments a
JOIN orders o ON o.id = a.order_id
WHERE o.status = 'completed';
--> statement-breakpoint
CREATE VIEW report_refunds WITH (security_invoker = true) AS
SELECT r.merchant_id, r.outlet_id, o.brand_id, r.business_date, r.order_id, o.order_no, o.order_type, o.channel AS source, r.station_id, r.shift_id,
       r.id AS refund_id, r.check_id, r.kind, r.reason, r.refunded_by, r.refunded_by_name, r.approved_by, r.approved_by_name, r.override_id,
       r.base, r.discount, r.fee, r.tax, r.taxes, r.total, r.refund_receipt_no, r.credit_note_no, r.created_at
FROM refunds r
JOIN orders o ON o.id = r.order_id;
--> statement-breakpoint
GRANT SELECT ON report_sales_lines, report_orders, report_adjustments, report_refunds TO app_authenticated, app_agent;
