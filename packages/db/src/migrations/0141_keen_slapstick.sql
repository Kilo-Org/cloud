ALTER TABLE "cloud_agent_code_reviews" ADD COLUMN "pending_dispatch_retry_count" smallint DEFAULT 0 NOT NULL;--> statement-breakpoint
COMMENT ON COLUMN "cloud_agent_code_reviews"."pending_dispatch_retry_count" IS 'Tracks the retry budget for the worst-case scenario where Kilo infrastructure failed to handle the review gracefully.';
