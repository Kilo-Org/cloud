import { describe, test, expect, afterEach } from '@jest/globals';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { organizations } from '@kilocode/db/schema';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { createTestOrganization } from '@kilocode/web-shared/tests/helpers/organization.helper';
import { createOrganizationUsage } from '@kilocode/web-shared/tests/helpers/microdollar-usage.helper';
import { addUserToOrganization } from '@kilocode/web-shared/lib/organizations/organizations';
import {
  getBalanceForOrganizationUser,
  ingestOrganizationTokenUsage,
} from '@kilocode/web-shared/lib/organizations/organization-usage';
import { removeUserFromOrganization } from './organization-member-removal';

jest.mock('@kilocode/web-shared/lib/email', () => ({
  ...jest.requireActual('@kilocode/web-shared/lib/email'),
  sendBalanceAlertEmail: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@kilocode/web-shared/lib/notifications-worker-client', () => ({
  dispatchLowBalancePush: jest.fn().mockResolvedValue(undefined),
  dispatchSecurityFindingPush: jest.fn().mockResolvedValue(undefined),
}));

// Mock next/server's after function which requires request context.
jest.mock('next/server', () => ({
  ...jest.requireActual('next/server'),
  after: jest.fn((fn: () => void | Promise<void>) => {
    void fn();
  }),
}));

describe('Organization Usage Functions', () => {
  afterEach(async () => {
    jest.clearAllMocks();
    // eslint-disable-next-line drizzle/enforce-delete-with-where
    await db.delete(organizations);
  });

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
