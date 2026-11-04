-- Hand-written: RLS and invariants for orders, lines, adjustments, overrides and pairing codes.

--> statement-breakpoint
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['orders','order_lines','order_manual_applications','order_adjustments','overrides'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR ALL TO app_authenticated USING (merchant_id = sail.merchant_id() AND sail.outlet_allowed(outlet_id)) WITH CHECK (merchant_id = sail.merchant_id() AND sail.outlet_allowed(outlet_id))', t || '_tenant', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['order_adjustment_lines','station_pairing_codes'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR ALL TO app_authenticated USING (merchant_id = sail.merchant_id()) WITH CHECK (merchant_id = sail.merchant_id())', t || '_tenant', t);
  END LOOP;
END $$;
--> statement-breakpoint
-- At most one open dine-in order per table (vision 5.2).
CREATE UNIQUE INDEX orders_one_open_per_table ON orders (table_id) WHERE table_id IS NOT NULL AND status IN ('open','fired','ready','out_for_delivery');
--> statement-breakpoint
-- Invariant: every adjustment's line amounts add up to its total (checked at commit).
CREATE OR REPLACE FUNCTION sail.check_adjustment_sum() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE adj uuid; total_lines integer; total_adj integer; gst_lines integer; gst_adj integer;
BEGIN
  adj := COALESCE(NEW.adjustment_id, OLD.adjustment_id);
  SELECT total, gst_total INTO total_adj, gst_adj FROM order_adjustments WHERE id = adj;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT COALESCE(SUM(amount), 0), COALESCE(SUM(gst_amount), 0) INTO total_lines, gst_lines FROM order_adjustment_lines WHERE adjustment_id = adj;
  IF total_lines <> total_adj OR gst_lines <> gst_adj THEN
    RAISE EXCEPTION 'adjustment_lines_sum: lines % / gst % do not add up to adjustment total % / gst %', total_lines, gst_lines, total_adj, gst_adj USING ERRCODE = 'P0001';
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER order_adjustment_lines_sum AFTER INSERT OR UPDATE OR DELETE ON order_adjustment_lines DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION sail.check_adjustment_sum();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION sail.check_adjustment_sum_from_adjustment() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE total_lines integer; total_adj integer;
BEGIN
  -- Deferred: the row may have been replaced by a later re-price in the same transaction.
  SELECT total INTO total_adj FROM order_adjustments WHERE id = NEW.id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT COALESCE(SUM(amount), 0) INTO total_lines FROM order_adjustment_lines WHERE adjustment_id = NEW.id;
  IF total_lines <> total_adj THEN
    RAISE EXCEPTION 'adjustment_lines_sum: lines % do not add up to adjustment total %', total_lines, total_adj USING ERRCODE = 'P0001';
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER order_adjustments_sum AFTER INSERT OR UPDATE ON order_adjustments DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION sail.check_adjustment_sum_from_adjustment();
--> statement-breakpoint
-- Invariant: the order total equals the sum of its non-voided line totals (checked at commit).
CREATE OR REPLACE FUNCTION sail.check_order_total() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE oid uuid; lines_total integer; order_total integer;
BEGIN
  oid := COALESCE(NEW.order_id, OLD.order_id, NEW.id, OLD.id);
  SELECT total INTO order_total FROM orders WHERE id = oid;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT COALESCE(SUM(total), 0) INTO lines_total FROM order_lines WHERE order_id = oid AND status <> 'voided';
  IF lines_total <> order_total THEN
    RAISE EXCEPTION 'order_total_sum: line totals % do not add up to order total %', lines_total, order_total USING ERRCODE = 'P0001';
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER order_lines_total_sum AFTER INSERT OR UPDATE OR DELETE ON order_lines DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION sail.check_order_total();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION sail.check_order_total_from_order() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE lines_total integer;
BEGIN
  SELECT COALESCE(SUM(total), 0) INTO lines_total FROM order_lines WHERE order_id = NEW.id AND status <> 'voided';
  IF lines_total <> NEW.total THEN
    RAISE EXCEPTION 'order_total_sum: line totals % do not add up to order total %', lines_total, NEW.total USING ERRCODE = 'P0001';
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER orders_total_sum AFTER INSERT OR UPDATE OF total ON orders DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION sail.check_order_total_from_order();
--> statement-breakpoint
-- Order and line money columns are only ever written from the pricing pipeline; voided lines carry zero amounts.
ALTER TABLE order_lines ADD CONSTRAINT order_lines_voided_zero CHECK (status <> 'voided' OR (total = 0 AND net_amount = 0 AND fee_amount = 0));
--> statement-breakpoint
ALTER TABLE order_lines ADD CONSTRAINT order_lines_quantity_positive CHECK (quantity >= 1);
