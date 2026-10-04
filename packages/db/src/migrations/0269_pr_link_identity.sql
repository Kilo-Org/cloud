DROP INDEX "UQ_github_branch_prs_org";--> statement-breakpoint
DROP INDEX "UQ_github_branch_prs_user";--> statement-breakpoint
DROP INDEX "IDX_github_branch_prs_url_branch";--> statement-breakpoint
ALTER TABLE "cli_sessions_v2" ADD COLUMN "pr_head_ref" text;--> statement-breakpoint
ALTER TABLE "cli_sessions_v2" ADD COLUMN "pr_head_sha" text;--> statement-breakpoint
ALTER TABLE "cli_sessions_v2" ADD COLUMN "pr_link_verified_at" timestamp with time zone;--> statement-breakpoint
COMMIT;--> statement-breakpoint
CREATE INDEX CONCURRENTLY "IDX_cli_sessions_v2_git_url_pr_number" ON "cli_sessions_v2" USING btree ("git_url","pr_number");--> statement-breakpoint
BEGIN;--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_github_branch_prs_org" ON "github_branch_pull_requests" USING btree ("git_url","pr_number","owned_by_organization_id") WHERE "github_branch_pull_requests"."pr_number" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_github_branch_prs_user" ON "github_branch_pull_requests" USING btree ("git_url","pr_number","owned_by_user_id") WHERE "github_branch_pull_requests"."pr_number" is not null;--> statement-breakpoint
COMMIT;--> statement-breakpoint
CREATE INDEX CONCURRENTLY "IDX_github_branch_prs_url_branch" ON "github_branch_pull_requests" USING btree ("git_url","pr_number");
--> statement-breakpoint
BEGIN;