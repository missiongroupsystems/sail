-- Hand-written: a guest reads every round on the order its session is bound to, not only its own,
-- so a second phone at the table files the first phone's lines under their guest round.
-- `mine` in the guest view still tells the caller's rounds apart; service requests stay per session.

--> statement-breakpoint
DROP POLICY guest_rounds_guest ON guest_rounds;
--> statement-breakpoint
CREATE POLICY guest_rounds_guest ON guest_rounds FOR SELECT TO app_guest
  USING (merchant_id = sail.merchant_id() AND (guest_session_id::text = sail.principal_id() OR order_id::text = sail.current_order()));
