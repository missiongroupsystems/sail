-- Written by hand after drizzle-kit generated 0000 (drizzle-kit generate --custom): the recipe in docs/extensions.md,
-- "Migrations". Grants for the tables and sequences 0000 made, default grants for later ones (staff only), the agent's
-- grants table by table, then RLS and the outlet's brand on each table.
GRANT USAGE ON SCHEMA ext_fixture TO app_authenticated, app_agent;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ext_fixture TO app_authenticated;
--> statement-breakpoint
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA ext_fixture TO app_authenticated, app_agent;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA ext_fixture GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_authenticated;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA ext_fixture GRANT USAGE, SELECT ON SEQUENCES TO app_authenticated;
--> statement-breakpoint
-- Agents, as Sail's 0017: named columns without the contact column, and only the writes their operations need.
GRANT SELECT (id, merchant_id, outlet_id, brand_id, number, body), INSERT ON ext_fixture.notes TO app_agent;
--> statement-breakpoint
ALTER TABLE ext_fixture.notes ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
-- The merchant and the caller's outlets, as Sail's own outlet tables.
CREATE POLICY notes_tenant ON ext_fixture.notes FOR ALL TO app_authenticated, app_agent
  USING (merchant_id = sail.merchant_id() AND sail.outlet_allowed(outlet_id))
  WITH CHECK (merchant_id = sail.merchant_id() AND sail.outlet_allowed(outlet_id));
--> statement-breakpoint
-- Brand scope narrows it (RESTRICTIVE), as Sail's 0044 does: staff or an agent limited to some brands see only those.
CREATE POLICY notes_brand_scope ON ext_fixture.notes AS RESTRICTIVE FOR ALL TO app_authenticated, app_agent
  USING (sail.brand_allowed(brand_id))
  WITH CHECK (sail.brand_allowed(brand_id));
--> statement-breakpoint
-- A row's brand is its outlet's (none or another is refused), with Sail's own trigger function, as Sail's 0057 does for
-- stations, channel links and orders.
CREATE TRIGGER notes_outlet_brand BEFORE INSERT OR UPDATE OF brand_id, outlet_id ON ext_fixture.notes
  FOR EACH ROW EXECUTE FUNCTION sail.check_outlet_brand();
