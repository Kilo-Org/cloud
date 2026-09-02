CREATE TABLE "organization_vercel_compute_credentials" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"token_encrypted" jsonb NOT NULL,
	"token_scope" text DEFAULT 'team' NOT NULL,
	"team_id" text NOT NULL,
	"project_id" text NOT NULL,
	"team_slug" text,
	"project_slug" text,
	"setup_status" text DEFAULT 'pending' NOT NULL,
	"setup_step" text,
	"setup_error" text,
	"build_generation" uuid DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"runtime_build_id" text,
	"runtime_snapshot_id" text,
	"setup_started_at" timestamp with time zone,
	"setup_completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "UQ_organization_vercel_compute_credentials_organization" UNIQUE("organization_id"),
	CONSTRAINT "organization_vercel_compute_credentials_ids_non_empty" CHECK (length(trim("organization_vercel_compute_credentials"."team_id")) > 0 AND length(trim("organization_vercel_compute_credentials"."project_id")) > 0),
	CONSTRAINT "organization_vercel_compute_credentials_token_scope_check" CHECK ("organization_vercel_compute_credentials"."token_scope" IN ('team', 'project')),
	CONSTRAINT "organization_vercel_compute_credentials_status_check" CHECK ("organization_vercel_compute_credentials"."setup_status" IN ('pending', 'building', 'ready', 'failed')),
	CONSTRAINT "organization_vercel_compute_credentials_ready_fields_check" CHECK ("organization_vercel_compute_credentials"."setup_status" <> 'ready' OR ("organization_vercel_compute_credentials"."runtime_snapshot_id" IS NOT NULL AND "organization_vercel_compute_credentials"."project_slug" IS NOT NULL AND "organization_vercel_compute_credentials"."setup_completed_at" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "organization_vercel_compute_credentials" ADD CONSTRAINT "organization_vercel_compute_credentials_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE cascade;