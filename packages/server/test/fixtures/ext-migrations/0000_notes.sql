-- A fixture extension, used only by test/ext-migrations.test.ts: the recipe in docs/how-to.md,
-- "Tables owned by an extension". The one-time grants come first, then a table with merchant_id and RLS.
CREATE SCHEMA IF NOT EXISTS ext_fixture;
--> statement-breakpoint
GRANT USAGE ON SCHEMA ext_fixture TO app_authenticated;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA ext_fixture GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_authenticated;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA ext_fixture GRANT USAGE, SELECT ON SEQUENCES TO app_authenticated;
--> statement-breakpoint
CREATE TABLE ext_fixture.notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id uuid NOT NULL REFERENCES public.merchants(id),
  body text NOT NULL
);
--> statement-breakpoint
ALTER TABLE ext_fixture.notes ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY notes_tenant ON ext_fixture.notes FOR ALL TO app_authenticated USING (merchant_id = sail.merchant_id()) WITH CHECK (merchant_id = sail.merchant_id());
