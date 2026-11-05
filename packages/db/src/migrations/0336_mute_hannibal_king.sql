-- The first transaction is atomic, so the operation-key column marks whether all of it already applied.
-- A failed concurrent index build commits this part without recording the migration.
DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM information_schema.columns
		WHERE table_schema = 'public' AND table_name = 'cloud_agent_code_reviews' AND column_name = 'manual_operation_key'
	) THEN
		ALTER TABLE "cloud_agent_code_reviews" ADD COLUMN "manual_operation_key" text;
	END IF;
END $$;--> statement-breakpoint
COMMIT;--> statement-breakpoint
-- The server default statement_timeout can cancel these concurrent builds in production.
SET statement_timeout = 0;--> statement-breakpoint
-- A cancelled build leaves an INVALID index under its name; drop each so a retry rebuilds it.
DROP INDEX CONCURRENTLY IF EXISTS "UQ_cloud_agent_code_reviews_user_manual_operation_key";--> statement-breakpoint
CREATE UNIQUE INDEX CONCURRENTLY "UQ_cloud_agent_code_reviews_user_manual_operation_key" ON "cloud_agent_code_reviews" USING btree ("owned_by_user_id","manual_operation_key") WHERE "cloud_agent_code_reviews"."owned_by_user_id" IS NOT NULL AND "cloud_agent_code_reviews"."manual_operation_key" IS NOT NULL;--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "UQ_cloud_agent_code_reviews_org_manual_operation_key";--> statement-breakpoint
CREATE UNIQUE INDEX CONCURRENTLY "UQ_cloud_agent_code_reviews_org_manual_operation_key" ON "cloud_agent_code_reviews" USING btree ("owned_by_organization_id","manual_operation_key") WHERE "cloud_agent_code_reviews"."owned_by_organization_id" IS NOT NULL AND "cloud_agent_code_reviews"."manual_operation_key" IS NOT NULL;--> statement-breakpoint
RESET statement_timeout;--> statement-breakpoint
BEGIN;
