ALTER TABLE "cloud_agent_webhook_triggers" ADD COLUMN "activation_mode" text DEFAULT 'webhook' NOT NULL;--> statement-breakpoint
ALTER TABLE "cloud_agent_webhook_triggers" ADD COLUMN "cron_expression" text;--> statement-breakpoint
ALTER TABLE "cloud_agent_webhook_triggers" ADD COLUMN "cron_timezone" text DEFAULT 'UTC';--> statement-breakpoint
ALTER TABLE "cloud_agent_webhook_triggers" ADD CONSTRAINT "CHK_cloud_agent_webhook_triggers_scheduled_fields" CHECK ((
        "cloud_agent_webhook_triggers"."activation_mode" != 'scheduled' OR
        "cloud_agent_webhook_triggers"."cron_expression" IS NOT NULL
      ));