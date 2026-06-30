ALTER TABLE "cloud_agent_code_reviews" ADD COLUMN "manual_config" jsonb;--> statement-breakpoint
COMMIT;--> statement-breakpoint
CREATE UNIQUE INDEX CONCURRENTLY "UQ_cloud_agent_code_reviews_webhook_integration_repo_pr_sha" ON "cloud_agent_code_reviews" USING btree ("platform_integration_id","repo_full_name","pr_number","head_sha") WHERE "cloud_agent_code_reviews"."manual_config" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX CONCURRENTLY "UQ_cloud_agent_code_reviews_active_provider_publisher" ON "cloud_agent_code_reviews" USING btree ("platform_integration_id","repo_full_name","pr_number") WHERE "cloud_agent_code_reviews"."platform_integration_id" IS NOT NULL
        AND "cloud_agent_code_reviews"."status" IN ('pending', 'queued', 'running')
        AND ("cloud_agent_code_reviews"."manual_config" IS NULL OR "cloud_agent_code_reviews"."manual_config"->>'outputMode' = 'provider');--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "UQ_cloud_agent_code_reviews_repo_pr_sha";--> statement-breakpoint
BEGIN;
