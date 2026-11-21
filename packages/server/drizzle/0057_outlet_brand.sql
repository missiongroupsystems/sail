-- An outlet belongs to exactly one brand. The column and its constraints are the generated part; the rest is
-- hand-written: the backfill, the brand of the stations under each outlet, row-level security and the trigger that
-- keeps a station, a channel link and a new order on their outlet's brand.

-- 1. The column, empty at first so that existing outlets can be given their brand.
ALTER TABLE "outlets" ADD COLUMN "brand_id" uuid;
--> statement-breakpoint
-- 2. Each outlet's brand, from what the outlet already has, in this order:
--      a. the brand of its channel links;
--      b. else the brand of its stations;
--      c. else the brand most of its orders carry;
--      d. else the merchant's only brand (its only brand that is not archived, when there are archived ones).
--    When the rows that decide name two brands (links or stations of two brands, or two brands level on orders), or
--    nothing decides, the migration stops and names the outlets: it never guesses. The one exception is an archived
--    outlet with nothing under it, which nobody trades from: it takes the merchant's oldest brand.
DO $$
DECLARE
  problems text;
  summary text;
BEGIN
  CREATE TEMP TABLE outlet_brand_choice ON COMMIT DROP AS
  WITH link AS (
    SELECT outlet_id, count(DISTINCT brand_id) AS brands, min(brand_id::text)::uuid AS brand_id FROM channel_links GROUP BY outlet_id
  ), station AS (
    SELECT outlet_id, count(DISTINCT brand_id) AS brands, min(brand_id::text)::uuid AS brand_id FROM stations WHERE brand_id IS NOT NULL GROUP BY outlet_id
  ), order_counts AS (
    SELECT outlet_id, brand_id, count(*) AS n FROM orders GROUP BY outlet_id, brand_id
  ), order_top AS (
    SELECT outlet_id, count(*) AS brands, min(brand_id::text)::uuid AS brand_id
    FROM (SELECT outlet_id, brand_id, n, max(n) OVER (PARTITION BY outlet_id) AS top FROM order_counts) c
    WHERE n = top GROUP BY outlet_id
  ), merchant_brand AS (
    SELECT merchant_id,
      count(*) AS brands,
      count(*) FILTER (WHERE archived_at IS NULL) AS live,
      (array_agg(id ORDER BY created_at, id))[1] AS oldest,
      (array_agg(id ORDER BY created_at, id) FILTER (WHERE archived_at IS NULL))[1] AS oldest_live
    FROM brands GROUP BY merchant_id
  )
  SELECT o.id AS outlet_id, o.merchant_id, o.name,
    CASE
      WHEN link.brands IS NOT NULL THEN 'its channel links'
      WHEN station.brands IS NOT NULL THEN 'its stations'
      WHEN order_top.brands IS NOT NULL THEN 'its orders'
      WHEN mb.live = 1 OR mb.brands = 1 THEN 'the merchant''s only brand'
      WHEN o.archived_at IS NOT NULL AND mb.brands > 0 THEN 'archived and empty: the merchant''s oldest brand'
      ELSE 'nothing'
    END AS decided_by,
    CASE
      WHEN link.brands IS NOT NULL THEN CASE WHEN link.brands = 1 THEN link.brand_id END
      WHEN station.brands IS NOT NULL THEN CASE WHEN station.brands = 1 THEN station.brand_id END
      WHEN order_top.brands IS NOT NULL THEN CASE WHEN order_top.brands = 1 THEN order_top.brand_id END
      WHEN mb.live = 1 THEN mb.oldest_live
      WHEN mb.brands = 1 THEN mb.oldest
      WHEN o.archived_at IS NOT NULL THEN mb.oldest
    END AS brand_id,
    CASE
      WHEN link.brands > 1 THEN 'its channel links name ' || link.brands || ' brands'
      WHEN link.brands IS NULL AND station.brands > 1 THEN 'its stations name ' || station.brands || ' brands'
      WHEN link.brands IS NULL AND station.brands IS NULL AND order_top.brands > 1 THEN 'its orders are level between ' || order_top.brands || ' brands'
      WHEN mb.brands IS NULL THEN 'the merchant has no brand'
      ELSE 'it has no channel link, station or order, and the merchant has ' || mb.brands || ' brands'
    END AS why_not
  FROM outlets o
  LEFT JOIN link ON link.outlet_id = o.id
  LEFT JOIN station ON station.outlet_id = o.id
  LEFT JOIN order_top ON order_top.outlet_id = o.id
  LEFT JOIN merchant_brand mb ON mb.merchant_id = o.merchant_id;

  SELECT string_agg(format('  %s (outlet %s, merchant %s): %s', name, outlet_id, merchant_id, why_not), E'\n' ORDER BY merchant_id, name)
    INTO problems FROM outlet_brand_choice WHERE brand_id IS NULL;
  IF problems IS NOT NULL THEN
    RAISE EXCEPTION E'An outlet belongs to one brand from this version on, and these outlets cannot be given theirs:\n%', problems
      USING HINT = 'On the version still running, leave each of these outlets with the stations and channel links of one brand only (move or archive the others, or archive an outlet nobody uses), then migrate again. An outlet that really trades as two brands is two outlets now.';
  END IF;

  UPDATE outlets o SET brand_id = c.brand_id FROM outlet_brand_choice c WHERE c.outlet_id = o.id;

  SELECT string_agg(n || ' by ' || decided_by, ', ' ORDER BY decided_by) INTO summary FROM (SELECT decided_by, count(*) AS n FROM outlet_brand_choice GROUP BY decided_by) s;
  RAISE NOTICE 'outlet brands: %', coalesce(summary, 'no outlets');
END $$;
--> statement-breakpoint
-- 3. Every station takes its outlet's brand: a station left without one, a kitchen display, and a station whose
--    brand was not the one its outlet's channel links decided.
UPDATE stations s SET brand_id = o.brand_id FROM outlets o WHERE o.id = s.outlet_id AND s.brand_id IS DISTINCT FROM o.brand_id;
--> statement-breakpoint
ALTER TABLE "outlets" ALTER COLUMN "brand_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "outlets" ADD CONSTRAINT "outlets_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "outlets_merchant_brand_idx" ON "outlets" USING btree ("merchant_id","brand_id");
--> statement-breakpoint
-- 4. The brand is one of the outlet's own merchant's, in the database too (the twin every tenant foreign key has since 0051).
ALTER TABLE outlets ADD CONSTRAINT outlets_brand_id_same_merchant FOREIGN KEY (brand_id, merchant_id) REFERENCES brands (id, merchant_id);
--> statement-breakpoint
-- 5. Brand scope reaches the outlet itself: someone limited to some brands does not see another brand's outlets.
--    RESTRICTIVE, like the policies of 0044, so it narrows the tenant and outlet policies and widens nothing.
CREATE POLICY outlets_brand_scope ON outlets AS RESTRICTIVE FOR ALL TO app_authenticated, app_agent USING (sail.brand_allowed(brand_id)) WITH CHECK (sail.brand_allowed(brand_id));
--> statement-breakpoint
-- 6. A station, a channel link and a new order carry their outlet's brand. A station written without a brand takes
--    it; a row that names another brand is refused, whoever writes it (the register checks first and says so in words).
--    Orders are checked when they are opened only: orders from before this version keep the brand they had.
CREATE OR REPLACE FUNCTION sail.check_outlet_brand() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, sail, pg_temp AS $$
DECLARE
  outlet_brand uuid;
BEGIN
  SELECT brand_id INTO outlet_brand FROM outlets WHERE id = NEW.outlet_id;
  IF outlet_brand IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.brand_id IS NULL AND TG_TABLE_NAME = 'stations' THEN
    NEW.brand_id := outlet_brand;
  ELSIF NEW.brand_id IS DISTINCT FROM outlet_brand THEN
    RAISE EXCEPTION 'a row of % names brand %, but its outlet % belongs to brand %', TG_TABLE_NAME, NEW.brand_id, NEW.outlet_id, outlet_brand
      USING ERRCODE = 'check_violation', CONSTRAINT = TG_TABLE_NAME || '_outlet_brand';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER stations_outlet_brand BEFORE INSERT OR UPDATE OF brand_id, outlet_id ON stations FOR EACH ROW EXECUTE FUNCTION sail.check_outlet_brand();
--> statement-breakpoint
CREATE TRIGGER channel_links_outlet_brand BEFORE INSERT OR UPDATE OF brand_id, outlet_id ON channel_links FOR EACH ROW EXECUTE FUNCTION sail.check_outlet_brand();
--> statement-breakpoint
CREATE TRIGGER orders_outlet_brand BEFORE INSERT ON orders FOR EACH ROW EXECUTE FUNCTION sail.check_outlet_brand();
