-- Hand-written: brand scope for rows that belong to an order but carry no brand of their own (lines, bills, payments,
-- refunds, print jobs, kitchen tickets, rounds, requests, proposals, payment intents) and for events about an order.
-- Each is visible only when its order is, so the orders policy from 0044 decides. Unscoped callers ('*') skip the lookup.

--> statement-breakpoint
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['order_adjustments','order_lines','order_manual_applications','print_jobs','checks','payments','refunds','guest_rounds','service_requests','proposals','kitchen_tickets','payment_intents'] LOOP
    EXECUTE format('CREATE POLICY %I ON %I AS RESTRICTIVE FOR ALL TO app_authenticated, app_agent USING (current_setting(''app.current_brands'', true) = ''*'' OR order_id IS NULL OR EXISTS (SELECT 1 FROM orders o WHERE o.id = order_id)) WITH CHECK (current_setting(''app.current_brands'', true) = ''*'' OR order_id IS NULL OR EXISTS (SELECT 1 FROM orders o WHERE o.id = order_id))', t || '_brand_scope', t);
  END LOOP;
  -- An event is about an order when the order is its aggregate or its payload names one (print jobs, tables, rounds).
  CREATE OR REPLACE FUNCTION sail.event_order_visible(kind text, aggregate uuid, payload jsonb) RETURNS boolean
  LANGUAGE sql STABLE AS $f$
    SELECT current_setting('app.current_brands', true) = '*'
        OR ((kind <> 'order' OR EXISTS (SELECT 1 FROM orders o WHERE o.id = aggregate))
            AND (coalesce(payload->>'order_id', '') !~ '^[0-9a-f-]{36}$' OR EXISTS (SELECT 1 FROM orders o WHERE o.id = (payload->>'order_id')::uuid)))
  $f$;
  GRANT EXECUTE ON FUNCTION sail.event_order_visible(text, uuid, jsonb) TO app_authenticated, app_agent;
  CREATE POLICY events_brand_scope ON events AS RESTRICTIVE FOR ALL TO app_authenticated, app_agent
    USING (sail.event_order_visible(aggregate_kind, aggregate_id, payload)) WITH CHECK (sail.event_order_visible(aggregate_kind, aggregate_id, payload));
END $$;
