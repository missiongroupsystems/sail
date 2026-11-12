CREATE TABLE "guest_rate_hits" (
	"merchant_id" uuid NOT NULL,
	"key" text NOT NULL,
	"hits" timestamp with time zone[] DEFAULT '{}' NOT NULL,
	CONSTRAINT "guest_rate_hits_merchant_id_key_pk" PRIMARY KEY("merchant_id","key")
);
--> statement-breakpoint
CREATE TABLE "pin_attempts" (
	"merchant_id" uuid NOT NULL,
	"scope" text NOT NULL,
	"failures" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pin_attempts_merchant_id_scope_pk" PRIMARY KEY("merchant_id","scope")
);
