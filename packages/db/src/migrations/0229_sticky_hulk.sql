COMMIT;--> statement-breakpoint
CREATE INDEX CONCURRENTLY "IDX_cli_sessions_v2_user_created" ON "cli_sessions_v2" USING btree ("kilo_user_id","created_at");--> statement-breakpoint
CREATE INDEX CONCURRENTLY "IDX_github_branch_prs_url_branch" ON "github_branch_pull_requests" USING btree ("git_url","git_branch");--> statement-breakpoint
BEGIN;