ALTER TABLE "cloud_agent_webhook_triggers" DROP CONSTRAINT "CHK_cloud_agent_webhook_triggers_cloud_agent_fields";--> statement-breakpoint
ALTER TABLE "cloud_agent_webhook_triggers" ADD CONSTRAINT "CHK_cloud_agent_webhook_triggers_cloud_agent_fields" CHECK ((
        "cloud_agent_webhook_triggers"."target_type" != 'cloud_agent' OR
        "cloud_agent_webhook_triggers"."github_repo" IS NOT NULL
      ));