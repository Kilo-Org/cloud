ALTER TABLE "cloud_agent_webhook_triggers" ALTER COLUMN "github_repo" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "cloud_agent_webhook_triggers" ALTER COLUMN "profile_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "cloud_agent_webhook_triggers" ADD COLUMN "target_type" text DEFAULT 'cloud_agent' NOT NULL;--> statement-breakpoint
ALTER TABLE "cloud_agent_webhook_triggers" ADD COLUMN "kiloclaw_instance_id" uuid;--> statement-breakpoint
ALTER TABLE "cloud_agent_webhook_triggers" ADD CONSTRAINT "cloud_agent_webhook_triggers_kiloclaw_instance_id_kiloclaw_instances_id_fk" FOREIGN KEY ("kiloclaw_instance_id") REFERENCES "public"."kiloclaw_instances"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cloud_agent_webhook_triggers" ADD CONSTRAINT "CHK_cloud_agent_webhook_triggers_cloud_agent_fields" CHECK ((
        "cloud_agent_webhook_triggers"."target_type" != 'cloud_agent' OR
        ("cloud_agent_webhook_triggers"."github_repo" IS NOT NULL AND "cloud_agent_webhook_triggers"."profile_id" IS NOT NULL)
      ));--> statement-breakpoint
ALTER TABLE "cloud_agent_webhook_triggers" ADD CONSTRAINT "CHK_cloud_agent_webhook_triggers_kiloclaw_fields" CHECK ((
        "cloud_agent_webhook_triggers"."target_type" != 'kiloclaw_chat' OR
        "cloud_agent_webhook_triggers"."kiloclaw_instance_id" IS NOT NULL
      ));