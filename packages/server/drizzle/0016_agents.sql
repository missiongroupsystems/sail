CREATE TABLE "agent_identities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"merchant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"role" text NOT NULL,
	"outlet_ids" uuid[] DEFAULT '{}' NOT NULL,
	"brand_ids" uuid[] DEFAULT '{}' NOT NULL,
	"toolsets" text[] DEFAULT '{}' NOT NULL,
	"risk_ceiling" text DEFAULT 'T1' NOT NULL,
	"credential_hash" text,
	"credential_rotated_at" timestamp with time zone,
	"enabled" boolean DEFAULT true NOT NULL,
	"max_ops_per_hour" integer DEFAULT 600 NOT NULL,
	"max_proposals_per_day" integer DEFAULT 50 NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"merchant_id" uuid NOT NULL,
	"identity_id" uuid NOT NULL,
	"task_id" text,
	"on_behalf_of" jsonb,
	"effective_role" text NOT NULL,
	"effective_outlet_ids" uuid[] DEFAULT '{}' NOT NULL,
	"effective_brand_ids" uuid[] DEFAULT '{}' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ops_count" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"merchant_id" uuid NOT NULL,
	"outlet_id" uuid,
	"operation_id" text NOT NULL,
	"tier" text NOT NULL,
	"method" text NOT NULL,
	"path" text NOT NULL,
	"body" jsonb,
	"idempotency_key" text,
	"expected_version" integer,
	"target_kind" text,
	"target_id" text,
	"rationale" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"proposed_by_type" text NOT NULL,
	"proposed_by_id" text NOT NULL,
	"proposed_by_name" text,
	"agent_identity_id" uuid,
	"agent_session_id" uuid,
	"decided_by" text,
	"decided_by_name" text,
	"decided_at" timestamp with time zone,
	"reject_reason" text,
	"result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_identities" ADD CONSTRAINT "agent_identities_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD CONSTRAINT "agent_sessions_identity_id_agent_identities_id_fk" FOREIGN KEY ("identity_id") REFERENCES "public"."agent_identities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_identities_merchant_idx" ON "agent_identities" USING btree ("merchant_id");--> statement-breakpoint
CREATE INDEX "agent_sessions_identity_idx" ON "agent_sessions" USING btree ("identity_id","expires_at");--> statement-breakpoint
CREATE INDEX "proposals_outlet_status_idx" ON "proposals" USING btree ("outlet_id","status","created_at");