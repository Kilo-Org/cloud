CREATE TABLE "github_installation_webhook_receipts" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"github_installation_id" uuid NOT NULL,
	"delivery_id" text NOT NULL,
	"event_type" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "provider_oauth_attempts" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"purpose" text DEFAULT 'provider_install' NOT NULL,
	"state_hash" text NOT NULL,
	"initiated_by_user_id" text NOT NULL,
	"owned_by_user_id" text,
	"owned_by_organization_id" uuid,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	CONSTRAINT "provider_oauth_attempts_state_hash_unique" UNIQUE("state_hash"),
	CONSTRAINT "provider_oauth_attempts_provider_check" CHECK ("provider_oauth_attempts"."provider" IN ('slack', 'linear', 'discord')),
	CONSTRAINT "provider_oauth_attempts_status_check" CHECK ("provider_oauth_attempts"."status" IN ('pending', 'consumed', 'expired')),
	CONSTRAINT "provider_oauth_attempts_purpose_check" CHECK ("provider_oauth_attempts"."purpose" = 'provider_install'),
	CONSTRAINT "provider_oauth_attempts_owner_check" CHECK (num_nonnulls("provider_oauth_attempts"."owned_by_user_id", "provider_oauth_attempts"."owned_by_organization_id") = 1)
);
--> statement-breakpoint
DROP INDEX "UQ_platform_integrations_github_platform_inst";--> statement-breakpoint
DROP INDEX "UQ_platform_integrations_github_pending_target";--> statement-breakpoint
ALTER TABLE "github_app_installations" ADD COLUMN "sharing_mode" text DEFAULT 'exclusive' NOT NULL;--> statement-breakpoint
ALTER TABLE "github_app_installations" ADD COLUMN "sharing_admission_checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "github_installation_webhook_receipts" ADD CONSTRAINT "github_installation_webhook_receipts_github_installation_id_github_app_installations_id_fk" FOREIGN KEY ("github_installation_id") REFERENCES "public"."github_app_installations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_oauth_attempts" ADD CONSTRAINT "provider_oauth_attempts_initiated_by_user_id_kilocode_users_id_fk" FOREIGN KEY ("initiated_by_user_id") REFERENCES "public"."kilocode_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_oauth_attempts" ADD CONSTRAINT "provider_oauth_attempts_owned_by_user_id_kilocode_users_id_fk" FOREIGN KEY ("owned_by_user_id") REFERENCES "public"."kilocode_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_oauth_attempts" ADD CONSTRAINT "provider_oauth_attempts_owned_by_organization_id_organizations_id_fk" FOREIGN KEY ("owned_by_organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_github_installation_webhook_receipts_delivery" ON "github_installation_webhook_receipts" USING btree ("github_installation_id","delivery_id");--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_provider_oauth_attempts_user_pending" ON "provider_oauth_attempts" USING btree ("owned_by_user_id","provider") WHERE "provider_oauth_attempts"."status" = 'pending' AND "provider_oauth_attempts"."owned_by_user_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_provider_oauth_attempts_org_pending" ON "provider_oauth_attempts" USING btree ("owned_by_organization_id","provider") WHERE "provider_oauth_attempts"."status" = 'pending' AND "provider_oauth_attempts"."owned_by_organization_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "IDX_provider_oauth_attempts_expires_at" ON "provider_oauth_attempts" USING btree ("expires_at");--> statement-breakpoint
ALTER TABLE "platform_integrations" ADD CONSTRAINT "platform_integrations_github_installation_id_github_app_installations_id_fk" FOREIGN KEY ("github_installation_id") REFERENCES "public"."github_app_installations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_platform_integrations_github_org_canonical" ON "platform_integrations" USING btree ("owned_by_organization_id","github_installation_id") WHERE "platform_integrations"."platform" = 'github' AND "platform_integrations"."owned_by_organization_id" IS NOT NULL AND "platform_integrations"."github_installation_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_platform_integrations_github_user_canonical" ON "platform_integrations" USING btree ("owned_by_user_id","github_installation_id") WHERE "platform_integrations"."platform" = 'github' AND "platform_integrations"."owned_by_user_id" IS NOT NULL AND "platform_integrations"."github_installation_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_platform_integrations_github_org_pending_target" ON "platform_integrations" USING btree ("owned_by_organization_id","platform","github_app_type","platform_account_id") WHERE "platform_integrations"."platform" = 'github' AND "platform_integrations"."owned_by_organization_id" IS NOT NULL AND "platform_integrations"."integration_status" = 'pending' AND "platform_integrations"."platform_installation_id" IS NULL AND "platform_integrations"."platform_account_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_platform_integrations_github_user_pending_target" ON "platform_integrations" USING btree ("owned_by_user_id","platform","github_app_type","platform_account_id") WHERE "platform_integrations"."platform" = 'github' AND "platform_integrations"."owned_by_user_id" IS NOT NULL AND "platform_integrations"."integration_status" = 'pending' AND "platform_integrations"."platform_installation_id" IS NULL AND "platform_integrations"."platform_account_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "github_app_installations" ADD CONSTRAINT "github_app_installations_sharing_mode_check" CHECK ("github_app_installations"."sharing_mode" IN ('exclusive', 'web_cloud_agent'));