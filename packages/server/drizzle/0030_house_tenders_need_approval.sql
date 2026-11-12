-- Hand-written: tenders that are neither cash nor a card terminal (house accounts, "invoice to", vouchers) settle a bill
-- with nothing else verifying the money, so existing ones start out needing a Manager's approval, as new ones do.
UPDATE tender_types SET requires_approval = true WHERE NOT is_cash AND NOT is_terminal;
