ALTER TABLE "platform_integrations" ADD COLUMN "github_connection_role" text;--> statement-breakpoint
CREATE UNIQUE INDEX CONCURRENTLY "UQ_platform_integrations_github_workflow_canonical" ON "platform_integrations" USING btree ("github_installation_id") WHERE "platform_integrations"."github_connection_role" = 'workflow';--> statement-breakpoint
CREATE UNIQUE INDEX CONCURRENTLY "UQ_platform_integrations_github_workflow_identity" ON "platform_integrations" USING btree (COALESCE("github_app_type", 'standard'),"platform_installation_id") WHERE "platform_integrations"."github_connection_role" = 'workflow';--> statement-breakpoint
ALTER TABLE "platform_integrations" ADD CONSTRAINT "platform_integrations_github_connection_role_check" CHECK ("platform_integrations"."github_connection_role" IS NULL OR (
        "platform_integrations"."platform" = 'github' AND "platform_integrations"."integration_type" = 'app'
        AND "platform_integrations"."platform_installation_id" IS NOT NULL
        AND "platform_integrations"."github_connection_role" IN ('workflow', 'agent_only')
        AND ("platform_integrations"."github_connection_role" <> 'agent_only' OR "platform_integrations"."github_installation_id" IS NOT NULL)
      ));