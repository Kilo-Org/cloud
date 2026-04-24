ALTER TABLE "agent_configs" ADD COLUMN "runtime_state" jsonb DEFAULT '{}'::jsonb;

-- Backfill last_synced_at from existing findings so owners don't lose their
-- "Last synced" timestamp until the next full sync completes.
UPDATE "agent_configs" ac
SET "runtime_state" = jsonb_set(
  COALESCE(ac."runtime_state", '{}'::jsonb),
  '{last_synced_at}',
  to_jsonb(sf.last_synced)
)
FROM (
  SELECT
    sf_inner."owned_by_organization_id",
    sf_inner."owned_by_user_id",
    MAX(sf_inner."last_synced_at") AS last_synced
  FROM "security_findings" sf_inner
  GROUP BY sf_inner."owned_by_organization_id", sf_inner."owned_by_user_id"
) sf
WHERE ac."agent_type" = 'security_scan'
  AND ac."platform" = 'github'
  AND (
    (ac."owned_by_organization_id" IS NOT NULL AND ac."owned_by_organization_id" = sf."owned_by_organization_id")
    OR
    (ac."owned_by_user_id" IS NOT NULL AND ac."owned_by_user_id" = sf."owned_by_user_id")
  );
