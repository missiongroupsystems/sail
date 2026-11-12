-- Hand-written: delegation grants are minted by the person delegating (app_authenticated) and redeemed by the
-- connection owner when an agent session starts. No agent grant at all: a grant is a secret.

--> statement-breakpoint
ALTER TABLE agent_delegations ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY agent_delegations_tenant ON agent_delegations FOR INSERT TO app_authenticated WITH CHECK (merchant_id = sail.merchant_id() AND person->>'principal_id' = sail.principal_id());
--> statement-breakpoint
REVOKE SELECT, UPDATE, DELETE ON agent_delegations FROM app_authenticated;
