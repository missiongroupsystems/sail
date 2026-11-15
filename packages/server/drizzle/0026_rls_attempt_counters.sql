-- Hand-written: RLS for the wrong-PIN and guest rate-limit counters. The register writes them in its own
-- committed transaction as the connection owner (a refused request must still count), so request roles only read.

--> statement-breakpoint
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['pin_attempts','guest_rate_hits'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE INSERT, UPDATE, DELETE ON %I FROM app_authenticated', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR SELECT TO app_authenticated USING (merchant_id = sail.merchant_id())', t || '_tenant', t);
  END LOOP;
END $$;
