-- Custom SQL migration file, put your code below! --
DO $$ BEGIN
	ALTER TABLE "platform_integrations" ADD COLUMN "github_connection_role" text;
EXCEPTION
	WHEN duplicate_column THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "platform_integrations" ADD CONSTRAINT "platform_integrations_github_connection_role_check" CHECK ("platform_integrations"."github_connection_role" IS NULL OR (
        "platform_integrations"."platform" = 'github' AND "platform_integrations"."integration_type" = 'app'
        AND "platform_integrations"."platform_installation_id" IS NOT NULL
        AND "platform_integrations"."github_connection_role" IN ('workflow', 'agent_only')
        AND ("platform_integrations"."github_connection_role" <> 'agent_only' OR "platform_integrations"."github_installation_id" IS NOT NULL)
      ));
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;
