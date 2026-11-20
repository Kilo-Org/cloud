ALTER TABLE "agent_environment_profile_vars" ADD COLUMN "delivery" text DEFAULT 'env' NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_environment_profile_vars" ADD COLUMN "allowed_hosts" text[];--> statement-breakpoint
ALTER TABLE "agent_environment_profile_vars" ADD COLUMN "injection_locations" text[];--> statement-breakpoint
ALTER TABLE "cloud_agent_environment_vars" ADD COLUMN "delivery" text DEFAULT 'env' NOT NULL;--> statement-breakpoint
ALTER TABLE "cloud_agent_environment_vars" ADD COLUMN "allowed_hosts" text[];--> statement-breakpoint
ALTER TABLE "cloud_agent_environment_vars" ADD COLUMN "injection_locations" text[];