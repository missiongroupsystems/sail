-- Hand-written: RLS for Scan to Order tables and the narrow app_guest role.
-- A guest token can read the channel's menu and its own table's order, rounds and requests. Nothing else.
-- Guest writes (rounds, requests) are performed by the register as a system actor after validation under the guest token.

--> statement-breakpoint
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['table_qr_tokens','guest_sessions','guest_rounds','service_requests'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR ALL TO app_authenticated USING (merchant_id = sail.merchant_id() AND sail.outlet_allowed(outlet_id)) WITH CHECK (merchant_id = sail.merchant_id() AND sail.outlet_allowed(outlet_id))', t || '_tenant', t);
  END LOOP;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION sail.current_order() RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT coalesce(current_setting('app.current_order', true), '')
$$;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION sail.current_order() TO app_authenticated, app_guest, app_relay, app_agent;
--> statement-breakpoint
-- Catalogue reads for guests (the compiled menu).
GRANT SELECT ON brands, outlets, merchant_settings, products, product_prices, modifier_groups, modifier_options, product_modifier_groups, menus, menu_sections, menu_items, availability_rules, stock_status, channel_links, report_categories, tables TO app_guest;
--> statement-breakpoint
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['merchant_settings','products','product_prices','modifier_groups','modifier_options','product_modifier_groups','menus','menu_sections','menu_items','availability_rules','report_categories','brands'] LOOP
    EXECUTE format('CREATE POLICY %I ON %I FOR SELECT TO app_guest USING (merchant_id = sail.merchant_id())', t || '_guest', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['stock_status','channel_links','tables'] LOOP
    EXECUTE format('CREATE POLICY %I ON %I FOR SELECT TO app_guest USING (merchant_id = sail.merchant_id() AND sail.outlet_allowed(outlet_id))', t || '_guest', t);
  END LOOP;
  CREATE POLICY outlets_guest ON outlets FOR SELECT TO app_guest USING (merchant_id = sail.merchant_id() AND sail.outlet_allowed(id));
END $$;
--> statement-breakpoint
-- Own order, own rounds, own requests, own session.
GRANT SELECT ON orders, order_lines, guest_rounds, service_requests, guest_sessions TO app_guest;
--> statement-breakpoint
CREATE POLICY orders_guest ON orders FOR SELECT TO app_guest USING (merchant_id = sail.merchant_id() AND id::text = sail.current_order());
--> statement-breakpoint
CREATE POLICY order_lines_guest ON order_lines FOR SELECT TO app_guest USING (merchant_id = sail.merchant_id() AND order_id::text = sail.current_order());
--> statement-breakpoint
CREATE POLICY guest_rounds_guest ON guest_rounds FOR SELECT TO app_guest USING (merchant_id = sail.merchant_id() AND guest_session_id::text = sail.principal_id());
--> statement-breakpoint
CREATE POLICY service_requests_guest ON service_requests FOR SELECT TO app_guest USING (merchant_id = sail.merchant_id() AND guest_session_id::text = sail.principal_id());
--> statement-breakpoint
CREATE POLICY guest_sessions_guest ON guest_sessions FOR SELECT TO app_guest USING (merchant_id = sail.merchant_id() AND id::text = sail.principal_id());
--> statement-breakpoint
-- Guests send Idempotency-Key on their mutations like every other client.
GRANT SELECT, INSERT, UPDATE ON idempotency_keys TO app_guest;
--> statement-breakpoint
CREATE POLICY idempotency_keys_guest ON idempotency_keys FOR ALL TO app_guest USING (merchant_id = sail.merchant_id() AND principal_id = sail.principal_id()) WITH CHECK (merchant_id = sail.merchant_id() AND principal_id = sail.principal_id());
--> statement-breakpoint
-- The connection user already holds app_authenticated, so the register can act as the system for a validated guest request.
GRANT SELECT ON events TO app_guest;
--> statement-breakpoint
CREATE POLICY events_guest ON events FOR SELECT TO app_guest USING (merchant_id = sail.merchant_id() AND aggregate_kind = 'order' AND aggregate_id::text = sail.current_order());
