-- Hand-written: RLS, invariants and the ticket state guard for the kitchen display.
-- Staff and stations (app_authenticated) reach their outlets' destinations and tickets. Agents (app_agent) may read
-- them, never write. Guests and relays get no grant at all.

--> statement-breakpoint
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['display_destinations','kitchen_tickets','kitchen_ticket_lines'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR ALL TO app_authenticated USING (merchant_id = sail.merchant_id() AND sail.outlet_allowed(outlet_id)) WITH CHECK (merchant_id = sail.merchant_id() AND sail.outlet_allowed(outlet_id))', t || '_tenant', t);
    EXECUTE format('GRANT SELECT ON %I TO app_agent', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR SELECT TO app_agent USING (merchant_id = sail.merchant_id() AND sail.outlet_allowed(outlet_id))', t || '_agent', t);
  END LOOP;
END $$;
--> statement-breakpoint
ALTER TABLE kitchen_ticket_lines ADD CONSTRAINT kitchen_ticket_lines_voided_within_quantity CHECK (quantity > 0 AND voided_quantity >= 0 AND voided_quantity <= quantity);
--> statement-breakpoint
ALTER TABLE merchant_settings ADD CONSTRAINT merchant_settings_kitchen_thresholds CHECK (kitchen_warn_minutes >= 1 AND kitchen_late_minutes > kitchen_warn_minutes AND kitchen_late_minutes <= 240);
--> statement-breakpoint
-- Ticket lifecycle: new → in_progress | ready; in_progress → ready; ready → recalled; recalled → in_progress | ready;
-- any open or ready ticket → cancelled. A bumped ticket is ready (or cancelled) and only a ready one is recalled.
CREATE OR REPLACE FUNCTION sail.kitchen_ticket_transition_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, sail AS $$
BEGIN
  IF OLD.status = NEW.status THEN RETURN NEW; END IF;
  IF (OLD.status = 'new' AND NEW.status IN ('in_progress','ready','cancelled'))
     OR (OLD.status = 'in_progress' AND NEW.status IN ('ready','cancelled'))
     OR (OLD.status = 'ready' AND NEW.status IN ('recalled','cancelled'))
     OR (OLD.status = 'recalled' AND NEW.status IN ('in_progress','ready','cancelled')) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'kitchen_ticket_transition: % -> % is not allowed', OLD.status, NEW.status USING ERRCODE = 'P0001';
END $$;
--> statement-breakpoint
CREATE TRIGGER kitchen_tickets_transition BEFORE UPDATE OF status ON kitchen_tickets FOR EACH ROW EXECUTE FUNCTION sail.kitchen_ticket_transition_guard();
--> statement-breakpoint
-- A ready ticket carries its bump time; a ticket on the display (new, in progress, recalled) has none.
ALTER TABLE kitchen_tickets ADD CONSTRAINT kitchen_tickets_bumped_when_ready CHECK ((status = 'ready') = (bumped_at IS NOT NULL) OR status = 'cancelled');
