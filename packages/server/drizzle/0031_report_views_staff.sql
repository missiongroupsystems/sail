-- Hand-written: the staff filter on reports is the staff member who opened the order (report_orders.staff_id), and
-- every view the sales summary and exceptions report filter on needs it, or filtering by staff fails.
CREATE OR REPLACE VIEW report_adjustments WITH (security_invoker = true) AS
SELECT a.merchant_id, a.outlet_id, o.brand_id, o.business_date, o.id AS order_id, o.order_no, o.order_type, o.channel AS source, o.station_id,
       a.rule_key, a.rule_version, a.name, a.kind, a.level, a.report_class, a.total, a.tax_total, a.capped, a.frozen,
       a.manual_application_id, a.entered_value, a.applied_by, a.approved_by, a.override_id, a.reason,
       o.opened_by AS staff_id
FROM order_adjustments a
JOIN orders o ON o.id = a.order_id
WHERE o.status = 'completed';
--> statement-breakpoint
CREATE OR REPLACE VIEW report_payments WITH (security_invoker = true) AS
SELECT p.merchant_id, p.outlet_id, o.brand_id, p.business_date, p.order_id, o.order_no, o.order_type, o.channel AS source, p.station_id, p.shift_id,
       p.id AS payment_id, p.check_id, p.tender_type_id, p.tender_name, p.is_cash, p.amount, p.rounding_cents, p.tip_cents, p.change_cents, p.reference,
       p.status, p.recorded_by, p.recorded_by_name, p.created_at,
       o.opened_by AS staff_id
FROM payments p
JOIN orders o ON o.id = p.order_id;
--> statement-breakpoint
CREATE OR REPLACE VIEW report_refunds WITH (security_invoker = true) AS
SELECT r.merchant_id, r.outlet_id, o.brand_id, r.business_date, r.order_id, o.order_no, o.order_type, o.channel AS source, r.station_id, r.shift_id,
       r.id AS refund_id, r.check_id, r.kind, r.reason, r.refunded_by, r.refunded_by_name, r.approved_by, r.approved_by_name, r.override_id,
       r.base, r.discount, r.fee, r.tax, r.taxes, r.total, r.refund_receipt_no, r.credit_note_no, r.created_at,
       coalesce((SELECT sum(n.net) FROM report_refund_lines n WHERE n.refund_id = r.id), 0)::int AS net,
       o.opened_by AS staff_id
FROM refunds r
JOIN orders o ON o.id = r.order_id;
--> statement-breakpoint
CREATE OR REPLACE VIEW report_voids WITH (security_invoker = true) AS
SELECT l.merchant_id, l.outlet_id, o.brand_id, o.business_date, o.id AS order_id, o.order_no, o.order_type, o.channel AS source, o.station_id,
       l.id AS line_id, l.product_id, l.name AS product_name, l.category_id, l.quantity, l.unit_price,
       (l.quantity * (l.unit_price + COALESCE((SELECT SUM((m->>'price')::int * (m->>'quantity')::int) FROM jsonb_array_elements(l.modifiers) m), 0)))::int AS value,
       (l.fired_at IS NOT NULL) AS after_firing, l.void_reason, l.void_reason_id, l.voided_by, l.void_approved_by, l.void_override_id, l.voided_at,
       o.opened_by AS staff_id
FROM order_lines l
JOIN orders o ON o.id = l.order_id
WHERE l.status = 'voided';
