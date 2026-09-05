CREATE TABLE "github_app_installations" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"github_app_type" text NOT NULL,
	"installation_id" text NOT NULL,
	"account_id" text,
	"account_login" text,
	"account_type" text,
	"permissions" jsonb,
	"scopes" text[],
	"repository_access" text,
	"repositories" jsonb,
	"repositories_synced_at" timestamp with time zone,
	"lifecycle_state" text DEFAULT 'unknown' NOT NULL,
	"suspended_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"auth_invalid_at" timestamp with time zone,
	"auth_invalid_reason" text,
	"revision" integer DEFAULT 0 NOT NULL,
	"observed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "github_app_installations_app_type_check" CHECK ("github_app_installations"."github_app_type" IN ('standard', 'lite')),
	CONSTRAINT "github_app_installations_installation_id_check" CHECK ("github_app_installations"."installation_id" ~ '^[1-9][0-9]*$'),
	CONSTRAINT "github_app_installations_lifecycle_state_check" CHECK ("github_app_installations"."lifecycle_state" IN ('unknown', 'active', 'suspended', 'deleted'))
);
--> statement-breakpoint
CREATE TABLE "github_connection_attempts" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"kilo_user_id" text NOT NULL,
	"owner_type" text NOT NULL,
	"owner_id" text NOT NULL,
	"github_app_type" text NOT NULL,
	"return_to" text,
	"selected_installation_id" text,
	"github_user_id" text,
	"eligible_installations" jsonb,
	"completed_integration_id" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "github_connection_attempts_owner_type_check" CHECK ("github_connection_attempts"."owner_type" IN ('user', 'org')),
	CONSTRAINT "github_connection_attempts_app_type_check" CHECK ("github_connection_attempts"."github_app_type" IN ('standard', 'lite'))
);
--> statement-breakpoint
ALTER TABLE "platform_integrations" ADD COLUMN "github_installation_id" uuid;--> statement-breakpoint
ALTER TABLE "platform_integrations" ADD COLUMN "github_disconnected_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "platform_integrations" ADD COLUMN "github_authorized_by_user_id" text;--> statement-breakpoint
ALTER TABLE "platform_integrations" ADD COLUMN "github_authorized_user_id" text;--> statement-breakpoint
ALTER TABLE "platform_integrations" ADD COLUMN "github_authorized_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "github_connection_attempts" ADD CONSTRAINT "github_connection_attempts_completed_integration_id_platform_integrations_id_fk" FOREIGN KEY ("completed_integration_id") REFERENCES "public"."platform_integrations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_github_app_installations_app_installation" ON "github_app_installations" USING btree ("github_app_type","installation_id");--> statement-breakpoint
CREATE INDEX "IDX_github_connection_attempts_expires_at" ON "github_connection_attempts" USING btree ("expires_at");