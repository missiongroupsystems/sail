-- Hand-written migration: roles, grants, RLS, helper functions and triggers.
-- Generated migrations never touch these; later phases add their own hand-written files.

--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_authenticated') THEN CREATE ROLE app_authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_guest') THEN CREATE ROLE app_guest NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_relay') THEN CREATE ROLE app_relay NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_agent') THEN CREATE ROLE app_agent NOLOGIN; END IF;
END $$;
--> statement-breakpoint
-- The connection user must be able to SET LOCAL ROLE to the app roles.
DO $$
BEGIN
  EXECUTE format('GRANT app_authenticated, app_guest, app_relay, app_agent TO %I', current_user);
END $$;
--> statement-breakpoint
CREATE SCHEMA IF NOT EXISTS sail;
--> statement-breakpoint
-- The merchant of the current request, from set_config('app.current_merchant').
CREATE OR REPLACE FUNCTION sail.merchant_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.current_merchant', true), '')::uuid
$$;
--> statement-breakpoint
-- Outlet scoping: '*' means every outlet of the merchant; otherwise a comma-separated list of outlet IDs.
CREATE OR REPLACE FUNCTION sail.outlet_allowed(outlet uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT outlet IS NULL
      OR current_setting('app.current_outlets', true) = '*'
      OR outlet::text = ANY (string_to_array(coalesce(current_setting('app.current_outlets', true), ''), ','))
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION sail.principal_type() RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT coalesce(current_setting('app.current_principal_type', true), '')
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION sail.principal_id() RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT coalesce(current_setting('app.current_principal', true), '')
$$;
--> statement-breakpoint
GRANT USAGE ON SCHEMA sail TO app_authenticated, app_guest, app_relay, app_agent;
--> statement-breakpoint
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA sail TO app_authenticated, app_guest, app_relay, app_agent;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA sail GRANT EXECUTE ON FUNCTIONS TO app_authenticated, app_guest, app_relay, app_agent;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO app_authenticated, app_guest, app_relay, app_agent;
--> statement-breakpoint
-- Staff and stations: full access to the merchant's rows, limited by RLS below.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_authenticated;
--> statement-breakpoint
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_authenticated;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_authenticated;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO app_authenticated;
--> statement-breakpoint
-- The event log and the audit log are append-only for every app role.
REVOKE UPDATE, DELETE ON events, audit_log FROM app_authenticated;
--> statement-breakpoint
-- Row-level security: tenancy on every table, outlet scoping where an outlet applies.
ALTER TABLE merchants ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY merchants_tenant ON merchants FOR ALL TO app_authenticated USING (id = sail.merchant_id()) WITH CHECK (id = sail.merchant_id());
--> statement-breakpoint
ALTER TABLE merchant_settings ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY merchant_settings_tenant ON merchant_settings FOR ALL TO app_authenticated USING (merchant_id = sail.merchant_id()) WITH CHECK (merchant_id = sail.merchant_id());
--> statement-breakpoint
ALTER TABLE brands ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY brands_tenant ON brands FOR ALL TO app_authenticated USING (merchant_id = sail.merchant_id()) WITH CHECK (merchant_id = sail.merchant_id());
--> statement-breakpoint
ALTER TABLE outlets ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY outlets_tenant ON outlets FOR ALL TO app_authenticated
  USING (merchant_id = sail.merchant_id() AND sail.outlet_allowed(id))
  WITH CHECK (merchant_id = sail.merchant_id());
--> statement-breakpoint
ALTER TABLE stations ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY stations_tenant ON stations FOR ALL TO app_authenticated
  USING (merchant_id = sail.merchant_id() AND sail.outlet_allowed(outlet_id))
  WITH CHECK (merchant_id = sail.merchant_id() AND sail.outlet_allowed(outlet_id));
--> statement-breakpoint
ALTER TABLE staff ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY staff_tenant ON staff FOR ALL TO app_authenticated USING (merchant_id = sail.merchant_id()) WITH CHECK (merchant_id = sail.merchant_id());
--> statement-breakpoint
ALTER TABLE staff_sessions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY staff_sessions_tenant ON staff_sessions FOR ALL TO app_authenticated
  USING (merchant_id = sail.merchant_id() AND sail.outlet_allowed(outlet_id))
  WITH CHECK (merchant_id = sail.merchant_id() AND sail.outlet_allowed(outlet_id));
--> statement-breakpoint
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY audit_log_tenant ON audit_log FOR ALL TO app_authenticated USING (merchant_id = sail.merchant_id()) WITH CHECK (merchant_id = sail.merchant_id());
--> statement-breakpoint
ALTER TABLE events ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY events_tenant ON events FOR ALL TO app_authenticated
  USING (merchant_id = sail.merchant_id() AND sail.outlet_allowed(outlet_id))
  WITH CHECK (merchant_id = sail.merchant_id() AND sail.outlet_allowed(outlet_id));
--> statement-breakpoint
ALTER TABLE outlet_sequences ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY outlet_sequences_tenant ON outlet_sequences FOR ALL TO app_authenticated
  USING (merchant_id = sail.merchant_id() AND sail.outlet_allowed(outlet_id))
  WITH CHECK (merchant_id = sail.merchant_id() AND sail.outlet_allowed(outlet_id));
--> statement-breakpoint
ALTER TABLE merchant_sequences ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY merchant_sequences_tenant ON merchant_sequences FOR ALL TO app_authenticated USING (merchant_id = sail.merchant_id()) WITH CHECK (merchant_id = sail.merchant_id());
--> statement-breakpoint
ALTER TABLE idempotency_keys ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY idempotency_keys_principal ON idempotency_keys FOR ALL TO app_authenticated
  USING (merchant_id = sail.merchant_id() AND principal_id = sail.principal_id())
  WITH CHECK (merchant_id = sail.merchant_id() AND principal_id = sail.principal_id());
--> statement-breakpoint
-- Live updates: signal new events to the API's LISTEN connection when the transaction commits.
CREATE OR REPLACE FUNCTION sail.notify_event() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('sail_events', json_build_object(
    'kind', 'event',
    'merchant_id', NEW.merchant_id,
    'outlet_id', NEW.outlet_id,
    'seq', NEW.seq,
    'type', NEW.type,
    'aggregate_kind', NEW.aggregate_kind,
    'aggregate_id', NEW.aggregate_id
  )::text);
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER events_notify AFTER INSERT ON events FOR EACH ROW EXECUTE FUNCTION sail.notify_event();
--> statement-breakpoint
-- Events are immutable: no role may update or delete them, including the owner through the API.
CREATE OR REPLACE FUNCTION sail.forbid_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'append_only: % rows cannot be changed or deleted', TG_TABLE_NAME USING ERRCODE = 'P0001';
END $$;
--> statement-breakpoint
CREATE TRIGGER events_append_only BEFORE UPDATE OR DELETE ON events FOR EACH ROW EXECUTE FUNCTION sail.forbid_change();
--> statement-breakpoint
CREATE TRIGGER audit_log_append_only BEFORE UPDATE OR DELETE ON audit_log FOR EACH ROW EXECUTE FUNCTION sail.forbid_change();
