import type { WorkerDb } from '@kilocode/db/client';
import { organization_memberships, organizations } from '@kilocode/db/schema';
import { and, eq, isNotNull, isNull, or, sql, type SQL } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';

type OrganizationMembershipDb = Pick<WorkerDb, 'select'>;

type OrganizationIdColumn = AnyPgColumn;

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
 * True when the user has a direct membership row for the organization and the
 * organization is not soft-deleted. Mirrors worker session-access predicates in
 * `cloud-agent-session-access.ts` as a standalone query (no session join).
 *
 * Deliberately excluded:
 * - Parent-organization inherited roles — honoured only by the tRPC path
 *   (`packages/web-shared/src/routers/organizations/utils.ts`), restricted to
 *   owner/admin/billing_manager. Worker-side session checks do not consider
 *   them.
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
