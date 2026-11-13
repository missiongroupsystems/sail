-- Hand-written: report categories are two levels deep, a category and its parent, because reports and pricing rules read
-- exactly a line's category and its parent. Before this the API took a category under itself, a cycle, or a third
-- level, and the back office then hid it. SQLSTATE SL400 is a refusal written for people (app.ts shows its message).
--> statement-breakpoint
CREATE OR REPLACE FUNCTION sail.check_category_nesting() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, sail, pg_temp AS $$
BEGIN
  IF NEW.parent_id IS NULL OR (TG_OP = 'UPDATE' AND NEW.parent_id IS NOT DISTINCT FROM OLD.parent_id) THEN RETURN NEW; END IF;
  IF NEW.parent_id = NEW.id THEN
    RAISE EXCEPTION 'A category cannot sit under itself' USING ERRCODE = 'SL400';
  END IF;
  IF EXISTS (SELECT 1 FROM report_categories p WHERE p.id = NEW.parent_id AND p.parent_id IS NOT NULL) THEN
    RAISE EXCEPTION 'A category can only sit under a top-level category' USING ERRCODE = 'SL400';
  END IF;
  IF EXISTS (SELECT 1 FROM report_categories c WHERE c.parent_id = NEW.id) THEN
    RAISE EXCEPTION 'A category with sub-categories cannot sit under another one' USING ERRCODE = 'SL400';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER report_categories_nesting BEFORE INSERT OR UPDATE OF parent_id ON report_categories FOR EACH ROW EXECUTE FUNCTION sail.check_category_nesting();
--> statement-breakpoint
-- The modifier nesting guard (0003) is reachable from modifier_groups.update, so its refusal is said for people too.
CREATE OR REPLACE FUNCTION sail.modifier_nesting_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.child_group_id IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM modifier_options o WHERE o.group_id = NEW.child_group_id AND o.child_group_id IS NOT NULL)
       OR EXISTS (SELECT 1 FROM modifier_options o WHERE o.child_group_id = NEW.group_id) THEN
      RAISE EXCEPTION 'Modifier groups nest at most 2 levels: a group an option opens cannot open another' USING ERRCODE = 'SL400';
    END IF;
  END IF;
  RETURN NEW;
END $$;
