ALTER TABLE "refund_tenders" ADD COLUMN "tip_cents" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "refunds" ADD COLUMN "tip" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
-- A refund of only a tip (the bill was given back before) has a total of 0.
ALTER TABLE refunds DROP CONSTRAINT refunds_total_positive;--> statement-breakpoint
ALTER TABLE refunds ADD CONSTRAINT refunds_total_positive CHECK (total >= 0 AND tip >= 0 AND total + tip > 0);--> statement-breakpoint
-- A refund's tip is given back on top of its total: per payment, never more than the tip it took.
CREATE OR REPLACE FUNCTION sail.check_refund_sums()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'sail'
AS $function$
DECLARE r record; lines_total bigint; tenders_total bigint; tenders_tip bigint; alloc record; refunded record; pay record; pay_refunded bigint; pay_tip_refunded bigint; v_check uuid;
BEGIN
  SELECT * INTO r FROM refunds WHERE id = NEW.refund_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT COALESCE(SUM(total),0) INTO lines_total FROM refund_lines WHERE refund_id = r.id;
  SELECT COALESCE(SUM(amount),0), COALESCE(SUM(tip_cents),0) INTO tenders_total, tenders_tip FROM refund_tenders WHERE refund_id = r.id;
  IF lines_total <> r.total OR tenders_total <> r.total THEN
    RAISE EXCEPTION 'refund_sum: lines % and tenders % must both equal refund total %', lines_total, tenders_total, r.total USING ERRCODE = 'P0001';
  END IF;
  IF tenders_tip <> r.tip THEN
    RAISE EXCEPTION 'refund_tip_sum: tenders give back % of tips but the refund says %', tenders_tip, r.tip USING ERRCODE = 'P0001';
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
    SELECT amount, tip_cents INTO pay FROM payments WHERE id = NEW.payment_id AND status = 'recorded';
    IF NOT FOUND THEN RAISE EXCEPTION 'refund_payment_missing: payment % is not a recorded payment', NEW.payment_id USING ERRCODE = 'P0001'; END IF;
    SELECT COALESCE(SUM(amount),0), COALESCE(SUM(tip_cents),0) INTO pay_refunded, pay_tip_refunded FROM refund_tenders WHERE payment_id = NEW.payment_id;
    IF pay_refunded > pay.amount THEN
      RAISE EXCEPTION 'refund_exceeds_payment: % refunded against payment % which paid %', pay_refunded, NEW.payment_id, pay.amount USING ERRCODE = 'P0001';
    END IF;
    IF NEW.tip_cents < 0 OR pay_tip_refunded > pay.tip_cents THEN
      RAISE EXCEPTION 'refund_exceeds_tip: % of tip given back against payment % which took a tip of %', pay_tip_refunded, NEW.payment_id, pay.tip_cents USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NULL;
END $function$;
--> statement-breakpoint
CREATE OR REPLACE VIEW report_refunds WITH (security_invoker = true) AS
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
    o.opened_by AS staff_id,
    r.tip
   FROM refunds r
     JOIN orders o ON o.id = r.order_id;
