import 'server-only';

import { db } from '@/lib/drizzle';
import { createAuditLog } from '@/lib/organizations/organization-audit-logs';
import {
  addUserToOrganization,
  lockOrganizationMembershipMutation,
} from '@/lib/organizations/organizations';
import { verifiedDomainEmailIdentity } from '@/lib/organizations/verified-domain';
import {
  kilocode_users,
  organization_domain_claims,
  organization_invitations,
  organization_membership_removals,
  organizations,
  type Organization,
  type User,
} from '@kilocode/db/schema';
import { and, asc, eq, gt, inArray, isNull, sql } from 'drizzle-orm';

export type VerifiedDomainMembershipAdmission = {
  organizationId: Organization['id'];
  membershipCreated: boolean;
};

/** Ensures automatic membership from authoritative local verified-domain state. */
export async function ensureVerifiedDomainOrganizationMembership(
  userId: User['id']
): Promise<VerifiedDomainMembershipAdmission | null> {
  return db.transaction(async tx => {
    const [candidateUser] = await tx
      .select({
        google_user_email: kilocode_users.google_user_email,
        isBot: kilocode_users.is_bot,
        normalized_email: kilocode_users.normalized_email,
      })
      .from(kilocode_users)
      .where(eq(kilocode_users.id, userId))
      .limit(1);
    if (!candidateUser || candidateUser.isBot) return null;
    const candidateIdentity = verifiedDomainEmailIdentity(candidateUser);
    if (!candidateIdentity) return null;

    const claims = await tx
      .select({ organizationId: organization_domain_claims.organization_id })
      .from(organization_domain_claims)
      .where(
        and(
          eq(organization_domain_claims.domain, candidateIdentity.domain),
          eq(organization_domain_claims.status, 'verified')
        )
      )
      .limit(2)
      .for('share');

    if (claims.length !== 1) return null;
    const organizationId = claims[0].organizationId;

    const invitationNormalizedEmail = sql<string>`
      lower(split_part(split_part(btrim(${organization_invitations.email}), '@', 1), '+', 1))
      || '@' || lower(split_part(btrim(${organization_invitations.email}), '@', 2))
    `;
    const matchingInvitations = await tx
      .select({ id: organization_invitations.id })
      .from(organization_invitations)
      .where(
        and(
          eq(organization_invitations.organization_id, organizationId),
          eq(invitationNormalizedEmail, candidateIdentity.normalizedEmail),
          isNull(organization_invitations.accepted_at),
          gt(organization_invitations.expires_at, sql`now()`)
        )
      )
      .orderBy(asc(organization_invitations.id))
      .for('update');

    const [organization] = await tx
      .select({ id: organizations.id })
      .from(organizations)
      .where(and(eq(organizations.id, organizationId), isNull(organizations.deleted_at)))
      .limit(1)
      .for('share');
    if (!organization) return null;

    await lockOrganizationMembershipMutation(tx, organizationId, userId);
    const [user] = await tx
      .select({
        google_user_email: kilocode_users.google_user_email,
        isBot: kilocode_users.is_bot,
        name: kilocode_users.google_user_name,
        normalized_email: kilocode_users.normalized_email,
      })
      .from(kilocode_users)
      .where(eq(kilocode_users.id, userId))
      .for('share')
      .limit(1);
    if (!user || user.isBot) return null;
    const identity = verifiedDomainEmailIdentity(user);
    if (
      !identity ||
      identity.domain !== candidateIdentity.domain ||
      identity.normalizedEmail !== candidateIdentity.normalizedEmail
    ) {
      return null;
    }

    const [removal] = await tx
      .select({ id: organization_membership_removals.id })
      .from(organization_membership_removals)
      .where(
        and(
          eq(organization_membership_removals.organization_id, organizationId),
          eq(organization_membership_removals.kilo_user_id, userId)
        )
      )
      .limit(1);
    if (removal) return null;

    const membershipCreated = await addUserToOrganization(organizationId, userId, 'member', tx);

    if (matchingInvitations.length > 0) {
      await tx
        .update(organization_invitations)
        .set({ accepted_at: sql`now()` })
        .where(
          inArray(
            organization_invitations.id,
            matchingInvitations.map(({ id }) => id)
          )
        );
    }

    if (membershipCreated) {
      await createAuditLog({
        action: 'organization.member.auto_join',
        actor_email: user.google_user_email,
        actor_id: userId,
        actor_name: user.name,
        message: 'User joined organization via verified domain',
        organization_id: organizationId,
        tx,
      });
    }

    return { organizationId, membershipCreated };
  });
}
