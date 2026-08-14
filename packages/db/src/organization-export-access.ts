import { sql, type SQL } from 'drizzle-orm';
import { ORGANIZATION_MANAGE_ROLES } from '@kilocode/app-shared/organizations';

/**
 * Who may export an organization's data, as one predicate shared by everything that
 * has to agree on the answer.
 *
 * Three places ask this question: the web router when a request is made, the same
 * router again when a download is requested, and the export Worker, which re-checks
 * independently rather than trusting the caller. They are in different packages and
 * different processes, and they previously carried three hand-written copies of the
 * rule.
 *
 * The copies drifting is not a theoretical concern — it already happened. The Worker's
 * copy lacked parent-organization inheritance, so an export requested by a parent-org
 * owner generated, showed as ready, and then failed its download every time, having
 * consumed the organization's single active-export slot on the way. Nothing failed
 * loudly; the two halves simply disagreed.
 *
 * Deliberately NOT the `is_admin` elevation that `ensureOrganizationAccess` applies.
 * Kilo staff access to `/admin` is not permission to export a customer's data, and the
 * Worker has no notion of elevation anyway.
 */
export const ORGANIZATION_EXPORT_ROLES = ORGANIZATION_MANAGE_ROLES;

const EXPORT_ROLES_SQL = sql.join(
  ORGANIZATION_EXPORT_ROLES.map(role => sql`${role}`),
  sql`, `
);

/**
 * True when `kiloUserId` currently holds an export role on the organization named by
 * `organizationId`, which may be a literal or a correlated column reference.
 *
 * Aliases are prefixed so the fragment can be embedded in a query that already names
 * `organizations` or `organization_memberships` without colliding.
 *
 * Soft-deleted organizations are excluded here rather than at each call site:
 * membership rows outlive the organization, so without it a former admin could still
 * reach an export of something the product treats as gone.
 */
export function organizationExportAccess(input: { kiloUserId: string; organizationId: SQL }): SQL {
  return sql`EXISTS (
    SELECT 1 FROM organizations export_access_org
    WHERE export_access_org.id = ${input.organizationId}
      AND export_access_org.deleted_at IS NULL
      AND (
        EXISTS (
          SELECT 1 FROM organization_memberships export_access_direct
          WHERE export_access_direct.organization_id = export_access_org.id
            AND export_access_direct.kilo_user_id = ${input.kiloUserId}
            AND export_access_direct.role IN (${EXPORT_ROLES_SQL})
        )
        OR EXISTS (
          SELECT 1 FROM organization_memberships export_access_parent
          WHERE export_access_parent.organization_id = export_access_org.parent_organization_id
            AND export_access_parent.kilo_user_id = ${input.kiloUserId}
            AND export_access_parent.role IN (${EXPORT_ROLES_SQL})
        )
      )
  )`;
}
