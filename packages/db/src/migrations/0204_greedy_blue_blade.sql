CREATE TABLE "slack_workspace_installations" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"team_id" text NOT NULL,
	"team_name" text,
	"bot_user_id" text,
	"bot_token" text NOT NULL,
	"scopes" text[],
	"last_installed_by_user_id" text,
	"installed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "slack_workspace_installations" ADD CONSTRAINT "slack_workspace_installations_last_installed_by_user_id_kilocode_users_id_fk" FOREIGN KEY ("last_installed_by_user_id") REFERENCES "public"."kilocode_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_slack_workspace_installations_team_id" ON "slack_workspace_installations" USING btree ("team_id");-->  statement-breakpoint
-- Seed the workspace-level installation store from the existing per-integration
-- copies of the Slack bot token, so the new read path resolves a token for every
-- workspace that is already connected.
--
-- UQ_platform_integrations_slack_platform_inst still limits a workspace to one
-- owner, so at most one row can supply each team_id. DISTINCT ON with an explicit
-- ORDER BY keeps the result deterministic regardless.
--
-- Rows detached by 0108_wise_psylocke (platform_installation_id set to NULL) are
-- excluded by the IS NOT NULL filter; their tokens are stale duplicates.
--
-- last_installed_by_user_id is deliberately left NULL: the closest source column
-- (platform_integrations.created_by_user_id) has no foreign key and may hold ids
-- that no longer exist in kilocode_users, which would violate the new FK.
INSERT INTO "slack_workspace_installations" (
  "team_id",
  "team_name",
  "bot_user_id",
  "bot_token",
  "scopes",
  "installed_at"
)
SELECT DISTINCT ON (pi."platform_installation_id")
  pi."platform_installation_id",
  pi."platform_account_login",
  pi."metadata"->>'bot_user_id',
  pi."metadata"->>'access_token',
  pi."scopes",
  pi."installed_at"
FROM "platform_integrations" pi
WHERE pi."platform" = 'slack'
  AND pi."platform_installation_id" IS NOT NULL
  AND pi."metadata"->>'access_token' IS NOT NULL
ORDER BY pi."platform_installation_id", pi."updated_at" DESC
ON CONFLICT ("team_id") DO NOTHING;