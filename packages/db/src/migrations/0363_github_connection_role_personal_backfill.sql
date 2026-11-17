-- Custom SQL migration file, put your code below! --

-- 0258 added platform_integrations.github_connection_role and 0259 assigned it
-- only where it could rank an installation identity without ambiguity. A
-- user-owned association that stayed roleless is still a healthy installation
-- with its repository snapshot: every personal GitHub read requires the
-- workflow role, so the New Session composer reports the connected account as
-- not connected ("Connect GitHub", an empty repository picker, a disabled
-- Start) and the Cloud Agent runtime refuses to mint a token for it. Nothing
-- repairs that state except reconnecting the installation.
--
-- Give those rows the workflow role, with the same guards as the organization
-- backfill in 0322 so only an unambiguous, healthy, user-owned installation is
-- reclassified:
--
--   * one candidate per installation identity (oldest created_at), so the role
--     cannot collide with UQ_platform_integrations_github_workflow_identity;
--   * no other row already claims the workflow role for the identity or for the
--     same canonical installation, so UQ_platform_integrations_github_workflow_canonical
--     and existing ownership stay untouched;
--   * the installation is real: bound to a live canonical
--     github_app_installations row, or provably not canonicalized yet;
--   * the association is active and carries no suspension, reauthentication or
--     local-disconnect marker.
--
-- Organization-owned rows, pending rows, deduplicated rows, unhealthy rows and
-- shadowed identities are left exactly as they are.
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
    AND pi.owned_by_user_id IS NOT NULL
    AND pi.owned_by_organization_id IS NULL
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
      -- active record for this exact installation identity: the runtime
      -- authorization joins the canonical row through github_installation_id
      -- and requires it to be live.
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
      -- which is the same state the runtime authorization already accepts for
      -- this installation identity.
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
