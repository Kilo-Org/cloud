import type { User, Organization, OrganizationInvitation } from '@/db/schema';
import {
  type OrganizationRole,
  type UserOrganizationWithSeats,
  type OrganizationMember,
  type AcceptInviteResult,
  type OrganizationSettings,
  OrganizationSSODomainSchema,
} from '@/lib/organizations/organization-types';
import {
  kilocode_users,
  organization_invitations,
  organization_memberships,
  organization_user_limits,
  organization_user_usage,
  organizations,
} from '@/db/schema';
import type { DrizzleTransaction } from '@/lib/drizzle';
import { auto_deleted_at, db, sql } from '@/lib/drizzle';
import { and, eq, isNull, gt } from 'drizzle-orm';
import { TRIAL_DURATION_DAYS } from '@/lib/constants';
import { randomUUID } from 'crypto';
import { fromMicrodollars } from '@/lib/utils';
import { logExceptInTest } from '@/lib/utils.server';
import { APP_URL } from '@/lib/constants';
import { createAuditLog } from '@/lib/organizations/organization-audit-logs';
import { failureResult, successResult } from '@/lib/maybe-result';

export async function getOrganizationById(
  id: Organization['id'],
  txn?: DrizzleTransaction
): Promise<Organization | null> {
  return (
    (await (txn || db).query.organizations.findFirst({
      where: and(eq(organizations.id, id), isNull(organizations.deleted_at)),
    })) || null
  );
}

export async function findOrganizationByStripeCustomerId(
  stripeCustomerId: string,
  txn?: DrizzleTransaction
): Promise<Organization | null> {
  return (
    (await (txn || db).query.organizations.findFirst({
      where: and(
        eq(organizations.stripe_customer_id, stripeCustomerId),
        isNull(organizations.deleted_at)
      ),
    })) || null
  );
}

export async function getUserOrganizationsWithSeats(
  userId: User['id']
): Promise<UserOrganizationWithSeats[]> {
  const results = await db
    .select({
      organization: organizations,
      membership: organization_memberships,
      total_member_count: sql<number>`(
        SELECT COUNT(*)::int FROM (
          SELECT 1 FROM ${organization_memberships} om
          WHERE om.organization_id = ${organizations.id}
            AND om.role != 'billing_manager'
          UNION ALL
          SELECT 1 FROM ${organization_invitations} oi
          WHERE oi.organization_id = ${organizations.id}
            AND oi.accepted_at IS NULL
            AND oi.expires_at > NOW()
            AND oi.role != 'billing_manager'
        ) combined_count
      )`,
    })
    .from(organizations)
    .innerJoin(
      organization_memberships,
      eq(organization_memberships.organization_id, organizations.id)
    )
    .where(
      and(eq(organization_memberships.kilo_user_id, userId), isNull(organizations.deleted_at))
    );

  return results.map(result => ({
    organizationName: result.organization.name,
    organizationId: result.organization.id,
    role: result.membership.role,
    memberCount: result.total_member_count,
    balance:
      result.organization.total_microdollars_acquired - result.organization.microdollars_used,
    requireSeats: result.organization.require_seats,
    plan: result.organization.plan,
    created_at: result.organization.created_at,
    seatCount: {
      used: result.total_member_count,
      total: result.organization.seat_count,
    },
  }));
}

export async function userHasOrganizations(userId: User['id']): Promise<boolean> {
  const result = await db
    .select({ id: organization_memberships.id })
    .from(organization_memberships)
    .innerJoin(organizations, eq(organizations.id, organization_memberships.organization_id))
    .where(and(eq(organization_memberships.kilo_user_id, userId), isNull(organizations.deleted_at)))
    .limit(1);
  return result.length > 0;
}

/**
 * Returns the full organization object only if the user is a member of exactly one organization.
 * Returns null if the user has zero or multiple organizations.
 */
export async function getSingleUserOrganization(userId: User['id']): Promise<Organization | null> {
  const result = await db
    .select({ organization: organizations })
    .from(organization_memberships)
    .innerJoin(organizations, eq(organizations.id, organization_memberships.organization_id))
    .where(and(eq(organization_memberships.kilo_user_id, userId), isNull(organizations.deleted_at)))
    .limit(2);
  // Only return the org if user has exactly one organization
  return result.length === 1 ? result[0].organization : null;
}

export type ProfileOrganization = {
  id: string;
  name: string;
  role: OrganizationRole;
};

export async function getProfileOrganizations(userId: User['id']): Promise<ProfileOrganization[]> {
  const results = await db
    .select({
      organization: organizations,
      membership: organization_memberships,
    })
    .from(organizations)
    .innerJoin(
      organization_memberships,
      eq(organization_memberships.organization_id, organizations.id)
    )
    .where(
      and(eq(organization_memberships.kilo_user_id, userId), isNull(organizations.deleted_at))
    );

  return results.map(result => ({
    id: result.organization.id,
    name: result.organization.name,
    role: result.membership.role,
  }));
}

export async function createOrganization(
  name: string,
  // this is only used in tests
  // TODO(bmc): remove this from tests in the future. nbd rn.
  userId?: User['id'] | null,
  addUserAsOwner: boolean = true
): Promise<Organization> {
  return await db.transaction(async tx => {
    const now = new Date();
    const trialEndDate = new Date(now.getTime() + TRIAL_DURATION_DAYS * 24 * 60 * 60 * 1000);

    const [organization] = await tx
      .insert(organizations)
      .values({
        name,
        require_seats: true,
        created_by_kilo_user_id: userId,
        free_trial_end_at: trialEndDate.toISOString(),
        settings: {
          // all new orgs will have usage limits disabled by default
          enable_usage_limits: false,
          // all new orgs will have code indexing enabled by default
          code_indexing_enabled: true,
        },
      })
      .returning();

    if (!userId || !addUserAsOwner) {
      // If no user ID is provided or addUserAsOwner is false, return the organization without adding a member
      return organization;
    }
    await tx.insert(organization_memberships).values({
      organization_id: organization.id,
      kilo_user_id: userId,
      role: 'owner',
    });
    return organization;
  });
}

export async function addUserToOrganization(
  organizationId: Organization['id'],
  userId: User['id'],
  role: OrganizationRole,
  txn?: DrizzleTransaction
): Promise<boolean> {
  const result = await (txn || db)
    .insert(organization_memberships)
    .values({
      organization_id: organizationId,
      kilo_user_id: userId,
      role,
    })
    .onConflictDoNothing();

  return (result.rowCount ?? 0) > 0;
}

export async function removeUserFromOrganization(
  organizationId: Organization['id'],
  userId: User['id']
) {
  return await db
    .delete(organization_memberships)
    .where(
      and(
        eq(organization_memberships.organization_id, organizationId),
        eq(organization_memberships.kilo_user_id, userId)
      )
    );
}

export async function updateUserRoleInOrganization(
  organizationId: Organization['id'],
  userId: User['id'],
  role: OrganizationRole
): Promise<{ success: boolean; updated: 'membership' | 'invitation' | 'none' }> {
  return await db.transaction(async tx => {
    // First, try to update existing membership
    const membershipUpdateResult = await tx
      .update(organization_memberships)
      .set({ role })
      .where(
        and(
          eq(organization_memberships.organization_id, organizationId),
          eq(organization_memberships.kilo_user_id, userId)
        )
      );

    if (membershipUpdateResult.rowCount && membershipUpdateResult.rowCount > 0) {
      return successResult({ updated: 'membership' });
    }

    // If no membership was updated, check for pending invitations
    const [user] = await tx
      .select({ email: kilocode_users.google_user_email })
      .from(kilocode_users)
      .where(eq(kilocode_users.id, userId));

    if (!user) {
      return { success: false, updated: 'none' };
    }

    // Update any non-accepted, non-expired invitations for this user's email
    const invitationUpdateResult = await tx
      .update(organization_invitations)
      .set({ role })
      .where(
        and(
          eq(organization_invitations.organization_id, organizationId),
          eq(organization_invitations.email, user.email),
          isNull(organization_invitations.accepted_at),
          gt(organization_invitations.expires_at, sql`NOW()`)
        )
      );

    if (invitationUpdateResult.rowCount && invitationUpdateResult.rowCount > 0) {
      return successResult({ updated: 'invitation' });
    }

    return { success: false, updated: 'none' };
  });
}

export async function inviteUserToOrganization(
  organizationId: Organization['id'],
  invitingUserId: User['id'],
  email: string,
  role: OrganizationRole
): Promise<OrganizationInvitation> {
  // Check for existing pending invitation
  const existingInvitation = await db
    .select()
    .from(organization_invitations)
    .where(
      and(
        eq(organization_invitations.organization_id, organizationId),
        eq(organization_invitations.email, email),
        isNull(organization_invitations.accepted_at),
        gt(organization_invitations.expires_at, sql`NOW()`)
      )
    )
    .limit(1);

  if (existingInvitation.length > 0) {
    throw new Error('User already has a pending invitation');
  }

  // Check for existing membership
  const existingMember = await db
    .select()
    .from(organization_memberships)
    .innerJoin(kilocode_users, eq(kilocode_users.id, organization_memberships.kilo_user_id))
    .where(
      and(
        eq(organization_memberships.organization_id, organizationId),
        eq(kilocode_users.google_user_email, email)
      )
    )
    .limit(1);

  if (existingMember.length > 0) {
    throw new Error('User is already a member of this organization');
  }

  const token = randomUUID();

  const [invitation] = await db
    .insert(organization_invitations)
    .values({
      organization_id: organizationId,
      email,
      role,
      invited_by: invitingUserId,
      token,
      expires_at: sql`NOW() + INTERVAL '7 days'`,
    })
    .returning();

  return invitation;
}

export async function getOrganizationMembers(
  organizationId: Organization['id']
): Promise<OrganizationMember[]> {
  // Optimize by using a single query with LEFT JOIN and UNION ALL
  const [activeMembers, pendingInvitations] = await Promise.all([
    db
      .select({
        id: organization_memberships.kilo_user_id,
        name: kilocode_users.google_user_name,
        email: kilocode_users.google_user_email,
        role: organization_memberships.role,
        inviteDate: organization_memberships.created_at,
        dailyUsageLimitUsdMicrodollars: organization_user_limits.microdollar_limit,
        currentDailyUsageUsdMicrodollars: organization_user_usage.microdollar_usage,
      })
      .from(organization_memberships)
      .innerJoin(kilocode_users, eq(kilocode_users.id, organization_memberships.kilo_user_id))
      .leftJoin(
        organization_user_limits,
        and(
          eq(organization_user_limits.organization_id, organizationId),
          eq(organization_user_limits.kilo_user_id, organization_memberships.kilo_user_id),
          eq(organization_user_limits.limit_type, 'daily')
        )
      )
      .leftJoin(
        organization_user_usage,
        and(
          eq(organization_user_usage.organization_id, organizationId),
          eq(organization_user_usage.kilo_user_id, organization_memberships.kilo_user_id),
          eq(organization_user_usage.limit_type, 'daily'),
          eq(organization_user_usage.usage_date, sql`CURRENT_DATE`)
        )
      )
      .where(
        and(
          eq(organization_memberships.organization_id, organizationId),
          eq(kilocode_users.is_bot, false)
        )
      ),
    db
      .select({
        id: organization_invitations.id,
        email: organization_invitations.email,
        role: organization_invitations.role,
        inviteDate: organization_invitations.created_at,
        token: organization_invitations.token,
      })
      .from(organization_invitations)
      .where(
        and(
          eq(organization_invitations.organization_id, organizationId),
          isNull(organization_invitations.accepted_at),
          gt(organization_invitations.expires_at, sql`NOW()`)
        )
      ),
  ]);

  const members: OrganizationMember[] = [
    ...activeMembers.map(member => ({
      id: member.id,
      name: member.name,
      email: member.email,
      role: member.role,
      status: 'active' as const,
      inviteDate: member.inviteDate,
      dailyUsageLimitUsd:
        member.dailyUsageLimitUsdMicrodollars != null
          ? fromMicrodollars(member.dailyUsageLimitUsdMicrodollars)
          : null,
      currentDailyUsageUsd: member.currentDailyUsageUsdMicrodollars
        ? fromMicrodollars(member.currentDailyUsageUsdMicrodollars)
        : null,
    })),
    ...pendingInvitations.map(invitation => ({
      email: invitation.email,
      role: invitation.role,
      status: 'invited' as const,
      inviteDate: invitation.inviteDate,
      inviteToken: invitation.token,
      inviteId: invitation.id,
      inviteUrl: getAcceptInviteUrl(invitation.token),
      dailyUsageLimitUsd: null, // Invited members don't have limits yet
      currentDailyUsageUsd: null, // Invited members don't have usage yet
    })),
  ];

  return members;
}

export async function acceptOrganizationInvite(
  userId: User['id'],
  inviteToken: string
): Promise<AcceptInviteResult> {
  try {
    return await db.transaction(async tx => {
      // Find and lock the invitation to prevent race conditions
      const [invitation] = await tx
        .select()
        .from(organization_invitations)
        .where(eq(organization_invitations.token, inviteToken))
        .for('update');

      if (!invitation) {
        return failureResult('Invitation not found');
      }

      // Check if invitation is expired
      const now = new Date();
      const expiresAt = new Date(invitation.expires_at);
      if (now > expiresAt) {
        return failureResult('Invitation has expired');
      }

      // Check if invitation is already accepted
      if (invitation.accepted_at) {
        return failureResult('Invitation has already been accepted');
      }

      // Fetch the organization to check the require_seats flag
      const organization = await getOrganizationById(invitation.organization_id, tx);
      if (!organization) {
        return failureResult('Organization not found');
      }

      // Check if user is already a member of the organization
      const existingMembership = await tx
        .select()
        .from(organization_memberships)
        .where(
          and(
            eq(organization_memberships.organization_id, invitation.organization_id),
            eq(organization_memberships.kilo_user_id, userId)
          )
        )
        .limit(1);

      if (existingMembership.length > 0) {
        // User is already a member, but we still mark the invitation as accepted
        // and return success to handle the duplicate membership gracefully
        const [updatedInvitation] = await tx
          .update(organization_invitations)
          .set({ accepted_at: sql`NOW()` })
          .where(eq(organization_invitations.token, inviteToken))
          .returning();

        return successResult({
          invitation: updatedInvitation,
          organizationId: invitation.organization_id,
          role: invitation.role,
        });
      }

      // Add user to organization
      await tx.insert(organization_memberships).values({
        organization_id: invitation.organization_id,
        kilo_user_id: userId,
        role: invitation.role,
        invited_by: invitation.invited_by,
      });

      // Mark invitation as accepted
      const [updatedInvitation] = await tx
        .update(organization_invitations)
        .set({ accepted_at: sql`NOW()` })
        .where(eq(organization_invitations.token, inviteToken))
        .returning();

      await createAuditLog({
        action: 'organization.user.accept_invite',
        actor_email: invitation.email,
        actor_id: userId,
        actor_name: null,
        message: `${invitation.email} accepted an invitation`,
        organization_id: organization.id,
        tx,
      });

      logExceptInTest(`Invitation ${inviteToken} accepted by ${userId}`);
      return successResult({
        invitation: updatedInvitation,
        organizationId: invitation.organization_id,
        role: invitation.role,
      });
    });
  } catch (error) {
    console.error('Error accepting organization invite:', error);
    return failureResult('An unexpected error occurred');
  }
}

/**
 * @param fromDb - Database instance to use (defaults to primary db, pass readDb for replica)
 */
export async function isOrganizationMember(
  organizationId: Organization['id'],
  userId: User['id'],
  fromDb: typeof db = db
) {
  const result = await fromDb.query.organization_memberships.findFirst({
    where: and(
      eq(organization_memberships.organization_id, organizationId),
      eq(organization_memberships.kilo_user_id, userId)
    ),
  });
  return !!result;
}

export function getAcceptInviteUrl(inviteToken: OrganizationInvitation['token']): string {
  const acceptInviteUrl = `${APP_URL}/users/accept-invite/${inviteToken}`;
  return acceptInviteUrl;
}

export async function updateOrganizationSettings(
  organizationId: Organization['id'],
  settings: OrganizationSettings,
  txn?: DrizzleTransaction
): Promise<OrganizationSettings> {
  await (txn || db)
    .update(organizations)
    .set({
      settings,
    })
    .where(eq(organizations.id, organizationId));

  return settings;
}

export async function markOrganizationAsDeleted(organizationId: Organization['id']): Promise<void> {
  await db
    .update(organizations)
    .set({ ...auto_deleted_at })
    .where(eq(organizations.id, organizationId));
}

export async function doesOrgWithSSODomainExist(domain: string): Promise<string | false> {
  const d = OrganizationSSODomainSchema.safeParse(domain);
  if (!d.success) return false;

  const result = await db.query.organizations.findFirst({
    where: and(eq(organizations.sso_domain, d.data), isNull(organizations.deleted_at)),
    columns: { id: true },
  });
  return result?.id || false;
}

export async function getOrganizationMemberByEmail(
  organizationId: Organization['id'],
  email: string
) {
  const result = await db
    .select()
    .from(organization_memberships)
    .innerJoin(kilocode_users, eq(kilocode_users.id, organization_memberships.kilo_user_id))
    .where(
      and(
        eq(organization_memberships.organization_id, organizationId),
        eq(kilocode_users.google_user_email, email)
      )
    )
    .limit(1);
  return result.length > 0 ? result[0] : null;
}
