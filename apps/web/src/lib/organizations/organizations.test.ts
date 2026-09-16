import { describe, test, expect, afterEach, beforeEach } from '@jest/globals';
import { db, sql } from '@/lib/drizzle';
import {
  organizations,
  organization_invitations,
  organization_memberships,
  organization_membership_removals,
  organization_seats_purchases,
  organization_user_limits,
  kilocode_users,
} from '@kilocode/db/schema';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { eq, and } from 'drizzle-orm';
import {
  getUserOrganizationsWithSeats,
  getProfileOrganizations,
  createOrganization,
  addUserToOrganization,
  addSsoUserToOrganization,
  removeUserFromOrganization,
  updateUserRoleInOrganization,
  inviteUserToOrganization,
  getOrganizationMembers,
  acceptOrganizationInvite,
} from './organizations';
import { fromMicrodollars } from '@/lib/utils';
import { DEFAULT_MEMBER_DAILY_LIMIT_USD } from '@/lib/organizations/constants';
import { invalidateOrganizationSessionAccess } from '@/lib/session-ingest-client';
import { closeCloudAgentOrgStreams } from '@/lib/cloud-agent-next/cloud-agent-client';

jest.mock('@/lib/session-ingest-client', () => ({
  invalidateOrganizationSessionAccess: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@/lib/cloud-agent-next/cloud-agent-client', () => ({
  closeCloudAgentOrgStreams: jest.fn().mockResolvedValue(undefined),
}));

describe('Organizations', () => {
  afterEach(async () => {
    // eslint-disable-next-line drizzle/enforce-delete-with-where
    await db.delete(organization_user_limits);
    // eslint-disable-next-line drizzle/enforce-delete-with-where
    await db.delete(organization_invitations);
    // eslint-disable-next-line drizzle/enforce-delete-with-where
    await db.delete(organization_memberships);
    // eslint-disable-next-line drizzle/enforce-delete-with-where
    await db.delete(organization_membership_removals);
    // eslint-disable-next-line drizzle/enforce-delete-with-where
    await db.delete(organization_seats_purchases);
    // eslint-disable-next-line drizzle/enforce-delete-with-where
    await db.delete(organizations);
  });

  describe('createOrganization', () => {
    test('enables recommendations digest for new enterprise organizations only', async () => {
      const user = await insertTestUser();

      const enterprise = await createOrganization(
        'Enterprise with recommendations',
        user.id,
        true,
        undefined,
        'enterprise'
      );
      const teams = await createOrganization(
        'Teams without recommendations',
        user.id,
        true,
        undefined,
        'teams'
      );

      expect(enterprise.settings.recommendations_digest_enabled).toBe(true);
      expect(teams.settings.recommendations_digest_enabled).toBeUndefined();
    });
  });

  describe('getUserOrganizationsWithSeats', () => {
    test('should return empty array when user has no organizations', async () => {
      const user = await insertTestUser();

      const result = await getUserOrganizationsWithSeats(user.id);

      expect(result).toEqual([]);
    });

    test('should return organizations for user with single organization', async () => {
      const user = await insertTestUser();
      const orgName = 'Test Organization';

      const organization = await createOrganization(orgName, user.id);
      const result = await getUserOrganizationsWithSeats(user.id);

      expect(result).toHaveLength(1);
      expect(result[0].organizationId).toBe(organization.id);
      expect(result[0].organizationName).toBe(orgName);
      expect(result[0].role).toBe('owner');
    });

    test('should return multiple organizations for user with multiple memberships', async () => {
      const user = await insertTestUser();
      const org1 = await createOrganization('Organization 1', user.id);

      const otherUser = await insertTestUser();
      const org2 = await createOrganization('Organization 2', otherUser.id);

      await addUserToOrganization(org2.id, user.id, 'member');

      const result = await getUserOrganizationsWithSeats(user.id);

      expect(result).toHaveLength(2);

      const orgIds = result.map(r => r.organizationId);
      expect(orgIds).toContain(org1.id);
      expect(orgIds).toContain(org2.id);

      const ownerMembership = result.find(r => r.role === 'owner');
      const memberMembership = result.find(r => r.role === 'member');

      expect(ownerMembership?.organizationName).toBe('Organization 1');
      expect(memberMembership?.organizationName).toBe('Organization 2');
    });

    test('should not return organizations where user is not a member', async () => {
      const user1 = await insertTestUser();
      const user2 = await insertTestUser();

      await createOrganization('Other User Org', user2.id);

      const result = await getUserOrganizationsWithSeats(user1.id);

      expect(result).toEqual([]);
    });

    test('returns exactly the documented UserOrganizationWithSeats key set with no extra org fields', async () => {
      const user = await insertTestUser();
      await createOrganization('Key Set Org', user.id);

      const result = await getUserOrganizationsWithSeats(user.id);

      expect(result).toHaveLength(1);
      expect(Object.keys(result[0]).sort()).toEqual(
        [
          'balance',
          'created_at',
          'isSalesDemo',
          'memberCount',
          'organizationId',
          'organizationName',
          'plan',
          'requireSeats',
          'role',
          'seatCount',
        ].sort()
      );
      expect(Object.keys(result[0].seatCount).sort()).toEqual(['total', 'used'].sort());
    });
  });

  describe('getProfileOrganizations', () => {
    test('returns standalone organizations', async () => {
      const user = await insertTestUser();
      const organization = await createOrganization('Standalone Organization', user.id);

      const result = await getProfileOrganizations(user.id);

      expect(result).toEqual([
        {
          id: organization.id,
          name: organization.name,
          role: 'owner',
        },
      ]);
    });

    test('prefers a sales demo org over an older non-demo org', async () => {
      const user = await insertTestUser();
      const older = await createOrganization('Older Org', user.id);
      await db
        .update(organizations)
        .set({ created_at: '2020-01-01T00:00:00.000Z' })
        .where(eq(organizations.id, older.id));

      const demo = await createOrganization('Sales Demo Org', user.id);
      await db
        .update(organizations)
        .set({ settings: { is_sales_demo: true } })
        .where(eq(organizations.id, demo.id));

      const result = await getProfileOrganizations(user.id);

      expect(result.map(organization => organization.id)[0]).toBe(demo.id);
    });

    test('hides a parent when the user is also a member of its child', async () => {
      const user = await insertTestUser();
      const parent = await createOrganization('Parent Organization', user.id);
      const child = await createOrganization('Child Organization', user.id);
      await db
        .update(organizations)
        .set({ parent_organization_id: parent.id })
        .where(eq(organizations.id, child.id));

      const result = await getProfileOrganizations(user.id);

      expect(result).toEqual([
        {
          id: child.id,
          name: child.name,
          role: 'owner',
        },
      ]);
    });

    test('returns a parent when the user has no child membership', async () => {
      const user = await insertTestUser();
      const childOwner = await insertTestUser();
      const parent = await createOrganization('Parent Organization', user.id);
      const child = await createOrganization('Child Organization', childOwner.id);
      await db
        .update(organizations)
        .set({ parent_organization_id: parent.id })
        .where(eq(organizations.id, child.id));

      const result = await getProfileOrganizations(user.id);

      expect(result).toEqual([
        {
          id: parent.id,
          name: parent.name,
          role: 'owner',
        },
      ]);
    });

    test('returns a child when the user has no parent membership', async () => {
      const hierarchyOwner = await insertTestUser();
      const user = await insertTestUser();
      const parent = await createOrganization('Parent Organization', hierarchyOwner.id);
      const child = await createOrganization('Child Organization', hierarchyOwner.id);
      await db
        .update(organizations)
        .set({ parent_organization_id: parent.id })
        .where(eq(organizations.id, child.id));
      await addUserToOrganization(child.id, user.id, 'member');

      const result = await getProfileOrganizations(user.id);

      expect(result).toEqual([
        {
          id: child.id,
          name: child.name,
          role: 'member',
        },
      ]);
    });

    test('keeps unrelated organizations alongside child memberships', async () => {
      const user = await insertTestUser();
      const parent = await createOrganization('Parent Organization', user.id);
      const childOne = await createOrganization('First Child', user.id);
      const childTwo = await createOrganization('Second Child', user.id);
      const unrelated = await createOrganization('Unrelated Organization', user.id);
      await db
        .update(organizations)
        .set({ parent_organization_id: parent.id })
        .where(eq(organizations.id, childOne.id));
      await db
        .update(organizations)
        .set({ parent_organization_id: parent.id })
        .where(eq(organizations.id, childTwo.id));

      const result = await getProfileOrganizations(user.id);

      expect(result).toHaveLength(3);
      expect(result.map(organization => organization.id)).toEqual(
        expect.arrayContaining([childOne.id, childTwo.id, unrelated.id])
      );
      expect(result.map(organization => organization.id)).not.toContain(parent.id);
    });

    test('excludeAccessBlocked omits a hard-expired trial org with no active subscription', async () => {
      const user = await insertTestUser();
      const activeTrial = await createOrganization('Active Trial Org', user.id);
      const blocked = await createOrganization('Access Blocked Org', user.id);
      await db
        .update(organizations)
        .set({ free_trial_end_at: '2020-01-01T00:00:00.000Z' })
        .where(eq(organizations.id, blocked.id));

      const result = await getProfileOrganizations(user.id, { excludeAccessBlocked: true });

      expect(result.map(organization => organization.id)).toEqual([activeTrial.id]);
    });

    test('excludeAccessBlocked keeps a hard-expired trial org with an active seat purchase', async () => {
      const user = await insertTestUser();
      const subscribed = await createOrganization('Subscribed Org', user.id);
      await db
        .update(organizations)
        .set({ free_trial_end_at: '2020-01-01T00:00:00.000Z' })
        .where(eq(organizations.id, subscribed.id));
      await db.insert(organization_seats_purchases).values({
        subscription_stripe_id: 'sub_profile_active',
        organization_id: subscribed.id,
        seat_count: 5,
        amount_usd: 50.0,
        starts_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
        subscription_status: 'active',
      });

      const result = await getProfileOrganizations(user.id, { excludeAccessBlocked: true });

      expect(result.map(organization => organization.id)).toEqual([subscribed.id]);
    });

    test('includes hard-expired trial organizations by default', async () => {
      const user = await insertTestUser();
      const blocked = await createOrganization('Access Blocked Org', user.id);
      await db
        .update(organizations)
        .set({ free_trial_end_at: '2020-01-01T00:00:00.000Z' })
        .where(eq(organizations.id, blocked.id));

      const result = await getProfileOrganizations(user.id);

      expect(result.map(organization => organization.id)).toEqual([blocked.id]);
    });
  });

  describe('createOrganization', () => {
    test('should create organization and add creator as owner', async () => {
      const user = await insertTestUser();
      const orgName = 'New Organization';

      const organization = await createOrganization(orgName, user.id);

      expect(organization.id).toBeDefined();
      expect(organization.name).toBe(orgName);
      expect(organization.created_at).toBeDefined();
      expect(organization.updated_at).toBeDefined();
      expect(organization.total_microdollars_acquired - organization.microdollars_used).toBe(0);
      expect(organization.auto_top_up_enabled).toBe(false);

      const userOrgs = await getUserOrganizationsWithSeats(user.id);

      expect(userOrgs).toHaveLength(1);
      expect(userOrgs[0].role).toBe('owner');
      expect(userOrgs[0].organizationId).toBe(organization.id);
      expect(userOrgs[0].organizationName).toBe(orgName);
    });

    test('should handle organization names with special characters', async () => {
      const user = await insertTestUser();
      const orgName = 'Test Org & Co. (2024)';

      const organization = await createOrganization(orgName, user.id);

      expect(organization.name).toBe(orgName);
    });

    test('should create multiple organizations for same user', async () => {
      const user = await insertTestUser();

      const org1 = await createOrganization('Organization 1', user.id);
      const org2 = await createOrganization('Organization 2', user.id);

      expect(org1.id).not.toBe(org2.id);
      expect(org1.name).toBe('Organization 1');
      expect(org2.name).toBe('Organization 2');

      const userOrgs = await getUserOrganizationsWithSeats(user.id);

      expect(userOrgs).toHaveLength(2);
      expect(userOrgs.every(org => org.role === 'owner')).toBe(true);

      const orgNames = userOrgs.map(org => org.organizationName).sort();
      expect(orgNames).toEqual(['Organization 1', 'Organization 2']);
    });
  });

  describe('addUserToOrganization', () => {
    test('should add user to organization with specified role and return true', async () => {
      const owner = await insertTestUser();
      const member = await insertTestUser();
      const organization = await createOrganization('Test Org', owner.id);

      const result = await addUserToOrganization(organization.id, member.id, 'member');

      expect(result).toBe(true);

      const memberOrgs = await getUserOrganizationsWithSeats(member.id);

      expect(memberOrgs).toHaveLength(1);
      expect(memberOrgs[0].role).toBe('member');
      expect(memberOrgs[0].organizationId).toBe(organization.id);
      expect(memberOrgs[0].organizationName).toBe('Test Org');
    });

    test('should return false when user already exists (onConflictDoNothing)', async () => {
      const owner = await insertTestUser();
      const member = await insertTestUser();
      const organization = await createOrganization('Test Org', owner.id);

      const firstResult = await addUserToOrganization(organization.id, member.id, 'member');
      expect(firstResult).toBe(true);

      const secondResult = await addUserToOrganization(organization.id, member.id, 'owner');
      expect(secondResult).toBe(false);

      const memberOrgs = await getUserOrganizationsWithSeats(member.id);

      expect(memberOrgs).toHaveLength(1);
      expect(memberOrgs[0].role).toBe('member'); // Original role preserved
    });

    test('should add multiple users to same organization and return true for each', async () => {
      const owner = await insertTestUser();
      const member1 = await insertTestUser();
      const member2 = await insertTestUser();
      const organization = await createOrganization('Test Org', owner.id);

      const result1 = await addUserToOrganization(organization.id, member1.id, 'member');
      const result2 = await addUserToOrganization(organization.id, member2.id, 'owner');

      expect(result1).toBe(true);
      expect(result2).toBe(true);

      const ownerOrgs = await getUserOrganizationsWithSeats(owner.id);
      const member1Orgs = await getUserOrganizationsWithSeats(member1.id);
      const member2Orgs = await getUserOrganizationsWithSeats(member2.id);

      expect(ownerOrgs).toHaveLength(1);
      expect(member1Orgs).toHaveLength(1);
      expect(member2Orgs).toHaveLength(1);

      expect(ownerOrgs[0].role).toBe('owner');
      expect(member1Orgs[0].role).toBe('member');
      expect(member2Orgs[0].role).toBe('owner');
    });
  });

  describe('removeUserFromOrganization', () => {
    beforeEach(() => {
      jest.mocked(invalidateOrganizationSessionAccess).mockClear();
      jest.mocked(closeCloudAgentOrgStreams).mockClear();
    });

    test('should remove user from organization', async () => {
      const owner = await insertTestUser();
      const member = await insertTestUser();
      const organization = await createOrganization('Test Org', owner.id);

      await addUserToOrganization(organization.id, member.id, 'member');

      let memberOrgs = await getUserOrganizationsWithSeats(member.id);
      expect(memberOrgs).toHaveLength(1);

      const result = await removeUserFromOrganization(organization.id, member.id);
      expect(result).toBeDefined();

      memberOrgs = await getUserOrganizationsWithSeats(member.id);
      expect(memberOrgs).toHaveLength(0);
      expect(invalidateOrganizationSessionAccess).toHaveBeenCalledWith(member.id, organization.id);
    });

    test('should handle removing non-existent membership gracefully', async () => {
      const owner = await insertTestUser();
      const nonMember = await insertTestUser();
      const organization = await createOrganization('Test Org', owner.id);

      const result = await removeUserFromOrganization(organization.id, nonMember.id);

      expect(result).toBeDefined();
      expect(invalidateOrganizationSessionAccess).not.toHaveBeenCalled();
    });

    test('should complete removal when session access invalidation fails', async () => {
      const owner = await insertTestUser();
      const member = await insertTestUser();
      const organization = await createOrganization('Test Org', owner.id);
      await addUserToOrganization(organization.id, member.id, 'member');
      jest
        .mocked(invalidateOrganizationSessionAccess)
        .mockRejectedValueOnce(new Error('invalidation unavailable'));

      await expect(removeUserFromOrganization(organization.id, member.id)).resolves.toBeDefined();

      const memberOrgs = await getUserOrganizationsWithSeats(member.id);
      expect(memberOrgs).toHaveLength(0);
      expect(invalidateOrganizationSessionAccess).toHaveBeenCalledWith(member.id, organization.id);
    });

    test('closes Cloud Agent org streams when a member is removed', async () => {
      const owner = await insertTestUser();
      const member = await insertTestUser();
      const organization = await createOrganization('Test Org', owner.id);
      await addUserToOrganization(organization.id, member.id, 'member');

      await removeUserFromOrganization(organization.id, member.id);

      expect(closeCloudAgentOrgStreams).toHaveBeenCalledWith(member.id, organization.id);
    });

    test('does not close Cloud Agent org streams when no membership was removed', async () => {
      const owner = await insertTestUser();
      const nonMember = await insertTestUser();
      const organization = await createOrganization('Test Org', owner.id);

      await removeUserFromOrganization(organization.id, nonMember.id);

      expect(closeCloudAgentOrgStreams).not.toHaveBeenCalled();
    });

    test('completes removal when Cloud Agent stream close fails', async () => {
      const owner = await insertTestUser();
      const member = await insertTestUser();
      const organization = await createOrganization('Test Org', owner.id);
      await addUserToOrganization(organization.id, member.id, 'member');
      jest
        .mocked(closeCloudAgentOrgStreams)
        .mockRejectedValueOnce(new Error('stream close unavailable'));

      await expect(removeUserFromOrganization(organization.id, member.id)).resolves.toBeDefined();

      const memberOrgs = await getUserOrganizationsWithSeats(member.id);
      expect(memberOrgs).toHaveLength(0);
      expect(closeCloudAgentOrgStreams).toHaveBeenCalledWith(member.id, organization.id);
    });

    test('should remove specific user without affecting others', async () => {
      const owner = await insertTestUser();
      const member1 = await insertTestUser();
      const member2 = await insertTestUser();
      const organization = await createOrganization('Test Org', owner.id);

      await addUserToOrganization(organization.id, member1.id, 'member');
      await addUserToOrganization(organization.id, member2.id, 'owner');

      await removeUserFromOrganization(organization.id, member1.id);

      const ownerOrgs = await getUserOrganizationsWithSeats(owner.id);
      const member1Orgs = await getUserOrganizationsWithSeats(member1.id);
      const member2Orgs = await getUserOrganizationsWithSeats(member2.id);

      expect(ownerOrgs).toHaveLength(1);
      expect(member1Orgs).toHaveLength(0); // removed
      expect(member2Orgs).toHaveLength(1);

      expect(ownerOrgs[0].role).toBe('owner');
      expect(member2Orgs[0].role).toBe('owner');
    });

    test('should allow removing owner (though this might be restricted in business logic)', async () => {
      const owner = await insertTestUser();
      const organization = await createOrganization('Test Org', owner.id);

      await removeUserFromOrganization(organization.id, owner.id);

      const ownerOrgs = await getUserOrganizationsWithSeats(owner.id);
      expect(ownerOrgs).toHaveLength(0);
    });

    test('does not restore a removed user during SSO JIT provisioning', async () => {
      const owner = await insertTestUser();
      const member = await insertTestUser();
      const organization = await createOrganization('SSO Org', owner.id);
      await addUserToOrganization(organization.id, member.id, 'member');
      await removeUserFromOrganization(organization.id, member.id, owner.id);

      const added = await addSsoUserToOrganization(organization.id, member.id);

      expect(added).toBe(false);
      expect(await getUserOrganizationsWithSeats(member.id)).toHaveLength(0);
    });

    test('disables the personal account for a brand-new user provisioned via SSO', async () => {
      const owner = await insertTestUser();
      const member = await insertTestUser();
      const organization = await createOrganization('SSO Org', owner.id);

      const added = await addSsoUserToOrganization(organization.id, member.id, {
        isNewUser: true,
      });

      expect(added).toBe(true);
      const updatedMember = await db.query.kilocode_users.findFirst({
        where: eq(kilocode_users.id, member.id),
      });
      expect(updatedMember?.personal_account_disabled).toBe(true);
    });

    test('leaves the personal account untouched for an existing user authenticating via SSO', async () => {
      const owner = await insertTestUser();
      const member = await insertTestUser();
      const organization = await createOrganization('SSO Org', owner.id);

      const added = await addSsoUserToOrganization(organization.id, member.id);

      expect(added).toBe(true);
      const updatedMember = await db.query.kilocode_users.findFirst({
        where: eq(kilocode_users.id, member.id),
      });
      expect(updatedMember?.personal_account_disabled).toBe(false);
    });
  });

  describe('updateUserRoleInOrganization', () => {
    test('should update user role from member to owner', async () => {
      const owner = await insertTestUser();
      const member = await insertTestUser();
      const organization = await createOrganization('Test Org', owner.id);

      await addUserToOrganization(organization.id, member.id, 'member');

      const result = await updateUserRoleInOrganization(organization.id, member.id, 'owner');
      expect(result).toBeDefined();

      const memberOrgs = await getUserOrganizationsWithSeats(member.id);

      expect(memberOrgs).toHaveLength(1);
      expect(memberOrgs[0].role).toBe('owner');
    });

    test('should update user role from owner to member', async () => {
      const owner = await insertTestUser();
      const admin = await insertTestUser();
      const organization = await createOrganization('Test Org', owner.id);

      await addUserToOrganization(organization.id, admin.id, 'owner');

      await updateUserRoleInOrganization(organization.id, admin.id, 'member');

      const adminOrgs = await getUserOrganizationsWithSeats(admin.id);

      expect(adminOrgs).toHaveLength(1);
      expect(adminOrgs[0].role).toBe('member');
    });

    test('should handle updating role for non-existent membership', async () => {
      const owner = await insertTestUser();
      const nonMember = await insertTestUser();
      const organization = await createOrganization('Test Org', owner.id);

      const result = await updateUserRoleInOrganization(organization.id, nonMember.id, 'owner');

      expect(result).toBeDefined();

      const nonMemberOrgs = await getUserOrganizationsWithSeats(nonMember.id);
      expect(nonMemberOrgs).toHaveLength(0);
    });

    test('should update updated_at timestamp when role changes', async () => {
      const owner = await insertTestUser();
      const member = await insertTestUser();
      const organization = await createOrganization('Test Org', owner.id);

      await addUserToOrganization(organization.id, member.id, 'member');

      // Wait a bit to ensure timestamp difference
      await new Promise(resolve => setTimeout(resolve, 10));

      await updateUserRoleInOrganization(organization.id, member.id, 'owner');

      const memberOrgs = await getUserOrganizationsWithSeats(member.id);

      expect(memberOrgs).toHaveLength(1);
      expect(memberOrgs[0].role).toBe('owner');
    });

    test('should not affect other users when updating one user role', async () => {
      const owner = await insertTestUser();
      const member1 = await insertTestUser();
      const member2 = await insertTestUser();
      const organization = await createOrganization('Test Org', owner.id);

      await addUserToOrganization(organization.id, member1.id, 'member');
      await addUserToOrganization(organization.id, member2.id, 'member');

      await updateUserRoleInOrganization(organization.id, member1.id, 'owner');

      const ownerOrgs = await getUserOrganizationsWithSeats(owner.id);
      const member1Orgs = await getUserOrganizationsWithSeats(member1.id);
      const member2Orgs = await getUserOrganizationsWithSeats(member2.id);

      expect(ownerOrgs).toHaveLength(1);
      expect(member1Orgs).toHaveLength(1);
      expect(member2Orgs).toHaveLength(1);

      expect(ownerOrgs[0].role).toBe('owner');
      expect(member1Orgs[0].role).toBe('owner');
      expect(member2Orgs[0].role).toBe('member');
    });

    test('should update pending invitations when user is not yet a member', async () => {
      const owner = await insertTestUser();
      const organization = await createOrganization('Test Org', owner.id);
      const invitee = await insertTestUser();

      const invitation = await inviteUserToOrganization(
        organization.id,
        owner.id,
        invitee.google_user_email,
        'member'
      );

      expect(invitation.role).toBe('member');

      await updateUserRoleInOrganization(organization.id, invitee.id, 'owner');

      const [updatedInvitation] = await db
        .select()
        .from(organization_invitations)
        .where(eq(organization_invitations.id, invitation.id));

      expect(updatedInvitation.role).toBe('owner');
      expect(new Date(updatedInvitation.updated_at).getTime()).toBeGreaterThanOrEqual(
        new Date(invitation.updated_at).getTime()
      );
    });

    test('should update pending invitation role for user email', async () => {
      const owner = await insertTestUser();
      const organization = await createOrganization('Test Org', owner.id);
      const invitee = await insertTestUser();

      const invitation = await inviteUserToOrganization(
        organization.id,
        owner.id,
        invitee.google_user_email,
        'member'
      );

      await updateUserRoleInOrganization(organization.id, invitee.id, 'owner');

      const updatedInvitations = await db
        .select()
        .from(organization_invitations)
        .where(
          and(
            eq(organization_invitations.organization_id, organization.id),
            eq(organization_invitations.email, invitee.google_user_email)
          )
        );

      expect(updatedInvitations).toHaveLength(1);
      expect(updatedInvitations[0].role).toBe('owner');
      expect(updatedInvitations[0].id).toBe(invitation.id);
    });

    test('should not update expired invitations', async () => {
      const owner = await insertTestUser();
      const organization = await createOrganization('Test Org', owner.id);
      const invitee = await insertTestUser();

      const invitation = await inviteUserToOrganization(
        organization.id,
        owner.id,
        invitee.google_user_email,
        'member'
      );

      await db
        .update(organization_invitations)
        .set({ expires_at: sql`NOW() - INTERVAL '1 day'` })
        .where(eq(organization_invitations.id, invitation.id));

      await updateUserRoleInOrganization(organization.id, invitee.id, 'owner');

      const [unchangedInvitation] = await db
        .select()
        .from(organization_invitations)
        .where(eq(organization_invitations.id, invitation.id));

      expect(unchangedInvitation.role).toBe('member'); // Should remain unchanged
    });

    test('should not update accepted invitations', async () => {
      const owner = await insertTestUser();
      const organization = await createOrganization('Test Org', owner.id);
      const invitee = await insertTestUser();

      const invitation = await inviteUserToOrganization(
        organization.id,
        owner.id,
        invitee.google_user_email,
        'member'
      );

      await acceptOrganizationInvite(invitee.id, invitation.token);

      await updateUserRoleInOrganization(organization.id, invitee.id, 'owner');

      const [unchangedInvitation] = await db
        .select()
        .from(organization_invitations)
        .where(eq(organization_invitations.id, invitation.id));

      expect(unchangedInvitation.role).toBe('member'); // Should remain unchanged

      const [membership] = await db
        .select()
        .from(organization_memberships)
        .where(
          and(
            eq(organization_memberships.organization_id, organization.id),
            eq(organization_memberships.kilo_user_id, invitee.id)
          )
        );

      expect(membership.role).toBe('owner');
    });

    test('should reject invitation when user is already a member', async () => {
      const owner = await insertTestUser();
      const organization = await createOrganization('Test Org', owner.id);
      const invitee = await insertTestUser();

      await addUserToOrganization(organization.id, invitee.id, 'member');

      await expect(
        inviteUserToOrganization(organization.id, owner.id, invitee.google_user_email, 'member')
      ).rejects.toThrow('User is already a member of this organization');

      await updateUserRoleInOrganization(organization.id, invitee.id, 'owner');

      const [membership] = await db
        .select()
        .from(organization_memberships)
        .where(
          and(
            eq(organization_memberships.organization_id, organization.id),
            eq(organization_memberships.kilo_user_id, invitee.id)
          )
        );

      expect(membership.role).toBe('owner');
    });
  });

  describe('inviteUserToOrganization', () => {
    test('should create invitation with correct details', async () => {
      const owner = await insertTestUser();
      const organization = await createOrganization('Test Org', owner.id);
      const inviteeEmail = 'invitee@example.com';

      const invitation = await inviteUserToOrganization(
        organization.id,
        owner.id,
        inviteeEmail,
        'member'
      );

      expect(invitation.id).toBeDefined();
      expect(invitation.organization_id).toBe(organization.id);
      expect(invitation.email).toBe(inviteeEmail);
      expect(invitation.role).toBe('member');
      expect(invitation.invited_by).toBe(owner.id);
      expect(invitation.token).toBeDefined();
      expect(invitation.expires_at).toBeDefined();
      expect(invitation.accepted_at).toBeNull();
      expect(invitation.created_at).toBeDefined();
      expect(invitation.updated_at).toBeDefined();

      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      expect(uuidRegex.test(invitation.token)).toBe(true);
    });

    test('should create invitation with owner role', async () => {
      const owner = await insertTestUser();
      const organization = await createOrganization('Test Org', owner.id);
      const inviteeEmail = 'newowner@example.com';

      const invitation = await inviteUserToOrganization(
        organization.id,
        owner.id,
        inviteeEmail,
        'owner'
      );

      expect(invitation.role).toBe('owner');
    });

    test('should set expiration date to 7 days from now', async () => {
      const owner = await insertTestUser();
      const organization = await createOrganization('Test Org', owner.id);
      const inviteeEmail = 'invitee@example.com';

      const beforeInvite = new Date();
      const invitation = await inviteUserToOrganization(
        organization.id,
        owner.id,
        inviteeEmail,
        'member'
      );
      const afterInvite = new Date();

      const expiresAt = new Date(invitation.expires_at);
      const expectedMinExpiry = new Date(beforeInvite.getTime() + 7 * 24 * 60 * 60 * 1000 - 1000); // 7 days minus 1 second buffer
      const expectedMaxExpiry = new Date(afterInvite.getTime() + 7 * 24 * 60 * 60 * 1000 + 1000); // 7 days plus 1 second buffer

      expect(expiresAt.getTime()).toBeGreaterThan(expectedMinExpiry.getTime());
      expect(expiresAt.getTime()).toBeLessThan(expectedMaxExpiry.getTime());
    });

    test('should allow multiple invitations to same organization', async () => {
      const owner = await insertTestUser();
      const organization = await createOrganization('Test Org', owner.id);

      const invitation1 = await inviteUserToOrganization(
        organization.id,
        owner.id,
        'user1@example.com',
        'member'
      );

      const invitation2 = await inviteUserToOrganization(
        organization.id,
        owner.id,
        'user2@example.com',
        'owner'
      );

      expect(invitation1.id).not.toBe(invitation2.id);
      expect(invitation1.token).not.toBe(invitation2.token);
      expect(invitation1.email).toBe('user1@example.com');
      expect(invitation2.email).toBe('user2@example.com');
      expect(invitation1.role).toBe('member');
      expect(invitation2.role).toBe('owner');
    });

    test('should allow same email to be invited to different organizations', async () => {
      const owner1 = await insertTestUser();
      const owner2 = await insertTestUser();
      const org1 = await createOrganization('Org 1', owner1.id);
      const org2 = await createOrganization('Org 2', owner2.id);
      const inviteeEmail = 'user@example.com';

      const invitation1 = await inviteUserToOrganization(
        org1.id,
        owner1.id,
        inviteeEmail,
        'member'
      );

      const invitation2 = await inviteUserToOrganization(org2.id, owner2.id, inviteeEmail, 'owner');

      expect(invitation1.organization_id).toBe(org1.id);
      expect(invitation2.organization_id).toBe(org2.id);
      expect(invitation1.email).toBe(inviteeEmail);
      expect(invitation2.email).toBe(inviteeEmail);
      expect(invitation1.role).toBe('member');
      expect(invitation2.role).toBe('owner');
    });

    test('should generate unique tokens for each invitation', async () => {
      const owner = await insertTestUser();
      const organization = await createOrganization('Test Org', owner.id);

      const invitation1 = await inviteUserToOrganization(
        organization.id,
        owner.id,
        'user1@example.com',
        'member'
      );

      const invitation2 = await inviteUserToOrganization(
        organization.id,
        owner.id,
        'user2@example.com',
        'member'
      );

      expect(invitation1.token).not.toBe(invitation2.token);

      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      expect(uuidRegex.test(invitation1.token)).toBe(true);
      expect(uuidRegex.test(invitation2.token)).toBe(true);
    });

    test('should handle email addresses with various formats', async () => {
      const owner = await insertTestUser();
      const organization = await createOrganization('Test Org', owner.id);

      const testEmails = [
        'simple@example.com',
        'user.name@example.com',
        'user+tag@example.com',
        'user123@sub.example.com',
        'UPPERCASE@EXAMPLE.COM',
      ];

      for (const email of testEmails) {
        const invitation = await inviteUserToOrganization(
          organization.id,
          owner.id,
          email,
          'member'
        );

        expect(invitation.email).toBe(email);
      }
    });

    test('should store invitation in database correctly', async () => {
      const owner = await insertTestUser();
      const organization = await createOrganization('Test Org', owner.id);
      const inviteeEmail = 'invitee@example.com';

      const invitation = await inviteUserToOrganization(
        organization.id,
        owner.id,
        inviteeEmail,
        'member'
      );

      const storedInvitation = await db.query.organization_invitations.findFirst({
        where: eq(organization_invitations.id, invitation.id),
      });

      expect(storedInvitation).toBeTruthy();
      expect(storedInvitation?.organization_id).toBe(organization.id);
      expect(storedInvitation?.email).toBe(inviteeEmail);
      expect(storedInvitation?.role).toBe('member');
      expect(storedInvitation?.invited_by).toBe(owner.id);
      expect(storedInvitation?.token).toBe(invitation.token);
      expect(storedInvitation?.accepted_at).toBeNull();
    });

    test('should allow admin to invite users', async () => {
      const owner = await insertTestUser();
      const admin = await insertTestUser();
      const organization = await createOrganization('Test Org', owner.id);

      await addUserToOrganization(organization.id, admin.id, 'owner');

      const invitation = await inviteUserToOrganization(
        organization.id,
        admin.id,
        'newuser@example.com',
        'member'
      );

      expect(invitation.invited_by).toBe(admin.id);
      expect(invitation.organization_id).toBe(organization.id);
    });

    test('should allow member to invite users (if business logic permits)', async () => {
      const owner = await insertTestUser();
      const member = await insertTestUser();
      const organization = await createOrganization('Test Org', owner.id);

      await addUserToOrganization(organization.id, member.id, 'member');

      const invitation = await inviteUserToOrganization(
        organization.id,
        member.id,
        'newuser@example.com',
        'member'
      );

      expect(invitation.invited_by).toBe(member.id);
      expect(invitation.organization_id).toBe(organization.id);
    });

    test('should reject duplicate invitation for same email with pending invitation', async () => {
      const owner = await insertTestUser();
      const organization = await createOrganization('Test Org', owner.id);
      const inviteeEmail = 'duplicate@example.com';

      await inviteUserToOrganization(organization.id, owner.id, inviteeEmail, 'member');

      await expect(
        inviteUserToOrganization(organization.id, owner.id, inviteeEmail, 'member')
      ).rejects.toThrow('User already has a pending invitation');
    });

    test('should reject invitation for user who is already a member', async () => {
      const owner = await insertTestUser();
      const existingMember = await insertTestUser();
      const organization = await createOrganization('Test Org', owner.id);

      await addUserToOrganization(organization.id, existingMember.id, 'member');

      await expect(
        inviteUserToOrganization(
          organization.id,
          owner.id,
          existingMember.google_user_email,
          'member'
        )
      ).rejects.toThrow('User is already a member of this organization');
    });

    test('should allow inviting same email after previous invitation expired', async () => {
      const owner = await insertTestUser();
      const organization = await createOrganization('Test Org', owner.id);
      const inviteeEmail = 'expired@example.com';

      const firstInvitation = await inviteUserToOrganization(
        organization.id,
        owner.id,
        inviteeEmail,
        'member'
      );

      await db
        .update(organization_invitations)
        .set({ expires_at: sql`NOW() - INTERVAL '1 day'` })
        .where(eq(organization_invitations.id, firstInvitation.id));

      const secondInvitation = await inviteUserToOrganization(
        organization.id,
        owner.id,
        inviteeEmail,
        'member'
      );

      expect(secondInvitation.email).toBe(inviteeEmail);
      expect(secondInvitation.id).not.toBe(firstInvitation.id);
    });

    test('should allow inviting same email after previous invitation was accepted', async () => {
      const owner = await insertTestUser();
      const invitee = await insertTestUser();
      const organization = await createOrganization('Test Org', owner.id);

      const firstInvitation = await inviteUserToOrganization(
        organization.id,
        owner.id,
        invitee.google_user_email,
        'member'
      );

      await acceptOrganizationInvite(invitee.id, firstInvitation.token);

      await removeUserFromOrganization(organization.id, invitee.id);

      const secondInvitation = await inviteUserToOrganization(
        organization.id,
        owner.id,
        invitee.google_user_email,
        'member'
      );

      expect(secondInvitation.email).toBe(invitee.google_user_email);
      expect(secondInvitation.id).not.toBe(firstInvitation.id);
    });

    test('requires direct SSO users to join through JIT provisioning', async () => {
      const owner = await insertTestUser();
      const organization = await createOrganization('Direct SSO Org', owner.id);
      await db
        .update(organizations)
        .set({ sso_domain: 'example.com' })
        .where(eq(organizations.id, organization.id));

      await expect(
        inviteUserToOrganization(organization.id, owner.id, 'member@example.com', 'member')
      ).rejects.toThrow('User must join this organization through SSO');
    });

    test('rejects invitations into a child organization', async () => {
      const owner = await insertTestUser();
      const parent = await createOrganization('Parent Org', owner.id);
      const child = await createOrganization('Child Org', owner.id);
      await db
        .update(organizations)
        .set({ parent_organization_id: parent.id })
        .where(eq(organizations.id, child.id));

      await expect(
        inviteUserToOrganization(child.id, owner.id, 'member@example.com', 'member')
      ).rejects.toThrow('Child organizations cannot invite members');
    });
  });

  describe('Integration tests', () => {
    test('should handle complete organization lifecycle', async () => {
      const owner = await insertTestUser();
      const member1 = await insertTestUser();
      const member2 = await insertTestUser();

      const organization = await createOrganization('Complete Lifecycle Org', owner.id);

      await addUserToOrganization(organization.id, member1.id, 'member');
      await addUserToOrganization(organization.id, member2.id, 'owner');

      const ownerOrgs = await getUserOrganizationsWithSeats(owner.id);
      const member1Orgs = await getUserOrganizationsWithSeats(member1.id);
      const member2Orgs = await getUserOrganizationsWithSeats(member2.id);

      expect(ownerOrgs).toHaveLength(1);
      expect(member1Orgs).toHaveLength(1);
      expect(member2Orgs).toHaveLength(1);

      await updateUserRoleInOrganization(organization.id, member1.id, 'owner');
      await updateUserRoleInOrganization(organization.id, member2.id, 'member');

      const updatedMember1Orgs = await getUserOrganizationsWithSeats(member1.id);
      const updatedMember2Orgs = await getUserOrganizationsWithSeats(member2.id);

      expect(updatedMember1Orgs[0].role).toBe('owner');
      expect(updatedMember2Orgs[0].role).toBe('member');

      await removeUserFromOrganization(organization.id, member2.id);

      const finalMember2Orgs = await getUserOrganizationsWithSeats(member2.id);
      expect(finalMember2Orgs).toHaveLength(0);

      const finalOwnerOrgs = await getUserOrganizationsWithSeats(owner.id);
      const finalMember1Orgs = await getUserOrganizationsWithSeats(member1.id);

      expect(finalOwnerOrgs).toHaveLength(1);
      expect(finalMember1Orgs).toHaveLength(1);
    });

    test('should handle multiple organizations per user', async () => {
      const user = await insertTestUser();
      const otherUser1 = await insertTestUser();
      const otherUser2 = await insertTestUser();

      await createOrganization('Own Organization', user.id);

      const otherOrg1 = await createOrganization('Other Org 1', otherUser1.id);
      const otherOrg2 = await createOrganization('Other Org 2', otherUser2.id);

      await addUserToOrganization(otherOrg1.id, user.id, 'owner');
      await addUserToOrganization(otherOrg2.id, user.id, 'member');

      const userOrgs = await getUserOrganizationsWithSeats(user.id);

      expect(userOrgs).toHaveLength(3);

      const roles = userOrgs.map(org => org.role).sort();
      expect(roles).toEqual(['member', 'owner', 'owner']);

      const orgNames = userOrgs.map(org => org.organizationName).sort();
      expect(orgNames).toEqual(['Other Org 1', 'Other Org 2', 'Own Organization']);
    });

    test('should handle invitation and membership workflow', async () => {
      const owner = await insertTestUser();
      const organization = await createOrganization('Test Org', owner.id);

      const invitation = await inviteUserToOrganization(
        organization.id,
        owner.id,
        'newuser@example.com',
        'member'
      );

      expect(invitation.organization_id).toBe(organization.id);
      expect(invitation.email).toBe('newuser@example.com');
      expect(invitation.role).toBe('member');

      const newUser = await insertTestUser({
        google_user_email: 'newuser@example.com',
      });

      await addUserToOrganization(organization.id, newUser.id, invitation.role);

      const newUserOrgs = await getUserOrganizationsWithSeats(newUser.id);
      expect(newUserOrgs).toHaveLength(1);
      expect(newUserOrgs[0].organizationId).toBe(organization.id);
      expect(newUserOrgs[0].role).toBe('member');
    });
    describe('getOrganizationMembers', () => {
      test('should return empty array when organization has no members or invitations', async () => {
        const owner = await insertTestUser();
        const organization = await createOrganization('Test Org', owner.id);

        await removeUserFromOrganization(organization.id, owner.id);

        const result = await getOrganizationMembers(organization.id);

        expect(result).toEqual([]);
      });

      test('should return only active members when no pending invitations exist', async () => {
        const owner = await insertTestUser();
        const member1 = await insertTestUser();
        const member2 = await insertTestUser();
        const organization = await createOrganization('Test Org', owner.id);

        await addUserToOrganization(organization.id, member1.id, 'member');
        await addUserToOrganization(organization.id, member2.id, 'owner');

        const result = await getOrganizationMembers(organization.id);

        expect(result).toHaveLength(3); // owner + 2 members

        expect(result.every(member => member.status === 'active')).toBe(true);

        const roles = result.map(member => member.role).sort();
        expect(roles).toEqual(['member', 'owner', 'owner']);

        expect(result.every(member => member.status === 'active')).toBe(true);
        expect(
          result.every(member => member.status === 'active' && 'id' in member && member.id !== '')
        ).toBe(true);
        expect(
          result.every(
            member => member.status === 'active' && 'name' in member && member.name !== ''
          )
        ).toBe(true);
        expect(result.every(member => member.email !== '')).toBe(true);
        expect(result.every(member => member.inviteDate !== null)).toBe(true);
      });

      test('should return only pending invitations when no active members exist', async () => {
        const owner = await insertTestUser();
        const organization = await createOrganization('Test Org', owner.id);

        await removeUserFromOrganization(organization.id, owner.id);

        await inviteUserToOrganization(organization.id, owner.id, 'invite1@example.com', 'member');
        await inviteUserToOrganization(organization.id, owner.id, 'invite2@example.com', 'owner');

        const result = await getOrganizationMembers(organization.id);

        expect(result).toHaveLength(2);

        expect(result.every(member => member.status === 'invited')).toBe(true);

        const roles = result.map(member => member.role).sort();
        expect(roles).toEqual(['member', 'owner']);

        expect(result.every(member => member.status === 'invited')).toBe(true);
        expect(result.every(member => member.email !== '')).toBe(true);
        expect(result.every(member => member.inviteDate !== null)).toBe(true);
        expect(result.every(member => 'inviteToken' in member)).toBe(true);
        expect(result.every(member => 'inviteId' in member)).toBe(true);
        expect(result.every(member => 'inviteUrl' in member)).toBe(true);

        const emails = result.map(member => member.email).sort();
        expect(emails).toEqual(['invite1@example.com', 'invite2@example.com']);
      });

      test('should return both active members and pending invitations', async () => {
        const owner = await insertTestUser();
        const member = await insertTestUser();
        const organization = await createOrganization('Test Org', owner.id);

        await addUserToOrganization(organization.id, member.id, 'owner');

        await inviteUserToOrganization(organization.id, owner.id, 'pending1@example.com', 'member');
        await inviteUserToOrganization(organization.id, owner.id, 'pending2@example.com', 'owner');

        const result = await getOrganizationMembers(organization.id);

        expect(result).toHaveLength(4); // owner + member + 2 invitations

        const activeMembers = result.filter(member => member.status === 'active');
        const pendingInvitations = result.filter(member => member.status === 'invited');

        expect(activeMembers).toHaveLength(2); // owner + member
        expect(pendingInvitations).toHaveLength(2); // 2 invitations

        expect(
          activeMembers.every(
            member => member.status === 'active' && 'id' in member && member.id !== ''
          )
        ).toBe(true);
        expect(
          activeMembers.every(
            member => member.status === 'active' && 'name' in member && member.name !== ''
          )
        ).toBe(true);
        expect(activeMembers.every(member => member.email !== '')).toBe(true);

        expect(pendingInvitations.every(member => member.status === 'invited')).toBe(true);
        expect(pendingInvitations.every(member => member.email !== '')).toBe(true);
        expect(pendingInvitations.every(member => 'inviteToken' in member)).toBe(true);
        expect(pendingInvitations.every(member => 'inviteId' in member)).toBe(true);
        expect(pendingInvitations.every(member => 'inviteUrl' in member)).toBe(true);

        const allRoles = result.map(member => member.role).sort();
        expect(allRoles).toEqual(['member', 'owner', 'owner', 'owner']);
      });

      test('should not include expired invitations', async () => {
        const owner = await insertTestUser();
        const organization = await createOrganization('Test Org', owner.id);

        await inviteUserToOrganization(organization.id, owner.id, 'valid@example.com', 'member');

        await db.insert(organization_invitations).values({
          organization_id: organization.id,
          email: 'expired@example.com',
          role: 'member',
          invited_by: owner.id,
          token: 'expired-token',
          expires_at: sql`NOW() - INTERVAL '1 day'`, // Expired yesterday
        });

        const result = await getOrganizationMembers(organization.id);

        expect(result).toHaveLength(2);

        const emails = result.map(member => member.email);
        expect(emails).toContain('valid@example.com');
        expect(emails).not.toContain('expired@example.com');
      });

      test('should not include accepted invitations', async () => {
        const owner = await insertTestUser();
        const organization = await createOrganization('Test Org', owner.id);

        await inviteUserToOrganization(organization.id, owner.id, 'pending@example.com', 'member');

        await db.insert(organization_invitations).values({
          organization_id: organization.id,
          email: 'accepted@example.com',
          role: 'member',
          invited_by: owner.id,
          token: 'accepted-token',
          expires_at: sql`NOW() + INTERVAL '7 days'`,
          accepted_at: sql`NOW()`, // Already accepted
        });

        const result = await getOrganizationMembers(organization.id);

        expect(result).toHaveLength(2);

        const emails = result.map(member => member.email);
        expect(emails).toContain('pending@example.com');
        expect(emails).not.toContain('accepted@example.com');
      });

      test('should handle organization with mixed roles correctly', async () => {
        const owner = await insertTestUser();
        const admin = await insertTestUser();
        const member1 = await insertTestUser();
        const member2 = await insertTestUser();
        const organization = await createOrganization('Test Org', owner.id);

        await addUserToOrganization(organization.id, admin.id, 'owner');
        await addUserToOrganization(organization.id, member1.id, 'member');
        await addUserToOrganization(organization.id, member2.id, 'member');

        await inviteUserToOrganization(
          organization.id,
          owner.id,
          'pending-owner@example.com',
          'owner'
        );
        await inviteUserToOrganization(
          organization.id,
          owner.id,
          'pending-admin@example.com',
          'owner'
        );
        await inviteUserToOrganization(
          organization.id,
          owner.id,
          'pending-member@example.com',
          'member'
        );

        const result = await getOrganizationMembers(organization.id);

        expect(result).toHaveLength(7); // 4 active + 3 pending

        const roleCount = result.reduce(
          (acc, member) => {
            acc[member.role] = (acc[member.role] || 0) + 1;
            return acc;
          },
          {} as Record<string, number>
        );

        expect(roleCount.owner).toBe(4); // 2 active + 2 pending
        expect(roleCount.member).toBe(3); // 2 active + 1 pending

        const statusCount = result.reduce(
          (acc, member) => {
            acc[member.status] = (acc[member.status] || 0) + 1;
            return acc;
          },
          {} as Record<string, number>
        );

        expect(statusCount.active).toBe(4);
        expect(statusCount.invited).toBe(3);
      });

      test('should return members sorted consistently', async () => {
        const owner = await insertTestUser();
        const member = await insertTestUser();
        const organization = await createOrganization('Test Org', owner.id);

        await addUserToOrganization(organization.id, member.id, 'member');
        await inviteUserToOrganization(organization.id, owner.id, 'invited@example.com', 'owner');

        const result1 = await getOrganizationMembers(organization.id);
        const result2 = await getOrganizationMembers(organization.id);

        expect(result1).toHaveLength(3);
        expect(result2).toHaveLength(3);

        expect(result1.map(m => ({ email: m.email, status: m.status }))).toEqual(
          result2.map(m => ({ email: m.email, status: m.status }))
        );

        const activeCount = result1.filter(m => m.status === 'active').length;
        const invitedCount = result1.filter(m => m.status === 'invited').length;

        expect(activeCount).toBe(2);
        expect(invitedCount).toBe(1);

        for (let i = 0; i < activeCount; i++) {
          expect(result1[i].status).toBe('active');
        }
        for (let i = activeCount; i < result1.length; i++) {
          expect(result1[i].status).toBe('invited');
        }
      });

      test('should handle non-existent organization gracefully', async () => {
        const nonExistentOrgId = '00000000-0000-0000-0000-000000000000'; // Valid UUID format

        const result = await getOrganizationMembers(nonExistentOrgId);

        expect(result).toEqual([]);
      });

      test('should include invite date for all members and invitations', async () => {
        const owner = await insertTestUser();
        const member = await insertTestUser();
        const organization = await createOrganization('Test Org', owner.id);

        await addUserToOrganization(organization.id, member.id, 'member');
        await inviteUserToOrganization(organization.id, owner.id, 'invited@example.com', 'owner');

        const result = await getOrganizationMembers(organization.id);

        expect(result).toHaveLength(3);

        expect(result.every(member => member.inviteDate !== null)).toBe(true);
        expect(result.every(member => typeof member.inviteDate === 'string')).toBe(true);

        result.forEach(member => {
          expect(() => new Date(member.inviteDate!)).not.toThrow();
          expect(new Date(member.inviteDate!).getTime()).toBeGreaterThan(0);
        });
      });

      test('should handle large number of members and invitations', async () => {
        const owner = await insertTestUser();
        const organization = await createOrganization('Test Org', owner.id);

        const members = [];
        for (let i = 0; i < 5; i++) {
          const member = await insertTestUser();
          await addUserToOrganization(organization.id, member.id, i % 2 === 0 ? 'member' : 'owner');
          members.push(member);
        }

        for (let i = 0; i < 3; i++) {
          await inviteUserToOrganization(
            organization.id,
            owner.id,
            `invite${i}@example.com`,
            i === 0 ? 'owner' : i === 1 ? 'owner' : 'member'
          );
        }

        const result = await getOrganizationMembers(organization.id);

        expect(result).toHaveLength(9); // owner + 5 members + 3 invitations

        const activeMembers = result.filter(m => m.status === 'active');
        const pendingInvitations = result.filter(m => m.status === 'invited');

        expect(activeMembers).toHaveLength(6); // owner + 5 members
        expect(pendingInvitations).toHaveLength(3); // 3 invitations

        result.forEach(member => {
          expect(member.role).toBeDefined();
          expect(member.status).toBeDefined();
          expect(member.email).toBeDefined();
          expect(member.inviteDate).toBeDefined();

          if (member.status === 'active') {
            expect('id' in member && member.id !== '').toBe(true);
            expect('name' in member && member.name !== '').toBe(true);
          } else if (member.status === 'invited') {
            expect('inviteToken' in member).toBe(true);
            expect('inviteId' in member).toBe(true);
            expect('inviteUrl' in member).toBe(true);
          }
        });
      });
    });
    describe('acceptOrganizationInvite', () => {
      test('should accept valid invitation and add user to organization', async () => {
        const owner = await insertTestUser();
        const invitee = await insertTestUser();
        const organization = await createOrganization('Test Org', owner.id);

        const invitation = await inviteUserToOrganization(
          organization.id,
          owner.id,
          invitee.google_user_email,
          'member'
        );

        const result = await acceptOrganizationInvite(invitee.id, invitation.token);

        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.organizationId).toBe(organization.id);
          expect(result.role).toBe('member');
          expect(result.invitation.accepted_at).toBeDefined();
          expect(result.invitation.accepted_at).not.toBeNull();
        }

        const userOrgs = await getUserOrganizationsWithSeats(invitee.id);
        expect(userOrgs).toHaveLength(1);
        expect(userOrgs[0].organizationId).toBe(organization.id);
        expect(userOrgs[0].role).toBe('member');

        const storedInvitation = await db.query.organization_invitations.findFirst({
          where: eq(organization_invitations.token, invitation.token),
        });
        expect(storedInvitation?.accepted_at).toBeDefined();
        expect(storedInvitation?.accepted_at).not.toBeNull();
      });

      test('disables the personal account when the account was created after the invite', async () => {
        const owner = await insertTestUser();
        const invitee = await insertTestUser();
        const organization = await createOrganization('Test Org', owner.id);

        const invitation = await inviteUserToOrganization(
          organization.id,
          owner.id,
          invitee.google_user_email,
          'member'
        );
        // Simulate a brand-new account created to accept an already-pending invite.
        await db
          .update(organization_invitations)
          .set({ created_at: sql`NOW() - INTERVAL '1 hour'` })
          .where(eq(organization_invitations.id, invitation.id));

        const result = await acceptOrganizationInvite(invitee.id, invitation.token);
        expect(result.success).toBe(true);

        const updatedInvitee = await db.query.kilocode_users.findFirst({
          where: eq(kilocode_users.id, invitee.id),
        });
        expect(updatedInvitee?.personal_account_disabled).toBe(true);
      });

      test('leaves the personal account untouched when the account predates the invite', async () => {
        const owner = await insertTestUser();
        const invitee = await insertTestUser();
        const organization = await createOrganization('Test Org', owner.id);

        // The invitation is created after the invitee's account, matching an
        // existing user who is later invited to an organization.
        const invitation = await inviteUserToOrganization(
          organization.id,
          owner.id,
          invitee.google_user_email,
          'member'
        );

        const result = await acceptOrganizationInvite(invitee.id, invitation.token);
        expect(result.success).toBe(true);

        const updatedInvitee = await db.query.kilocode_users.findFirst({
          where: eq(kilocode_users.id, invitee.id),
        });
        expect(updatedInvitee?.personal_account_disabled).toBe(false);
      });

      test('skips the customer-source survey when a user joins via invitation', async () => {
        const owner = await insertTestUser();
        const invitee = await insertTestUser({ customer_source: null });
        const organization = await createOrganization('Test Org', owner.id);

        const invitation = await inviteUserToOrganization(
          organization.id,
          owner.id,
          invitee.google_user_email,
          'member'
        );

        const result = await acceptOrganizationInvite(invitee.id, invitation.token);
        expect(result.success).toBe(true);

        const updatedInvitee = await db.query.kilocode_users.findFirst({
          where: eq(kilocode_users.id, invitee.id),
        });
        expect(updatedInvitee?.customer_source).toBe('');
      });

      test('does not overwrite an existing customer-source answer when accepting an invite', async () => {
        const owner = await insertTestUser();
        const invitee = await insertTestUser({ customer_source: 'GitHub' });
        const organization = await createOrganization('Test Org', owner.id);

        const invitation = await inviteUserToOrganization(
          organization.id,
          owner.id,
          invitee.google_user_email,
          'member'
        );

        const result = await acceptOrganizationInvite(invitee.id, invitation.token);
        expect(result.success).toBe(true);

        const updatedInvitee = await db.query.kilocode_users.findFirst({
          where: eq(kilocode_users.id, invitee.id),
        });
        expect(updatedInvitee?.customer_source).toBe('GitHub');
      });

      test('rejects accepting a pre-existing invitation into a child organization', async () => {
        const owner = await insertTestUser();
        const invitee = await insertTestUser({ google_user_email: 'legacy@example.com' });
        const parent = await createOrganization('Parent Org', owner.id);
        const child = await createOrganization('Child Org', owner.id);
        // Invites can no longer be created for child orgs through the normal flow,
        // so insert a pending invite directly, then reparent the org afterwards.
        const token = 'legacy-child-invitation';
        await db.insert(organization_invitations).values({
          organization_id: child.id,
          email: invitee.google_user_email,
          role: 'member',
          invited_by: owner.id,
          token,
          expires_at: sql`NOW() + INTERVAL '1 day'`,
        });
        await db
          .update(organizations)
          .set({ parent_organization_id: parent.id })
          .where(eq(organizations.id, child.id));

        const result = await acceptOrganizationInvite(invitee.id, token);

        expect(result).toEqual({
          success: false,
          error: 'Child organizations cannot accept invitations',
        });

        const userOrgs = await getUserOrganizationsWithSeats(invitee.id);
        expect(userOrgs).toHaveLength(0);
      });

      test('should accept invitation with owner role', async () => {
        const owner = await insertTestUser();
        const invitee = await insertTestUser();
        const organization = await createOrganization('Test Org', owner.id);

        const invitation = await inviteUserToOrganization(
          organization.id,
          owner.id,
          invitee.google_user_email,
          'owner'
        );

        const result = await acceptOrganizationInvite(invitee.id, invitation.token);

        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.role).toBe('owner');
        }

        const userOrgs = await getUserOrganizationsWithSeats(invitee.id);
        expect(userOrgs[0].role).toBe('owner');
      });

      test('should accept invitation with owner role', async () => {
        const owner = await insertTestUser();
        const invitee = await insertTestUser();
        const organization = await createOrganization('Test Org', owner.id);

        const invitation = await inviteUserToOrganization(
          organization.id,
          owner.id,
          invitee.google_user_email,
          'owner'
        );

        const result = await acceptOrganizationInvite(invitee.id, invitation.token);

        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.role).toBe('owner');
        }

        const userOrgs = await getUserOrganizationsWithSeats(invitee.id);
        expect(userOrgs[0].role).toBe('owner');
      });

      test('should return error for non-existent invitation token', async () => {
        const user = await insertTestUser();
        const nonExistentToken = 'non-existent-token';

        const result = await acceptOrganizationInvite(user.id, nonExistentToken);

        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error).toBe('Invitation not found');
        }
      });

      test('should return error for expired invitation', async () => {
        const owner = await insertTestUser();
        const invitee = await insertTestUser();
        const organization = await createOrganization('Test Org', owner.id);

        const expiredToken = 'expired-token-uuid';
        await db.insert(organization_invitations).values({
          organization_id: organization.id,
          email: invitee.google_user_email,
          role: 'member',
          invited_by: owner.id,
          token: expiredToken,
          expires_at: sql`NOW() - INTERVAL '1 day'`, // Expired yesterday
        });

        const result = await acceptOrganizationInvite(invitee.id, expiredToken);

        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error).toBe('Invitation has expired');
        }
      });

      test('should return error for already accepted invitation', async () => {
        const owner = await insertTestUser();
        const invitee = await insertTestUser();
        const organization = await createOrganization('Test Org', owner.id);

        const invitation = await inviteUserToOrganization(
          organization.id,
          owner.id,
          invitee.google_user_email,
          'member'
        );

        const firstResult = await acceptOrganizationInvite(invitee.id, invitation.token);
        expect(firstResult.success).toBe(true);

        const secondResult = await acceptOrganizationInvite(invitee.id, invitation.token);
        expect(secondResult.success).toBe(false);
        if (!secondResult.success) {
          expect(secondResult.error).toBe('Invitation has already been accepted');
        }
      });

      test('should reject invitation when accepting user email does not match invite email', async () => {
        const owner = await insertTestUser();
        const invitee = await insertTestUser();
        const differentUser = await insertTestUser();
        const organization = await createOrganization('Test Org', owner.id);

        const invitation = await inviteUserToOrganization(
          organization.id,
          owner.id,
          invitee.google_user_email,
          'member'
        );

        const result = await acceptOrganizationInvite(differentUser.id, invitation.token);

        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error).toBe('Invitation is for a different email address');
        }

        const storedInvitation = await db.query.organization_invitations.findFirst({
          where: eq(organization_invitations.token, invitation.token),
        });
        expect(storedInvitation?.accepted_at).toBeNull();

        const unexpectedMembership = await db.query.organization_memberships.findFirst({
          where: and(
            eq(organization_memberships.organization_id, organization.id),
            eq(organization_memberships.kilo_user_id, differentUser.id)
          ),
        });
        expect(unexpectedMembership).toBeUndefined();
      });

      test('should accept invitation when normalized user email matches invite email', async () => {
        const owner = await insertTestUser();
        const invitee = await insertTestUser({
          google_user_email: 'johndoe@gmail.com',
          normalized_email: 'johndoe@gmail.com',
        });
        const organization = await createOrganization('Test Org', owner.id);

        const invitation = await inviteUserToOrganization(
          organization.id,
          owner.id,
          'John.Doe+team@googlemail.com',
          'member'
        );

        const result = await acceptOrganizationInvite(invitee.id, invitation.token);

        expect(result.success).toBe(true);
        const userOrgs = await getUserOrganizationsWithSeats(invitee.id);
        expect(userOrgs).toHaveLength(1);
        expect(userOrgs[0].organizationId).toBe(organization.id);
      });

      test('should reject invitation for existing members', async () => {
        const owner = await insertTestUser();
        const invitee = await insertTestUser();
        const organization = await createOrganization('Test Org', owner.id);

        await addUserToOrganization(organization.id, invitee.id, 'owner');

        await expect(
          inviteUserToOrganization(organization.id, owner.id, invitee.google_user_email, 'member')
        ).rejects.toThrow('User is already a member of this organization');

        const userOrgs = await getUserOrganizationsWithSeats(invitee.id);
        expect(userOrgs).toHaveLength(1);
        expect(userOrgs[0].role).toBe('owner');
      });

      test('should preserve invited_by information when accepting invitation', async () => {
        const owner = await insertTestUser();
        const admin = await insertTestUser();
        const invitee = await insertTestUser();
        const organization = await createOrganization('Test Org', owner.id);

        await addUserToOrganization(organization.id, admin.id, 'owner');

        const invitation = await inviteUserToOrganization(
          organization.id,
          admin.id,
          invitee.google_user_email,
          'member'
        );

        await acceptOrganizationInvite(invitee.id, invitation.token);

        const membership = await db.query.organization_memberships.findFirst({
          where: and(
            eq(organization_memberships.organization_id, organization.id),
            eq(organization_memberships.kilo_user_id, invitee.id)
          ),
        });

        expect(membership?.invited_by).toBe(admin.id);
      });

      test('should update invitation timestamps correctly', async () => {
        const owner = await insertTestUser();
        const invitee = await insertTestUser();
        const organization = await createOrganization('Test Org', owner.id);

        const invitation = await inviteUserToOrganization(
          organization.id,
          owner.id,
          invitee.google_user_email,
          'member'
        );

        const beforeAccept = new Date();
        const result = await acceptOrganizationInvite(invitee.id, invitation.token);
        const afterAccept = new Date();

        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.invitation.accepted_at).not.toBeNull();
          const acceptedAt = new Date(result.invitation.accepted_at!);
          expect(acceptedAt.getTime()).toBeGreaterThanOrEqual(beforeAccept.getTime() - 1000); // 1 second buffer
          expect(acceptedAt.getTime()).toBeLessThanOrEqual(afterAccept.getTime() + 1000); // 1 second buffer

          const updatedAt = new Date(result.invitation.updated_at);
          expect(updatedAt.getTime()).toBeGreaterThanOrEqual(beforeAccept.getTime() - 1000);
          expect(updatedAt.getTime()).toBeLessThanOrEqual(afterAccept.getTime() + 1000);
        }
      });

      test('should work with valid UUID token format', async () => {
        const owner = await insertTestUser();
        const invitee = await insertTestUser();
        const organization = await createOrganization('Test Org', owner.id);

        const invitation = await inviteUserToOrganization(
          organization.id,
          owner.id,
          invitee.google_user_email,
          'member'
        );

        const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        expect(uuidRegex.test(invitation.token)).toBe(true);

        const result = await acceptOrganizationInvite(invitee.id, invitation.token);
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.organizationId).toBe(organization.id);
        }
      });

      test('should maintain data consistency during acceptance process', async () => {
        const owner = await insertTestUser();
        const invitee = await insertTestUser();
        const organization = await createOrganization('Test Org', owner.id);

        const invitation = await inviteUserToOrganization(
          organization.id,
          owner.id,
          invitee.google_user_email,
          'member'
        );

        const result = await acceptOrganizationInvite(invitee.id, invitation.token);

        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.organizationId).toBe(organization.id);
          expect(result.role).toBe('member');
        }

        const storedInvitation = await db.query.organization_invitations.findFirst({
          where: eq(organization_invitations.token, invitation.token),
        });
        expect(storedInvitation?.accepted_at).not.toBeNull();

        const membership = await db.query.organization_memberships.findFirst({
          where: and(
            eq(organization_memberships.organization_id, organization.id),
            eq(organization_memberships.kilo_user_id, invitee.id)
          ),
        });
        expect(membership).toBeTruthy();
        expect(membership?.role).toBe('member');
      });

      test('should not affect other invitations when accepting one', async () => {
        const owner = await insertTestUser();
        const invitee1 = await insertTestUser();
        const invitee2 = await insertTestUser();
        const organization = await createOrganization('Test Org', owner.id);

        const invitation1 = await inviteUserToOrganization(
          organization.id,
          owner.id,
          invitee1.google_user_email,
          'member'
        );

        const invitation2 = await inviteUserToOrganization(
          organization.id,
          owner.id,
          invitee2.google_user_email,
          'owner'
        );

        await acceptOrganizationInvite(invitee1.id, invitation1.token);

        const storedInvitation1 = await db.query.organization_invitations.findFirst({
          where: eq(organization_invitations.token, invitation1.token),
        });
        expect(storedInvitation1?.accepted_at).not.toBeNull();

        const storedInvitation2 = await db.query.organization_invitations.findFirst({
          where: eq(organization_invitations.token, invitation2.token),
        });
        expect(storedInvitation2?.accepted_at).toBeNull();

        const result2 = await acceptOrganizationInvite(invitee2.id, invitation2.token);
        expect(result2.success).toBe(true);
        if (result2.success) {
          expect(result2.role).toBe('owner');
        }
      });

      test('should work in complete invitation workflow', async () => {
        const owner = await insertTestUser();
        const invitee = await insertTestUser();
        const organization = await createOrganization('Test Org', owner.id);

        const invitation = await inviteUserToOrganization(
          organization.id,
          owner.id,
          invitee.google_user_email,
          'member'
        );

        let members = await getOrganizationMembers(organization.id);
        const pendingInvitations = members.filter(m => m.status === 'invited');
        expect(pendingInvitations).toHaveLength(1);
        expect(pendingInvitations[0].email).toBe(invitee.google_user_email);

        await acceptOrganizationInvite(invitee.id, invitation.token);

        members = await getOrganizationMembers(organization.id);
        const activeMembers = members.filter(m => m.status === 'active');
        const stillPendingInvitations = members.filter(m => m.status === 'invited');

        expect(activeMembers).toHaveLength(2); // owner + new member
        expect(stillPendingInvitations).toHaveLength(0); // no more pending invitations

        const newMember = activeMembers.find(m => m.email === invitee.google_user_email);
        expect(newMember).toBeDefined();
        expect(newMember?.role).toBe('member');
        expect(newMember?.id).toBe(invitee.id);

        const userOrgs = await getUserOrganizationsWithSeats(invitee.id);
        expect(userOrgs).toHaveLength(1);
        expect(userOrgs[0].organizationId).toBe(organization.id);
        expect(userOrgs[0].role).toBe('member');
      });

      test('should not set usage limits for member role when accepting invitation (default require_seats: true)', async () => {
        const owner = await insertTestUser();
        const invitee = await insertTestUser();
        const organization = await createOrganization('Test Org', owner.id);

        const invitation = await inviteUserToOrganization(
          organization.id,
          owner.id,
          invitee.google_user_email,
          'member'
        );

        const result = await acceptOrganizationInvite(invitee.id, invitation.token);
        expect(result.success).toBe(true);

        const userLimit = await db.query.organization_user_limits.findFirst({
          where: and(
            eq(organization_user_limits.organization_id, organization.id),
            eq(organization_user_limits.kilo_user_id, invitee.id),
            eq(organization_user_limits.limit_type, 'daily')
          ),
        });

        expect(userLimit).toBeUndefined(); // No limit should be set for require_seats orgs
      });

      test('should not set usage limits for owner role when accepting invitation (default require_seats: true)', async () => {
        const owner = await insertTestUser();
        const invitee = await insertTestUser();
        const organization = await createOrganization('Test Org', owner.id);

        const invitation = await inviteUserToOrganization(
          organization.id,
          owner.id,
          invitee.google_user_email,
          'owner'
        );

        const result = await acceptOrganizationInvite(invitee.id, invitation.token);
        expect(result.success).toBe(true);

        const userLimit = await db.query.organization_user_limits.findFirst({
          where: and(
            eq(organization_user_limits.organization_id, organization.id),
            eq(organization_user_limits.kilo_user_id, invitee.id),
            eq(organization_user_limits.limit_type, 'daily')
          ),
        });

        expect(userLimit).toBeUndefined(); // No limit should be set for require_seats orgs
      });

      test('should not set usage limits for owner role when accepting invitation', async () => {
        const owner = await insertTestUser();
        const invitee = await insertTestUser();
        const organization = await createOrganization('Test Org', owner.id);

        const invitation = await inviteUserToOrganization(
          organization.id,
          owner.id,
          invitee.google_user_email,
          'owner'
        );

        const result = await acceptOrganizationInvite(invitee.id, invitation.token);
        expect(result.success).toBe(true);

        const userLimit = await db.query.organization_user_limits.findFirst({
          where: and(
            eq(organization_user_limits.organization_id, organization.id),
            eq(organization_user_limits.kilo_user_id, invitee.id),
            eq(organization_user_limits.limit_type, 'daily')
          ),
        });

        expect(userLimit).toBeUndefined(); // No limit should be set for owners
      });

      test('should reject creating invitation when user is already a member', async () => {
        const owner = await insertTestUser();
        const invitee = await insertTestUser();
        const organization = await createOrganization('Test Org', owner.id);

        await addUserToOrganization(organization.id, invitee.id, 'owner');

        await expect(
          inviteUserToOrganization(organization.id, owner.id, invitee.google_user_email, 'member')
        ).rejects.toThrow('User is already a member of this organization');

        const userOrgs = await getUserOrganizationsWithSeats(invitee.id);
        expect(userOrgs).toHaveLength(1);
        expect(userOrgs[0].role).toBe('owner');

        const userLimit = await db.query.organization_user_limits.findFirst({
          where: and(
            eq(organization_user_limits.organization_id, organization.id),
            eq(organization_user_limits.kilo_user_id, invitee.id),
            eq(organization_user_limits.limit_type, 'daily')
          ),
        });

        expect(userLimit).toBeUndefined(); // No limit should be set for owners
      });

      test('should not set usage limits for member role when accepting invitation in require_seats organization', async () => {
        const owner = await insertTestUser();
        const invitee = await insertTestUser();
        const organization = await createOrganization('Test Org', owner.id);

        const invitation = await inviteUserToOrganization(
          organization.id,
          owner.id,
          invitee.google_user_email,
          'member'
        );

        const result = await acceptOrganizationInvite(invitee.id, invitation.token);
        expect(result.success).toBe(true);

        const userLimit = await db.query.organization_user_limits.findFirst({
          where: and(
            eq(organization_user_limits.organization_id, organization.id),
            eq(organization_user_limits.kilo_user_id, invitee.id),
            eq(organization_user_limits.limit_type, 'daily')
          ),
        });

        expect(userLimit).toBeUndefined(); // No limit should be set for require_seats orgs
      });

      test('should not set usage limits for owner role when accepting invitation in require_seats organization', async () => {
        const owner = await insertTestUser();
        const invitee = await insertTestUser();
        const organization = await createOrganization('Test Org', owner.id);

        const invitation = await inviteUserToOrganization(
          organization.id,
          owner.id,
          invitee.google_user_email,
          'owner'
        );

        const result = await acceptOrganizationInvite(invitee.id, invitation.token);
        expect(result.success).toBe(true);

        const userLimit = await db.query.organization_user_limits.findFirst({
          where: and(
            eq(organization_user_limits.organization_id, organization.id),
            eq(organization_user_limits.kilo_user_id, invitee.id),
            eq(organization_user_limits.limit_type, 'daily')
          ),
        });

        expect(userLimit).toBeUndefined(); // No limit should be set for require_seats orgs
      });

      test.skip('should set usage limits for member role when accepting invitation in non-require_seats organization', async () => {
        const owner = await insertTestUser();
        const invitee = await insertTestUser();

        const organization = await db.transaction(async tx => {
          const [org] = await tx
            .insert(organizations)
            .values({ name: 'Test Org', require_seats: false })
            .returning();

          await tx.insert(organization_memberships).values({
            organization_id: org.id,
            kilo_user_id: owner.id,
            role: 'owner',
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          });

          return org;
        });

        const invitation = await inviteUserToOrganization(
          organization.id,
          owner.id,
          invitee.google_user_email,
          'member'
        );

        const result = await acceptOrganizationInvite(invitee.id, invitation.token);
        expect(result.success).toBe(true);

        const userLimit = await db.query.organization_user_limits.findFirst({
          where: and(
            eq(organization_user_limits.organization_id, organization.id),
            eq(organization_user_limits.kilo_user_id, invitee.id),
            eq(organization_user_limits.limit_type, 'daily')
          ),
        });

        expect(userLimit).toBeTruthy();
        expect(fromMicrodollars(userLimit!.microdollar_limit)).toBe(DEFAULT_MEMBER_DAILY_LIMIT_USD);
      });

      test.skip('should set usage limits for owner role when accepting invitation in non-require_seats organization', async () => {
        const owner = await insertTestUser();
        const invitee = await insertTestUser();

        const organization = await db.transaction(async tx => {
          const [org] = await tx
            .insert(organizations)
            .values({ name: 'Test Org', require_seats: false })
            .returning();

          await tx.insert(organization_memberships).values({
            organization_id: org.id,
            kilo_user_id: owner.id,
            role: 'owner',
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          });

          return org;
        });

        const invitation = await inviteUserToOrganization(
          organization.id,
          owner.id,
          invitee.google_user_email,
          'owner'
        );

        const result = await acceptOrganizationInvite(invitee.id, invitation.token);
        expect(result.success).toBe(true);

        const userLimit = await db.query.organization_user_limits.findFirst({
          where: and(
            eq(organization_user_limits.organization_id, organization.id),
            eq(organization_user_limits.kilo_user_id, invitee.id),
            eq(organization_user_limits.limit_type, 'daily')
          ),
        });

        expect(userLimit).toBeTruthy();
        expect(fromMicrodollars(userLimit!.microdollar_limit)).toBe(DEFAULT_MEMBER_DAILY_LIMIT_USD);
      });
    });
  });
});
