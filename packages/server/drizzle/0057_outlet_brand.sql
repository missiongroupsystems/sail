-- An outlet belongs to exactly one brand. The column and its constraints are the generated part; the rest is
-- hand-written: the backfill, the brand of the stations under each outlet, row-level security and the trigger that
-- keeps a station, a channel link and a new order on their outlet's brand.

-- 1. The column, empty at first so that existing outlets can be given their brand.
ALTER TABLE "outlets" ADD COLUMN "brand_id" uuid;
--> statement-breakpoint
-- 2. Each outlet's brand, from the live rows the outlet already has, in this order:
--      a. the brand of its enabled channel links;
--      b. else the brand of its stations that are not archived (a station or kitchen display without a brand counts as
--         nothing);
--      c. else the brand most of its orders carry;
--      d. else the merchant's only brand (its only brand that is not archived, when there are archived ones).
--    An archived outlet never stops the migration: when its rows do not decide one brand, it takes the merchant's
--    oldest brand (the oldest one not archived, if there is one). A live outlet whose deciding rows name two brands
--    (enabled links, or live stations, of two brands, or two brands level on orders), or that has nothing to decide by
--    at a merchant with several brands, stops the migration, which names each outlet and changes nothing.
--    Disabled channel links and archived stations do not decide.
DO $$
DECLARE
  problems text;
  summary text;
BEGIN
  CREATE TEMP TABLE outlet_brand_choice ON COMMIT DROP AS
  WITH link AS (
    SELECT outlet_id, count(DISTINCT brand_id) AS brands, min(brand_id::text)::uuid AS brand_id FROM channel_links WHERE enabled GROUP BY outlet_id
  ), station AS (
    SELECT outlet_id, count(DISTINCT brand_id) AS brands, min(brand_id::text)::uuid AS brand_id FROM stations WHERE brand_id IS NOT NULL AND archived_at IS NULL GROUP BY outlet_id
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
  ), rule AS (
    SELECT o.id AS outlet_id, o.merchant_id, o.name, o.archived_at IS NOT NULL AS archived, mb.brands AS merchant_brands,
      coalesce(mb.oldest_live, mb.oldest) AS oldest,
      CASE
        WHEN link.brands IS NOT NULL THEN 'its enabled channel links'
        WHEN station.brands IS NOT NULL THEN 'its stations'
        WHEN order_top.brands IS NOT NULL THEN 'its orders'
        WHEN mb.live = 1 OR mb.brands = 1 THEN 'the merchant''s only brand'
      END AS decided_by,
      CASE
        WHEN link.brands IS NOT NULL THEN CASE WHEN link.brands = 1 THEN link.brand_id END
        WHEN station.brands IS NOT NULL THEN CASE WHEN station.brands = 1 THEN station.brand_id END
        WHEN order_top.brands IS NOT NULL THEN CASE WHEN order_top.brands = 1 THEN order_top.brand_id END
        WHEN mb.live = 1 THEN mb.oldest_live
        WHEN mb.brands = 1 THEN mb.oldest
      END AS brand_id,
      CASE
        WHEN mb.brands IS NULL THEN 'the merchant has no brand'
        WHEN link.brands > 1 THEN 'its enabled channel links name ' || link.brands || ' brands'
        WHEN link.brands IS NULL AND station.brands > 1 THEN 'its stations that are not archived name ' || station.brands || ' brands'
        WHEN link.brands IS NULL AND station.brands IS NULL AND order_top.brands > 1 THEN 'its orders are level between ' || order_top.brands || ' brands'
        ELSE 'it has no enabled channel link, no live station with a brand and no order, and the merchant has ' || CASE WHEN mb.live > 1 THEN mb.live || ' brands' ELSE mb.brands || ' brands, all archived' END
      END AS why_not
    FROM outlets o
    LEFT JOIN link ON link.outlet_id = o.id
    LEFT JOIN station ON station.outlet_id = o.id
    LEFT JOIN order_top ON order_top.outlet_id = o.id
    LEFT JOIN merchant_brand mb ON mb.merchant_id = o.merchant_id
  )
  SELECT outlet_id, merchant_id, name,
    CASE WHEN brand_id IS NULL AND archived AND oldest IS NOT NULL THEN 'archived, and nothing live decides: the merchant''s oldest brand' ELSE decided_by END AS decided_by,
    CASE WHEN brand_id IS NULL AND archived THEN oldest ELSE brand_id END AS brand_id,
    why_not
  FROM rule;

  SELECT string_agg(format('  %s (outlet %s, merchant %s): %s', c.name, c.outlet_id, m.name, c.why_not), E'\n' ORDER BY m.name, c.name, c.outlet_id)
    INTO problems FROM outlet_brand_choice c JOIN merchants m ON m.id = c.merchant_id WHERE c.brand_id IS NULL;
  IF problems IS NOT NULL THEN
    RAISE EXCEPTION E'An outlet belongs to one brand from this version on, and these outlets cannot be given theirs:\n%', problems
      USING HINT = 'On the version still running, for each outlet named: in Settings > Channels, disable the channels of every brand but one; in Settings > Stations, give each station that brand or archive it; or, if nobody trades there, archive the outlet in Settings > Outlets. An outlet with nothing to decide by needs an enabled channel or a station of its brand (or archive it). Then migrate again. An outlet that really trades as two brands is two outlets now.';
  END IF;

  UPDATE outlets o SET brand_id = c.brand_id FROM outlet_brand_choice c WHERE c.outlet_id = o.id;

  SELECT string_agg(n || ' by ' || decided_by, ', ' ORDER BY decided_by) INTO summary FROM (SELECT decided_by, count(*) AS n FROM outlet_brand_choice GROUP BY decided_by) s;
  RAISE NOTICE 'outlet brands: %', coalesce(summary, 'no outlets');
END $$;
--> statement-breakpoint
-- 3. Every station takes its outlet's brand: a station left without one, a kitchen display, and a station (archived
--    ones too) of another brand than the one its outlet was given. Each station whose brand changes is named in a
--    NOTICE (outlet, station, from, to). A station whose POS layout is of another brand than its new one loses the
--    layout, also named: its POS then lays out the brand's menu until a layout of the brand is chosen. A channel link
--    left on another brand than its outlet's (a disabled one, or one at an archived outlet) is named and left as it is.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT o.name AS outlet, o.id AS outlet_id, s.name AS station, s.id AS station_id, coalesce(fb.name, 'no brand') AS from_brand, tb.name AS to_brand
    FROM stations s JOIN outlets o ON o.id = s.outlet_id JOIN brands tb ON tb.id = o.brand_id LEFT JOIN brands fb ON fb.id = s.brand_id
    WHERE s.brand_id IS DISTINCT FROM o.brand_id ORDER BY o.name, s.name, s.id
  LOOP
    RAISE NOTICE 'station brand: % (outlet %), station % (%): % -> %', r.outlet, r.outlet_id, r.station, r.station_id, r.from_brand, r.to_brand;
  END LOOP;
  UPDATE stations s SET brand_id = o.brand_id FROM outlets o WHERE o.id = s.outlet_id AND s.brand_id IS DISTINCT FROM o.brand_id;

  FOR r IN
    SELECT o.name AS outlet, o.id AS outlet_id, s.name AS station, s.id AS station_id, l.name AS layout, lb.name AS layout_brand
    FROM stations s JOIN outlets o ON o.id = s.outlet_id JOIN pos_layouts l ON l.id = s.layout_id JOIN brands lb ON lb.id = l.brand_id
    WHERE l.brand_id IS DISTINCT FROM s.brand_id ORDER BY o.name, s.name, s.id
  LOOP
    RAISE NOTICE 'station layout cleared: % (outlet %), station % (%): layout % is of brand %', r.outlet, r.outlet_id, r.station, r.station_id, r.layout, r.layout_brand;
  END LOOP;
  UPDATE stations s SET layout_id = NULL FROM pos_layouts l WHERE l.id = s.layout_id AND l.brand_id IS DISTINCT FROM s.brand_id;

  FOR r IN
    SELECT o.name AS outlet, o.id AS outlet_id, c.channel, c.id AS link_id, c.enabled, b.name AS brand
    FROM channel_links c JOIN outlets o ON o.id = c.outlet_id JOIN brands b ON b.id = c.brand_id
    WHERE c.brand_id IS DISTINCT FROM o.brand_id ORDER BY o.name, c.channel, c.id
  LOOP
    RAISE NOTICE 'channel link of another brand: % (outlet %), % link % of brand % (%), left as it is', r.outlet, r.outlet_id, r.channel, r.link_id, r.brand, CASE WHEN r.enabled THEN 'enabled, at an archived outlet' ELSE 'disabled' END;
  END LOOP;
END $$;
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
--    A channel link is checked when it is switched on too.
--    Orders are checked when they are opened only: orders from before this version keep the brand they had.
CREATE OR REPLACE FUNCTION sail.check_outlet_brand() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, sail, pg_temp AS $$
DECLARE
  outlet_brand uuid;
BEGIN
  -- With a key share lock: a change of the outlet's brand being made (outlets.update locks the outlet) commits first,
  -- and this row is then checked against the new brand.
  SELECT brand_id INTO outlet_brand FROM outlets WHERE id = NEW.outlet_id FOR KEY SHARE;
  IF outlet_brand IS NULL THEN
    RETURN NEW;
  END IF;
  -- A channel link of another brand that step 3 left (a disabled one) may stay, and be edited, while it is off; it is
  -- refused when it is switched on, as it would sell another brand's menu at this outlet.
  IF TG_OP = 'UPDATE' AND TG_TABLE_NAME = 'channel_links' THEN
    IF NOT NEW.enabled AND NEW.brand_id IS NOT DISTINCT FROM OLD.brand_id AND NEW.outlet_id IS NOT DISTINCT FROM OLD.outlet_id THEN
      RETURN NEW;
    END IF;
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
CREATE TRIGGER channel_links_outlet_brand BEFORE INSERT OR UPDATE OF brand_id, outlet_id, enabled ON channel_links FOR EACH ROW EXECUTE FUNCTION sail.check_outlet_brand();
--> statement-breakpoint
CREATE TRIGGER orders_outlet_brand BEFORE INSERT ON orders FOR EACH ROW EXECUTE FUNCTION sail.check_outlet_brand();
