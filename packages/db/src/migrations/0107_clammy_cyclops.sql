CREATE TABLE "cli_session_pull_requests" (
	"session_id" text PRIMARY KEY NOT NULL,
	"pr_url" text,
	"pr_number" integer,
	"pr_state" text,
	"pr_title" text,
	"pr_head_sha" text,
	"pr_last_synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "cli_sessions_v2_git_url_branch_idx" ON "cli_sessions_v2" USING btree ("git_url","git_branch");--> statement-breakpoint
CREATE INDEX "cli_sessions_v2_git_branch_idx" ON "cli_sessions_v2" USING btree ("git_branch");--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_cli_sessions_v2_session_id" ON "cli_sessions_v2" USING btree ("session_id");--> statement-breakpoint
ALTER TABLE "cli_session_pull_requests" ADD CONSTRAINT "cli_session_pull_requests_session_id_cli_sessions_v2_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."cli_sessions_v2"("session_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cli_session_pull_requests_pr_state_idx" ON "cli_session_pull_requests" USING btree ("pr_state");--> statement-breakpoint
CREATE INDEX "cli_session_pull_requests_pr_number_idx" ON "cli_session_pull_requests" USING btree ("pr_number");
