-- Hand-written: money amounts move from integer to bigint in the next migration, and a column a view reads cannot
-- change type. The report views are dropped here and recreated, unchanged apart from their casts, after it.
DROP VIEW report_net_sales, report_refunds, report_refund_lines, report_sales_lines, report_orders, report_adjustments, report_payments, report_refund_tenders, report_voids;
--> statement-breakpoint
-- The deferred order-total check fires on UPDATE OF total, which also pins the column's type; it is recreated after it.
DROP TRIGGER orders_total_sum ON orders;
