-- Hand-written: a refund made in the back office with no cash out (no drawer, no station of its own) counts on the
-- station of the payment it gives back (the largest of its tenders), else the order's station, so the stations'
-- Z-reports add up to the day's (review 4, T1). New refunds are written that way; this backfills the old ones.
-- Refunds are immutable; this backfill of their station is the only change made to them. It moves those refunds onto a
-- station in the station-filtered Z-reports of past days too (the day's own Z-report is unchanged).
ALTER TABLE "refunds" DISABLE TRIGGER "refunds_immutable";--> statement-breakpoint
UPDATE "refunds" r SET "station_id" = COALESCE(
  (SELECT p."station_id" FROM "refund_tenders" rt JOIN "payments" p ON p."id" = rt."payment_id"
    WHERE rt."refund_id" = r."id" AND p."station_id" IS NOT NULL
    ORDER BY rt."amount" + rt."rounding_cents" + rt."tip_cents" DESC, p."id" LIMIT 1),
  (SELECT o."station_id" FROM "orders" o WHERE o."id" = r."order_id"))
WHERE r."station_id" IS NULL;--> statement-breakpoint
ALTER TABLE "refunds" ENABLE TRIGGER "refunds_immutable";
