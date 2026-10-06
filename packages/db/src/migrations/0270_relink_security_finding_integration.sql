-- One-time repair: relink security findings whose platform_integration_id is NULL or
-- points at an integration that is no longer the owner's current active GitHub
-- workflow app (for example after a GitHub App reinstall deleted or replaced the old
-- integration row). Dismissals validate the finding's stored integration, so a stale
-- link makes older findings permanently undismissable even though the web admission
-- check passes against the owner's current integration.
--
-- Conservative by design: only owners with exactly one clearly-current active GitHub
-- integration are repaired, using the same selection logic as getOwnerConfig in
-- services/security-sync/src/sync.ts. Ambiguous owners (zero or multiple candidates)
-- are left untouched rather than guessed. The sync path relinks the rest on the next
-- successful sync.
WITH active_github_integrations AS (
  SELECT
    id,
    owned_by_organization_id,
    owned_by_user_id
  FROM platform_integrations
  WHERE platform = 'github'
    AND github_connection_role = 'workflow'
    AND integration_type = 'app'
    AND integration_status = 'active'
    AND suspended_at IS NULL
    AND github_disconnected_at IS NULL
    AND platform_installation_id IS NOT NULL
    AND COALESCE(permissions ->> 'vulnerability_alerts', '') IN ('read', 'write')
),
org_targets AS (
  SELECT
    owned_by_organization_id AS owner_id,
    (array_agg(id))[1] AS integration_id
  FROM active_github_integrations
  WHERE owned_by_organization_id IS NOT NULL
  GROUP BY owned_by_organization_id
  HAVING count(*) = 1
),
user_targets AS (
  SELECT
    owned_by_user_id AS owner_id,
    (array_agg(id))[1] AS integration_id
  FROM active_github_integrations
  WHERE owned_by_user_id IS NOT NULL
  GROUP BY owned_by_user_id
  HAVING count(*) = 1
),
repairs AS (
  SELECT
    finding.id AS finding_id,
    COALESCE(org_targets.integration_id, user_targets.integration_id) AS integration_id
  FROM security_findings AS finding
  LEFT JOIN org_targets ON org_targets.owner_id = finding.owned_by_organization_id
  LEFT JOIN user_targets ON user_targets.owner_id = finding.owned_by_user_id
  WHERE COALESCE(org_targets.integration_id, user_targets.integration_id) IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM active_github_integrations AS active
      WHERE active.id = finding.platform_integration_id
        AND active.owned_by_organization_id IS NOT DISTINCT FROM finding.owned_by_organization_id
        AND active.owned_by_user_id IS NOT DISTINCT FROM finding.owned_by_user_id
    )
)
UPDATE security_findings AS finding
SET
  platform_integration_id = repairs.integration_id,
  updated_at = now()
FROM repairs
WHERE finding.id = repairs.finding_id
  AND finding.platform_integration_id IS DISTINCT FROM repairs.integration_id;
