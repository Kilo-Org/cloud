CREATE TABLE "gitlab_credential_migration_jobs" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"requested_mode" text NOT NULL,
	"phase" text NOT NULL,
	"status" text NOT NULL,
	"requested_by_user_id" text NOT NULL,
	"cursor" text,
	"lease_token" uuid,
	"lease_expires_at" timestamp with time zone,
	"scanned_integrations" integer DEFAULT 0 NOT NULL,
	"mutated_integrations" integer DEFAULT 0 NOT NULL,
	"public_audit_counts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"private_audit_counts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"private_audit_key_id" text,
	"private_audit_public_key_sha256" text,
	"retry_count" integer DEFAULT 0 NOT NULL,
	"issue_integration_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"error_code" text,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "gitlab_credential_migration_jobs_mode_check" CHECK ("gitlab_credential_migration_jobs"."requested_mode" IN ('audit', 'backfill', 'scrub')),
	CONSTRAINT "gitlab_credential_migration_jobs_phase_check" CHECK ("gitlab_credential_migration_jobs"."phase" IN ('public_audit', 'backfill', 'private_audit', 'scrub', 'final_public_audit', 'final_private_audit')),
	CONSTRAINT "gitlab_credential_migration_jobs_status_check" CHECK ("gitlab_credential_migration_jobs"."status" IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
	CONSTRAINT "gitlab_credential_migration_jobs_lease_check" CHECK (("gitlab_credential_migration_jobs"."lease_token" IS NULL AND "gitlab_credential_migration_jobs"."lease_expires_at" IS NULL) OR ("gitlab_credential_migration_jobs"."lease_token" IS NOT NULL AND "gitlab_credential_migration_jobs"."lease_expires_at" IS NOT NULL)),
	CONSTRAINT "gitlab_credential_migration_jobs_counter_check" CHECK ("gitlab_credential_migration_jobs"."scanned_integrations" >= 0 AND "gitlab_credential_migration_jobs"."mutated_integrations" >= 0 AND "gitlab_credential_migration_jobs"."retry_count" >= 0)
);
--> statement-breakpoint
ALTER TABLE "gitlab_credential_migration_jobs" ADD CONSTRAINT "gitlab_credential_migration_jobs_requested_by_user_id_kilocode_users_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."kilocode_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_gitlab_credential_migration_jobs_active" ON "gitlab_credential_migration_jobs" USING btree ((1)) WHERE "gitlab_credential_migration_jobs"."status" IN ('queued', 'running');--> statement-breakpoint
CREATE INDEX "IDX_gitlab_credential_migration_jobs_created_at" ON "gitlab_credential_migration_jobs" USING btree ("created_at");