COMMIT;--> statement-breakpoint
-- DROP INDEX CONCURRENTLY IF EXISTS immediately before each CREATE makes this
-- migration retry-safe: if a concurrent build fails or is interrupted, Postgres
-- can leave an INVALID index under this exact name, and a blind retry of
-- CREATE UNIQUE INDEX CONCURRENTLY would then fail with "already exists"
-- instead of rebuilding it. Dropping first (a no-op when the index doesn't
-- exist yet, and a clean removal of a leftover invalid index otherwise) makes
-- every retry of this file converge to the same end state. Per
-- packages/db/AGENTS.md, CREATE ... CONCURRENTLY IF NOT EXISTS is not used
-- here since it would leave a leftover invalid index in place unrebuilt.
DROP INDEX CONCURRENTLY IF EXISTS "UQ_platform_integrations_github_org_canonical";--> statement-breakpoint
CREATE UNIQUE INDEX CONCURRENTLY "UQ_platform_integrations_github_org_canonical" ON "platform_integrations" USING btree ("owned_by_organization_id","github_installation_id") WHERE "platform_integrations"."platform" = 'github' AND "platform_integrations"."owned_by_organization_id" IS NOT NULL AND "platform_integrations"."github_installation_id" IS NOT NULL;--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "UQ_platform_integrations_github_user_canonical";--> statement-breakpoint
CREATE UNIQUE INDEX CONCURRENTLY "UQ_platform_integrations_github_user_canonical" ON "platform_integrations" USING btree ("owned_by_user_id","github_installation_id") WHERE "platform_integrations"."platform" = 'github' AND "platform_integrations"."owned_by_user_id" IS NOT NULL AND "platform_integrations"."github_installation_id" IS NOT NULL;--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "UQ_platform_integrations_github_org_pending_target";--> statement-breakpoint
CREATE UNIQUE INDEX CONCURRENTLY "UQ_platform_integrations_github_org_pending_target" ON "platform_integrations" USING btree ("owned_by_organization_id","platform","github_app_type","platform_account_id") WHERE "platform_integrations"."platform" = 'github' AND "platform_integrations"."owned_by_organization_id" IS NOT NULL AND "platform_integrations"."integration_status" = 'pending' AND "platform_integrations"."platform_installation_id" IS NULL AND "platform_integrations"."platform_account_id" IS NOT NULL;--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "UQ_platform_integrations_github_user_pending_target";--> statement-breakpoint
CREATE UNIQUE INDEX CONCURRENTLY "UQ_platform_integrations_github_user_pending_target" ON "platform_integrations" USING btree ("owned_by_user_id","platform","github_app_type","platform_account_id") WHERE "platform_integrations"."platform" = 'github' AND "platform_integrations"."owned_by_user_id" IS NOT NULL AND "platform_integrations"."integration_status" = 'pending' AND "platform_integrations"."platform_installation_id" IS NULL AND "platform_integrations"."platform_account_id" IS NOT NULL;--> statement-breakpoint
BEGIN;