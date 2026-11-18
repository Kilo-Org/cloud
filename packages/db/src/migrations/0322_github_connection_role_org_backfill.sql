-- Custom SQL migration file, put your code below! --

-- 0258 added platform_integrations.github_connection_role and 0259 assigned it,
-- but 0259 only reclassified identities it could rank without ambiguity. An
-- organization-owned GitHub App installation that stayed roleless is still a
-- healthy installation: githubApps.getInstallation, the repository pickers and
-- every installation surface report the organization as connected, and the
-- organization's Security Agent findings are already stored for it. Only the
-- lookups that require github_connection_role = 'workflow' miss it, so the
-- Security Agent entry renders its connect-GitHub setup state and the findings
-- dashboard, findings list and dismiss sheet are unreachable.
--
-- Give those rows the workflow role so the status gate and the operational
-- lookups resolve the same installation. Only an unambiguous, healthy,
-- organization-owned installation is reclassified:
--
--   * one candidate per installation identity (oldest created_at), so the role
--     cannot collide with UQ_platform_integrations_github_workflow_identity;
--   * no other row already claims the workflow role for the identity or for the
--     same canonical installation, so UQ_platform_integrations_github_workflow_canonical
--     and existing ownership stay untouched;
--   * the installation is real: bound to a live canonical
--     github_app_installations row, or provably not canonicalized yet.
--
-- Personal installations, pending rows, deduplicated rows, disconnected or
-- otherwise unhealthy rows and shadowed identities are left exactly as they are.
WITH candidate AS (
  SELECT
    pi.id,
    pi.created_at,
    COALESCE(pi.github_app_type, 'standard') AS identity_app_type,
    pi.platform_installation_id AS identity_installation_id
  FROM platform_integrations pi
  WHERE pi.platform = 'github'
    AND pi.integration_type = 'app'
    AND pi.github_connection_role IS NULL
    AND pi.owned_by_organization_id IS NOT NULL
    AND pi.platform_installation_id ~ '^[1-9][0-9]*$'
    AND (pi.github_app_type IN ('standard', 'lite') OR pi.github_app_type IS NULL)
    AND NOT (COALESCE(pi.metadata, '{}'::jsonb) ? 'github_dedup')
    AND pi.integration_status = 'active'
    AND pi.suspended_at IS NULL
    AND pi.auth_invalid_at IS NULL
    AND pi.github_disconnected_at IS NULL
    AND NOT EXISTS (
      SELECT 1
      FROM platform_integrations claimed
      WHERE claimed.github_connection_role = 'workflow'
        AND claimed.platform_installation_id = pi.platform_installation_id
        AND COALESCE(claimed.github_app_type, 'standard') =
          COALESCE(pi.github_app_type, 'standard')
    )
    AND (
      pi.github_installation_id IS NULL
      OR NOT EXISTS (
        SELECT 1
        FROM platform_integrations claimed
        WHERE claimed.github_connection_role = 'workflow'
          AND claimed.github_installation_id = pi.github_installation_id
      )
    )
    AND (
      -- The linked canonical installation, when there is one, must be the
      -- active record for this exact installation identity: the Security sync
      -- Worker joins the canonical row through github_installation_id and
      -- requires it to name platform_installation_id.
      EXISTS (
        SELECT 1
        FROM github_app_installations installation
        WHERE installation.id = pi.github_installation_id
          AND installation.installation_id = pi.platform_installation_id
          AND installation.github_app_type = COALESCE(pi.github_app_type, 'standard')
          AND installation.lifecycle_state = 'active'
          AND installation.suspended_at IS NULL
          AND installation.deleted_at IS NULL
      )
      -- Otherwise the association is a legacy row that was never canonicalized,
      -- which is the same state the Worker and the runtime authorization
      -- already accept for this installation identity.
      OR (
        pi.github_installation_id IS NULL
        AND NOT EXISTS (
          SELECT 1
          FROM github_app_installations installation
          WHERE installation.installation_id = pi.platform_installation_id
            AND installation.github_app_type = COALESCE(pi.github_app_type, 'standard')
        )
      )
    )
), ranked AS MATERIALIZED (
  SELECT
    id,
    row_number() OVER (
      PARTITION BY identity_app_type, identity_installation_id
      ORDER BY created_at, id
    ) AS position
  FROM candidate
)
UPDATE platform_integrations pi
SET github_connection_role = 'workflow'
FROM ranked
WHERE pi.id = ranked.id
  AND ranked.position = 1;