import type { Organization, User } from '@kilocode/db/schema';
import {
  external_side_effect_outbox,
  organization_invitations,
  organization_membership_removals,
  organization_memberships,
  kilocode_users,
} from '@kilocode/db/schema';
import type { DrizzleTransaction } from '@kilocode/web-shared/lib/drizzle';
import { db, sql } from '@kilocode/web-shared/lib/drizzle';
import { and, eq, gt, isNull } from 'drizzle-orm';
import { errorExceptInTest } from '@kilocode/web-shared/lib/utils.server';
import { normalizeEmail } from '@kilocode/web-shared/lib/email-address';
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

      // Pending invitations are deleted with the membership they belong to,
      // so the invitation list and the membership stay consistent. Both
      // sides are compared in normalized form, matching how acceptance
      // resolves the invitation email.
      const [member] = await tx
        .select({
          email: sql<string>`coalesce(${kilocode_users.normalized_email}, lower(${kilocode_users.google_user_email}))`,
        })
        .from(kilocode_users)
        .where(eq(kilocode_users.id, userId))
        .limit(1);

      if (member) {
        const pending = await tx
          .select({ id: organization_invitations.id, email: organization_invitations.email })
          .from(organization_invitations)
          .where(
            and(
              eq(organization_invitations.organization_id, organizationId),
              isNull(organization_invitations.accepted_at),
              gt(organization_invitations.expires_at, sql`NOW()`)
            )
          );

        const normalizedMember = normalizeEmail(member.email);
        const removable = pending.filter(
          invitation => normalizeEmail(invitation.email) === normalizedMember
        );

        for (const invitation of removable) {
          await tx
            .delete(organization_invitations)
            .where(eq(organization_invitations.id, invitation.id));

          // An invitation row that is gone must never produce a later invite
          // email. Mark the outbox rows terminal so the cron drain skips them
          // (same shape as the deleteInvite procedure).
          await tx
            .update(external_side_effect_outbox)
            .set({
              status: 'failed',
              claimed_at: null,
              next_attempt_at: null,
              last_error: 'revoked',
            })
            .where(eq(external_side_effect_outbox.invitation_id, invitation.id));
        }
      }
    }

    return result;
  };

  const result = txn ? await run(txn) : await db.transaction(run);

  // Session access invalidation is a best-effort network call and must not run
  // inside a caller-provided transaction; the caller handles it after commit.
  if (!txn && (result.rowCount ?? 0) > 0) {
    await invalidateRemovedMemberSessionAccess(organizationId, userId);
  }

  return result;
}

/**
 * Best-effort: a removed member loses cached Session Ingest access within the
 * cache TTL even when this call fails, so removal never fails on it.
 */
async function invalidateRemovedMemberSessionAccess(
  organizationId: Organization['id'],
  userId: User['id']
): Promise<void> {
  try {
    await invalidateOrganizationSessionAccess(userId, organizationId);
  } catch (error) {
    errorExceptInTest(
      'Failed to invalidate cached session access for removed organization member',
      {
        organizationId,
        userId,
        error: error instanceof Error ? error.message : String(error),
      }
    );
  }

  // Best-effort: close the removed member's live Cloud Agent stream sockets.
  try {
    await closeCloudAgentOrgStreams(userId, organizationId);
  } catch (error) {
    errorExceptInTest('Failed to close Cloud Agent streams for removed organization member', {
      organizationId,
      userId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
