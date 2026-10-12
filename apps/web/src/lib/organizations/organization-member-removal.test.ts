import { describe, test, expect, afterEach, beforeEach } from '@jest/globals';
import { db } from '@kilocode/web-shared/lib/drizzle';
import {
  organizations,
  organization_invitations,
  organization_memberships,
  organization_membership_removals,
  organization_seats_purchases,
  organization_user_limits,
} from '@kilocode/db/schema';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { createTestOrganization } from '@kilocode/web-shared/tests/helpers/organization.helper';
import { createOrganizationUsage } from '@kilocode/web-shared/tests/helpers/microdollar-usage.helper';
import {
  getUserOrganizationsWithSeats,
  createOrganization,
  addUserToOrganization,
  addSsoUserToOrganization,
  updateUserRoleInOrganization,
  inviteUserToOrganization,
  getOrganizationMembers,
  acceptOrganizationInvite,
} from '@kilocode/web-shared/lib/organizations/organizations';
import {
  getBalanceForOrganizationUser,
  ingestOrganizationTokenUsage,
} from '@kilocode/web-shared/lib/organizations/organization-usage';
import { removeUserFromOrganization } from './organization-member-removal';
import { invalidateOrganizationSessionAccess } from '@/lib/session-ingest-client';
import { closeCloudAgentOrgStreams } from '@/lib/cloud-agent-next/cloud-agent-client';

jest.mock('@/lib/session-ingest-client', () => ({
  invalidateOrganizationSessionAccess: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@/lib/cloud-agent-next/cloud-agent-client', () => ({
  closeCloudAgentOrgStreams: jest.fn().mockResolvedValue(undefined),
}));

// Mock next/server's after function which requires request context.
jest.mock('next/server', () => ({
  ...jest.requireActual('next/server'),
  after: jest.fn((fn: () => void | Promise<void>) => {
    void fn();
  }),
}));

describe('removeUserFromOrganization', () => {
  beforeEach(() => {
    jest.mocked(invalidateOrganizationSessionAccess).mockClear();
    jest.mocked(closeCloudAgentOrgStreams).mockClear();
  });

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

  describe('Organizations', () => {
    describe('inviteUserToOrganization', () => {
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

      describe('getOrganizationMembers', () => {
        test('should return empty array when organization has no members or invitations', async () => {
          const owner = await insertTestUser();
          const organization = await createOrganization('Test Org', owner.id);

          await removeUserFromOrganization(organization.id, owner.id);

          const result = await getOrganizationMembers(organization.id);

          expect(result).toEqual([]);
        });

        test('should return only pending invitations when no active members exist', async () => {
          const owner = await insertTestUser();
          const organization = await createOrganization('Test Org', owner.id);

          await removeUserFromOrganization(organization.id, owner.id);

          await inviteUserToOrganization(
            organization.id,
            owner.id,
            'invite1@example.com',
            'member'
          );
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
      });
    });
  });

  describe('Organization Usage Functions', () => {
    describe('ensureUserHasAvailableUsage (legacy getUsdBalanceForOrganization behavior)', () => {
      test('should not return balance after user is removed from organization', async () => {
        const owner = await insertTestUser();
        const member = await insertTestUser();
        const organization = await createTestOrganization('Test Org', owner.id, 30000);

        await addUserToOrganization(organization.id, member.id, 'member');

        let result = await getBalanceForOrganizationUser(organization.id, member.id);
        expect(result.balance).toBe(0.03); // 30000 microdollars = 0.03 USD

        await removeUserFromOrganization(organization.id, member.id);

        result = await getBalanceForOrganizationUser(organization.id, member.id);
        expect(result.balance).toBe(0);
      });
    });

    describe('Integration tests', () => {
      test('should handle complete usage workflow', async () => {
        const owner = await insertTestUser();
        const member = await insertTestUser();
        const organization = await createTestOrganization('Integration Test Org', owner.id, 100000);

        await addUserToOrganization(organization.id, member.id, 'member');

        let ownerBalance = await getBalanceForOrganizationUser(organization.id, owner.id);
        let memberBalance = await getBalanceForOrganizationUser(organization.id, member.id);
        expect(ownerBalance.balance).toBe(0.1); // 100000 microdollars = 0.1 USD
        expect(memberBalance.balance).toBe(0.1); // Same organization balance

        const ownerUsageRecord = await createOrganizationUsage(20000, owner.id, organization.id);
        await ingestOrganizationTokenUsage(ownerUsageRecord);

        ownerBalance = await getBalanceForOrganizationUser(organization.id, owner.id);
        memberBalance = await getBalanceForOrganizationUser(organization.id, member.id);
        expect(ownerBalance.balance).toBe(0.08); // 80000 microdollars = 0.08 USD
        expect(memberBalance.balance).toBe(0.08); // Same organization balance

        const memberUsageRecord = await createOrganizationUsage(15000, member.id, organization.id);
        await ingestOrganizationTokenUsage(memberUsageRecord);

        ownerBalance = await getBalanceForOrganizationUser(organization.id, owner.id);
        memberBalance = await getBalanceForOrganizationUser(organization.id, member.id);
        expect(ownerBalance.balance).toBe(0.065); // 65000 microdollars = 0.065 USD (100000 - 20000 - 15000)
        expect(memberBalance.balance).toBe(0.065); // Same organization balance

        await removeUserFromOrganization(organization.id, member.id);
        memberBalance = await getBalanceForOrganizationUser(organization.id, member.id);
        expect(memberBalance.balance).toBe(0); // No longer a member

        ownerBalance = await getBalanceForOrganizationUser(organization.id, owner.id);
        expect(ownerBalance.balance).toBe(0.065); // 65000 microdollars = 0.065 USD (Unchanged)
      });
    });
  });
});
