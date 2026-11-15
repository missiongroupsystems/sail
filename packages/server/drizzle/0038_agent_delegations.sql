CREATE TABLE "agent_delegations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"merchant_id" uuid NOT NULL,
	"identity_id" uuid NOT NULL,
	"grant_hash" text NOT NULL,
	"person" jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "proposals" ADD COLUMN "on_behalf_of_id" text;--> statement-breakpoint
ALTER TABLE "agent_delegations" ADD CONSTRAINT "agent_delegations_identity_id_agent_identities_id_fk" FOREIGN KEY ("identity_id") REFERENCES "public"."agent_identities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_delegations_identity_idx" ON "agent_delegations" USING btree ("identity_id");