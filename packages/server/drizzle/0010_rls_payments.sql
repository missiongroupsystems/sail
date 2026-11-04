-- Hand-written: RLS and invariants for checks, allocations, payments, document numbering, shifts, business days and digital receipts.

--> statement-breakpoint
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['checks','payments','shifts','business_day_closes','digital_receipts'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR ALL TO app_authenticated USING (merchant_id = sail.merchant_id() AND sail.outlet_allowed(outlet_id)) WITH CHECK (merchant_id = sail.merchant_id() AND sail.outlet_allowed(outlet_id))', t || '_tenant', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['check_allocations','document_sequences'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR ALL TO app_authenticated USING (merchant_id = sail.merchant_id()) WITH CHECK (merchant_id = sail.merchant_id())', t || '_tenant', t);
  END LOOP;
END $$;
--> statement-breakpoint
-- Payments are never deleted; reversal is a status change.
CREATE TRIGGER payments_no_delete BEFORE DELETE ON payments FOR EACH ROW EXECUTE FUNCTION sail.forbid_change();
--> statement-breakpoint
-- One open shift per station, and one open outlet-wide shift per outlet.
CREATE UNIQUE INDEX shifts_one_open_per_station ON shifts (station_id) WHERE status = 'open' AND station_id IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX shifts_one_open_per_outlet ON shifts (outlet_id) WHERE status = 'open' AND station_id IS NULL;
--> statement-breakpoint
-- Invariant: a check's totals equal the sums of its allocations, and a line's allocations across checks add up to the line (checked at commit).
CREATE OR REPLACE FUNCTION sail.check_allocation_sums() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE c uuid; l uuid; sum_total integer; sum_base integer; chk record; line_total integer; line_alloc integer; n_alloc integer;
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
END $$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER check_allocations_sum AFTER INSERT OR UPDATE OR DELETE ON check_allocations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION sail.check_allocation_sums();
--> statement-breakpoint
-- Invariant: paid_total never exceeds total + 0 (payments are applied amounts), and never goes negative.
ALTER TABLE checks ADD CONSTRAINT checks_paid_within_total CHECK (paid_total >= 0 AND paid_total <= total);
--> statement-breakpoint
ALTER TABLE payments ADD CONSTRAINT payments_amount_positive CHECK (amount > 0 AND tip_cents >= 0 AND change_cents >= 0);
--> statement-breakpoint
-- Public digital receipt page: the token is the only credential, so the row is readable with no principal (owner connection).
CREATE INDEX digital_receipts_expires_idx ON digital_receipts (expires_at);
