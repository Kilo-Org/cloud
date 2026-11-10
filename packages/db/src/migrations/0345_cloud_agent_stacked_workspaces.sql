-- A failed concurrent build commits this first transaction without recording the migration.
-- Its settings table marks that all of this atomic DDL already applied.
DO $$
BEGIN
	IF to_regclass('public.cloud_agent_user_settings') IS NULL THEN
CREATE TABLE "cloud_agent_user_settings" (
	"kilo_user_id" text PRIMARY KEY NOT NULL,
	"workspace_order" text DEFAULT 'manual' NOT NULL,
	"builtin_agents" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cloud_agent_user_settings_workspace_order_check" CHECK ("cloud_agent_user_settings"."workspace_order" IN ('manual', 'created', 'activity'))
);
ALTER TABLE "cloud_agent_workspace_folders" ADD COLUMN "kind" text DEFAULT 'manual' NOT NULL;
ALTER TABLE "cloud_agent_workspace_folders" ADD COLUMN "smart_preset" text;
ALTER TABLE "cloud_agent_workspace_folders" ADD COLUMN "sort_mode" text DEFAULT 'manual' NOT NULL;
ALTER TABLE "cloud_agent_worktrees" ADD COLUMN "parent_worktree_id" text;
ALTER TABLE "cloud_agent_worktrees" ADD COLUMN "base_branch" text;
ALTER TABLE "cloud_agent_worktrees" ADD COLUMN "base_sha" text;
ALTER TABLE "cloud_agent_worktrees" ADD COLUMN "sidebar_position" text;
ALTER TABLE "github_branch_pull_requests" ADD COLUMN "pr_base_ref" text;
ALTER TABLE "github_branch_pull_requests" ADD COLUMN "stack_number" integer;
ALTER TABLE "github_branch_pull_requests" ADD COLUMN "stack_position" integer;
ALTER TABLE "github_branch_pull_requests" ADD COLUMN "stack_size" integer;
ALTER TABLE "cloud_agent_user_settings" ADD CONSTRAINT "cloud_agent_user_settings_kilo_user_id_kilocode_users_id_fk" FOREIGN KEY ("kilo_user_id") REFERENCES "public"."kilocode_users"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "cloud_agent_worktrees" ADD CONSTRAINT "cloud_agent_worktrees_parent_worktree_id_cloud_agent_worktrees_worktree_id_fk" FOREIGN KEY ("parent_worktree_id") REFERENCES "public"."cloud_agent_worktrees"("worktree_id") ON DELETE set null ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
COMMIT;
--> statement-breakpoint
SET statement_timeout = 0;
--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "IDX_cli_sessions_v2_user_activity";
--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "UQ_cloud_agent_workspace_folders_smart_preset";
--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "IDX_cloud_agent_worktrees_parent_worktree_id";
--> statement-breakpoint
CREATE INDEX CONCURRENTLY "IDX_cli_sessions_v2_user_activity" ON "cli_sessions_v2" USING btree ("kilo_user_id",coalesce("last_activity_at", "created_at"));
--> statement-breakpoint
CREATE UNIQUE INDEX CONCURRENTLY "UQ_cloud_agent_workspace_folders_smart_preset" ON "cloud_agent_workspace_folders" USING btree ("kilo_user_id",coalesce("organization_id"::text, ''),"smart_preset") WHERE "cloud_agent_workspace_folders"."kind" = 'smart';
--> statement-breakpoint
CREATE INDEX CONCURRENTLY "IDX_cloud_agent_worktrees_parent_worktree_id" ON "cloud_agent_worktrees" USING btree ("parent_worktree_id") WHERE "cloud_agent_worktrees"."parent_worktree_id" is not null;
--> statement-breakpoint
RESET statement_timeout;
--> statement-breakpoint
BEGIN;
--> statement-breakpoint
ALTER TABLE "cloud_agent_workspace_folders" ADD CONSTRAINT "cloud_agent_workspace_folders_kind_check" CHECK ("cloud_agent_workspace_folders"."kind" IN ('manual', 'smart'));--> statement-breakpoint
ALTER TABLE "cloud_agent_workspace_folders" ADD CONSTRAINT "cloud_agent_workspace_folders_smart_preset_check" CHECK (("cloud_agent_workspace_folders"."kind" = 'manual' AND "cloud_agent_workspace_folders"."smart_preset" IS NULL) OR ("cloud_agent_workspace_folders"."kind" = 'smart' AND "cloud_agent_workspace_folders"."smart_preset" IS NOT NULL AND "cloud_agent_workspace_folders"."smart_preset" IN ('needs_you', 'in_review', 'done')));--> statement-breakpoint
ALTER TABLE "cloud_agent_workspace_folders" ADD CONSTRAINT "cloud_agent_workspace_folders_sort_mode_check" CHECK ("cloud_agent_workspace_folders"."sort_mode" IN ('manual', 'created', 'activity'));
-->  statement-breakpoint
INSERT INTO "cloud_agent_user_settings" ("kilo_user_id", "workspace_order")
SELECT DISTINCT "kilo_user_id", 'activity'
FROM "cloud_agent_worktrees"
ON CONFLICT DO NOTHING;
-->  statement-breakpoint
INSERT INTO "cloud_agent_user_settings" ("kilo_user_id", "builtin_agents")
SELECT "user_id", "agents"
FROM "cloud_agent_builtin_agent_settings"
ON CONFLICT ("kilo_user_id") DO UPDATE SET "builtin_agents" = EXCLUDED."builtin_agents";
-->  statement-breakpoint
UPDATE "cloud_agent_workspace_folders" SET "sort_mode" = 'activity';
