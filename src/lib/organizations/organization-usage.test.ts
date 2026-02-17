import { describe, test, expect, afterEach } from '@jest/globals';
import { db } from '@/lib/drizzle';
import { organizations, organization_user_usage } from '@/db/schema';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { createTestOrganization } from '@/tests/helpers/organization.helper';
import { eq, sql } from 'drizzle-orm';
import {
  createOrganization,
  addUserToOrganization,
  removeUserFromOrganization,
  getOrganizationMembers,
} from './organizations';
import {
  getBalanceForOrganizationUser,
  ingestOrganizationTokenUsage,
  updateOrganizationUserLimit,
} from './organization-usage';
import { createOrganizationUsage } from '@/tests/helpers/microdollar-usage.helper';

// Mock next/server's after function which requires request context
jest.mock('next/server', () => {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-return
  return {
    ...jest.requireActual('next/server'),
    after: jest.fn((fn: () => Promise<void>) => {
      // Execute the function asynchronously as Next.js would
      void fn();
    }),
  };
});

describe('Organization Usage Functions', () => {
  afterEach(async () => {
    // eslint-disable-next-line drizzle/enforce-delete-with-where
    await db.delete(organizations);
  });

  describe('ensureUserHasAvailableUsage (legacy getUsdBalanceForOrganization behavior)', () => {
    test('should return balance for organization member', async () => {
      const user = await insertTestUser();
      const organization = await createTestOrganization('Test Org', user.id, 50000, {
        model_allow_list: ['fizz', 'buzz'],
      });

      const result = await getBalanceForOrganizationUser(organization.id, user.id);

      expect(result.balance).toBe(0.05); // 50000 microdollars = 0.05 USD
      expect(result.settings?.model_allow_list).toEqual(['fizz', 'buzz']); // 50000 microdollars = 0.05 USD
    });

    test('should return balance for regular member', async () => {
      const owner = await insertTestUser();
      const member = await insertTestUser();
      const organization = await createTestOrganization('Test Org', owner.id, 25000);

      await addUserToOrganization(organization.id, member.id, 'member');

      const result = await getBalanceForOrganizationUser(organization.id, member.id);

      expect(result.balance).toBe(0.025); // 25000 microdollars = 0.025 USD
    });

    test('should return 0 balance for non-member', async () => {
      const owner = await insertTestUser();
      const nonMember = await insertTestUser();
      const organization = await createTestOrganization('Test Org', owner.id, 100000);

      const result = await getBalanceForOrganizationUser(organization.id, nonMember.id);

      expect(result.balance).toBe(0);
    });

    test('should return 0 balance for billing_manager role', async () => {
      const owner = await insertTestUser();
      const billingManager = await insertTestUser();
      const organization = await createTestOrganization('Test Org', owner.id, 100000);

      await addUserToOrganization(organization.id, billingManager.id, 'billing_manager');

      const result = await getBalanceForOrganizationUser(organization.id, billingManager.id);

      expect(result.balance).toBe(0);
      expect(result.settings).toEqual({});
    });

    test('should return 0 balance for non-existent organization', async () => {
      const user = await insertTestUser();
      const nonExistentOrgId = '00000000-0000-0000-0000-000000000000';

      const result = await getBalanceForOrganizationUser(nonExistentOrgId, user.id);

      expect(result.balance).toBe(0);
    });

    test('should return 0 balance when organization has zero balance', async () => {
      const user = await insertTestUser();
      const organization = await createOrganization('Test Org', user.id);

      // Organization starts with 0 balance by default
      const result = await getBalanceForOrganizationUser(organization.id, user.id);

      expect(result.balance).toBe(0);
    });

    test('should return correct balance when organization has negative balance', async () => {
      const user = await insertTestUser();
      const organization = await createTestOrganization('Test Org', user.id, -15000);

      const result = await getBalanceForOrganizationUser(organization.id, user.id);

      expect(result.balance).toBe(-0.015); // -15000 microdollars = -0.015 USD
    });

    test('should not return balance after user is removed from organization', async () => {
      const owner = await insertTestUser();
      const member = await insertTestUser();
      const organization = await createTestOrganization('Test Org', owner.id, 30000);

      await addUserToOrganization(organization.id, member.id, 'member');

      // Verify member can see balance
      let result = await getBalanceForOrganizationUser(organization.id, member.id);
      expect(result.balance).toBe(0.03); // 30000 microdollars = 0.03 USD

      // Remove member
      await removeUserFromOrganization(organization.id, member.id);

      // Verify member can no longer see balance
      result = await getBalanceForOrganizationUser(organization.id, member.id);
      expect(result.balance).toBe(0);
    });

    test('should handle multiple organizations correctly', async () => {
      const user = await insertTestUser();
      const org1 = await createTestOrganization('Org 1', user.id, 10000);
      const org2 = await createTestOrganization('Org 2', user.id, 20000);

      const result1 = await getBalanceForOrganizationUser(org1.id, user.id);
      const result2 = await getBalanceForOrganizationUser(org2.id, user.id);

      expect(result1.balance).toBe(0.01); // 10000 microdollars = 0.01 USD
      expect(result2.balance).toBe(0.02); // 20000 microdollars = 0.02 USD
    });
  });

  describe('ingestOrganizationTokenUsage', () => {
    test('should deduct cost from organization balance for member', async () => {
      const user = await insertTestUser();
      const organization = await createTestOrganization('Test Org', user.id, 50000);

      const usage = createOrganizationUsage(5000, user.id, organization.id);
      await ingestOrganizationTokenUsage(usage);

      // Verify balance was reduced
      const result = await getBalanceForOrganizationUser(organization.id, user.id);
      expect(result.balance).toBe(0.045); // 45000 microdollars = 0.045 USD (50000 - 5000)
    });

    test('should handle zero cost usage', async () => {
      const user = await insertTestUser();
      const organization = await createTestOrganization('Test Org', user.id, 40000);

      const usage = createOrganizationUsage(0, user.id, organization.id);
      await ingestOrganizationTokenUsage(usage);

      // Verify balance unchanged
      const result = await getBalanceForOrganizationUser(organization.id, user.id);
      expect(result.balance).toBe(0.04); // 40000 microdollars = 0.04 USD (unchanged)
    });

    test('should handle large cost usage', async () => {
      const user = await insertTestUser();
      const organization = await createTestOrganization('Test Org', user.id, 1000000);

      const usage = createOrganizationUsage(500000, user.id, organization.id);
      await ingestOrganizationTokenUsage(usage);

      // Verify balance was reduced by large amount
      const result = await getBalanceForOrganizationUser(organization.id, user.id);
      expect(result.balance).toBe(0.5); // 500000 microdollars = 0.5 USD (1000000 - 500000)
    });

    test('should allow balance to go negative', async () => {
      const user = await insertTestUser();
      const organization = await createTestOrganization('Test Org', user.id, 5000);

      const usage = createOrganizationUsage(10000, user.id, organization.id);
      await ingestOrganizationTokenUsage(usage);

      // Verify balance went negative
      const result = await getBalanceForOrganizationUser(organization.id, user.id);
      expect(result.balance).toBe(-0.005); // -5000 microdollars = -0.005 USD (5000 - 10000)
    });

    test('should handle multiple sequential usage ingestions', async () => {
      const user = await insertTestUser();
      const organization = await createTestOrganization('Test Org', user.id, 100000);

      const usage1Record = createOrganizationUsage(10000, user.id, organization.id);
      const usage2Record = createOrganizationUsage(15000, user.id, organization.id);
      const usage3Record = createOrganizationUsage(5000, user.id, organization.id);
      await ingestOrganizationTokenUsage(usage1Record);
      await ingestOrganizationTokenUsage(usage2Record);
      await ingestOrganizationTokenUsage(usage3Record);

      // Verify cumulative deduction
      const result = await getBalanceForOrganizationUser(organization.id, user.id);
      expect(result.balance).toBe(0.07); // 70000 microdollars = 0.07 USD (100000 - 10000 - 15000 - 5000)
    });

    test('should handle usage from different members of same organization', async () => {
      const owner = await insertTestUser();
      const member1 = await insertTestUser();
      const member2 = await insertTestUser();
      const organization = await createTestOrganization('Test Org', owner.id, 80000);

      await addUserToOrganization(organization.id, member1.id, 'member');
      await addUserToOrganization(organization.id, member2.id, 'owner');

      const ownerUsageRecord = createOrganizationUsage(10000, owner.id, organization.id);
      await ingestOrganizationTokenUsage(ownerUsageRecord);
      const member1UsageRecord = createOrganizationUsage(12000, member1.id, organization.id);
      await ingestOrganizationTokenUsage(member1UsageRecord);
      const member2UsageRecord = createOrganizationUsage(8000, member2.id, organization.id);
      await ingestOrganizationTokenUsage(member2UsageRecord);

      // Verify total deduction from all members
      const result = await getBalanceForOrganizationUser(organization.id, owner.id);
      expect(result.balance).toBe(0.05); // 50000 microdollars = 0.05 USD (80000 - 10000 - 12000 - 8000)
    });

    test('should not affect other organizations', async () => {
      const user = await insertTestUser();
      const org1 = await createTestOrganization('Org 1', user.id, 50000);
      const org2 = await createTestOrganization('Org 2', user.id, 60000);

      // Ingest usage for org1 only
      const usage = createOrganizationUsage(10000, user.id, org1.id);
      await ingestOrganizationTokenUsage(usage);

      // Verify org1 balance was reduced
      const result1 = await getBalanceForOrganizationUser(org1.id, user.id);
      expect(result1.balance).toBe(0.04); // 40000 microdollars = 0.04 USD (50000 - 10000)

      // Verify org2 balance was unchanged
      const result2 = await getBalanceForOrganizationUser(org2.id, user.id);
      expect(result2.balance).toBe(0.06); // 60000 microdollars = 0.06 USD (unchanged)
    });

    test('should handle non-existent organization gracefully', async () => {
      const user = await insertTestUser();
      const nonExistentOrgId = '00000000-0000-0000-0000-000000000000';

      // Should complete without error even for non-existent organization (new behavior)
      const usage = createOrganizationUsage(5000, user.id, nonExistentOrgId);
      await ingestOrganizationTokenUsage(usage);
    });

    test('should update organization updated_at timestamp', async () => {
      const user = await insertTestUser();
      const organization = await createTestOrganization('Test Org', user.id, 30000);

      // Get initial updated_at
      const [orgBefore] = await db
        .select({ updated_at: organizations.updated_at })
        .from(organizations)
        .where(eq(organizations.id, organization.id));

      // Wait a bit to ensure timestamp difference
      await new Promise(resolve => setTimeout(resolve, 10));

      const usage = createOrganizationUsage(5000, user.id, organization.id);
      await ingestOrganizationTokenUsage(usage);

      // Get updated updated_at
      const [orgAfter] = await db
        .select({ updated_at: organizations.updated_at })
        .from(organizations)
        .where(eq(organizations.id, organization.id));

      // Verify timestamp was updated
      expect(new Date(orgAfter.updated_at).getTime()).toBeGreaterThan(
        new Date(orgBefore.updated_at).getTime()
      );
    });

    test('should handle concurrent usage ingestion without race conditions', async () => {
      const user = await insertTestUser();
      const initialBalance = 1000000; // 1M microdollars
      const organization = await createTestOrganization(
        'Concurrent Test Org',
        user.id,
        initialBalance
      );

      // Create 20 small usage records
      const costPerUsage = 5000; // 5k microdollars each
      const numberOfUsages = 20;
      const expectedTotalCost = costPerUsage * numberOfUsages; // 100k total

      const usagePromises = Array.from({ length: numberOfUsages }, () => {
        const usage = createOrganizationUsage(costPerUsage, user.id, organization.id);
        return ingestOrganizationTokenUsage(usage);
      });

      // Execute all usage ingestions concurrently
      await Promise.all(usagePromises);

      // Verify that all usages were properly accounted for
      const finalBalance = await getBalanceForOrganizationUser(organization.id, user.id);
      const expectedFinalBalance = initialBalance - expectedTotalCost;

      expect(finalBalance.balance).toBe(expectedFinalBalance / 1000000); // Convert to USD
      expect(finalBalance.balance).toBe(0.9); // 900000 microdollars = 0.9 USD (1000000 - 100000)
    });
  });

  describe('Integration tests', () => {
    test('should handle complete usage workflow', async () => {
      const owner = await insertTestUser();
      const member = await insertTestUser();
      const organization = await createTestOrganization('Integration Test Org', owner.id, 100000);

      await addUserToOrganization(organization.id, member.id, 'member');

      // Verify initial balance
      let ownerBalance = await getBalanceForOrganizationUser(organization.id, owner.id);
      let memberBalance = await getBalanceForOrganizationUser(organization.id, member.id);
      expect(ownerBalance.balance).toBe(0.1); // 100000 microdollars = 0.1 USD
      expect(memberBalance.balance).toBe(0.1); // Same organization balance

      // Owner uses tokens
      const ownerUsageRecord = createOrganizationUsage(20000, owner.id, organization.id);
      await ingestOrganizationTokenUsage(ownerUsageRecord);

      // Verify balance after owner usage
      ownerBalance = await getBalanceForOrganizationUser(organization.id, owner.id);
      memberBalance = await getBalanceForOrganizationUser(organization.id, member.id);
      expect(ownerBalance.balance).toBe(0.08); // 80000 microdollars = 0.08 USD
      expect(memberBalance.balance).toBe(0.08); // Same organization balance

      // Member uses tokens
      const memberUsageRecord = createOrganizationUsage(15000, member.id, organization.id);
      await ingestOrganizationTokenUsage(memberUsageRecord);

      // Verify final balance
      ownerBalance = await getBalanceForOrganizationUser(organization.id, owner.id);
      memberBalance = await getBalanceForOrganizationUser(organization.id, member.id);
      expect(ownerBalance.balance).toBe(0.065); // 65000 microdollars = 0.065 USD (100000 - 20000 - 15000)
      expect(memberBalance.balance).toBe(0.065); // Same organization balance

      // Remove member and verify they can no longer see balance
      await removeUserFromOrganization(organization.id, member.id);
      memberBalance = await getBalanceForOrganizationUser(organization.id, member.id);
      expect(memberBalance.balance).toBe(0); // No longer a member

      // Owner should still see the balance
      ownerBalance = await getBalanceForOrganizationUser(organization.id, owner.id);
      expect(ownerBalance.balance).toBe(0.065); // 65000 microdollars = 0.065 USD (Unchanged)
    });
  });

  describe('ensureUserHasAvailableUsage', () => {
    test('should return organization balance when no limit is set', async () => {
      const user = await insertTestUser();
      const organization = await createTestOrganization('Test Org', user.id, 100000);

      const result = await getBalanceForOrganizationUser(organization.id, user.id, {
        limitType: 'daily',
      });

      expect(result.balance).toBe(0.1); // 100000 microdollars = 0.1 USD (organization balance)
    });

    test('should return remaining allowance when limit exists but no usage recorded', async () => {
      const user = await insertTestUser();

      // Create organization with require_seats: false to test limit functionality
      const organization = await createTestOrganization('Test Org', user.id, 100000, {}, false);

      await updateOrganizationUserLimit(organization.id, user.id, 0.05); // $0.05 limit

      const result = await getBalanceForOrganizationUser(organization.id, user.id, {
        limitType: 'daily',
      });

      expect(result.balance).toBe(0.05); // 50000 microdollars = 0.05 USD (full limit available)
    });

    test('should return remaining allowance when usage is below limit', async () => {
      const user = await insertTestUser();

      // Create organization with require_seats: false to test limit functionality
      const organization = await createOrganization('Test Org', user.id);
      await db
        .update(organizations)
        .set({
          require_seats: false,
          total_microdollars_acquired: 100000,
        })
        .where(eq(organizations.id, organization.id));

      await updateOrganizationUserLimit(organization.id, user.id, 0.05); // $0.05 limit

      // Add some usage below the limit
      await db.insert(organization_user_usage).values({
        organization_id: organization.id,
        kilo_user_id: user.id,
        usage_date: sql`CURRENT_DATE`, // Today
        limit_type: 'daily',
        microdollar_usage: 30000, // $0.03 usage
      });

      const result = await getBalanceForOrganizationUser(organization.id, user.id, {
        limitType: 'daily',
      });

      expect(result.balance).toBe(0.02); // 20000 microdollars = 0.02 USD (50000 - 30000)
    });

    test('should return zero when usage equals limit', async () => {
      const user = await insertTestUser();

      // Create organization with require_seats: false to test limit functionality
      const organization = await createOrganization('Test Org', user.id);
      await db
        .update(organizations)
        .set({
          require_seats: false,
          total_microdollars_acquired: 100000,
        })
        .where(eq(organizations.id, organization.id));

      await updateOrganizationUserLimit(organization.id, user.id, 0.05); // $0.05 limit

      // Add usage equal to the limit
      await db.insert(organization_user_usage).values({
        organization_id: organization.id,
        kilo_user_id: user.id,
        usage_date: sql`CURRENT_DATE`, // Today
        limit_type: 'daily',
        microdollar_usage: 50000, // $0.05 usage (equal to limit)
      });

      const result = await getBalanceForOrganizationUser(organization.id, user.id, {
        limitType: 'daily',
      });

      expect(result.balance).toBe(0); // 0 microdollars = 0 USD (50000 - 50000)
    });

    test('should return negative balance when usage exceeds limit', async () => {
      const user = await insertTestUser();

      // Create organization with require_seats: false to test limit functionality
      const organization = await createOrganization('Test Org', user.id);
      await db
        .update(organizations)
        .set({
          require_seats: false,
          total_microdollars_acquired: 100000,
        })
        .where(eq(organizations.id, organization.id));

      await updateOrganizationUserLimit(organization.id, user.id, 0.05); // $0.05 limit

      // Add usage that exceeds the limit
      await db.insert(organization_user_usage).values({
        organization_id: organization.id,
        kilo_user_id: user.id,
        usage_date: sql`CURRENT_DATE`, // Today
        limit_type: 'daily',
        microdollar_usage: 75000, // $0.075 usage (exceeds limit)
      });

      const result = await getBalanceForOrganizationUser(organization.id, user.id, {
        limitType: 'daily',
      });

      expect(result.balance).toBe(-0.025); // -25000 microdollars = -0.025 USD (50000 - 75000)
    });

    test("should only check today's usage, not previous days", async () => {
      const user = await insertTestUser();

      // Create organization with require_seats: false to test limit functionality
      const organization = await createOrganization('Test Org', user.id);
      await db
        .update(organizations)
        .set({
          require_seats: false,
          total_microdollars_acquired: 100000,
        })
        .where(eq(organizations.id, organization.id));

      await updateOrganizationUserLimit(organization.id, user.id, 0.05); // $0.05 limit

      // Add usage from yesterday that would exceed limit
      await db.insert(organization_user_usage).values({
        organization_id: organization.id,
        kilo_user_id: user.id,
        usage_date: sql`CURRENT_DATE - INTERVAL '1 day'`, // Yesterday
        limit_type: 'daily',
        microdollar_usage: 100000, // $0.10 usage (exceeds limit, but from yesterday)
      });

      // Add small usage for today
      await db.insert(organization_user_usage).values({
        organization_id: organization.id,
        kilo_user_id: user.id,
        usage_date: sql`CURRENT_DATE`, // Today
        limit_type: 'daily',
        microdollar_usage: 10000, // $0.01 usage (below limit)
      });

      const result = await getBalanceForOrganizationUser(organization.id, user.id, {
        limitType: 'daily',
      });

      expect(result.balance).toBe(0.04); // 40000 microdollars = 0.04 USD (50000 - 10000)
    });

    test('should handle different users in same organization separately', async () => {
      const user1 = await insertTestUser();
      const user2 = await insertTestUser();

      // Create organization with require_seats: false to test limit functionality
      const organization = await createOrganization('Test Org', user1.id);
      await db
        .update(organizations)
        .set({
          require_seats: false,
          total_microdollars_acquired: 200000,
        })
        .where(eq(organizations.id, organization.id));

      await addUserToOrganization(organization.id, user2.id, 'member');

      // Set limits for both users
      await updateOrganizationUserLimit(organization.id, user1.id, 0.05); // $0.05 limit
      await updateOrganizationUserLimit(organization.id, user2.id, 0.03); // $0.03 limit

      // Add usage for user1 that exceeds their limit
      await db.insert(organization_user_usage).values({
        organization_id: organization.id,
        kilo_user_id: user1.id,
        usage_date: sql`CURRENT_DATE`, // Today
        limit_type: 'daily',
        microdollar_usage: 60000, // $0.06 usage (exceeds user1's limit)
      });

      // Add usage for user2 that's below their limit
      await db.insert(organization_user_usage).values({
        organization_id: organization.id,
        kilo_user_id: user2.id,
        usage_date: sql`CURRENT_DATE`, // Today
        limit_type: 'daily',
        microdollar_usage: 20000, // $0.02 usage (below user2's limit)
      });

      const result1 = await getBalanceForOrganizationUser(organization.id, user1.id, {
        limitType: 'daily',
      });
      const result2 = await getBalanceForOrganizationUser(organization.id, user2.id, {
        limitType: 'daily',
      });

      expect(result1.balance).toBe(-0.01); // -10000 microdollars = -0.01 USD (50000 - 60000)
      expect(result2.balance).toBe(0.01); // 10000 microdollars = 0.01 USD (30000 - 20000)
    });

    test('should handle different organizations separately', async () => {
      const user = await insertTestUser();

      // Create organizations with require_seats: false to test limit functionality
      const org1 = await createTestOrganization('Org 1', user.id, 100000, {}, false);
      const org2 = await createTestOrganization('Org 2', user.id, 200000, {}, false);

      // Set limits for both organizations
      await updateOrganizationUserLimit(org1.id, user.id, 0.05); // $0.05 limit
      await updateOrganizationUserLimit(org2.id, user.id, 0.03); // $0.03 limit

      // Add usage for org1 that exceeds limit
      await db.insert(organization_user_usage).values({
        organization_id: org1.id,
        kilo_user_id: user.id,
        usage_date: sql`CURRENT_DATE`, // Today
        limit_type: 'daily',
        microdollar_usage: 60000, // $0.06 usage (exceeds org1's limit)
      });

      // Add usage for org2 that's below limit
      await db.insert(organization_user_usage).values({
        organization_id: org2.id,
        kilo_user_id: user.id,
        usage_date: sql`CURRENT_DATE`, // Today
        limit_type: 'daily',
        microdollar_usage: 20000, // $0.02 usage (below org2's limit)
      });

      const result1 = await getBalanceForOrganizationUser(org1.id, user.id, { limitType: 'daily' });
      const result2 = await getBalanceForOrganizationUser(org2.id, user.id, { limitType: 'daily' });

      expect(result1.balance).toBe(-0.01); // -10000 microdollars = -0.01 USD (50000 - 60000)
      expect(result2.balance).toBe(0.01); // 10000 microdollars = 0.01 USD (30000 - 20000)
    });

    test('should handle zero usage correctly', async () => {
      const user = await insertTestUser();

      // Create organization with require_seats: false to test limit functionality
      const organization = await createTestOrganization('Test Org', user.id, 100000, {}, false);

      await updateOrganizationUserLimit(organization.id, user.id, 0.05); // $0.05 limit

      // Add zero usage
      await db.insert(organization_user_usage).values({
        organization_id: organization.id,
        kilo_user_id: user.id,
        usage_date: sql`CURRENT_DATE`, // Today
        limit_type: 'daily',
        microdollar_usage: 0, // Zero usage
      });

      const result = await getBalanceForOrganizationUser(organization.id, user.id, {
        limitType: 'daily',
      });

      expect(result.balance).toBe(0.05); // 50000 microdollars = 0.05 USD (50000 - 0)
    });

    test('should handle zero limit correctly', async () => {
      const user = await insertTestUser();

      // Create organization with require_seats: false to test limit functionality
      const organization = await createTestOrganization('Test Org', user.id, 100000, {}, false);

      // Set a zero daily limit using the updated function
      await updateOrganizationUserLimit(organization.id, user.id, 0);

      // Verify the limit is set correctly in getOrganizationMembers
      const members = await getOrganizationMembers(organization.id);
      const userMember = members.find(m => m.status === 'active' && m.id === user.id);
      expect(userMember).toBeDefined();
      expect(userMember!.dailyUsageLimitUsd).toBe(0); // Should be exactly 0, not null

      // Add any usage (even 1 microdollar should result in negative balance)
      await db.insert(organization_user_usage).values({
        organization_id: organization.id,
        kilo_user_id: user.id,
        usage_date: sql`CURRENT_DATE`, // Today
        limit_type: 'daily',
        microdollar_usage: 1, // 1 microdollar usage
      });

      const result = await getBalanceForOrganizationUser(organization.id, user.id, {
        limitType: 'daily',
      });

      expect(result.balance).toBe(-0.000001); // -1 microdollar = -0.000001 USD (0 - 1)
    });

    test('should handle null limit (unlimited) correctly', async () => {
      const user = await insertTestUser();
      const organization = await createTestOrganization('Test Org', user.id, 100000);

      // Set unlimited usage (null limit)
      await updateOrganizationUserLimit(organization.id, user.id, null);

      // Add some usage
      await db.insert(organization_user_usage).values({
        organization_id: organization.id,
        kilo_user_id: user.id,
        usage_date: sql`CURRENT_DATE`, // Today
        limit_type: 'daily',
        microdollar_usage: 50000, // $0.05 usage
      });

      const result = await getBalanceForOrganizationUser(organization.id, user.id, {
        limitType: 'daily',
      });

      // Should return organization balance since no limit is set
      expect(result.balance).toBe(0.1); // 100000 microdollars = 0.1 USD (organization balance)
    });

    test('should distinguish between zero limit and unlimited (null) limit', async () => {
      const user1 = await insertTestUser();
      const user2 = await insertTestUser();

      // Create organization with require_seats: false to test limit functionality
      const organization = await createTestOrganization('Test Org', user1.id, 100000, {}, false);

      await addUserToOrganization(organization.id, user2.id, 'member');

      // Set zero limit for user1
      await updateOrganizationUserLimit(organization.id, user1.id, 0);

      // Set unlimited (null) for user2
      await updateOrganizationUserLimit(organization.id, user2.id, null);

      // Verify the limits are set correctly in getOrganizationMembers
      const members = await getOrganizationMembers(organization.id);
      const user1Member = members.find(m => m.status === 'active' && m.id === user1.id);
      const user2Member = members.find(m => m.status === 'active' && m.id === user2.id);

      expect(user1Member).toBeDefined();
      expect(user2Member).toBeDefined();
      expect(user1Member!.dailyUsageLimitUsd).toBe(0); // Should be exactly 0
      expect(user2Member!.dailyUsageLimitUsd).toBe(null); // Should be null (unlimited)

      const result1 = await getBalanceForOrganizationUser(organization.id, user1.id, {
        limitType: 'daily',
      });
      const result2 = await getBalanceForOrganizationUser(organization.id, user2.id, {
        limitType: 'daily',
      });

      expect(result1.balance).toBe(0); // Zero limit = 0 balance
      expect(result2.balance).toBe(0.1); // Unlimited = organization balance (100000 microdollars = 0.1 USD)
    });

    test('should reject limits above $2000', async () => {
      const user = await insertTestUser();
      const organization = await createTestOrganization('Test Org', user.id, 0);

      // Try to set a limit above $2000
      await expect(updateOrganizationUserLimit(organization.id, user.id, 2001)).rejects.toThrow(
        'Daily usage limit must be between $0 and $2000'
      );

      // Try to set a negative limit
      await expect(updateOrganizationUserLimit(organization.id, user.id, -1)).rejects.toThrow(
        'Daily usage limit must be between $0 and $2000'
      );

      // Verify that exactly $2000 is allowed
      await expect(
        updateOrganizationUserLimit(organization.id, user.id, 2000)
      ).resolves.not.toThrow();

      // Verify the limit was set correctly
      const members = await getOrganizationMembers(organization.id);
      const userMember = members.find(m => m.status === 'active' && m.id === user.id);
      expect(userMember).toBeDefined();
      expect(userMember!.dailyUsageLimitUsd).toBe(2000);
    });

    test('should return 0 balance for non-member', async () => {
      const owner = await insertTestUser();
      const nonMember = await insertTestUser();
      const organization = await createTestOrganization('Test Org', owner.id, 100000);

      const result = await getBalanceForOrganizationUser(organization.id, nonMember.id, {
        limitType: 'daily',
      });

      expect(result.balance).toBe(0);
    });

    test('should return 0 balance for non-existent organization', async () => {
      const user = await insertTestUser();
      const nonExistentOrgId = '00000000-0000-0000-0000-000000000000';

      const result = await getBalanceForOrganizationUser(nonExistentOrgId, user.id, {
        limitType: 'daily',
      });

      expect(result.balance).toBe(0);
    });

    test('should cap user balance at organization balance when limit exceeds org balance', async () => {
      const user = await insertTestUser();
      const organization = await createTestOrganization('Test Org', user.id, 20000); // $0.02

      // Set a daily limit that exceeds the organization balance
      await updateOrganizationUserLimit(organization.id, user.id, 0.05); // $0.05 limit (exceeds org balance)

      const result = await getBalanceForOrganizationUser(organization.id, user.id, {
        limitType: 'daily',
      });

      // Should return organization balance, not the full limit
      expect(result.balance).toBe(0.02); // 20000 microdollars = 0.02 USD (org balance, not 0.05 limit)
    });

    test('should cap user balance at organization balance when remaining allowance exceeds org balance', async () => {
      const user = await insertTestUser();
      const organization = await createTestOrganization('Test Org', user.id, 15000); // $0.015

      // Set a daily limit
      await updateOrganizationUserLimit(organization.id, user.id, 0.05); // $0.05 limit

      // Add some usage, but remaining allowance still exceeds org balance
      await db.insert(organization_user_usage).values({
        organization_id: organization.id,
        kilo_user_id: user.id,
        usage_date: sql`CURRENT_DATE`, // Today
        limit_type: 'daily',
        microdollar_usage: 10000, // $0.01 usage
      });

      const result = await getBalanceForOrganizationUser(organization.id, user.id, {
        limitType: 'daily',
      });

      // Remaining allowance would be $0.04 (50000 - 10000), but org only has $0.015
      // Should return organization balance
      expect(result.balance).toBe(0.015); // 15000 microdollars = 0.015 USD (org balance, not 0.04 allowance)
    });

    test('should return negative balance when organization balance is negative', async () => {
      const user = await insertTestUser();
      const organization = await createTestOrganization('Test Org', user.id, -10000); // -$0.01

      // Set a daily limit
      await updateOrganizationUserLimit(organization.id, user.id, 0.05); // $0.05 limit

      const result = await getBalanceForOrganizationUser(organization.id, user.id, {
        limitType: 'daily',
      });

      // Should return the negative organization balance, not the positive limit
      expect(result.balance).toBe(-0.01); // -10000 microdollars = -0.01 USD
    });

    test('should return user allowance when it is less than organization balance', async () => {
      const user = await insertTestUser();

      // Create organization with require_seats: false to test limit functionality
      const organization = await createTestOrganization('Test Org', user.id, 100000, {}, false);

      // Set a small daily limit
      await updateOrganizationUserLimit(organization.id, user.id, 0.02); // $0.02 limit

      // Add some usage
      await db.insert(organization_user_usage).values({
        organization_id: organization.id,
        kilo_user_id: user.id,
        usage_date: sql`CURRENT_DATE`, // Today
        limit_type: 'daily',
        microdollar_usage: 5000, // $0.005 usage
      });

      const result = await getBalanceForOrganizationUser(organization.id, user.id, {
        limitType: 'daily',
      });

      // Remaining allowance is $0.015 (20000 - 5000), org has $0.10
      // Should return the smaller remaining allowance
      expect(result.balance).toBe(0.015); // 15000 microdollars = 0.015 USD (allowance < org balance)
    });
  });
});

describe('microdollars_used tracking', () => {
  test('should initialize new organization with microdollars_used = 0', async () => {
    const user = await insertTestUser();
    const organization = await createTestOrganization('Test Org', user.id, 50000);

    const [org] = await db
      .select({ microdollars_used: organizations.microdollars_used })
      .from(organizations)
      .where(eq(organizations.id, organization.id));

    expect(org.microdollars_used).toBe(0);
  });

  test('should increment microdollars_used when ingesting usage', async () => {
    const user = await insertTestUser();
    const organization = await createTestOrganization('Test Org', user.id, 50000);

    const usage = createOrganizationUsage(5000, user.id, organization.id);
    await ingestOrganizationTokenUsage(usage);

    const [org] = await db
      .select({ microdollars_used: organizations.microdollars_used })
      .from(organizations)
      .where(eq(organizations.id, organization.id));

    expect(org.microdollars_used).toBe(5000);
  });

  test('should accumulate microdollars_used from multiple usage ingestions', async () => {
    const user = await insertTestUser();
    const organization = await createTestOrganization('Test Org', user.id, 100000);

    const usage1 = createOrganizationUsage(10000, user.id, organization.id);
    const usage2 = createOrganizationUsage(15000, user.id, organization.id);
    const usage3 = createOrganizationUsage(5000, user.id, organization.id);

    await ingestOrganizationTokenUsage(usage1);
    await ingestOrganizationTokenUsage(usage2);
    await ingestOrganizationTokenUsage(usage3);

    const [org] = await db
      .select({ microdollars_used: organizations.microdollars_used })
      .from(organizations)
      .where(eq(organizations.id, organization.id));

    expect(org.microdollars_used).toBe(30000); // 10000 + 15000 + 5000
  });

  test('should accumulate usage from different members of same organization', async () => {
    const owner = await insertTestUser();
    const member1 = await insertTestUser();
    const member2 = await insertTestUser();
    const organization = await createTestOrganization('Test Org', owner.id, 80000);

    await addUserToOrganization(organization.id, member1.id, 'member');
    await addUserToOrganization(organization.id, member2.id, 'owner');

    const ownerUsage = createOrganizationUsage(10000, owner.id, organization.id);
    const member1Usage = createOrganizationUsage(12000, member1.id, organization.id);
    const member2Usage = createOrganizationUsage(8000, member2.id, organization.id);

    await ingestOrganizationTokenUsage(ownerUsage);
    await ingestOrganizationTokenUsage(member1Usage);
    await ingestOrganizationTokenUsage(member2Usage);

    const [org] = await db
      .select({ microdollars_used: organizations.microdollars_used })
      .from(organizations)
      .where(eq(organizations.id, organization.id));

    expect(org.microdollars_used).toBe(30000); // 10000 + 12000 + 8000
  });

  test('should track usage separately for different organizations', async () => {
    const user = await insertTestUser();
    const org1 = await createTestOrganization('Org 1', user.id, 50000);
    const org2 = await createTestOrganization('Org 2', user.id, 60000);

    const org1Usage = createOrganizationUsage(10000, user.id, org1.id);
    const org2Usage = createOrganizationUsage(15000, user.id, org2.id);

    await ingestOrganizationTokenUsage(org1Usage);
    await ingestOrganizationTokenUsage(org2Usage);

    const [org1Result] = await db
      .select({ microdollars_used: organizations.microdollars_used })
      .from(organizations)
      .where(eq(organizations.id, org1.id));

    const [org2Result] = await db
      .select({ microdollars_used: organizations.microdollars_used })
      .from(organizations)
      .where(eq(organizations.id, org2.id));

    expect(org1Result.microdollars_used).toBe(10000);
    expect(org2Result.microdollars_used).toBe(15000);
  });

  test('should handle zero cost usage without changing microdollars_used', async () => {
    const user = await insertTestUser();
    const organization = await createTestOrganization('Test Org', user.id, 40000);

    const usage = createOrganizationUsage(0, user.id, organization.id);
    await ingestOrganizationTokenUsage(usage);

    const [org] = await db
      .select({ microdollars_used: organizations.microdollars_used })
      .from(organizations)
      .where(eq(organizations.id, organization.id));

    expect(org.microdollars_used).toBe(0);
  });

  test('should handle large cost usage correctly', async () => {
    const user = await insertTestUser();
    const organization = await createTestOrganization('Test Org', user.id, 1000000);

    const usage = createOrganizationUsage(500000, user.id, organization.id);
    await ingestOrganizationTokenUsage(usage);

    const [org] = await db
      .select({ microdollars_used: organizations.microdollars_used })
      .from(organizations)
      .where(eq(organizations.id, organization.id));

    expect(org.microdollars_used).toBe(500000);
  });

  test('should update microdollars_used correctly', async () => {
    const user = await insertTestUser();
    const initialBalance = 100000;
    const organization = await createTestOrganization('Test Org', user.id, initialBalance);

    const usageCost = 25000;
    const usage = createOrganizationUsage(usageCost, user.id, organization.id);
    await ingestOrganizationTokenUsage(usage);

    const [org] = await db
      .select({
        total_microdollars_acquired: organizations.total_microdollars_acquired,
        microdollars_used: organizations.microdollars_used,
      })
      .from(organizations)
      .where(eq(organizations.id, organization.id));

    expect(org.total_microdollars_acquired - org.microdollars_used).toBe(
      initialBalance - usageCost
    ); // 75000
    expect(org.microdollars_used).toBe(usageCost); // 25000
  });

  test('should handle concurrent usage ingestion without race conditions for microdollars_used', async () => {
    const user = await insertTestUser();
    const initialBalance = 1000000; // 1M microdollars
    const organization = await createTestOrganization(
      'Concurrent Test Org',
      user.id,
      initialBalance
    );

    // Create 20 small usage records
    const costPerUsage = 5000; // 5k microdollars each
    const numberOfUsages = 20;
    const expectedTotalUsed = costPerUsage * numberOfUsages; // 100k total

    const usagePromises = Array.from({ length: numberOfUsages }, () => {
      const usage = createOrganizationUsage(costPerUsage, user.id, organization.id);
      return ingestOrganizationTokenUsage(usage);
    });

    // Execute all usage ingestions concurrently
    await Promise.all(usagePromises);

    // Verify that all usages were properly tracked
    const [org] = await db
      .select({
        total_microdollars_acquired: organizations.total_microdollars_acquired,
        microdollars_used: organizations.microdollars_used,
      })
      .from(organizations)
      .where(eq(organizations.id, organization.id));

    expect(org.microdollars_used).toBe(expectedTotalUsed); // 100000
    expect(org.total_microdollars_acquired - org.microdollars_used).toBe(
      initialBalance - expectedTotalUsed
    ); // 900000
  });

  test('should handle non-existent organization gracefully for microdollars_used', async () => {
    const user = await insertTestUser();
    const nonExistentOrgId = '00000000-0000-0000-0000-000000000000';

    // Should complete without error even for non-existent organization
    const usage = createOrganizationUsage(5000, user.id, nonExistentOrgId);
    await expect(ingestOrganizationTokenUsage(usage)).resolves.not.toThrow();

    // Verify that trying to query the non-existent organization returns nothing
    const nonExistentOrg = await db
      .select()
      .from(organizations)
      .where(eq(organizations.id, nonExistentOrgId));
    expect(nonExistentOrg.length).toBe(0);
  });
});
