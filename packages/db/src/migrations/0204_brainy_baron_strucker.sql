CREATE TABLE "device_refresh_tokens" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"device_session_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "device_sessions" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"kilo_user_id" text NOT NULL,
	"device_auth_request_id" uuid,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_reason" text
);
--> statement-breakpoint
CREATE TABLE "github_install_states" (
	"token" text PRIMARY KEY NOT NULL,
	"kilo_user_id" text NOT NULL,
	"owner_type" text NOT NULL,
	"owner_id" text NOT NULL,
	"github_app_type" text NOT NULL,
	"return_to" text,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "github_install_states_owner_type_check" CHECK ("github_install_states"."owner_type" IN ('org', 'user'))
);
--> statement-breakpoint
ALTER TABLE "device_auth_requests" ADD COLUMN "consumed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "device_auth_requests" ADD COLUMN "user_code" text;--> statement-breakpoint
ALTER TABLE "device_auth_requests" ADD COLUMN "device_code_hash" text;--> statement-breakpoint
ALTER TABLE "magic_link_tokens" ADD COLUMN "reserved_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "magic_link_tokens" ADD COLUMN "challenge_id" uuid;--> statement-breakpoint
ALTER TABLE "device_refresh_tokens" ADD CONSTRAINT "device_refresh_tokens_device_session_id_device_sessions_id_fk" FOREIGN KEY ("device_session_id") REFERENCES "public"."device_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_sessions" ADD CONSTRAINT "device_sessions_kilo_user_id_kilocode_users_id_fk" FOREIGN KEY ("kilo_user_id") REFERENCES "public"."kilocode_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_install_states" ADD CONSTRAINT "github_install_states_kilo_user_id_kilocode_users_id_fk" FOREIGN KEY ("kilo_user_id") REFERENCES "public"."kilocode_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "IDX_device_refresh_tokens_device_session_id" ON "device_refresh_tokens" USING btree ("device_session_id");--> statement-breakpoint
CREATE INDEX "IDX_device_refresh_tokens_expires_at" ON "device_refresh_tokens" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "IDX_device_sessions_kilo_user_id" ON "device_sessions" USING btree ("kilo_user_id");--> statement-breakpoint
CREATE INDEX "IDX_device_sessions_revoked_at" ON "device_sessions" USING btree ("revoked_at");--> statement-breakpoint
CREATE INDEX "IDX_github_install_states_expires_at" ON "github_install_states" USING btree ("expires_at");--> statement-breakpoint
COMMIT;--> statement-breakpoint
CREATE UNIQUE INDEX CONCURRENTLY "UQ_device_auth_requests_device_code_hash" ON "device_auth_requests" USING btree ("device_code_hash") WHERE "device_auth_requests"."device_code_hash" IS NOT NULL;--> statement-breakpoint
CREATE INDEX CONCURRENTLY "IDX_device_auth_requests_user_code" ON "device_auth_requests" USING btree ("user_code") WHERE "device_auth_requests"."user_code" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX CONCURRENTLY "UQ_magic_link_tokens_challenge_id" ON "magic_link_tokens" USING btree ("challenge_id") WHERE "magic_link_tokens"."challenge_id" IS NOT NULL;--> statement-breakpoint
BEGIN;--> statement-breakpoint
-- Backfill: survey duplicate GitHub installation rows and resolve them.
-- Rows grouped by (platform, github_app_type, platform_installation_id)
-- where platform = 'github' and platform_installation_id is not null.
-- Winner: newest installed_at, tie-broken by greatest id.
-- Losers: platform_installation_id set to NULL, integration_status = 'suspended'.
DO $$
DECLARE
  dup_group RECORD;
  winner RECORD;
  loser RECORD;
  dup_count integer;
BEGIN
  RAISE NOTICE '[github-dedup] Scanning for duplicate GitHub installation rows...';

  SELECT count(*) INTO dup_count FROM (
    SELECT platform, github_app_type, platform_installation_id
    FROM platform_integrations
    WHERE platform = 'github'
      AND platform_installation_id IS NOT NULL
    GROUP BY platform, github_app_type, platform_installation_id
    HAVING count(*) > 1
  ) sub;

  RAISE NOTICE '[github-dedup] Found % duplicate groups.', dup_count;

  FOR dup_group IN
    SELECT platform, github_app_type, platform_installation_id
    FROM platform_integrations
    WHERE platform = 'github'
      AND platform_installation_id IS NOT NULL
    GROUP BY platform, github_app_type, platform_installation_id
    HAVING count(*) > 1
  LOOP
    -- Identify the winner: newest installed_at, tie-broken by greatest id.
    SELECT id, installed_at INTO winner
    FROM platform_integrations
    WHERE platform = 'github'
      AND github_app_type = dup_group.github_app_type
      AND platform_installation_id = dup_group.platform_installation_id
    ORDER BY installed_at DESC NULLS LAST, id DESC
    LIMIT 1;

    RAISE NOTICE '[github-dedup] Group (app_type=%, inst_id=%): winner id=%', dup_group.github_app_type, dup_group.platform_installation_id, winner.id;

    -- Null the installation id and suspend every loser.
    FOR loser IN
      SELECT id, platform_installation_id, owned_by_user_id, owned_by_organization_id
      FROM platform_integrations
      WHERE platform = 'github'
        AND github_app_type = dup_group.github_app_type
        AND platform_installation_id = dup_group.platform_installation_id
        AND id != winner.id
    LOOP
      UPDATE platform_integrations
      SET platform_installation_id = NULL,
          integration_status = 'suspended',
          suspended_at = now(),
          suspended_by = 'migration-0204-github-dedup',
          metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
            'github_dedup', jsonb_build_object(
              'suspended_at', now(),
              'reason', 'Duplicate installation resolved by migration 0204',
              'original_installation_id', loser.platform_installation_id
            )
          ),
          updated_at = now()
      WHERE id = loser.id;

      RAISE NOTICE '[github-dedup] Suspended loser id=%, original_installation_id=%', loser.id, loser.platform_installation_id;
    END LOOP;
  END LOOP;
END $$;--> statement-breakpoint
COMMIT;--> statement-breakpoint
CREATE UNIQUE INDEX CONCURRENTLY "UQ_platform_integrations_github_platform_inst" ON "platform_integrations" USING btree ("platform","github_app_type","platform_installation_id") WHERE "platform_integrations"."platform" = 'github' AND "platform_integrations"."platform_installation_id" IS NOT NULL;--> statement-breakpoint
BEGIN;
