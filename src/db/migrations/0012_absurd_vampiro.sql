ALTER TABLE "cloud_agent_code_reviews" ADD COLUMN "platform" text DEFAULT 'github' NOT NULL;--> statement-breakpoint
ALTER TABLE "cloud_agent_code_reviews" ADD COLUMN "platform_project_id" integer;