-- Hand-written: one definition of net sales for the Z-report, the sales summary and the product mix.
-- Net sales are item sales after discounts, without tax and fees, less the net of refunds.
-- In inclusive mode every amount carries its tax, so the tax on items (the tax less the tax on fees)
-- comes off the net amount; in exclusive mode the net amount has none. Discount adjustments carry no
-- tax (pricing-semantics §2 step 5), so the tax on a line's adjustments is the tax on its fees.

--> statement-breakpoint
CREATE OR REPLACE VIEW report_orders WITH (security_invoker = true) AS
SELECT o.merchant_id, o.outlet_id, o.brand_id, o.business_date, o.id AS order_id, o.order_no, o.order_type, o.channel AS source, o.station_id,
       o.opened_by AS staff_id, o.opened_by_name AS staff_name, o.pax, o.status, o.opened_at, o.completed_at,
       o.subtotal, o.discount_total, o.fee_total, o.tax_total, o.taxes, o.total,
       o.tax_mode,
       o.fee_total - CASE WHEN o.tax_mode = 'inclusive' THEN ft.fee_tax ELSE 0 END AS fees_net,
       o.subtotal + o.discount_total - CASE WHEN o.tax_mode = 'inclusive' THEN o.tax_total - ft.fee_tax ELSE 0 END AS net_sales
FROM orders o
CROSS JOIN LATERAL (SELECT coalesce(sum(a.tax_total), 0)::int AS fee_tax FROM order_adjustments a WHERE a.order_id = o.id AND a.kind = 'fee') ft
WHERE o.status = 'completed';
--> statement-breakpoint
CREATE VIEW report_refund_lines WITH (security_invoker = true) AS
SELECT r.merchant_id, r.outlet_id, o.brand_id, r.business_date, r.order_id, o.order_type, o.channel AS source, r.station_id, o.opened_by AS staff_id,
       r.id AS refund_id, l.id AS line_id, l.product_id, l.name AS product_name, l.category_id, l.parent_category_id, l.added_by, l.added_by_name,
       rl.quantity,
       rl.base + rl.discount - CASE WHEN o.tax_mode = 'inclusive' THEN rl.tax - ft.fee_tax ELSE 0 END AS net
FROM refund_lines rl
JOIN refunds r ON r.id = rl.refund_id
JOIN orders o ON o.id = r.order_id
JOIN order_lines l ON l.id = rl.order_line_id
CROSS JOIN LATERAL (SELECT coalesce(sum((e.value->>'tax')::int), 0)::int AS fee_tax FROM jsonb_each(rl.adjustments) e) ft;
--> statement-breakpoint
CREATE OR REPLACE VIEW report_refunds WITH (security_invoker = true) AS
SELECT r.merchant_id, r.outlet_id, o.brand_id, r.business_date, r.order_id, o.order_no, o.order_type, o.channel AS source, r.station_id, r.shift_id,
       r.id AS refund_id, r.check_id, r.kind, r.reason, r.refunded_by, r.refunded_by_name, r.approved_by, r.approved_by_name, r.override_id,
       r.base, r.discount, r.fee, r.tax, r.taxes, r.total, r.refund_receipt_no, r.credit_note_no, r.created_at,
       coalesce((SELECT sum(n.net) FROM report_refund_lines n WHERE n.refund_id = r.id), 0)::int AS net
FROM refunds r
JOIN orders o ON o.id = r.order_id;
--> statement-breakpoint
-- Net sales by line: sold lines on their order's business day, refunded lines (negative, quantity 0) on the refund's.
CREATE VIEW report_net_sales WITH (security_invoker = true) AS
SELECT s.merchant_id, s.outlet_id, s.brand_id, s.business_date, s.order_type, s.source, s.station_id, s.staff_id,
       s.product_id, s.product_name, s.category_id, s.parent_category_id, s.added_by, s.added_by_name,
       s.quantity, s.base_amount AS gross, s.discount_amount AS discounts,
       s.net_amount - CASE WHEN o.tax_mode = 'inclusive' THEN s.tax_amount - ft.fee_tax ELSE 0 END AS net
FROM report_sales_lines s
JOIN orders o ON o.id = s.order_id
CROSS JOIN LATERAL (SELECT coalesce(sum(al.tax_amount), 0)::int AS fee_tax FROM order_adjustment_lines al WHERE al.order_line_id = s.line_id) ft
UNION ALL
SELECT n.merchant_id, n.outlet_id, n.brand_id, n.business_date, n.order_type, n.source, n.station_id, n.staff_id,
       n.product_id, n.product_name, n.category_id, n.parent_category_id, n.added_by, n.added_by_name,
       0, 0, 0, -n.net
FROM report_refund_lines n;
--> statement-breakpoint
GRANT SELECT ON report_refund_lines, report_net_sales TO app_authenticated, app_agent;
