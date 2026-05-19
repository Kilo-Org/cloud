ALTER TABLE "cloud_agent_code_reviews" ADD COLUMN "repository_review_instructions_used" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "cloud_agent_code_reviews" ADD COLUMN "repository_review_instructions_ref" text;--> statement-breakpoint
ALTER TABLE "cloud_agent_code_reviews" ADD COLUMN "repository_review_instructions_truncated" boolean DEFAULT false NOT NULL;