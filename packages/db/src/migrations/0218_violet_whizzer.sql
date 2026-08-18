ALTER TABLE "agent_configs" ADD COLUMN "config_revision" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "security_analysis_queue" ADD COLUMN "admitted_config_revision" integer;--> statement-breakpoint
ALTER TABLE "agent_configs" ADD CONSTRAINT "agent_configs_config_revision_check" CHECK ("agent_configs"."config_revision" >= 1);