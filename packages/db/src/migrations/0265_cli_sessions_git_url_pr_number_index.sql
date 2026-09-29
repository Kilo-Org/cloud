COMMIT;--> statement-breakpoint
CREATE INDEX CONCURRENTLY "IDX_cli_sessions_v2_git_url_pr_number" ON "cli_sessions_v2" USING btree ("git_url","pr_number");--> statement-breakpoint
BEGIN;