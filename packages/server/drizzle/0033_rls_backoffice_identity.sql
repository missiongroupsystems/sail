-- Hand-written: RLS for back-office sign-in. Tenancy as everywhere; app_agent, app_guest and app_relay get no grants at all.
-- Request roles never read or write password hashes: sign-in, link acceptance and password change verify and write them
-- as the connection owner.

--> statement-breakpoint
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['backoffice_logins','backoffice_sessions','backoffice_links'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR ALL TO app_authenticated USING (merchant_id = sail.merchant_id()) WITH CHECK (merchant_id = sail.merchant_id())', t || '_tenant', t);
  END LOOP;
END $$;
--> statement-breakpoint
REVOKE ALL ON backoffice_logins FROM app_authenticated;
--> statement-breakpoint
GRANT SELECT (staff_id, merchant_id, email, password_changed_at, created_at), INSERT (staff_id, merchant_id, email), DELETE ON backoffice_logins TO app_authenticated;
--> statement-breakpoint
ALTER TABLE backoffice_logins ADD CONSTRAINT backoffice_logins_email_lower CHECK (email = lower(email));
--> statement-breakpoint
ALTER TABLE backoffice_links ADD CONSTRAINT backoffice_links_kind CHECK (kind IN ('invite', 'reset'));
