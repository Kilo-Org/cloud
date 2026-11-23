COMMIT;
--> statement-breakpoint
BEGIN;
--> statement-breakpoint
SET LOCAL lock_timeout = '1s';
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_attribute
    WHERE attrelid = to_regclass('public.cloud_agent_worktrees')
      AND attname = 'closed_session_ids' AND NOT attisdropped
  ) THEN
    RETURN;
  END IF;
  FOR attempt IN 1..10 LOOP
    BEGIN
      ALTER TABLE "cloud_agent_worktrees" ADD COLUMN "closed_session_ids" text[] DEFAULT '{}'::text[] NOT NULL;
      RETURN;
    EXCEPTION WHEN lock_not_available THEN
      IF attempt = 10 THEN RAISE; END IF;
      PERFORM pg_sleep(least(attempt, 5));
    END;
  END LOOP;
END $$;
--> statement-breakpoint
COMMIT;
--> statement-breakpoint
BEGIN;
--> statement-breakpoint
SET LOCAL lock_timeout = '1s';
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_attribute
    WHERE attrelid = to_regclass('public.cloud_agent_worktrees')
      AND attname = 'tab_order' AND NOT attisdropped
  ) THEN
    RETURN;
  END IF;
  FOR attempt IN 1..10 LOOP
    BEGIN
      ALTER TABLE "cloud_agent_worktrees" ADD COLUMN "tab_order" text[] DEFAULT '{}'::text[] NOT NULL;
      RETURN;
    EXCEPTION WHEN lock_not_available THEN
      IF attempt = 10 THEN RAISE; END IF;
      PERFORM pg_sleep(least(attempt, 5));
    END;
  END LOOP;
END $$;
--> statement-breakpoint
COMMIT;
--> statement-breakpoint
BEGIN;
--> statement-breakpoint
SET LOCAL lock_timeout = '1s';
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_attribute
    WHERE attrelid = to_regclass('public.cloud_agent_worktrees')
      AND attname = 'last_activity_at' AND NOT attisdropped
  ) THEN
    RETURN;
  END IF;
  FOR attempt IN 1..10 LOOP
    BEGIN
      ALTER TABLE "cloud_agent_worktrees" ADD COLUMN "last_activity_at" timestamp with time zone;
      RETURN;
    EXCEPTION WHEN lock_not_available THEN
      IF attempt = 10 THEN RAISE; END IF;
      PERFORM pg_sleep(least(attempt, 5));
    END;
  END LOOP;
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
CREATE INDEX CONCURRENTLY "IDX_cli_sessions_v2_workspace_activity" ON "cli_sessions_v2" USING btree ("kilo_user_id","cloud_agent_worktree_id",coalesce("last_activity_at", "created_at") DESC,"session_id" DESC NULLS LAST) WHERE "cli_sessions_v2"."parent_session_id" IS NULL AND "cli_sessions_v2"."cloud_agent_worktree_id" IS NOT NULL;--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "IDX_cli_sessions_v2_workspace_active";
--> statement-breakpoint
CREATE INDEX CONCURRENTLY "IDX_cli_sessions_v2_workspace_active" ON "cli_sessions_v2" USING btree ("kilo_user_id","cloud_agent_worktree_id") WHERE "cli_sessions_v2"."parent_session_id" IS NULL AND "cli_sessions_v2"."status" IN ('question', 'permission', 'busy', 'retry');--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "IDX_cloud_agent_session_runs_latest";
--> statement-breakpoint
CREATE INDEX CONCURRENTLY "IDX_cloud_agent_session_runs_latest" ON "cloud_agent_session_runs" USING btree ("cloud_agent_session_id","queued_at" DESC NULLS LAST,"message_id" DESC NULLS LAST);--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "IDX_cloud_agent_session_runs_open";
--> statement-breakpoint
CREATE INDEX CONCURRENTLY "IDX_cloud_agent_session_runs_open" ON "cloud_agent_session_runs" USING btree ("cloud_agent_session_id","queued_at" DESC NULLS LAST,"message_id" DESC NULLS LAST) WHERE "cloud_agent_session_runs"."status" IN ('queued', 'accepted');
--> statement-breakpoint
RESET lock_timeout;
--> statement-breakpoint
RESET statement_timeout;
--> statement-breakpoint
BEGIN;
