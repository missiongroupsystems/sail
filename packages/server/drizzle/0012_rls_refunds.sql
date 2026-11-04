-- Hand-written: RLS and invariants for refunds (scope doc 4.5): immutable records, sums, per-line and per-payment caps.

--> statement-breakpoint
DO $$
DECLARE t text;
BEGIN
  ALTER TABLE refunds ENABLE ROW LEVEL SECURITY;
  CREATE POLICY refunds_tenant ON refunds FOR ALL TO app_authenticated USING (merchant_id = sail.merchant_id() AND sail.outlet_allowed(outlet_id)) WITH CHECK (merchant_id = sail.merchant_id() AND sail.outlet_allowed(outlet_id));
  FOREACH t IN ARRAY ARRAY['refund_lines','refund_tenders'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR ALL TO app_authenticated USING (merchant_id = sail.merchant_id()) WITH CHECK (merchant_id = sail.merchant_id())', t || '_tenant', t);
  END LOOP;
END $$;
--> statement-breakpoint
CREATE TRIGGER refunds_immutable BEFORE UPDATE OR DELETE ON refunds FOR EACH ROW EXECUTE FUNCTION sail.forbid_change();
--> statement-breakpoint
CREATE TRIGGER refund_lines_immutable BEFORE UPDATE OR DELETE ON refund_lines FOR EACH ROW EXECUTE FUNCTION sail.forbid_change();
--> statement-breakpoint
CREATE TRIGGER refund_tenders_immutable BEFORE UPDATE OR DELETE ON refund_tenders FOR EACH ROW EXECUTE FUNCTION sail.forbid_change();
--> statement-breakpoint
-- Invariant (at commit): a refund's lines and tenders both add up to its total; each line's refunds never exceed
-- its allocation on that check; each payment's refunds never exceed what it paid.
CREATE OR REPLACE FUNCTION sail.check_refund_sums() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, sail AS $$
DECLARE r record; lines_total integer; tenders_total integer; alloc record; refunded record; pay_amount integer; pay_refunded integer; v_check uuid;
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
END $$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER refund_lines_sums AFTER INSERT ON refund_lines DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION sail.check_refund_sums();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER refund_tenders_sums AFTER INSERT ON refund_tenders DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION sail.check_refund_sums();
--> statement-breakpoint
ALTER TABLE refunds ADD CONSTRAINT refunds_total_positive CHECK (total > 0);
--> statement-breakpoint
ALTER TABLE refund_tenders ADD CONSTRAINT refund_tenders_amount_nonneg CHECK (amount >= 0);
