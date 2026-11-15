-- One-time setup of an empty Supabase project for Sail, run as `postgres` before the first migration. Safe to run again.
--
-- The migrations need nothing more than Supabase's `postgres` already has: it is not a superuser, but it has CREATEROLE
-- (migration 0001 creates the NOLOGIN roles app_authenticated, app_guest, app_relay and app_agent and grants them to
-- itself, so it can SET LOCAL ROLE to them) and it owns what it creates (the SECURITY DEFINER trigger functions, the
-- security_invoker report views, row-level security on every table). No extension is needed.
--
-- What this file does is keep Supabase's Data API roles away from Sail's tables. Sail never uses the Data API, and
-- Supabase's default privileges would otherwise grant anon, authenticated and service_role every right on each table
-- Sail creates in `public`. Row-level security already gives anon and authenticated no rows, but service_role
-- bypasses it, and table names would still show in the API's schema.

DO $$
BEGIN
  IF NOT (SELECT rolcreaterole FROM pg_roles WHERE rolname = current_user) THEN
    RAISE EXCEPTION 'role % cannot create roles; run this, and the migrations, as the project''s postgres role', current_user;
  END IF;
END $$;

ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM anon, authenticated, service_role;
-- For a database that was migrated before this file ran.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon, authenticated, service_role;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated, service_role;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM anon, authenticated, service_role;
