CREATE TABLE "deployments_ephemeral" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"owned_by_user_id" text,
	"source_type" text NOT NULL,
	"internal_worker_name" text NOT NULL,
	"deployment_slug" text,
	"status" text NOT NULL,
	"expires_at" timestamp with time zone,
	"next_cleanup_at" timestamp with time zone NOT NULL,
	"cleanup_claim_token" uuid,
	"cleanup_claimed_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "UQ_deployments_ephemeral_internal_worker_name" UNIQUE("internal_worker_name"),
	CONSTRAINT "UQ_deployments_ephemeral_deployment_slug" UNIQUE("deployment_slug"),
	CONSTRAINT "deployments_ephemeral_source_type_check" CHECK ("deployments_ephemeral"."source_type" IN ('html')),
	CONSTRAINT "deployments_ephemeral_status_check" CHECK ("deployments_ephemeral"."status" IN ('pending', 'active', 'cleanup_retry')),
	CONSTRAINT "deployments_ephemeral_claim_fields_check" CHECK (("deployments_ephemeral"."cleanup_claim_token" IS NULL) = ("deployments_ephemeral"."cleanup_claimed_until" IS NULL)),
	CONSTRAINT "deployments_ephemeral_active_fields_check" CHECK ("deployments_ephemeral"."status" <> 'active' OR ("deployments_ephemeral"."deployment_slug" IS NOT NULL AND "deployments_ephemeral"."expires_at" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "deployments_ephemeral" ADD CONSTRAINT "deployments_ephemeral_owned_by_user_id_kilocode_users_id_fk" FOREIGN KEY ("owned_by_user_id") REFERENCES "public"."kilocode_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_deployments_ephemeral_owned_by_user_id" ON "deployments_ephemeral" USING btree ("owned_by_user_id");--> statement-breakpoint
CREATE INDEX "idx_deployments_ephemeral_next_cleanup_at" ON "deployments_ephemeral" USING btree ("next_cleanup_at");