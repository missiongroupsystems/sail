-- Hand-written: reporting views. Reports read from SQL views; no separate analytics stack.
-- Views run with the caller's rights (security_invoker), so row-level security on the underlying tables applies.

--> statement-breakpoint
CREATE VIEW report_sales_lines WITH (security_invoker = true) AS
SELECT o.merchant_id, o.outlet_id, o.brand_id, o.business_date, o.id AS order_id, o.order_no, o.order_type, o.channel AS source, o.station_id,
       o.opened_by AS staff_id, o.opened_by_name AS staff_name, o.pax, o.completed_at,
       l.id AS line_id, l.product_id, l.name AS product_name, l.sku, l.category_id, l.parent_category_id, l.quantity,
       l.base_amount, l.discount_amount, l.net_amount, l.fee_amount, l.gst_amount, l.total,
       l.source AS line_source, l.added_by, l.added_by_name
FROM orders o
JOIN order_lines l ON l.order_id = o.id
WHERE o.status = 'completed' AND l.status <> 'voided';
--> statement-breakpoint
CREATE VIEW report_orders WITH (security_invoker = true) AS
SELECT o.merchant_id, o.outlet_id, o.brand_id, o.business_date, o.id AS order_id, o.order_no, o.order_type, o.channel AS source, o.station_id,
       o.opened_by AS staff_id, o.opened_by_name AS staff_name, o.pax, o.status, o.opened_at, o.completed_at,
       o.subtotal, o.discount_total, o.fee_total, o.gst_total, o.total
FROM orders o
WHERE o.status = 'completed';
--> statement-breakpoint
CREATE VIEW report_adjustments WITH (security_invoker = true) AS
SELECT a.merchant_id, a.outlet_id, o.brand_id, o.business_date, o.id AS order_id, o.order_no, o.order_type, o.channel AS source, o.station_id,
       a.rule_key, a.rule_version, a.name, a.kind, a.level, a.report_class, a.total, a.gst_total, a.capped, a.frozen,
       a.manual_application_id, a.entered_value, a.applied_by, a.approved_by, a.override_id, a.reason
FROM order_adjustments a
JOIN orders o ON o.id = a.order_id
WHERE o.status = 'completed';
--> statement-breakpoint
CREATE VIEW report_payments WITH (security_invoker = true) AS
SELECT p.merchant_id, p.outlet_id, o.brand_id, p.business_date, p.order_id, o.order_no, o.order_type, o.channel AS source, p.station_id, p.shift_id,
       p.id AS payment_id, p.check_id, p.tender_type_id, p.tender_name, p.is_cash, p.amount, p.rounding_cents, p.tip_cents, p.change_cents, p.reference,
       p.status, p.recorded_by, p.recorded_by_name, p.created_at
FROM payments p
JOIN orders o ON o.id = p.order_id;
--> statement-breakpoint
CREATE VIEW report_refunds WITH (security_invoker = true) AS
SELECT r.merchant_id, r.outlet_id, o.brand_id, r.business_date, r.order_id, o.order_no, o.order_type, o.channel AS source, r.station_id, r.shift_id,
       r.id AS refund_id, r.check_id, r.kind, r.reason, r.refunded_by, r.refunded_by_name, r.approved_by, r.approved_by_name, r.override_id,
       r.base, r.discount, r.fee, r.gst, r.total, r.refund_receipt_no, r.credit_note_no, r.created_at
FROM refunds r
JOIN orders o ON o.id = r.order_id;
--> statement-breakpoint
CREATE VIEW report_refund_tenders WITH (security_invoker = true) AS
SELECT r.merchant_id, r.outlet_id, r.business_date, r.id AS refund_id, t.payment_id, t.tender_name, t.is_cash, t.amount, t.rounding_cents
FROM refund_tenders t
JOIN refunds r ON r.id = t.refund_id;
--> statement-breakpoint
CREATE VIEW report_voids WITH (security_invoker = true) AS
SELECT l.merchant_id, l.outlet_id, o.brand_id, o.business_date, o.id AS order_id, o.order_no, o.order_type, o.channel AS source, o.station_id,
       l.id AS line_id, l.product_id, l.name AS product_name, l.category_id, l.quantity, l.unit_price, (l.quantity * l.unit_price) AS value,
       (l.fired_at IS NOT NULL) AS after_firing, l.void_reason, l.void_reason_id, l.voided_by, l.void_approved_by, l.void_override_id, l.voided_at
FROM order_lines l
JOIN orders o ON o.id = l.order_id
WHERE l.status = 'voided';
--> statement-breakpoint
CREATE VIEW report_print_jobs WITH (security_invoker = true) AS
SELECT j.merchant_id, j.outlet_id, j.printer_id, pr.name AS printer_name, j.claimed_by AS relay_id, j.kind, j.status, j.attempts, j.order_id,
       j.created_at, j.claimed_at, j.printed_at, j.failed_at, j.last_error, (j.reprint_of IS NOT NULL) AS is_reprint, (j.rerouted_from IS NOT NULL) AS is_rerouted,
       (j.created_at::date) AS created_date,
       EXTRACT(EPOCH FROM (j.printed_at - j.created_at)) AS seconds_to_print
FROM print_jobs j
LEFT JOIN printers pr ON pr.id = j.printer_id;
--> statement-breakpoint
GRANT SELECT ON report_sales_lines, report_orders, report_adjustments, report_payments, report_refunds, report_refund_tenders, report_voids, report_print_jobs TO app_authenticated, app_agent;
