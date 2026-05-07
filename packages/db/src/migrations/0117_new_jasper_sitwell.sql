ALTER TABLE "cloud_agent_code_reviews" ADD COLUMN "sandbox_id" text;--> statement-breakpoint
ALTER TABLE "cloud_agent_code_reviews" ADD COLUMN "sandbox_retry_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "cloud_agent_code_reviews" ADD COLUMN "sandbox_retry_reason" text;--> statement-breakpoint
ALTER TABLE "cloud_agent_code_reviews" ADD COLUMN "sandbox_retry_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "cloud_agent_code_reviews" ADD COLUMN "current_attempt" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
COMMIT;--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_cloud_agent_code_reviews_sandbox_id" ON "cloud_agent_code_reviews" USING btree ("sandbox_id");--> statement-breakpoint
BEGIN;
