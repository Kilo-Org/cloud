ALTER TABLE "cloud_agent_code_reviews" ADD COLUMN IF NOT EXISTS "manual_config" jsonb;--> statement-breakpoint
DROP INDEX IF EXISTS "UQ_cloud_agent_code_reviews_webhook_integration_repo_pr_sha";--> statement-breakpoint
DROP INDEX IF EXISTS "UQ_cloud_agent_code_reviews_active_provider_publisher";--> statement-breakpoint
WITH ranked AS (
        SELECT "id",
                row_number() OVER (
                        PARTITION BY "platform_integration_id", "repo_full_name", "pr_number"
                        ORDER BY "created_at" DESC, "id" DESC
                ) AS rn
        FROM "cloud_agent_code_reviews"
        WHERE "platform_integration_id" IS NOT NULL
                AND "status" IN ('pending', 'queued', 'running')
                AND ("manual_config" IS NULL OR "manual_config"->>'outputMode' = 'provider')
)
UPDATE "cloud_agent_code_reviews" AS r
SET "status" = 'cancelled',
        "terminal_reason" = 'superseded',
        "error_message" = 'Superseded by newer review (backfill)',
        "completed_at" = now(),
        "updated_at" = now()
FROM ranked
WHERE r."id" = ranked."id" AND ranked.rn > 1;--> statement-breakpoint
UPDATE "cloud_agent_code_review_attempts" AS a
SET "status" = 'cancelled',
        "terminal_reason" = 'superseded',
        "error_message" = 'Superseded by newer review (backfill)',
        "completed_at" = now(),
        "updated_at" = now()
FROM "cloud_agent_code_reviews" AS r
WHERE a."code_review_id" = r."id"
        AND r."status" = 'cancelled'
        AND r."terminal_reason" = 'superseded'
        AND a."status" IN ('pending', 'queued', 'running');--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_cloud_agent_code_reviews_webhook_integration_repo_pr_sha" ON "cloud_agent_code_reviews" USING btree ("platform_integration_id","repo_full_name","pr_number","head_sha") WHERE "cloud_agent_code_reviews"."manual_config" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_cloud_agent_code_reviews_active_provider_publisher" ON "cloud_agent_code_reviews" USING btree ("platform_integration_id","repo_full_name","pr_number") WHERE "cloud_agent_code_reviews"."platform_integration_id" IS NOT NULL
        AND "cloud_agent_code_reviews"."status" IN ('pending', 'queued', 'running')
        AND ("cloud_agent_code_reviews"."manual_config" IS NULL OR "cloud_agent_code_reviews"."manual_config"->>'outputMode' = 'provider');--> statement-breakpoint
DROP INDEX IF EXISTS "UQ_cloud_agent_code_reviews_repo_pr_sha";
