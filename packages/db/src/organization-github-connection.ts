import { sql, type AnyColumn, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';

import { platform_integrations } from './schema';

const siblingAliasName = 'sibling';
const claimingAliasName = 'claimed';

/**
 * The `platform_integrations` relation, named however a caller references it:
 * the table itself, or an alias inside the predicate's subqueries. Typed by
 * column so {@link organizationWorkflowGitHubConnectionSql} can read the same
 * conditions from an aliased relation.
 */
type ConnectionRelation = {
  readonly id: AnyColumn;
  readonly platform: AnyColumn;
  readonly owned_by_organization_id: AnyColumn;
  readonly github_connection_role: AnyColumn;
  readonly github_installation_id: AnyColumn;
  readonly integration_type: AnyColumn;
  readonly integration_status: AnyColumn;
  readonly platform_installation_id: AnyColumn;
  readonly github_app_type: AnyColumn;
  readonly suspended_at: AnyColumn;
  readonly auth_invalid_at: AnyColumn;
  readonly github_disconnected_at: AnyColumn;
  readonly metadata: AnyColumn;
  readonly created_at: AnyColumn;
};

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
 * their lookups keep the stored role. The predicate carries that scope itself —
 * it only matches a GitHub row owned by an organization — so a caller cannot
 * widen it to a personal or non-GitHub association by forgetting a filter, and
 * the planner can use the platform index. The relations the predicate reads
 * carry the scope as well: a shadowing sibling is a GitHub organization row of
 * the same installation identity, and the relation that could claim the role
 * is any GitHub association of that identity, personal or organization, exactly
 * as migration 0322 counted claims. Neither is ever a row of another platform
 * that happens to reuse a numeric `platform_installation_id`.
 *
 * The eligibility conditions are built once, by
 * {@link eligibleRolelessOrganizationGitHubAppSql}, and the sibling relation
 * applies the same builder through an alias, so the outer row and the rows that
 * could shadow it cannot disagree.
 */
export function organizationWorkflowGitHubConnectionSql(): SQL {
  const sibling = alias(platform_integrations, siblingAliasName);
  const claiming = alias(platform_integrations, claimingAliasName);
  return sql`(
    ${organizationGitHubAppSql(platform_integrations)}
    AND (
      ${platform_integrations.github_connection_role} = 'workflow'
      OR (
        ${eligibleRolelessOrganizationGitHubAppSql(platform_integrations)}
        AND NOT EXISTS (
          SELECT 1
          FROM ${aliasedRelationSql(claimingAliasName)}
          WHERE ${claiming.id} <> ${platform_integrations.id}
            AND ${claiming.platform} = 'github'
            AND ${claiming.github_connection_role} = 'workflow'
            AND ${claiming.platform_installation_id} =
              ${platform_integrations.platform_installation_id}
            AND COALESCE(${claiming.github_app_type}, 'standard') =
              COALESCE(${platform_integrations.github_app_type}, 'standard')
        )
        AND NOT EXISTS (
          SELECT 1
          FROM ${aliasedRelationSql(siblingAliasName)}
          WHERE ${sibling.id} <> ${platform_integrations.id}
            AND ${sibling.platform_installation_id} =
              ${platform_integrations.platform_installation_id}
            AND COALESCE(${sibling.github_app_type}, 'standard') =
              COALESCE(${platform_integrations.github_app_type}, 'standard')
            AND ${eligibleRolelessOrganizationGitHubAppSql(sibling)}
            AND (${sibling.created_at}, ${sibling.id}) < (
              ${platform_integrations.created_at},
              ${platform_integrations.id}
            )
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

/**
 * Scope shared by every relation of the definition: a GitHub association that
 * an organization owns. Relation-parameterized so the aliased relations of
 * {@link organizationWorkflowGitHubConnectionSql} carry it as well.
 */
function organizationGitHubAppSql(connection: ConnectionRelation): SQL {
  return sql`(
    ${connection.platform} = 'github'
    AND ${connection.owned_by_organization_id} IS NOT NULL
  )`;
}

/**
 * `FROM` clause of an aliased relation. An aliased relation only renders its
 * alias name, so the table has to be named explicitly next to it.
 */
function aliasedRelationSql(aliasName: string): SQL {
  return sql`${platform_integrations} AS ${sql.identifier(aliasName)}`;
}

/**
 * An organization's GitHub App association that can stand in for its workflow
 * connection without carrying the stored role: the installation shape GitHub
 * issues, a healthy row, and a canonical installation record that accepts the
 * same identity. Migration 0322 applied these conditions before it gave a row
 * the role; the builder restates them for the runtime predicate, so a roleless
 * row is only as connected as the writers would have made it.
 *
 * The connection role is part of the conjunction: only a roleless row is
 * classified here, because a row that carries a role is handled by the stored
 * role itself.
 */
function eligibleRolelessOrganizationGitHubAppSql(connection: ConnectionRelation): SQL {
  return sql`(
    ${organizationGitHubAppSql(connection)}
    AND ${connection.github_connection_role} IS NULL
    AND ${connection.integration_type} = 'app'
    AND ${connection.platform_installation_id} ~ '^[1-9][0-9]*$'
    AND COALESCE(${connection.github_app_type}, 'standard') IN ('standard', 'lite')
    AND ${connection.integration_status} = 'active'
    AND ${connection.suspended_at} IS NULL
    AND ${connection.auth_invalid_at} IS NULL
    AND ${connection.github_disconnected_at} IS NULL
    AND NOT (COALESCE(${connection.metadata}, '{}'::jsonb) ? 'github_dedup')
    AND (
      EXISTS (
        SELECT 1
        FROM github_app_installations canonical
        WHERE canonical.id = ${connection.github_installation_id}
          AND canonical.installation_id = ${connection.platform_installation_id}
          AND canonical.github_app_type =
            COALESCE(${connection.github_app_type}, 'standard')
          AND canonical.lifecycle_state = 'active'
          AND canonical.suspended_at IS NULL
          AND canonical.deleted_at IS NULL
          AND canonical.auth_invalid_at IS NULL
      )
      OR (
        ${connection.github_installation_id} IS NULL
        AND NOT EXISTS (
          SELECT 1
          FROM github_app_installations canonical
          WHERE canonical.installation_id = ${connection.platform_installation_id}
            AND canonical.github_app_type =
              COALESCE(${connection.github_app_type}, 'standard')
        )
      )
    )
  )`;
}
