ALTER TABLE "staff" ADD COLUMN "pin_lookup" text;--> statement-breakpoint
CREATE UNIQUE INDEX "staff_merchant_pin_uq" ON "staff" USING btree ("merchant_id","pin_lookup");