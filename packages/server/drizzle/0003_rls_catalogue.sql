-- Hand-written: RLS for the catalogue, menus, channels, floor, reference lists, customers, pricing rules and imports.
-- Merchant-scoped tables get the tenant policy; outlet-bound tables also check sail.outlet_allowed(outlet_id).

--> statement-breakpoint
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'report_categories','products','product_prices','modifier_groups','modifier_options','product_modifier_groups',
    'menus','menu_sections','menu_items','availability_rules','tender_types','void_reasons','pos_layouts',
    'customers','customer_groups','customer_group_members','pricing_rules','import_jobs'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR ALL TO app_authenticated USING (merchant_id = sail.merchant_id()) WITH CHECK (merchant_id = sail.merchant_id())', t || '_tenant', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['stock_status','channel_links','areas','tables'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR ALL TO app_authenticated USING (merchant_id = sail.merchant_id() AND sail.outlet_allowed(outlet_id)) WITH CHECK (merchant_id = sail.merchant_id() AND sail.outlet_allowed(outlet_id))', t || '_tenant', t);
  END LOOP;
END $$;
--> statement-breakpoint
-- Pricing-rule versions are immutable once created; only status, archived_at and note may change.
CREATE OR REPLACE FUNCTION sail.pricing_rules_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.body IS DISTINCT FROM OLD.body OR NEW.effective_from IS DISTINCT FROM OLD.effective_from OR NEW.rule_key IS DISTINCT FROM OLD.rule_key OR NEW.version IS DISTINCT FROM OLD.version THEN
    RAISE EXCEPTION 'pricing_rule_version_immutable: create a new version instead of editing one' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER pricing_rules_immutable BEFORE UPDATE ON pricing_rules FOR EACH ROW EXECUTE FUNCTION sail.pricing_rules_guard();
--> statement-breakpoint
-- Daily caps never go below zero.
ALTER TABLE stock_status ADD CONSTRAINT stock_cap_remaining_nonneg CHECK (cap_remaining IS NULL OR cap_remaining >= 0);
--> statement-breakpoint
-- Modifier groups nest at most two levels: a child group's options may not themselves have children.
CREATE OR REPLACE FUNCTION sail.modifier_nesting_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.child_group_id IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM modifier_options o WHERE o.group_id = NEW.child_group_id AND o.child_group_id IS NOT NULL) THEN
      RAISE EXCEPTION 'modifier_nesting_depth: modifier groups nest at most 2 levels' USING ERRCODE = 'P0001';
    END IF;
    IF EXISTS (SELECT 1 FROM modifier_options o WHERE o.child_group_id = NEW.group_id) THEN
      RAISE EXCEPTION 'modifier_nesting_depth: modifier groups nest at most 2 levels' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER modifier_options_nesting BEFORE INSERT OR UPDATE ON modifier_options FOR EACH ROW EXECUTE FUNCTION sail.modifier_nesting_guard();
