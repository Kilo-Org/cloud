ALTER TABLE "repository_customizations" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "repository_customizations" CASCADE;--> statement-breakpoint
ALTER TABLE "platform_integrations" ADD COLUMN "github_connection_role" text;--> statement-breakpoint
ALTER TABLE "user_activity_tokens" ADD COLUMN "superseded_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX CONCURRENTLY "UQ_platform_integrations_github_workflow_canonical" ON "platform_integrations" USING btree ("github_installation_id") WHERE "platform_integrations"."github_connection_role" = 'workflow';--> statement-breakpoint
CREATE UNIQUE INDEX CONCURRENTLY "UQ_platform_integrations_github_workflow_identity" ON "platform_integrations" USING btree (COALESCE("github_app_type", 'standard'),"platform_installation_id") WHERE "platform_integrations"."github_connection_role" = 'workflow';--> statement-breakpoint
CREATE UNIQUE INDEX CONCURRENTLY "UQ_user_activity_tokens_live_ios_activity" ON "user_activity_tokens" USING btree ("user_id",coalesce("organization_id", '')) WHERE "user_activity_tokens"."kind" = 'ios_activity' AND "user_activity_tokens"."superseded_at" IS NULL;--> statement-breakpoint
ALTER TABLE "platform_integrations" ADD CONSTRAINT "platform_integrations_github_connection_role_check" CHECK ("platform_integrations"."github_connection_role" IS NULL OR (
        "platform_integrations"."platform" = 'github' AND "platform_integrations"."integration_type" = 'app'
        AND "platform_integrations"."platform_installation_id" IS NOT NULL
        AND "platform_integrations"."github_connection_role" IN ('workflow', 'agent_only')
        AND ("platform_integrations"."github_connection_role" <> 'agent_only' OR "platform_integrations"."github_installation_id" IS NOT NULL)
      ));