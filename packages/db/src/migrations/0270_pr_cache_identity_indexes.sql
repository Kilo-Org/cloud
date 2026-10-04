COMMIT;--> statement-breakpoint
CREATE INDEX CONCURRENTLY "IDX_cli_sessions_v2_git_url_pr_number" ON "cli_sessions_v2" USING btree ("git_url","pr_number");--> statement-breakpoint
CREATE UNIQUE INDEX CONCURRENTLY "UQ_github_branch_prs_repo_pr_org" ON "github_branch_pull_requests" USING btree ("git_url","pr_number","owned_by_organization_id") WHERE "github_branch_pull_requests"."pr_number" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX CONCURRENTLY "UQ_github_branch_prs_repo_pr_user" ON "github_branch_pull_requests" USING btree ("git_url","pr_number","owned_by_user_id") WHERE "github_branch_pull_requests"."pr_number" is not null;--> statement-breakpoint
CREATE INDEX CONCURRENTLY "IDX_github_branch_prs_url_pr_number" ON "github_branch_pull_requests" USING btree ("git_url","pr_number");

--> statement-breakpoint
BEGIN;