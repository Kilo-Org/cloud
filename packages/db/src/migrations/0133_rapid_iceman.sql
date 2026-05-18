COMMIT;--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "IDX_app_builder_projects_git_repo_integration" ON "app_builder_projects" USING btree ("git_repo_full_name","git_platform_integration_id");--> statement-breakpoint
BEGIN;
