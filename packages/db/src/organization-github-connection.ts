import { sql, type SQL } from 'drizzle-orm';

import { platform_integrations } from './schema';

/**
 * The organization's workflow GitHub connection.
 *
 * An organization's GitHub App association carries its connection role in
 * `platform_integrations.github_connection_role`. Every writer assigns one
 * (`connectVerifiedGitHubInstallation` gives a fresh organization association
 * `workflow` and a shared installation `agent_only`), but the column stays
 * nullable and rows written outside those writers — a development seed, an
 * operator statement, an association linked to its canonical installation by
 * `backfillGitHubInstallations` after migration 0322 ran — can stay roleless
 * forever. Those rows are still a real installation: the installation surfaces
 * report the organization as connected, its repositories are cached on the row,
 * and its findings exist.
 *
 * This predicate is the single definition of "the organization's workflow
 * connection", so the Security Agent entry gate, the operations it opens
 * (repositories, findings, sync, dismissal, analysis) and the git-token service
 * that authorizes those operations resolve the same installation for a roleless
 * row as they do for a row that carries the role. A roleless row is only
 * eligible when it could be the organization's single primary installation —
 * the classification migration 0322 applied:
 *
 *   * it is a GitHub App association with a numeric installation id, the shape
 *     GitHub issues;
 *   * it is healthy: active, not suspended, not auth-invalid, not locally
 *     disconnected, and not a deduplicated row;
 *   * its canonical installation record, when it has one, is the active record
 *     of this exact identity, and it has none when it is unlinked, so the
 *     canonical lookups accept the same row;
 *   * no other association of the same installation identity already claims the
 *     workflow role, and no earlier eligible roleless association of that
 *     identity exists, so a shared installation's second organization and any
 *     shadowed duplicate stay exactly as they are.
 *
 * Personal associations are out of scope: they always carry their role, and
 * their lookups keep the stored role.
 */
export function organizationWorkflowGitHubConnectionSql(): SQL {
  return sql`(
    ${platform_integrations.github_connection_role} = 'workflow'
    OR (
      ${platform_integrations.github_connection_role} IS NULL
      AND ${platform_integrations.integration_type} = 'app'
      AND ${platform_integrations.platform_installation_id} ~ '^[1-9][0-9]*$'
      AND COALESCE(${platform_integrations.github_app_type}, 'standard') IN ('standard', 'lite')
      AND ${platform_integrations.integration_status} = 'active'
      AND ${platform_integrations.suspended_at} IS NULL
      AND ${platform_integrations.auth_invalid_at} IS NULL
      AND ${platform_integrations.github_disconnected_at} IS NULL
      AND NOT (COALESCE(${platform_integrations.metadata}, '{}'::jsonb) ? 'github_dedup')
      AND (
        EXISTS (
          SELECT 1
          FROM github_app_installations canonical
          WHERE canonical.id = ${platform_integrations.github_installation_id}
            AND canonical.installation_id = ${platform_integrations.platform_installation_id}
            AND canonical.github_app_type =
              COALESCE(${platform_integrations.github_app_type}, 'standard')
            AND canonical.lifecycle_state = 'active'
            AND canonical.suspended_at IS NULL
            AND canonical.deleted_at IS NULL
            AND canonical.auth_invalid_at IS NULL
        )
        OR (
          ${platform_integrations.github_installation_id} IS NULL
          AND NOT EXISTS (
            SELECT 1
            FROM github_app_installations canonical
            WHERE canonical.installation_id = ${platform_integrations.platform_installation_id}
              AND canonical.github_app_type =
                COALESCE(${platform_integrations.github_app_type}, 'standard')
          )
        )
      )
      AND NOT EXISTS (
        SELECT 1
        FROM platform_integrations claimed
        WHERE claimed.github_connection_role = 'workflow'
          AND claimed.id <> ${platform_integrations.id}
          AND claimed.platform_installation_id = ${platform_integrations.platform_installation_id}
          AND COALESCE(claimed.github_app_type, 'standard') =
            COALESCE(${platform_integrations.github_app_type}, 'standard')
      )
      AND NOT EXISTS (
        SELECT 1
        FROM platform_integrations sibling
        WHERE sibling.id <> ${platform_integrations.id}
          AND sibling.platform_installation_id = ${platform_integrations.platform_installation_id}
          AND COALESCE(sibling.github_app_type, 'standard') =
            COALESCE(${platform_integrations.github_app_type}, 'standard')
          AND sibling.github_connection_role IS NULL
          AND sibling.integration_type = 'app'
          AND sibling.integration_status = 'active'
          AND sibling.suspended_at IS NULL
          AND sibling.auth_invalid_at IS NULL
          AND sibling.github_disconnected_at IS NULL
          AND NOT (COALESCE(sibling.metadata, '{}'::jsonb) ? 'github_dedup')
          AND (sibling.created_at, sibling.id) < (
            ${platform_integrations.created_at},
            ${platform_integrations.id}
          )
      )
    )
  )`;
}

/**
 * Preference between two rows this predicate accepts: the organization's stored
 * workflow association outranks an eligible roleless one, so a lookup that
 * returns one connection names the installation the connection writers chose
 * rather than a legacy association that merely resolves to the same thing.
 */
export function organizationWorkflowGitHubPreferenceSql(): SQL {
  return sql`(${platform_integrations.github_connection_role} = 'workflow') IS TRUE`;
}
