-- Hand-written: a record may only point at records of its own merchant.
-- Foreign keys check that the referenced row exists, and they bypass row-level security, so before this a table of
-- one merchant could name another merchant's area, product or outlet, and the answer told the caller that the id
-- existed. Now an id of another merchant fails exactly as an unknown id does (foreign_key_violation).

-- 1. Every foreign key between two tenant tables gets a twin on (column, merchant_id), with the same delete action,
-- so it holds whichever of the two fires first. The originals stay: the Drizzle schema owns them.
-- Rows that already point at another merchant keep the twin NOT VALID (new writes are still checked) and raise a
-- warning naming the table; fix those rows and VALIDATE the constraint.
--> statement-breakpoint
DO $$
DECLARE
  r record;
  uq text;
  fk text;
  action text;
BEGIN
  FOR r IN
    SELECT c.conrelid::regclass AS child, c.confrelid::regclass AS parent, a.attname AS col, pa.attname AS pcol, c.confdeltype AS del
    FROM pg_constraint c
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
    JOIN pg_attribute pa ON pa.attrelid = c.confrelid AND pa.attnum = c.confkey[1]
    WHERE c.contype = 'f' AND cardinality(c.conkey) = 1 AND c.connamespace = 'public'::regnamespace AND a.attname <> 'merchant_id'
      AND EXISTS (SELECT 1 FROM pg_attribute x WHERE x.attrelid = c.conrelid AND x.attname = 'merchant_id' AND NOT x.attisdropped)
      AND EXISTS (SELECT 1 FROM pg_attribute x WHERE x.attrelid = c.confrelid AND x.attname = 'merchant_id' AND NOT x.attisdropped)
    ORDER BY 1, 3
  LOOP
    uq := left(r.parent::text || '_' || r.pcol || '_merchant_uq', 63);
    IF to_regclass(uq) IS NULL THEN
      EXECUTE format('CREATE UNIQUE INDEX %I ON %s (%I, merchant_id)', uq, r.parent, r.pcol);
    END IF;
    fk := left(r.child::text || '_' || r.col || '_same_merchant', 63);
    action := CASE r.del WHEN 'c' THEN 'ON DELETE CASCADE' WHEN 'n' THEN format('ON DELETE SET NULL (%I)', r.col) ELSE '' END;
    EXECUTE format('ALTER TABLE %s ADD CONSTRAINT %I FOREIGN KEY (%I, merchant_id) REFERENCES %s (%I, merchant_id) %s NOT VALID', r.child, fk, r.col, r.parent, r.pcol, action);
    BEGIN
      EXECUTE format('ALTER TABLE %s VALIDATE CONSTRAINT %I', r.child, fk);
    EXCEPTION WHEN foreign_key_violation THEN
      RAISE WARNING '% has rows whose % belongs to another merchant: % checks new rows only until they are fixed and it is validated', r.child, r.col, fk;
    END;
  END LOOP;
END $$;
--> statement-breakpoint
-- 2. References without a foreign key (id arrays, and ids the schema never tied to a table): a trigger checks each
-- changed value against the named table and the row's own merchant. Arguments are pairs: column, table.
CREATE OR REPLACE FUNCTION sail.check_merchant_refs() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, sail, pg_temp AS $$
DECLARE
  i smallint := 0;
  col text;
  parent text;
  v jsonb;
  ids uuid[];
  missing uuid;
BEGIN
  WHILE i < TG_NARGS LOOP
    col := TG_ARGV[i];
    parent := TG_ARGV[i + 1];
    i := i + 2;
    v := to_jsonb(NEW) -> col;
    CONTINUE WHEN v IS NULL OR jsonb_typeof(v) = 'null';
    CONTINUE WHEN TG_OP = 'UPDATE' AND v = to_jsonb(OLD) -> col;
    IF jsonb_typeof(v) = 'array' THEN
      SELECT array_agg(x::uuid) INTO ids FROM jsonb_array_elements_text(v) AS x;
    ELSE
      ids := ARRAY[(v #>> '{}')::uuid];
    END IF;
    CONTINUE WHEN ids IS NULL;
    EXECUTE format('SELECT x FROM unnest($1) AS x WHERE NOT EXISTS (SELECT 1 FROM %I p WHERE p.id = x AND p.merchant_id = $2) LIMIT 1', parent) INTO missing USING ids, NEW.merchant_id;
    IF missing IS NOT NULL THEN
      RAISE EXCEPTION 'A referenced record does not exist' USING ERRCODE = 'foreign_key_violation', COLUMN = col, TABLE = TG_TABLE_NAME;
    END IF;
  END LOOP;
  RETURN NEW;
END $$;
--> statement-breakpoint
-- An availability rule's target is a product or a menu section, by target_kind.
CREATE OR REPLACE FUNCTION sail.check_availability_target() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, sail, pg_temp AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.target_id = OLD.target_id AND NEW.target_kind = OLD.target_kind THEN RETURN NEW; END IF;
  IF (NEW.target_kind = 'product' AND NOT EXISTS (SELECT 1 FROM products p WHERE p.id = NEW.target_id AND p.merchant_id = NEW.merchant_id))
     OR (NEW.target_kind = 'section' AND NOT EXISTS (SELECT 1 FROM menu_sections s WHERE s.id = NEW.target_id AND s.merchant_id = NEW.merchant_id)) THEN
    RAISE EXCEPTION 'A referenced record does not exist' USING ERRCODE = 'foreign_key_violation', COLUMN = 'target_id', TABLE = TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER staff_merchant_refs BEFORE INSERT OR UPDATE ON staff FOR EACH ROW EXECUTE FUNCTION sail.check_merchant_refs('outlet_ids', 'outlets', 'brand_ids', 'brands');
--> statement-breakpoint
CREATE TRIGGER agent_identities_merchant_refs BEFORE INSERT OR UPDATE ON agent_identities FOR EACH ROW EXECUTE FUNCTION sail.check_merchant_refs('outlet_ids', 'outlets', 'brand_ids', 'brands');
--> statement-breakpoint
CREATE TRIGGER availability_rules_merchant_refs BEFORE INSERT OR UPDATE ON availability_rules FOR EACH ROW EXECUTE FUNCTION sail.check_merchant_refs('outlet_ids', 'outlets');
--> statement-breakpoint
CREATE TRIGGER availability_rules_target BEFORE INSERT OR UPDATE ON availability_rules FOR EACH ROW EXECUTE FUNCTION sail.check_availability_target();
--> statement-breakpoint
CREATE TRIGGER stations_merchant_refs BEFORE INSERT OR UPDATE ON stations FOR EACH ROW EXECUTE FUNCTION sail.check_merchant_refs('layout_id', 'pos_layouts', 'receipt_printer_id', 'printers', 'display_destination_ids', 'display_destinations');
--> statement-breakpoint
CREATE TRIGGER channel_links_merchant_refs BEFORE INSERT OR UPDATE ON channel_links FOR EACH ROW EXECUTE FUNCTION sail.check_merchant_refs('service_request_printer_id', 'printers');
--> statement-breakpoint
CREATE TRIGGER printers_merchant_refs BEFORE INSERT OR UPDATE ON printers FOR EACH ROW EXECUTE FUNCTION sail.check_merchant_refs('backup_printer_id', 'printers');
--> statement-breakpoint
CREATE TRIGGER menu_sections_merchant_refs BEFORE INSERT OR UPDATE ON menu_sections FOR EACH ROW EXECUTE FUNCTION sail.check_merchant_refs('parent_id', 'menu_sections');
--> statement-breakpoint
CREATE TRIGGER report_categories_merchant_refs BEFORE INSERT OR UPDATE ON report_categories FOR EACH ROW EXECUTE FUNCTION sail.check_merchant_refs('parent_id', 'report_categories');
