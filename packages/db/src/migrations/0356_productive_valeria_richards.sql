DO $$
BEGIN
	IF to_regclass('public.cloud_agent_environment_setup_runs') IS NULL THEN
		CREATE TABLE "cloud_agent_environment_setup_runs" (
			"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
			"owned_by_organization_id" uuid,
			"owned_by_user_id" text,
			"created_by_user_id" text NOT NULL,
			"draft_environment_id" uuid,
			"target_environment_id" uuid,
			"cloud_agent_session_id" text,
			"status" text DEFAULT 'starting' NOT NULL,
			"data" jsonb NOT NULL,
			"verification_count" integer DEFAULT 0 NOT NULL,
			"verification_limit" integer DEFAULT 6 NOT NULL,
			"published_environment_id" uuid,
			"created_at" timestamp with time zone DEFAULT now() NOT NULL,
			"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
			"completed_at" timestamp with time zone,
			CONSTRAINT "env_setup_runs_owner_check" CHECK ((
		        ("cloud_agent_environment_setup_runs"."owned_by_user_id" IS NOT NULL AND "cloud_agent_environment_setup_runs"."owned_by_organization_id" IS NULL) OR
		        ("cloud_agent_environment_setup_runs"."owned_by_user_id" IS NULL AND "cloud_agent_environment_setup_runs"."owned_by_organization_id" IS NOT NULL))),
			CONSTRAINT "env_setup_runs_status_check" CHECK ("cloud_agent_environment_setup_runs"."status" IN ('starting', 'running', 'needs_input', 'verifying', 'publish_conflict', 'failed', 'published', 'reverted', 'cancelled')),
			CONSTRAINT "env_setup_runs_verification_check" CHECK ("cloud_agent_environment_setup_runs"."verification_count" >= 0 AND "cloud_agent_environment_setup_runs"."verification_limit" >= 0)
		);

		ALTER TABLE "cloud_agent_environments" ADD COLUMN "is_draft" boolean DEFAULT false NOT NULL;
		ALTER TABLE "cloud_agent_environments" ADD COLUMN "draft_for_environment_id" uuid;
		ALTER TABLE "cloud_agent_environments" ADD COLUMN "egress_required_hosts" text[];
		ALTER TABLE "cloud_agent_environment_setup_runs" ADD CONSTRAINT "cloud_agent_environment_setup_runs_owned_by_organization_id_organizations_id_fk" FOREIGN KEY ("owned_by_organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
		ALTER TABLE "cloud_agent_environment_setup_runs" ADD CONSTRAINT "cloud_agent_environment_setup_runs_owned_by_user_id_kilocode_users_id_fk" FOREIGN KEY ("owned_by_user_id") REFERENCES "public"."kilocode_users"("id") ON DELETE cascade ON UPDATE no action;
		ALTER TABLE "cloud_agent_environment_setup_runs" ADD CONSTRAINT "cloud_agent_environment_setup_runs_draft_environment_id_cloud_agent_environments_id_fk" FOREIGN KEY ("draft_environment_id") REFERENCES "public"."cloud_agent_environments"("id") ON DELETE set null ON UPDATE no action;
		ALTER TABLE "cloud_agent_environment_setup_runs" ADD CONSTRAINT "cloud_agent_environment_setup_runs_target_environment_id_cloud_agent_environments_id_fk" FOREIGN KEY ("target_environment_id") REFERENCES "public"."cloud_agent_environments"("id") ON DELETE set null ON UPDATE no action;
		ALTER TABLE "cloud_agent_environment_setup_runs" ADD CONSTRAINT "cloud_agent_environment_setup_runs_published_environment_id_cloud_agent_environments_id_fk" FOREIGN KEY ("published_environment_id") REFERENCES "public"."cloud_agent_environments"("id") ON DELETE set null ON UPDATE no action;
		CREATE INDEX "IDX_env_setup_runs_user_id" ON "cloud_agent_environment_setup_runs" USING btree ("owned_by_user_id");
		CREATE INDEX "IDX_env_setup_runs_org_id" ON "cloud_agent_environment_setup_runs" USING btree ("owned_by_organization_id");
		CREATE INDEX "IDX_env_setup_runs_target" ON "cloud_agent_environment_setup_runs" USING btree ("target_environment_id");
		CREATE INDEX "IDX_env_setup_runs_published" ON "cloud_agent_environment_setup_runs" USING btree ("published_environment_id");
		CREATE UNIQUE INDEX "UQ_env_setup_runs_session" ON "cloud_agent_environment_setup_runs" USING btree ("cloud_agent_session_id") WHERE "cloud_agent_environment_setup_runs"."cloud_agent_session_id" IS NOT NULL;
		CREATE UNIQUE INDEX "UQ_env_setup_runs_draft" ON "cloud_agent_environment_setup_runs" USING btree ("draft_environment_id") WHERE "cloud_agent_environment_setup_runs"."draft_environment_id" IS NOT NULL;
		CREATE UNIQUE INDEX "UQ_env_setup_runs_open_target" ON "cloud_agent_environment_setup_runs" USING btree ("target_environment_id") WHERE "cloud_agent_environment_setup_runs"."target_environment_id" IS NOT NULL AND "cloud_agent_environment_setup_runs"."status" NOT IN ('published', 'reverted', 'cancelled');
		ALTER TABLE "cloud_agent_environments" ADD CONSTRAINT "cloud_agent_environments_draft_for_environment_id_cloud_agent_environments_id_fk" FOREIGN KEY ("draft_for_environment_id") REFERENCES "public"."cloud_agent_environments"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
COMMIT;
--> statement-breakpoint
SET statement_timeout = 0;
--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "IDX_cloud_agent_environments_draft_for";
--> statement-breakpoint
CREATE INDEX CONCURRENTLY "IDX_cloud_agent_environments_draft_for" ON "cloud_agent_environments" USING btree ("draft_for_environment_id");--> statement-breakpoint
RESET statement_timeout;
--> statement-breakpoint
BEGIN;
--> statement-breakpoint
ALTER TABLE "cloud_agent_environments" ADD CONSTRAINT "cloud_agent_environments_draft_target_check" CHECK ("cloud_agent_environments"."draft_for_environment_id" IS NULL OR "cloud_agent_environments"."is_draft");
