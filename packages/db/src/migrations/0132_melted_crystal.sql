COMMIT;--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "IDX_app_builder_projects_git_repo_integration" ON "app_builder_projects" USING btree ("git_repo_full_name","git_platform_integration_id") WHERE "app_builder_projects"."git_repo_full_name" is not null;--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_microdollar_usage_metadata_session_id_created_at" ON "microdollar_usage_metadata" USING btree ("session_id","created_at") WHERE "microdollar_usage_metadata"."session_id" is not null;--> statement-breakpoint
BEGIN;
