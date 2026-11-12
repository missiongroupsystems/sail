-- Hand-written: the report views dropped before the money columns became bigint, recreated with the same columns.
-- Their sums and casts are bigint now, as are the variables of the deferred sum checks, so no total wraps at 2^31.

--> statement-breakpoint
CREATE VIEW report_sales_lines WITH (security_invoker = true) AS
 SELECT o.merchant_id,
    o.outlet_id,
    o.brand_id,
    o.business_date,
    o.id AS order_id,
    o.order_no,
    o.order_type,
    o.channel AS source,
    o.station_id,
    o.opened_by AS staff_id,
    o.opened_by_name AS staff_name,
    o.pax,
    o.completed_at,
    l.id AS line_id,
    l.product_id,
    l.name AS product_name,
    l.sku,
    l.category_id,
    l.parent_category_id,
    l.quantity,
    l.base_amount,
    l.discount_amount,
    l.net_amount,
    l.fee_amount,
    l.tax_amount,
    l.taxes,
    l.tax_class_id,
    l.total,
    l.source AS line_source,
    l.added_by,
    l.added_by_name
   FROM orders o
     JOIN order_lines l ON l.order_id = o.id
  WHERE o.status = 'completed'::order_status AND l.status <> 'voided'::line_status;
--> statement-breakpoint
CREATE VIEW report_orders WITH (security_invoker = true) AS
 SELECT o.merchant_id,
    o.outlet_id,
    o.brand_id,
    o.business_date,
    o.id AS order_id,
    o.order_no,
    o.order_type,
    o.channel AS source,
    o.station_id,
    o.opened_by AS staff_id,
    o.opened_by_name AS staff_name,
    o.pax,
    o.status,
    o.opened_at,
    o.completed_at,
    o.subtotal,
    o.discount_total,
    o.fee_total,
    o.tax_total,
    o.taxes,
    o.total,
    o.tax_mode,
    o.fee_total -
        CASE
            WHEN o.tax_mode = 'inclusive'::text THEN ft.fee_tax
            ELSE 0
        END AS fees_net,
    o.subtotal + o.discount_total -
        CASE
            WHEN o.tax_mode = 'inclusive'::text THEN o.tax_total - ft.fee_tax
            ELSE 0
        END AS net_sales
   FROM orders o
     CROSS JOIN LATERAL ( SELECT COALESCE(sum(a.tax_total), 0::bigint)::bigint AS fee_tax
           FROM order_adjustments a
          WHERE a.order_id = o.id AND a.kind = 'fee'::text) ft
  WHERE o.status = 'completed'::order_status;
--> statement-breakpoint
CREATE VIEW report_adjustments WITH (security_invoker = true) AS
 SELECT a.merchant_id,
    a.outlet_id,
    o.brand_id,
    o.business_date,
    o.id AS order_id,
    o.order_no,
    o.order_type,
    o.channel AS source,
    o.station_id,
    a.rule_key,
    a.rule_version,
    a.name,
    a.kind,
    a.level,
    a.report_class,
    a.total,
    a.tax_total,
    a.capped,
    a.frozen,
    a.manual_application_id,
    a.entered_value,
    a.applied_by,
    a.approved_by,
    a.override_id,
    a.reason,
    o.opened_by AS staff_id
   FROM order_adjustments a
     JOIN orders o ON o.id = a.order_id
  WHERE o.status = 'completed'::order_status;
--> statement-breakpoint
CREATE VIEW report_payments WITH (security_invoker = true) AS
 SELECT p.merchant_id,
    p.outlet_id,
    o.brand_id,
    p.business_date,
    p.order_id,
    o.order_no,
    o.order_type,
    o.channel AS source,
    p.station_id,
    p.shift_id,
    p.id AS payment_id,
    p.check_id,
    p.tender_type_id,
    p.tender_name,
    p.is_cash,
    p.amount,
    p.rounding_cents,
    p.tip_cents,
    p.change_cents,
    p.reference,
    p.status,
    p.recorded_by,
    p.recorded_by_name,
    p.created_at,
    o.opened_by AS staff_id
   FROM payments p
     JOIN orders o ON o.id = p.order_id;
--> statement-breakpoint
CREATE VIEW report_refund_lines WITH (security_invoker = true) AS
 SELECT r.merchant_id,
    r.outlet_id,
    o.brand_id,
    r.business_date,
    r.order_id,
    o.order_type,
    o.channel AS source,
    r.station_id,
    o.opened_by AS staff_id,
    r.id AS refund_id,
    l.id AS line_id,
    l.product_id,
    l.name AS product_name,
    l.category_id,
    l.parent_category_id,
    l.added_by,
    l.added_by_name,
    rl.quantity,
    rl.base + rl.discount -
        CASE
            WHEN o.tax_mode = 'inclusive'::text THEN rl.tax - ft.fee_tax
            ELSE 0
        END AS net
   FROM refund_lines rl
     JOIN refunds r ON r.id = rl.refund_id
     JOIN orders o ON o.id = r.order_id
     JOIN order_lines l ON l.id = rl.order_line_id
     CROSS JOIN LATERAL ( SELECT COALESCE(sum((e.value ->> 'tax'::text)::bigint), 0::bigint)::bigint AS fee_tax
           FROM jsonb_each(rl.adjustments) e(key, value)) ft;
--> statement-breakpoint
CREATE VIEW report_refund_tenders WITH (security_invoker = true) AS
 SELECT r.merchant_id,
    r.outlet_id,
    r.business_date,
    r.id AS refund_id,
    t.payment_id,
    t.tender_name,
    t.is_cash,
    t.amount,
    t.rounding_cents
   FROM refund_tenders t
     JOIN refunds r ON r.id = t.refund_id;
--> statement-breakpoint
CREATE VIEW report_refunds WITH (security_invoker = true) AS
 SELECT r.merchant_id,
    r.outlet_id,
    o.brand_id,
    r.business_date,
    r.order_id,
    o.order_no,
    o.order_type,
    o.channel AS source,
    r.station_id,
    r.shift_id,
    r.id AS refund_id,
    r.check_id,
    r.kind,
    r.reason,
    r.refunded_by,
    r.refunded_by_name,
    r.approved_by,
    r.approved_by_name,
    r.override_id,
    r.base,
    r.discount,
    r.fee,
    r.tax,
    r.taxes,
    r.total,
    r.refund_receipt_no,
    r.credit_note_no,
    r.created_at,
    COALESCE(( SELECT sum(n.net) AS sum
           FROM report_refund_lines n
          WHERE n.refund_id = r.id), 0::bigint)::bigint AS net,
    o.opened_by AS staff_id
   FROM refunds r
     JOIN orders o ON o.id = r.order_id;
--> statement-breakpoint
CREATE VIEW report_net_sales WITH (security_invoker = true) AS
 SELECT s.merchant_id,
    s.outlet_id,
    s.brand_id,
    s.business_date,
    s.order_type,
    s.source,
    s.station_id,
    s.staff_id,
    s.product_id,
    s.product_name,
    s.category_id,
    s.parent_category_id,
    s.added_by,
    s.added_by_name,
    s.quantity,
    s.base_amount AS gross,
    s.discount_amount AS discounts,
    s.net_amount -
        CASE
            WHEN o.tax_mode = 'inclusive'::text THEN s.tax_amount - ft.fee_tax
            ELSE 0
        END AS net
   FROM report_sales_lines s
     JOIN orders o ON o.id = s.order_id
     CROSS JOIN LATERAL ( SELECT COALESCE(sum(al.tax_amount), 0::bigint)::bigint AS fee_tax
           FROM order_adjustment_lines al
          WHERE al.order_line_id = s.line_id) ft
UNION ALL
 SELECT n.merchant_id,
    n.outlet_id,
    n.brand_id,
    n.business_date,
    n.order_type,
    n.source,
    n.station_id,
    n.staff_id,
    n.product_id,
    n.product_name,
    n.category_id,
    n.parent_category_id,
    n.added_by,
    n.added_by_name,
    0 AS quantity,
    0 AS gross,
    0 AS discounts,
    - n.net AS net
   FROM report_refund_lines n;
--> statement-breakpoint
CREATE VIEW report_voids WITH (security_invoker = true) AS
 SELECT l.merchant_id,
    l.outlet_id,
    o.brand_id,
    o.business_date,
    o.id AS order_id,
    o.order_no,
    o.order_type,
    o.channel AS source,
    o.station_id,
    l.id AS line_id,
    l.product_id,
    l.name AS product_name,
    l.category_id,
    l.quantity,
    l.unit_price,
    (l.quantity * (l.unit_price + COALESCE(( SELECT sum(((m.value ->> 'price'::text)::bigint) * ((m.value ->> 'quantity'::text)::bigint)) AS sum
           FROM jsonb_array_elements(l.modifiers) m(value)), 0::bigint)))::bigint AS value,
    l.fired_at IS NOT NULL AS after_firing,
    l.void_reason,
    l.void_reason_id,
    l.voided_by,
    l.void_approved_by,
    l.void_override_id,
    l.voided_at,
    o.opened_by AS staff_id
   FROM order_lines l
     JOIN orders o ON o.id = l.order_id
  WHERE l.status = 'voided'::line_status;
--> statement-breakpoint
GRANT SELECT ON report_sales_lines, report_orders, report_adjustments, report_payments, report_refund_lines, report_refund_tenders, report_refunds, report_net_sales, report_voids TO app_authenticated, app_agent;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION sail.check_adjustment_sum_from_adjustment()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'sail'
AS $function$
DECLARE total_lines bigint; total_adj bigint;
BEGIN
  -- Deferred: the row may have been replaced by a later re-price in the same transaction.
  SELECT total INTO total_adj FROM order_adjustments WHERE id = NEW.id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT COALESCE(SUM(amount), 0) INTO total_lines FROM order_adjustment_lines WHERE adjustment_id = NEW.id;
  IF total_lines <> total_adj THEN
    RAISE EXCEPTION 'adjustment_lines_sum: lines % do not add up to adjustment total %', total_lines, total_adj USING ERRCODE = 'P0001';
  END IF;
  RETURN NULL;
END $function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION sail.check_order_total()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'sail'
AS $function$
DECLARE oid uuid; lines_total bigint; order_total bigint;
BEGIN
  oid := COALESCE(NEW.order_id, OLD.order_id, NEW.id, OLD.id);
  SELECT total INTO order_total FROM orders WHERE id = oid;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT COALESCE(SUM(total), 0) INTO lines_total FROM order_lines WHERE order_id = oid AND status <> 'voided';
  IF lines_total <> order_total THEN
    RAISE EXCEPTION 'order_total_sum: line totals % do not add up to order total %', lines_total, order_total USING ERRCODE = 'P0001';
  END IF;
  RETURN NULL;
END $function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION sail.check_order_total_from_order()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'sail'
AS $function$
DECLARE lines_total bigint; order_total bigint;
BEGIN
  -- Deferred: re-read the row, which may have been re-priced since this trigger was queued.
  SELECT total INTO order_total FROM orders WHERE id = NEW.id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT COALESCE(SUM(total), 0) INTO lines_total FROM order_lines WHERE order_id = NEW.id AND status <> 'voided';
  IF lines_total <> order_total THEN
    RAISE EXCEPTION 'order_total_sum: line totals % do not add up to order total %', lines_total, order_total USING ERRCODE = 'P0001';
  END IF;
  RETURN NULL;
END $function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION sail.check_allocation_sums()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'sail'
AS $function$
DECLARE c uuid; l uuid; sum_total bigint; sum_base bigint; chk record; line_total bigint; line_alloc bigint; n_alloc bigint;
BEGIN
  c := COALESCE(NEW.check_id, OLD.check_id);
  l := COALESCE(NEW.order_line_id, OLD.order_line_id);
  SELECT * INTO chk FROM checks WHERE id = c;
  IF FOUND THEN
    SELECT COALESCE(SUM(total),0), COALESCE(SUM(base),0) INTO sum_total, sum_base FROM check_allocations WHERE check_id = c;
    IF sum_total <> chk.total OR sum_base <> chk.subtotal THEN
      RAISE EXCEPTION 'check_allocation_sum: check % allocations total % / base % but check says % / %', c, sum_total, sum_base, chk.total, chk.subtotal USING ERRCODE = 'P0001';
    END IF;
  END IF;
  SELECT total INTO line_total FROM order_lines WHERE id = l AND status <> 'voided';
  IF FOUND THEN
    SELECT COALESCE(SUM(total),0), COUNT(*) INTO line_alloc, n_alloc FROM check_allocations WHERE order_line_id = l;
    IF n_alloc > 0 AND line_alloc <> line_total THEN
      RAISE EXCEPTION 'line_allocation_sum: line % allocated % across checks but line total is %', l, line_alloc, line_total USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NULL;
END $function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION sail.check_refund_sums()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'sail'
AS $function$
DECLARE r record; lines_total bigint; tenders_total bigint; alloc record; refunded record; pay_amount bigint; pay_refunded bigint; v_check uuid;
BEGIN
  SELECT * INTO r FROM refunds WHERE id = NEW.refund_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT COALESCE(SUM(total),0) INTO lines_total FROM refund_lines WHERE refund_id = r.id;
  SELECT COALESCE(SUM(amount),0) INTO tenders_total FROM refund_tenders WHERE refund_id = r.id;
  IF lines_total <> r.total OR tenders_total <> r.total THEN
    RAISE EXCEPTION 'refund_sum: lines % and tenders % must both equal refund total %', lines_total, tenders_total, r.total USING ERRCODE = 'P0001';
  END IF;
  IF TG_TABLE_NAME = 'refund_lines' THEN
    SELECT * INTO alloc FROM check_allocations WHERE check_id = r.check_id AND order_line_id = NEW.order_line_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'refund_line_not_on_check: line % is not allocated to check %', NEW.order_line_id, r.check_id USING ERRCODE = 'P0001'; END IF;
    SELECT COALESCE(SUM(rl.total),0) AS total, COALESCE(SUM(rl.quantity),0) AS quantity INTO refunded FROM refund_lines rl JOIN refunds rf ON rf.id = rl.refund_id WHERE rf.check_id = r.check_id AND rl.order_line_id = NEW.order_line_id;
    IF refunded.total > alloc.total THEN
      RAISE EXCEPTION 'refund_exceeds_line: % refunded on line % but only % was paid for it', refunded.total, NEW.order_line_id, alloc.total USING ERRCODE = 'P0001';
    END IF;
  END IF;
  IF TG_TABLE_NAME = 'refund_tenders' THEN
    SELECT amount INTO pay_amount FROM payments WHERE id = NEW.payment_id AND status = 'recorded';
    IF NOT FOUND THEN RAISE EXCEPTION 'refund_payment_missing: payment % is not a recorded payment', NEW.payment_id USING ERRCODE = 'P0001'; END IF;
    SELECT COALESCE(SUM(amount),0) INTO pay_refunded FROM refund_tenders WHERE payment_id = NEW.payment_id;
    IF pay_refunded > pay_amount THEN
      RAISE EXCEPTION 'refund_exceeds_payment: % refunded against payment % which paid %', pay_refunded, NEW.payment_id, pay_amount USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NULL;
END $function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION sail.check_adjustment_sum()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'sail'
AS $function$
DECLARE adj uuid; total_lines bigint; total_adj bigint; tax_lines bigint; tax_adj bigint;
BEGIN
  adj := COALESCE(NEW.adjustment_id, OLD.adjustment_id);
  SELECT total, tax_total INTO total_adj, tax_adj FROM order_adjustments WHERE id = adj;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT COALESCE(SUM(amount), 0), COALESCE(SUM(tax_amount), 0) INTO total_lines, tax_lines FROM order_adjustment_lines WHERE adjustment_id = adj;
  IF total_lines <> total_adj OR tax_lines <> tax_adj THEN
    RAISE EXCEPTION 'adjustment_lines_sum: lines % / tax % do not add up to adjustment total % / tax %', total_lines, tax_lines, total_adj, tax_adj USING ERRCODE = 'P0001';
  END IF;
  RETURN NULL;
END $function$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER orders_total_sum AFTER INSERT OR UPDATE OF total ON orders DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION sail.check_order_total_from_order();
