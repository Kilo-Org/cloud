import { ORGANIZATION_PARENT_ACCESS_ROLES } from '@kilocode/app-shared/organizations';
import type { WorkerDb } from '@kilocode/db/client';
import { organization_memberships, organizations } from '@kilocode/db/schema';
import { and, eq, inArray, isNotNull, isNull, or, sql, type SQL } from 'drizzle-orm';
import { alias, type AnyPgColumn } from 'drizzle-orm/pg-core';

type OrganizationMembershipDb = Pick<WorkerDb, 'select'>;

type OrganizationIdColumn = AnyPgColumn;

/** Parent-organization alias for the inherited-access joins. */
export const parentOrganizationsTable = alias(organizations, 'parent_organizations');
/** Parent-membership alias for the inherited-access joins. */
export const parentOrganizationMembershipsTable = alias(
  organization_memberships,
  'parent_organization_memberships'
);

/**
 * Join condition for the caller's membership in the row's organization.
 * Pair it with {@link activeOrganizationJoinCondition} so a soft-deleted
 * organization cannot satisfy the membership join.
 */
export function organizationMembershipJoinCondition(
  kiloUserId: string | AnyPgColumn,
  organizationIdColumn: OrganizationIdColumn
): SQL {
  return (
    and(
      eq(organization_memberships.organization_id, organizationIdColumn),
      eq(organization_memberships.kilo_user_id, kiloUserId)
    ) ?? sql`false`
  );
}

/**
 * Join condition for the row's live organization. The `deleted_at IS NULL`
 * check is what makes an "active" membership decision deny a soft-deleted
 * target organization.
 */
export function activeOrganizationJoinCondition(organizationIdColumn: OrganizationIdColumn): SQL {
  return (
    and(eq(organizations.id, organizationIdColumn), isNull(organizations.deleted_at)) ?? sql`false`
  );
}

/**
 * Join condition for the parent organization of the row's organization.
 * Add it after {@link activeOrganizationJoinCondition}; a soft-deleted parent
 * never satisfies the join.
 */
export function parentOrganizationJoinCondition(): SQL {
  return (
    and(
      eq(parentOrganizationsTable.id, organizations.parent_organization_id),
      isNull(parentOrganizationsTable.deleted_at)
    ) ?? sql`false`
  );
}

/**
 * Join condition for the caller's parent-organization membership. Add it after
 * {@link parentOrganizationJoinCondition}; only the roles allowed to inherit
 * child-organization access match.
 */
export function parentOrganizationMembershipJoinCondition(kiloUserId: string | AnyPgColumn): SQL {
  return (
    and(
      eq(parentOrganizationMembershipsTable.organization_id, organizations.parent_organization_id),
      eq(parentOrganizationMembershipsTable.kilo_user_id, kiloUserId),
      inArray(parentOrganizationMembershipsTable.role, ORGANIZATION_PARENT_ACCESS_ROLES)
    ) ?? sql`false`
  );
}

/**
 * True for personal rows or org rows whose organization membership joined
 * through the conditions above. Callers must add both left joins.
 */
export function personalOrActiveOrganizationCondition(
  organizationIdColumn: OrganizationIdColumn
): SQL {
  return (
    or(
      isNull(organizationIdColumn),
      and(
        isNotNull(organization_memberships.id),
        isNotNull(organizations.id),
        isNull(organizations.deleted_at)
      )
    ) ?? sql`false`
  );
}

/**
 * True for personal rows, direct active memberships, or access inherited from
 * a live parent organization through a permitted parent role. Callers must add
 * the direct membership and live-organization joins plus the parent
 * organization and parent membership joins.
 */
export function personalOrInheritedOrganizationCondition(
  organizationIdColumn: OrganizationIdColumn
): SQL {
  return (
    or(
      personalOrActiveOrganizationCondition(organizationIdColumn),
      and(
        isNotNull(organizations.id),
        isNotNull(parentOrganizationsTable.id),
        isNull(parentOrganizationsTable.deleted_at),
        isNotNull(parentOrganizationMembershipsTable.id)
      )
    ) ?? sql`false`
  );
}

/**
 * SQL predicate that keeps personal rows and organization rows the user may
 * still read: a direct membership in a live organization, or a parent
 * organization membership whose target organization is live. A soft-deleted
 * target organization never matches.
 */
export function activeOrganizationAccessSql(
  organizationIdColumn: AnyPgColumn,
  kiloUserId: string
): SQL<boolean> {
  return sql<boolean>`(
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

/**
 * True when the user has a direct membership row for the organization and the
 * organization is not soft-deleted. Mirrors worker session-access predicates in
 * `cloud-agent-session-access.ts` as a standalone query (no session join).
 *
 * Deliberately excluded:
 * - Parent-organization inherited roles — honoured by the session read helpers
 *   (`cloud-agent-session-access.ts`) and the web tRPC path, restricted to
 *   owner/admin/billing_manager. This standalone membership check is used by
 *   ingest and notification paths that authorize the session owner's own
 *   membership, not inherited child access.
 * - `kilocode_users.is_admin` — no worker session-access path consults it, and
 *   session-ingest JWT auth deliberately discards every JWT claim except
 *   `kiloUserId`.
 */
export async function hasOrganizationAccess(
  db: OrganizationMembershipDb,
  params: { kiloUserId: string; organizationId: string }
): Promise<boolean> {
  const rows = await db
    .select({ id: organization_memberships.id })
    .from(organization_memberships)
    .innerJoin(
      organizations,
      activeOrganizationJoinCondition(organization_memberships.organization_id)
    )
    .where(
      and(
        eq(organization_memberships.organization_id, params.organizationId),
        eq(organization_memberships.kilo_user_id, params.kiloUserId)
      )
    )
    .limit(1);

  return rows[0] !== undefined;
}
