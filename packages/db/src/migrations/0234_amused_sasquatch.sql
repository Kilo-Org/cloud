CREATE TABLE "cloud_agent_worktrees" (
	"worktree_id" text PRIMARY KEY NOT NULL,
	"kilo_user_id" text NOT NULL,
	"organization_id" uuid,
	"name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deletion_started_at" timestamp with time zone,
	"deletion_completed_at" timestamp with time zone,
	"runtime_locations" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"deletion_manifest" jsonb,
	"deleted_session_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	CONSTRAINT "cloud_agent_worktrees_deletion_check" CHECK ("cloud_agent_worktrees"."deletion_completed_at" IS NULL OR ("cloud_agent_worktrees"."deletion_started_at" IS NOT NULL AND "cloud_agent_worktrees"."name" IS NULL AND "cloud_agent_worktrees"."deletion_manifest" IS NULL AND "cloud_agent_worktrees"."runtime_locations" = '[]'::jsonb))
);
--> statement-breakpoint
ALTER TABLE "cli_sessions_v2" ADD COLUMN "cloud_agent_worktree_id" text;--> statement-breakpoint
ALTER TABLE "cloud_agent_worktrees" ADD CONSTRAINT "cloud_agent_worktrees_kilo_user_id_kilocode_users_id_fk" FOREIGN KEY ("kilo_user_id") REFERENCES "public"."kilocode_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cloud_agent_worktrees" ADD CONSTRAINT "cloud_agent_worktrees_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "IDX_cloud_agent_worktrees_owner_scope" ON "cloud_agent_worktrees" USING btree ("kilo_user_id","organization_id");--> statement-breakpoint
COMMIT;--> statement-breakpoint
CREATE INDEX CONCURRENTLY "IDX_cli_sessions_v2_user_worktree_updated" ON "cli_sessions_v2" USING btree ("kilo_user_id","cloud_agent_worktree_id","updated_at") WHERE "cli_sessions_v2"."cloud_agent_worktree_id" is not null;--> statement-breakpoint
BEGIN;
-->  statement-breakpoint
INSERT INTO "cloud_agent_worktrees" ("worktree_id", "kilo_user_id", "organization_id", "created_at", "updated_at")
SELECT "cloud_agent_worktree_id", min("kilo_user_id"), (array_agg("organization_id"))[1], min("created_at"), max("updated_at")
FROM "cli_sessions_v2"
WHERE "cloud_agent_worktree_id" IS NOT NULL
GROUP BY "cloud_agent_worktree_id"
HAVING count(DISTINCT "kilo_user_id") = 1
  AND count(DISTINCT coalesce("organization_id"::text, 'personal')) = 1
ON CONFLICT ("worktree_id") DO NOTHING;
