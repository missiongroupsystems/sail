-- Hand-written: RLS for agent identities, sessions and proposals, and the narrow app_agent role (vision 7.2, 11).
-- app_agent reaches the same tables as a station through the same operations, but:
--   * no grants at all on token, pairing, PIN-session and credential tables;
--   * no access to PIN hashes, token hashes, auth subjects or raw customer contact columns (column-level grants);
--   * no writes to configuration tables (catalogue, pricing, org, staff, printers), only to operational ones.

--> statement-breakpoint
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['agent_identities','agent_sessions','proposals'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
  END LOOP;
  CREATE POLICY agent_identities_tenant ON agent_identities FOR ALL TO app_authenticated USING (merchant_id = sail.merchant_id()) WITH CHECK (merchant_id = sail.merchant_id());
  CREATE POLICY agent_sessions_tenant ON agent_sessions FOR ALL TO app_authenticated USING (merchant_id = sail.merchant_id()) WITH CHECK (merchant_id = sail.merchant_id());
  CREATE POLICY proposals_tenant ON proposals FOR ALL TO app_authenticated USING (merchant_id = sail.merchant_id() AND sail.outlet_allowed(outlet_id)) WITH CHECK (merchant_id = sail.merchant_id() AND sail.outlet_allowed(outlet_id));
END $$;
--> statement-breakpoint
-- Grants for app_agent: generic over every tenant table, with deny and sensitive-column lists.
DO $$
DECLARE
  t text;
  cols text;
  deny text[] := ARRAY['staff_sessions','station_pairing_codes','relay_pairing_codes','table_qr_tokens','guest_sessions','agent_sessions','digital_receipts','import_jobs'];
  sensitive text[] := ARRAY['pin_hash','pin_lookup','pin_failed_attempts','pin_locked_until','auth_subject','token_hash','credential_hash','mobile','email'];
  writable text[] := ARRAY['orders','order_lines','order_adjustments','order_adjustment_lines','order_manual_applications','checks','check_allocations','payments','shifts','business_day_closes','document_sequences','outlet_sequences','merchant_sequences','events','audit_log','idempotency_keys','print_jobs','stock_status','guest_rounds','service_requests','proposals','tables'];
BEGIN
  FOR t IN SELECT p.tablename FROM pg_tables p WHERE p.schemaname = 'public' AND EXISTS (SELECT 1 FROM information_schema.columns c WHERE c.table_schema = 'public' AND c.table_name = p.tablename AND c.column_name = 'merchant_id') LOOP
    CONTINUE WHEN t = ANY (deny);
    IF EXISTS (SELECT 1 FROM information_schema.columns c WHERE c.table_schema = 'public' AND c.table_name = t AND c.column_name = ANY (sensitive)) THEN
      SELECT string_agg(format('%I', c.column_name), ', ') INTO cols FROM information_schema.columns c WHERE c.table_schema = 'public' AND c.table_name = t AND NOT (c.column_name = ANY (sensitive));
      EXECUTE format('GRANT SELECT (%s) ON %I TO app_agent', cols, t);
    ELSE
      EXECUTE format('GRANT SELECT ON %I TO app_agent', t);
    END IF;
    IF t = ANY (writable) THEN
      EXECUTE format('GRANT INSERT, UPDATE ON %I TO app_agent', t);
    END IF;
    -- Re-pricing replaces adjustments and allocations; unsplit removes bills. Nothing else is ever deleted by an agent.
    IF t IN ('order_adjustments','order_adjustment_lines','check_allocations','checks') THEN
      EXECUTE format('GRANT DELETE ON %I TO app_agent', t);
    END IF;
    -- Tenant policy mirroring app_authenticated (idempotency keys are per principal, handled below).
    IF t <> 'idempotency_keys' THEN
      IF EXISTS (SELECT 1 FROM information_schema.columns c WHERE c.table_schema = 'public' AND c.table_name = t AND c.column_name = 'outlet_id') THEN
        EXECUTE format('CREATE POLICY %I ON %I FOR ALL TO app_agent USING (merchant_id = sail.merchant_id() AND sail.outlet_allowed(outlet_id)) WITH CHECK (merchant_id = sail.merchant_id() AND sail.outlet_allowed(outlet_id))', t || '_agent', t);
      ELSE
        EXECUTE format('CREATE POLICY %I ON %I FOR ALL TO app_agent USING (merchant_id = sail.merchant_id()) WITH CHECK (merchant_id = sail.merchant_id())', t || '_agent', t);
      END IF;
    END IF;
  END LOOP;
  GRANT SELECT ON merchants TO app_agent;
  CREATE POLICY merchants_agent ON merchants FOR SELECT TO app_agent USING (id = sail.merchant_id());
  CREATE POLICY idempotency_keys_agent ON idempotency_keys FOR ALL TO app_agent USING (merchant_id = sail.merchant_id() AND principal_id = sail.principal_id()) WITH CHECK (merchant_id = sail.merchant_id() AND principal_id = sail.principal_id());
END $$;
--> statement-breakpoint
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_agent;
