import type { Organization, User } from '@kilocode/db/schema';
import {
  cli_sessions_v2,
  organization_membership_removals,
  organization_memberships,
} from '@kilocode/db/schema';
import type { DrizzleTransaction } from '@kilocode/web-shared/lib/drizzle';
import { db, sql } from '@kilocode/web-shared/lib/drizzle';
import { and, eq } from 'drizzle-orm';
import { errorExceptInTest } from '@kilocode/web-shared/lib/utils.server';
import { invalidateOrganizationSessionAccess } from '@/lib/session-ingest-client';
import { closeCloudAgentOrgStreams } from '@/lib/cloud-agent-next/cloud-agent-client';
import { bumpOrganizationGroupPolicyRevision } from '@kilocode/web-shared/lib/organizations/organization-groups';
import { lockOrganizationMembershipMutation } from '@kilocode/web-shared/lib/organizations/organizations';

export async function removeUserFromOrganization(
  organizationId: Organization['id'],
  userId: User['id'],
  removedBy?: User['id'],
  txn?: DrizzleTransaction
): Promise<{ rowCount: number | null }> {
  const run = async (tx: DrizzleTransaction) => {
    await lockOrganizationMembershipMutation(tx, organizationId, userId);
    await bumpOrganizationGroupPolicyRevision(tx, organizationId, removedBy ?? userId);
    const [membership] = await tx
      .select({ role: organization_memberships.role })
      .from(organization_memberships)
      .where(
        and(
          eq(organization_memberships.organization_id, organizationId),
          eq(organization_memberships.kilo_user_id, userId)
        )
      );

    const result = await tx
      .delete(organization_memberships)
      .where(
        and(
          eq(organization_memberships.organization_id, organizationId),
          eq(organization_memberships.kilo_user_id, userId)
        )
      );

    // Record the removal so webhook handlers don't re-add the user (Subscription Lifecycle 2)
    if (membership && (result.rowCount ?? 0) > 0) {
      await tx
        .update(cli_sessions_v2)
        .set({ public_id: null })
        .where(
          and(
            eq(cli_sessions_v2.kilo_user_id, userId),
            eq(cli_sessions_v2.organization_id, organizationId)
          )
        );

      await tx
        .insert(organization_membership_removals)
        .values({
          organization_id: organizationId,
          kilo_user_id: userId,
          removed_by: removedBy,
          previous_role: membership.role,
        })
        .onConflictDoUpdate({
          target: [
            organization_membership_removals.organization_id,
            organization_membership_removals.kilo_user_id,
          ],
          set: {
            removed_at: sql`now()`,
            removed_by: removedBy,
            previous_role: membership.role,
          },
        });
    }

    return result;
  };

  const result = txn ? await run(txn) : await db.transaction(run);

  // Session access invalidation is a best-effort network call and must not run
  // inside a caller-provided transaction; the caller handles it after commit.
  if (!txn && (result.rowCount ?? 0) > 0) {
    await invalidateMemberSessionAccess(organizationId, userId);
  }

  return result;
}

/**
 * Best-effort: a removed member loses cached Session Ingest access within the
 * cache TTL even when this call fails, so removal never fails on it.
 */
export async function invalidateMemberSessionAccess(
  organizationId: Organization['id'],
  userId: User['id']
): Promise<void> {
  try {
    await invalidateOrganizationSessionAccess(userId, organizationId);
  } catch (error) {
    errorExceptInTest('Failed to invalidate cached session access for organization member', {
      organizationId,
      userId,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  // Best-effort: close the member's live Cloud Agent stream sockets.
  try {
    await closeCloudAgentOrgStreams(userId, organizationId);
  } catch (error) {
    errorExceptInTest('Failed to close Cloud Agent streams for organization member', {
      organizationId,
      userId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Invalidate cached session access and close live streams for every affected
 * user. Failures stay best-effort; the database-backed access predicate denies
 * immediately and the cache entry expires within its TTL.
 */
export async function invalidateOrganizationSessionAccessForUsers(
  organizationId: Organization['id'],
  userIds: readonly User['id'][]
): Promise<void> {
  const batchSize = 10;
  for (let index = 0; index < userIds.length; index += batchSize) {
    await Promise.all(
      userIds
        .slice(index, index + batchSize)
        .map(userId => invalidateMemberSessionAccess(organizationId, userId))
    );
  }
}
