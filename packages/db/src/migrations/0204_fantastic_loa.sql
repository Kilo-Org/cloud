-- Backfill: survey duplicates and resolve them.
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
END $$;
-->  statement-breakpoint
CREATE UNIQUE INDEX "UQ_platform_integrations_github_platform_inst" ON "platform_integrations" USING btree ("platform","github_app_type","platform_installation_id") WHERE "platform_integrations"."platform" = 'github' AND "platform_integrations"."platform_installation_id" IS NOT NULL;