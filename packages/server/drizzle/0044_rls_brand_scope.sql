-- Hand-written: brand scope. A staff member or agent scoped to some brands sees and writes only rows of those brands
-- (an empty scope is every brand), the same way outlet scope works. The policies are RESTRICTIVE, so they narrow the
-- tenant policies instead of widening them. A row without a brand (a product shared by every brand) stays visible.

--> statement-breakpoint
CREATE OR REPLACE FUNCTION sail.brand_allowed(brand uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT brand IS NULL
      OR current_setting('app.current_brands', true) = '*'
      OR brand::text = ANY (string_to_array(coalesce(current_setting('app.current_brands', true), ''), ','))
$$;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION sail.brand_allowed(uuid) TO app_authenticated, app_guest, app_relay, app_agent;
--> statement-breakpoint
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['orders','channel_links','menus','pos_layouts','products','stations'] LOOP
    EXECUTE format('CREATE POLICY %I ON %I AS RESTRICTIVE FOR ALL TO app_authenticated, app_agent USING (sail.brand_allowed(brand_id)) WITH CHECK (sail.brand_allowed(brand_id))', t || '_brand_scope', t);
  END LOOP;
END $$;
