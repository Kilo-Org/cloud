-- A failed concurrent build commits this first transaction without recording the migration.
-- Its first column marks that all of this atomic DDL already applied.
DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM information_schema.columns
		WHERE table_schema = 'public' AND table_name = 'cloud_agent_worktrees' AND column_name = 'git_url'
	) THEN
ALTER TABLE "cloud_agent_worktrees" ADD COLUMN "git_url" text;
ALTER TABLE "cloud_agent_worktrees" ADD COLUMN "git_branch" text;
	END IF;
END $$;
--> statement-breakpoint
COMMIT;
--> statement-breakpoint
SET statement_timeout = 0;
--> statement-breakpoint
SET lock_timeout = 0;
--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "IDX_cloud_agent_worktrees_git_url_branch";
--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "IDX_github_branch_prs_url_branch";
--> statement-breakpoint
CREATE INDEX CONCURRENTLY "IDX_cloud_agent_worktrees_git_url_branch" ON "cloud_agent_worktrees" USING btree ("git_url","git_branch") WHERE "cloud_agent_worktrees"."git_branch" is not null;--> statement-breakpoint
CREATE INDEX CONCURRENTLY "IDX_github_branch_prs_url_branch" ON "github_branch_pull_requests" USING btree ("git_url","git_branch") WHERE "github_branch_pull_requests"."pr_number" is not null;
--> statement-breakpoint
RESET lock_timeout;
--> statement-breakpoint
RESET statement_timeout;
--> statement-breakpoint
BEGIN;
