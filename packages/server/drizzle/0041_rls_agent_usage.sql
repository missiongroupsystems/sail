-- Hand-written: agent budget counters are written only by the connection owner (they must commit even when the
-- request is refused); staff may read their merchant's. No agent grant.

--> statement-breakpoint
ALTER TABLE agent_usage ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY agent_usage_tenant ON agent_usage FOR SELECT TO app_authenticated USING (merchant_id = sail.merchant_id());
--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE ON agent_usage FROM app_authenticated;
