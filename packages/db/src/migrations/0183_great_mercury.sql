ALTER TABLE "cloud_agent_code_reviews" ADD COLUMN "review_type" text DEFAULT 'standard' NOT NULL;--> statement-breakpoint
ALTER TABLE "cloud_agent_code_reviews" ADD COLUMN "trigger_source" text;