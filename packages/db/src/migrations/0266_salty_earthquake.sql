ALTER TABLE "cloud_agent_sessions" ADD COLUMN "product_origin" text;--> statement-breakpoint
COMMIT;--> statement-breakpoint
CREATE INDEX CONCURRENTLY "idx_cloud_agent_code_reviews_completed_at" ON "cloud_agent_code_reviews" USING btree ("completed_at") WHERE "cloud_agent_code_reviews"."completed_at" is not null;--> statement-breakpoint
CREATE INDEX CONCURRENTLY "idx_cloud_agent_code_reviews_started_at" ON "cloud_agent_code_reviews" USING btree ("started_at") WHERE "cloud_agent_code_reviews"."started_at" is not null;--> statement-breakpoint
CREATE INDEX CONCURRENTLY "idx_cloud_agent_code_reviews_terminal_missing_completed_at" ON "cloud_agent_code_reviews" USING btree ("status") WHERE "cloud_agent_code_reviews"."status" IN ('completed', 'failed', 'cancelled', 'interrupted') AND "cloud_agent_code_reviews"."completed_at" IS NULL;--> statement-breakpoint
BEGIN;--> statement-breakpoint
ALTER TABLE "cloud_agent_sessions" ADD CONSTRAINT "cloud_agent_sessions_product_origin_check" CHECK ("cloud_agent_sessions"."product_origin" IS NULL OR "cloud_agent_sessions"."product_origin" IN ('code-review', 'other'));