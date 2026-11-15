-- Hand-written: RLS for printing, the narrow app_relay role, and print-job notifications.

--> statement-breakpoint
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['printers','print_relays','print_jobs'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR ALL TO app_authenticated USING (merchant_id = sail.merchant_id() AND sail.outlet_allowed(outlet_id)) WITH CHECK (merchant_id = sail.merchant_id() AND sail.outlet_allowed(outlet_id))', t || '_tenant', t);
  END LOOP;
  ALTER TABLE relay_pairing_codes ENABLE ROW LEVEL SECURITY;
  CREATE POLICY relay_pairing_codes_tenant ON relay_pairing_codes FOR ALL TO app_authenticated USING (merchant_id = sail.merchant_id()) WITH CHECK (merchant_id = sail.merchant_id());
END $$;
--> statement-breakpoint
-- app_relay: a relay may read its outlet's printers, read and update its outlet's print jobs,
-- read and update its own relay row, and append events for its outlet. Nothing else.
GRANT SELECT ON printers TO app_relay;
--> statement-breakpoint
GRANT SELECT, UPDATE ON print_jobs TO app_relay;
--> statement-breakpoint
GRANT SELECT, UPDATE ON print_relays TO app_relay;
--> statement-breakpoint
GRANT SELECT ON outlets, merchant_settings TO app_relay;
--> statement-breakpoint
GRANT INSERT, SELECT ON events TO app_relay;
--> statement-breakpoint
-- Relays send Idempotency-Key on their mutations like every other client.
GRANT SELECT, INSERT, UPDATE ON idempotency_keys TO app_relay;
--> statement-breakpoint
CREATE POLICY idempotency_keys_relay ON idempotency_keys FOR ALL TO app_relay USING (merchant_id = sail.merchant_id() AND principal_id = sail.principal_id()) WITH CHECK (merchant_id = sail.merchant_id() AND principal_id = sail.principal_id());
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON outlet_sequences TO app_relay;
--> statement-breakpoint
CREATE POLICY printers_relay ON printers FOR SELECT TO app_relay USING (merchant_id = sail.merchant_id() AND sail.outlet_allowed(outlet_id) AND archived_at IS NULL);
--> statement-breakpoint
CREATE POLICY print_jobs_relay ON print_jobs FOR ALL TO app_relay USING (merchant_id = sail.merchant_id() AND sail.outlet_allowed(outlet_id)) WITH CHECK (merchant_id = sail.merchant_id() AND sail.outlet_allowed(outlet_id));
--> statement-breakpoint
CREATE POLICY print_relays_relay ON print_relays FOR ALL TO app_relay USING (merchant_id = sail.merchant_id() AND id::text = sail.principal_id()) WITH CHECK (merchant_id = sail.merchant_id() AND id::text = sail.principal_id());
--> statement-breakpoint
CREATE POLICY outlets_relay ON outlets FOR SELECT TO app_relay USING (merchant_id = sail.merchant_id() AND sail.outlet_allowed(id));
--> statement-breakpoint
CREATE POLICY merchant_settings_relay ON merchant_settings FOR SELECT TO app_relay USING (merchant_id = sail.merchant_id());
--> statement-breakpoint
CREATE POLICY events_relay ON events FOR ALL TO app_relay USING (merchant_id = sail.merchant_id() AND sail.outlet_allowed(outlet_id)) WITH CHECK (merchant_id = sail.merchant_id() AND sail.outlet_allowed(outlet_id));
--> statement-breakpoint
CREATE POLICY outlet_sequences_relay ON outlet_sequences FOR ALL TO app_relay USING (merchant_id = sail.merchant_id() AND sail.outlet_allowed(outlet_id)) WITH CHECK (merchant_id = sail.merchant_id() AND sail.outlet_allowed(outlet_id));
--> statement-breakpoint
-- Signal print-job changes to relays (and stations, for the 10-second alert) when the transaction commits.
CREATE OR REPLACE FUNCTION sail.notify_print_job() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('sail_events', json_build_object(
    'kind', 'print_job',
    'merchant_id', NEW.merchant_id,
    'outlet_id', NEW.outlet_id,
    'job_id', NEW.id,
    'status', NEW.status,
    'printer_id', NEW.printer_id,
    'relay_hint', NULL
  )::text);
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER print_jobs_notify AFTER INSERT OR UPDATE OF status ON print_jobs FOR EACH ROW EXECUTE FUNCTION sail.notify_print_job();
--> statement-breakpoint
-- Job lifecycle guard: queued → claimed → printed | failed; queued | failed → rerouted; claimed → queued (stale re-queue).
CREATE OR REPLACE FUNCTION sail.print_job_transition_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, sail AS $$
BEGIN
  IF OLD.status = NEW.status THEN RETURN NEW; END IF;
  IF (OLD.status = 'queued' AND NEW.status IN ('claimed','rerouted','failed'))
     OR (OLD.status = 'claimed' AND NEW.status IN ('printed','failed','queued','rerouted'))
     OR (OLD.status = 'failed' AND NEW.status IN ('rerouted','queued')) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'print_job_transition: % -> % is not allowed', OLD.status, NEW.status USING ERRCODE = 'P0001';
END $$;
--> statement-breakpoint
CREATE TRIGGER print_jobs_transition BEFORE UPDATE OF status ON print_jobs FOR EACH ROW EXECUTE FUNCTION sail.print_job_transition_guard();
