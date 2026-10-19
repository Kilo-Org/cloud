import { ORGANIZATION_PARENT_ACCESS_ROLES } from '@kilocode/app-shared/organizations';
import { sql, type SQL } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';

/**
 * SQL predicate that keeps personal rows and organization rows the user may
 * still read: a direct membership in a live organization, or a parent
 * organization membership whose target organization is live. A soft-deleted
 * target organization never matches.
 */
export function activeOrganizationAccessSql(
  organizationIdColumn: AnyPgColumn,
  kiloUserId: string
): SQL {
  return sql`(
    ${organizationIdColumn} IS NULL
    OR EXISTS (
      SELECT 1
      FROM "organization_memberships" AS active_member_membership
      INNER JOIN "organizations" AS active_member_organization
        ON active_member_organization.id = active_member_membership.organization_id
        AND active_member_organization.deleted_at IS NULL
      WHERE active_member_membership.organization_id = ${organizationIdColumn}
        AND active_member_membership.kilo_user_id = ${kiloUserId}
    )
    OR EXISTS (
      SELECT 1
      FROM "organizations" AS active_target_organization
      INNER JOIN "organizations" AS active_parent_organization
        ON active_parent_organization.id = active_target_organization.parent_organization_id
        AND active_parent_organization.deleted_at IS NULL
      INNER JOIN "organization_memberships" AS active_parent_membership
        ON active_parent_membership.organization_id = active_target_organization.parent_organization_id
        AND active_parent_membership.kilo_user_id = ${kiloUserId}
        AND active_parent_membership.role IN (${sql.join(
          ORGANIZATION_PARENT_ACCESS_ROLES.map(role => sql`${role}`),
          sql`, `
        )})
      WHERE active_target_organization.id = ${organizationIdColumn}
        AND active_target_organization.deleted_at IS NULL
    )
  )`;
}
