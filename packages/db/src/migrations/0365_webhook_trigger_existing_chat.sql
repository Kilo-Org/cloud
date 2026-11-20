ALTER TABLE "cloud_agent_webhook_triggers" ADD COLUMN "cloud_agent_session_id" text;--> statement-breakpoint
ALTER TABLE "cloud_agent_webhook_triggers" ADD CONSTRAINT "CHK_cloud_agent_webhook_triggers_existing_chat_fields" CHECK ((
        ("cloud_agent_webhook_triggers"."target_type" = 'cloud_agent_chat' AND "cloud_agent_webhook_triggers"."cloud_agent_session_id" IS NOT NULL
          AND "cloud_agent_webhook_triggers"."github_repo" IS NULL AND "cloud_agent_webhook_triggers"."profile_id" IS NULL
          AND "cloud_agent_webhook_triggers"."kiloclaw_instance_id" IS NULL) OR
        ("cloud_agent_webhook_triggers"."target_type" != 'cloud_agent_chat' AND "cloud_agent_webhook_triggers"."cloud_agent_session_id" IS NULL)
      ));