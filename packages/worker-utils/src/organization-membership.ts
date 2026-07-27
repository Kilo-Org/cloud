import type { WorkerDb } from '@kilocode/db/client';
import { organization_memberships, organizations } from '@kilocode/db/schema';
import { and, eq, isNull } from 'drizzle-orm';

type OrganizationMembershipDb = Pick<WorkerDb, 'select'>;

/**
 * True when the user has a direct membership row for the organization and the
 * organization is not soft-deleted. Mirrors worker session-access predicates in
 * `cloud-agent-session-access.ts` as a standalone query (no session join).
 *
 * Deliberately excluded:
 * - Parent-organization inherited roles — honoured only by the tRPC path
 *   (`apps/web/src/routers/organizations/utils.ts`), restricted to
 *   owner/billing_manager. No worker-side check considers them; adding
 *   inheritance here would make this the single most permissive worker check in
 *   the repo, in a security fix. The pre-existing gap is uniform across every
 *   worker path and is not this PR's to change.
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
      and(
        eq(organizations.id, organization_memberships.organization_id),
        isNull(organizations.deleted_at)
      )
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
