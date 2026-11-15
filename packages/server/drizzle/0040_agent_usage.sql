CREATE TABLE "agent_usage" (
	"identity_id" uuid NOT NULL,
	"merchant_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "agent_usage_identity_id_kind_window_start_pk" PRIMARY KEY("identity_id","kind","window_start")
);
--> statement-breakpoint
ALTER TABLE "agent_usage" ADD CONSTRAINT "agent_usage_identity_id_agent_identities_id_fk" FOREIGN KEY ("identity_id") REFERENCES "public"."agent_identities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_sessions" DROP COLUMN "ops_count";