ALTER TABLE "overrides" ADD COLUMN "args" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "overrides" ADD COLUMN "requester_session_id" uuid;--> statement-breakpoint
ALTER TABLE "overrides" ADD COLUMN "station_id" uuid;