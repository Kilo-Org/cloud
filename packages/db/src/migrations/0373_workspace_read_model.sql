DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'cloud_agent_worktrees'
      AND column_name = 'closed_session_ids'
  ) THEN
    ALTER TABLE "cloud_agent_worktrees" ADD COLUMN "closed_session_ids" text[] DEFAULT '{}'::text[] NOT NULL;
    ALTER TABLE "cloud_agent_worktrees" ADD COLUMN "tab_order" text[] DEFAULT '{}'::text[] NOT NULL;
    ALTER TABLE "cloud_agent_worktrees" ADD COLUMN "last_activity_at" timestamp with time zone;
  END IF;
END $$;
--> statement-breakpoint
COMMIT;
--> statement-breakpoint
SET statement_timeout = 0;
--> statement-breakpoint
SET lock_timeout = 0;
--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "IDX_cli_sessions_v2_workspace_activity";
--> statement-breakpoint
CREATE INDEX CONCURRENTLY "IDX_cli_sessions_v2_workspace_activity" ON "cli_sessions_v2" USING btree ("kilo_user_id","cloud_agent_worktree_id",coalesce("last_activity_at", "created_at") DESC,"session_id" DESC NULLS LAST) WHERE "cli_sessions_v2"."parent_session_id" IS NULL AND "cli_sessions_v2"."cloud_agent_worktree_id" IS NOT NULL;
--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "IDX_cli_sessions_v2_workspace_active";
--> statement-breakpoint
CREATE INDEX CONCURRENTLY "IDX_cli_sessions_v2_workspace_active" ON "cli_sessions_v2" USING btree ("kilo_user_id","cloud_agent_worktree_id") WHERE "cli_sessions_v2"."parent_session_id" IS NULL AND "cli_sessions_v2"."status" IN ('question', 'permission', 'busy', 'retry');
--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "IDX_cloud_agent_session_runs_latest";
--> statement-breakpoint
CREATE INDEX CONCURRENTLY "IDX_cloud_agent_session_runs_latest" ON "cloud_agent_session_runs" USING btree ("cloud_agent_session_id","queued_at" DESC NULLS LAST,"message_id" DESC NULLS LAST);
--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "IDX_cloud_agent_session_runs_open";
--> statement-breakpoint
CREATE INDEX CONCURRENTLY "IDX_cloud_agent_session_runs_open" ON "cloud_agent_session_runs" USING btree ("cloud_agent_session_id","queued_at" DESC NULLS LAST,"message_id" DESC NULLS LAST) WHERE "cloud_agent_session_runs"."status" IN ('queued', 'accepted');
--> statement-breakpoint
RESET lock_timeout;
--> statement-breakpoint
RESET statement_timeout;
--> statement-breakpoint
BEGIN;
