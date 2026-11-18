-- Hand-written: an invoice issued for a bill that already has refunds is issued with a credit note for each of them
-- (review 5, V3). Refunds are immutable; the one change allowed is to give a refund that has no credit note its number
-- and document, once. Every other column, and any other change, is still refused.
CREATE OR REPLACE FUNCTION sail.forbid_refund_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.credit_note_no IS NULL AND NEW.credit_note_no IS NOT NULL AND NEW.credit_note_document IS NOT NULL
     AND (to_jsonb(NEW) - 'credit_note_no' - 'credit_note_document') = (to_jsonb(OLD) - 'credit_note_no' - 'credit_note_document') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'append_only: % rows cannot be changed or deleted', TG_TABLE_NAME USING ERRCODE = 'P0001';
END $$;--> statement-breakpoint
DROP TRIGGER "refunds_immutable" ON "refunds";--> statement-breakpoint
CREATE TRIGGER refunds_immutable BEFORE UPDATE OR DELETE ON refunds FOR EACH ROW EXECUTE FUNCTION sail.forbid_refund_change();
