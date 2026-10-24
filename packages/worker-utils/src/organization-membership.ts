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
 * Aliases for the standalone `EXISTS` form of the access rules below. Both
 * forms build their conditions from the same expressions and the same
 * `@kilocode/db/schema` tables, so the policy has one definition.
 */
const activeMemberMembership = alias(organization_memberships, 'active_member_membership');
const activeMemberOrganization = alias(organizations, 'active_member_organization');
const activeTargetOrganization = alias(organizations, 'active_target_organization');
const activeParentOrganization = alias(organizations, 'active_parent_organization');
const activeParentMembership = alias(organization_memberships, 'active_parent_membership');

type OrganizationColumns = {
  id: AnyPgColumn;
  parent_organization_id: AnyPgColumn;
  deleted_at: AnyPgColumn;
};

type OrganizationMembershipColumns = {
  organization_id: AnyPgColumn;
  kilo_user_id: AnyPgColumn;
  role: AnyPgColumn;
};

/** The organization is live: an "active" decision ignores soft-deleted rows. */
function liveOrganizationCondition(organization: OrganizationColumns): SQL {
  return isNull(organization.deleted_at);
}

/** The caller holds a membership row in the organization. */
function membershipCondition(
  membership: OrganizationMembershipColumns,
  organizationIdColumn: OrganizationIdColumn,
  kiloUserId: string | AnyPgColumn
): SQL {
  return (
    and(
      eq(membership.organization_id, organizationIdColumn),
      eq(membership.kilo_user_id, kiloUserId)
    ) ?? sql`false`
  );
}

/** The caller holds a membership row in the target organization's parent. */
function inheritingParentMembershipCondition(
  membership: OrganizationMembershipColumns,
  targetOrganization: OrganizationColumns,
  kiloUserId: string | AnyPgColumn
): SQL {
  return (
    and(
      eq(membership.organization_id, targetOrganization.parent_organization_id),
      eq(membership.kilo_user_id, kiloUserId),
      inArray(membership.role, ORGANIZATION_PARENT_ACCESS_ROLES)
    ) ?? sql`false`
  );
}

/**
 * Join condition for the caller's membership in the row's organization.
 * Pair it with {@link activeOrganizationJoinCondition} so a soft-deleted
 * organization cannot satisfy the membership join.
 */
export function organizationMembershipJoinCondition(
  kiloUserId: string | AnyPgColumn,
  organizationIdColumn: OrganizationIdColumn
): SQL {
  return membershipCondition(organization_memberships, organizationIdColumn, kiloUserId);
}

/**
 * Join condition for the row's live organization. The `deleted_at IS NULL`
 * check is what makes an "active" membership decision deny a soft-deleted
 * target organization.
 */
export function activeOrganizationJoinCondition(organizationIdColumn: OrganizationIdColumn): SQL {
  return (
    and(eq(organizations.id, organizationIdColumn), liveOrganizationCondition(organizations)) ??
    sql`false`
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
      liveOrganizationCondition(parentOrganizationsTable)
    ) ?? sql`false`
  );
}

/**
 * Join condition for the caller's parent-organization membership. Add it after
 * {@link parentOrganizationJoinCondition}; only the roles allowed to inherit
 * child-organization access match.
 */
export function parentOrganizationMembershipJoinCondition(kiloUserId: string | AnyPgColumn): SQL {
  return inheritingParentMembershipCondition(
    parentOrganizationMembershipsTable,
    organizations,
    kiloUserId
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
        liveOrganizationCondition(organizations)
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
        liveOrganizationCondition(parentOrganizationsTable),
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
      FROM ${organization_memberships} AS ${activeMemberMembership}
      INNER JOIN ${organizations} AS ${activeMemberOrganization}
        ON ${and(
          eq(activeMemberOrganization.id, activeMemberMembership.organization_id),
          liveOrganizationCondition(activeMemberOrganization)
        )}
      WHERE ${membershipCondition(activeMemberMembership, organizationIdColumn, kiloUserId)}
    )
    OR EXISTS (
      SELECT 1
      FROM ${organizations} AS ${activeTargetOrganization}
      INNER JOIN ${organizations} AS ${activeParentOrganization}
        ON ${and(
          eq(activeParentOrganization.id, activeTargetOrganization.parent_organization_id),
          liveOrganizationCondition(activeParentOrganization)
        )}
      INNER JOIN ${organization_memberships} AS ${activeParentMembership}
        ON ${inheritingParentMembershipCondition(
          activeParentMembership,
          activeTargetOrganization,
          kiloUserId
        )}
      WHERE ${and(
        eq(activeTargetOrganization.id, organizationIdColumn),
        liveOrganizationCondition(activeTargetOrganization)
      )}
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
