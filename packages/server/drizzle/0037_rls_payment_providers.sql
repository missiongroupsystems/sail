-- Hand-written: RLS, grants and invariants for payment intents, the provider outbox, provider accounts and webhook events.
-- The webhook route and the worker write as the connection owner (no request principal); request roles see their merchant's rows.

--> statement-breakpoint
ALTER TABLE payment_intents ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY payment_intents_tenant ON payment_intents FOR ALL TO app_authenticated USING (merchant_id = sail.merchant_id() AND sail.outlet_allowed(outlet_id)) WITH CHECK (merchant_id = sail.merchant_id() AND sail.outlet_allowed(outlet_id));
--> statement-breakpoint
-- Agents read intents (to follow a payment they proposed); starting, cancelling and voiding run as the person who approved the proposal.
GRANT SELECT ON payment_intents TO app_agent;
--> statement-breakpoint
CREATE POLICY payment_intents_agent ON payment_intents FOR SELECT TO app_agent USING (merchant_id = sail.merchant_id() AND sail.outlet_allowed(outlet_id));
--> statement-breakpoint
ALTER TABLE payment_outbox ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY payment_outbox_tenant ON payment_outbox FOR ALL TO app_authenticated USING (merchant_id = sail.merchant_id()) WITH CHECK (merchant_id = sail.merchant_id());
--> statement-breakpoint
-- Provider accounts hold webhook secrets: Admins write them through the register; no agent grant at all.
ALTER TABLE payment_provider_accounts ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY payment_provider_accounts_tenant ON payment_provider_accounts FOR ALL TO app_authenticated USING (merchant_id = sail.merchant_id()) WITH CHECK (merchant_id = sail.merchant_id());
--> statement-breakpoint
-- Webhook events are written only by the webhook route as the owner; request roles may read their own.
ALTER TABLE payment_webhook_events ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE ON payment_webhook_events FROM app_authenticated;
--> statement-breakpoint
CREATE POLICY payment_webhook_events_tenant ON payment_webhook_events FOR SELECT TO app_authenticated USING (merchant_id = sail.merchant_id());
--> statement-breakpoint
-- Intents are never deleted; their history is the record of what the provider was asked to do.
CREATE TRIGGER payment_intents_no_delete BEFORE DELETE ON payment_intents FOR EACH ROW EXECUTE FUNCTION sail.forbid_change();
--> statement-breakpoint
ALTER TABLE payment_intents ADD CONSTRAINT payment_intents_amounts CHECK (amount > 0 AND tip_cents >= 0);
--> statement-breakpoint
ALTER TABLE payment_outbox ADD CONSTRAINT payment_outbox_kind CHECK (kind IN ('start', 'cancel', 'void'));
--> statement-breakpoint
-- A provider tender names its terminal, and is never cash.
ALTER TABLE tender_types ADD CONSTRAINT tender_types_provider_terminal CHECK ((provider IS NULL) = (terminal_id IS NULL) AND (provider IS NULL OR NOT is_cash));
