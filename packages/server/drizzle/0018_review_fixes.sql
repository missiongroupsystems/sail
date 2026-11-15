-- Beta v1 review.
-- A voided line is worth quantity × (unit price + modifiers per unit); the earlier view ignored modifiers,
-- so the void report and the Z-report under-stated voids of items with paid modifiers.
CREATE OR REPLACE VIEW report_voids WITH (security_invoker = true) AS
SELECT l.merchant_id, l.outlet_id, o.brand_id, o.business_date, o.id AS order_id, o.order_no, o.order_type, o.channel AS source, o.station_id,
       l.id AS line_id, l.product_id, l.name AS product_name, l.category_id, l.quantity, l.unit_price,
       (l.quantity * (l.unit_price + COALESCE((SELECT SUM((m->>'price')::int * (m->>'quantity')::int) FROM jsonb_array_elements(l.modifiers) m), 0)))::int AS value,
       (l.fired_at IS NOT NULL) AS after_firing, l.void_reason, l.void_reason_id, l.voided_by, l.void_approved_by, l.void_override_id, l.voided_at
FROM order_lines l
JOIN orders o ON o.id = l.order_id
WHERE l.status = 'voided';
