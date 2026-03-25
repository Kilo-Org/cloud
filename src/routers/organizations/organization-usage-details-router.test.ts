import { createCallerForUser } from '@/routers/test-utils';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { insertUsageWithOverrides } from '@/tests/helpers/microdollar-usage.helper';
import { createOrganization, addUserToOrganization } from '@/lib/organizations/organizations';
import { db, pool } from '@/lib/drizzle';
import { microdollar_usage } from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';
import type { User, Organization } from '@kilocode/db/schema';

// Test users and organization will be created dynamically
let regularUser: User;
let memberUser: User;
let testOrganization: Organization;

// Helper functions for date handling in tests
async function getDateFromDb(intervalString = '0 days'): Promise<string> {
  const query =
    intervalString === '0 days'
      ? 'SELECT now()::text as date'
      : `SELECT (now() - interval '${intervalString}')::text as date`;

  const { rows } = await pool.query<{ date: string }>(query);
  return rows[0].date;
}

function extractDateOnly(timestamp: string): string {
  return timestamp.split(/[T ]/)[0];
}

describe('organizations usage details trpc router', () => {
  beforeAll(async () => {
    // Create test users using the helper function
    regularUser = await insertTestUser({
      google_user_email: 'regular-usage@example.com',
      google_user_name: 'Regular Usage User',
      is_admin: false,
    });

    memberUser = await insertTestUser({
      google_user_email: 'member-usage@example.com',
      google_user_name: 'Member Usage User',
      is_admin: false,
    });

    // Create test organization using the CRUD method
    testOrganization = await createOrganization('Test Usage Organization', regularUser.id);

    // Add member user to organization using CRUD method
    await addUserToOrganization(testOrganization.id, memberUser.id, 'member');
  });

  afterEach(async () => {
    // Clean up microdollar usage data after each test
    await db
      .delete(microdollar_usage)
      .where(eq(microdollar_usage.organization_id, testOrganization.id));
  });

  describe('get procedure', () => {
    it('should return usage details for organization member with default parameters', async () => {
      // Get current date from database to ensure consistency
      const now = await getDateFromDb();
      const yesterday = await getDateFromDb('1 day');

      await insertUsageWithOverrides({
        kilo_user_id: memberUser.id,
        organization_id: testOrganization.id,
        cost: 1000,
        input_tokens: 300,
        output_tokens: 200,
        created_at: now,
        model: 'gpt-4',
      });

      await insertUsageWithOverrides({
        kilo_user_id: memberUser.id,
        organization_id: testOrganization.id,
        cost: 1500,
        input_tokens: 450,
        output_tokens: 300,
        created_at: yesterday,
        model: 'gpt-4',
      });

      const caller = await createCallerForUser(memberUser.id);

      const result = await caller.organizations.usageDetails.get({
        organizationId: testOrganization.id,
      });

      expect(result.daily).toHaveLength(2);

      // Results should be ordered by date desc (newest first)
      const nowDate = extractDateOnly(now);
      const yesterdayDate = extractDateOnly(yesterday);
      const todayResult = result.daily.find(d => d.date === nowDate);
      const yesterdayResult = result.daily.find(d => d.date === yesterdayDate);

      expect(todayResult).toEqual({
        date: nowDate,
        user: {
          name: memberUser.google_user_name,
          email: memberUser.google_user_email,
        },
        microdollarCost: '1000',
        tokenCount: 500,
        inputTokens: 300,
        outputTokens: 200,
        requestCount: 1,
      });

      expect(yesterdayResult).toEqual({
        date: yesterdayDate,
        user: {
          name: memberUser.google_user_name,
          email: memberUser.google_user_email,
        },
        microdollarCost: '1500',
        tokenCount: 750,
        inputTokens: 450,
        outputTokens: 300,
        requestCount: 1,
      });
    });

    it('should return usage details with week period filter', async () => {
      // Get dates from database to ensure consistency
      const threeDaysAgo = await getDateFromDb('3 days');
      const tenDaysAgo = await getDateFromDb('10 days');

      await insertUsageWithOverrides({
        kilo_user_id: memberUser.id,
        organization_id: testOrganization.id,
        cost: 1000,
        input_tokens: 300,
        output_tokens: 200,
        created_at: threeDaysAgo,
        model: 'gpt-4',
      });

      await insertUsageWithOverrides({
        kilo_user_id: memberUser.id,
        organization_id: testOrganization.id,
        cost: 2000,
        input_tokens: 600,
        output_tokens: 400,
        created_at: tenDaysAgo,
        model: 'gpt-4',
      });

      const caller = await createCallerForUser(memberUser.id);

      const result = await caller.organizations.usageDetails.get({
        organizationId: testOrganization.id,
        period: 'week',
      });

      // Should only include usage from within the last week (3 days ago, not 10 days ago)
      expect(result.daily).toHaveLength(1);
      expect(result.daily[0]).toEqual({
        date: extractDateOnly(threeDaysAgo),
        user: {
          name: memberUser.google_user_name,
          email: memberUser.google_user_email,
        },
        microdollarCost: '1000',
        tokenCount: 500,
        inputTokens: 300,
        outputTokens: 200,
        requestCount: 1,
      });
    });

    it('should return usage details with me filter for current user', async () => {
      // Get current date from database to ensure consistency
      const now = await getDateFromDb();

      await insertUsageWithOverrides({
        kilo_user_id: memberUser.id,
        organization_id: testOrganization.id,
        cost: 1000,
        input_tokens: 300,
        output_tokens: 200,
        created_at: now,
        model: 'gpt-4',
      });

      await insertUsageWithOverrides({
        kilo_user_id: regularUser.id,
        organization_id: testOrganization.id,
        cost: 2000,
        input_tokens: 600,
        output_tokens: 400,
        created_at: now,
        model: 'gpt-4',
      });

      const caller = await createCallerForUser(memberUser.id);

      const result = await caller.organizations.usageDetails.get({
        organizationId: testOrganization.id,
        userFilter: 'me',
      });

      // Should only include usage from the member user, not the regular user
      expect(result.daily).toHaveLength(1);
      expect(result.daily[0].user.email).toBe(memberUser.google_user_email);
    });

    it('should return usage details grouped by model', async () => {
      // Get current date from database to ensure consistency
      const now = await getDateFromDb();

      await insertUsageWithOverrides({
        kilo_user_id: memberUser.id,
        organization_id: testOrganization.id,
        cost: 1000,
        input_tokens: 300,
        output_tokens: 200,
        created_at: now,
        model: 'gpt-4',
      });

      await insertUsageWithOverrides({
        kilo_user_id: memberUser.id,
        organization_id: testOrganization.id,
        cost: 500,
        input_tokens: 150,
        output_tokens: 100,
        created_at: now,
        model: 'gpt-3.5-turbo',
      });

      const caller = await createCallerForUser(memberUser.id);

      const result = await caller.organizations.usageDetails.get({
        organizationId: testOrganization.id,
        groupByModel: true,
      });

      expect(result.daily).toHaveLength(2);

      const gpt4Result = result.daily.find(d => d.model === 'gpt-4');
      const gpt35Result = result.daily.find(d => d.model === 'gpt-3.5-turbo');

      expect(gpt4Result).toHaveProperty('model', 'gpt-4');
      expect(gpt4Result?.microdollarCost).toBe('1000');

      expect(gpt35Result).toHaveProperty('model', 'gpt-3.5-turbo');
      expect(gpt35Result?.microdollarCost).toBe('500');
    });

    it('should handle empty usage data', async () => {
      const caller = await createCallerForUser(memberUser.id);

      const result = await caller.organizations.usageDetails.get({
        organizationId: testOrganization.id,
      });

      expect(result).toEqual({
        daily: [],
      });
    });

    it('should handle null microdollar cost', async () => {
      // Get current date from database to ensure consistency
      const now = await getDateFromDb();

      await insertUsageWithOverrides({
        kilo_user_id: memberUser.id,
        organization_id: testOrganization.id,
        cost: 0, // This should result in null when converted
        input_tokens: 300,
        output_tokens: 200,
        created_at: now,
        model: 'gpt-4',
      });

      const caller = await createCallerForUser(memberUser.id);

      const result = await caller.organizations.usageDetails.get({
        organizationId: testOrganization.id,
      });

      expect(result.daily).toHaveLength(1);
      expect(result.daily[0].microdollarCost).toBe('0'); // Should be '0', not null
    });

    it('should throw UNAUTHORIZED error for non-member users', async () => {
      const nonMemberUser = await insertTestUser({
        google_user_email: 'non-member-usage@example.com',
        google_user_name: 'Non Member Usage User',
        is_admin: false,
      });

      const caller = await createCallerForUser(nonMemberUser.id);

      await expect(
        caller.organizations.usageDetails.get({
          organizationId: testOrganization.id,
        })
      ).rejects.toThrow('You do not have access to this organization');
    });

    it('should validate input schema', async () => {
      const caller = await createCallerForUser(memberUser.id);

      // Test invalid UUID
      await expect(
        caller.organizations.usageDetails.get({
          organizationId: 'invalid-uuid',
        })
      ).rejects.toThrow();

      // Test invalid period
      await expect(
        caller.organizations.usageDetails.get({
          organizationId: testOrganization.id,
          // @ts-expect-error Testing invalid period
          period: 'invalid-period',
        })
      ).rejects.toThrow();

      // Test invalid userFilter
      await expect(
        caller.organizations.usageDetails.get({
          organizationId: testOrganization.id,
          // @ts-expect-error Testing invalid userFilter
          userFilter: 'invalid-filter',
        })
      ).rejects.toThrow();
    });

    it('should work with all valid period values', async () => {
      const caller = await createCallerForUser(memberUser.id);

      const periods = ['week', 'month', 'year', 'all'] as const;

      for (const period of periods) {
        const result = await caller.organizations.usageDetails.get({
          organizationId: testOrganization.id,
          period,
        });

        expect(result).toEqual({ daily: [] });
      }
    });
  });

  describe('getAutocomplete procedure', () => {
    it('should return autocomplete metrics for organization', async () => {
      const now = await getDateFromDb();

      // Insert autocomplete usage (codestral-2508 model)
      await insertUsageWithOverrides({
        kilo_user_id: memberUser.id,
        organization_id: testOrganization.id,
        cost: 1000,
        input_tokens: 300,
        output_tokens: 200,
        created_at: now,
        model: 'codestral-2508',
      });

      await insertUsageWithOverrides({
        kilo_user_id: memberUser.id,
        organization_id: testOrganization.id,
        cost: 500,
        input_tokens: 150,
        output_tokens: 100,
        created_at: now,
        model: 'codestral-2508',
      });

      // Insert non-autocomplete usage (should not be counted)
      await insertUsageWithOverrides({
        kilo_user_id: memberUser.id,
        organization_id: testOrganization.id,
        cost: 2000,
        input_tokens: 600,
        output_tokens: 400,
        created_at: now,
        model: 'gpt-4',
      });

      const caller = await createCallerForUser(memberUser.id);

      const result = await caller.organizations.usageDetails.getAutocomplete({
        organizationId: testOrganization.id,
        period: 'month',
      });

      expect(result.cost).toBe(1500); // 1000 + 500
      expect(result.requests).toBe(2);
      expect(result.tokens).toBe(750); // (300 + 200) + (150 + 100)
    });

    it('should return zero metrics when no autocomplete usage exists', async () => {
      const now = await getDateFromDb();

      // Insert only non-autocomplete usage
      await insertUsageWithOverrides({
        kilo_user_id: memberUser.id,
        organization_id: testOrganization.id,
        cost: 2000,
        input_tokens: 600,
        output_tokens: 400,
        created_at: now,
        model: 'gpt-4',
      });

      const caller = await createCallerForUser(memberUser.id);

      const result = await caller.organizations.usageDetails.getAutocomplete({
        organizationId: testOrganization.id,
        period: 'month',
      });

      expect(result.cost).toBe(0);
      expect(result.requests).toBe(0);
      expect(result.tokens).toBe(0);
    });

    it('should exclude autocomplete usage outside the selected period', async () => {
      const now = await getDateFromDb();
      const twoMonthsAgo = await getDateFromDb('60 days');

      // Insert recent autocomplete usage (within the past week)
      await insertUsageWithOverrides({
        kilo_user_id: memberUser.id,
        organization_id: testOrganization.id,
        cost: 1000,
        input_tokens: 300,
        output_tokens: 200,
        created_at: now,
        model: 'codestral-2508',
      });

      // Insert old autocomplete usage (outside the past week)
      await insertUsageWithOverrides({
        kilo_user_id: memberUser.id,
        organization_id: testOrganization.id,
        cost: 5000,
        input_tokens: 1000,
        output_tokens: 800,
        created_at: twoMonthsAgo,
        model: 'codestral-2508',
      });

      const caller = await createCallerForUser(memberUser.id);

      // Query with 'week' period — should only include recent usage
      const weekResult = await caller.organizations.usageDetails.getAutocomplete({
        organizationId: testOrganization.id,
        period: 'week',
      });

      expect(weekResult.cost).toBe(1000);
      expect(weekResult.requests).toBe(1);
      expect(weekResult.tokens).toBe(500); // 300 + 200

      // Query with 'all' period — should include everything
      const allResult = await caller.organizations.usageDetails.getAutocomplete({
        organizationId: testOrganization.id,
        period: 'all',
      });

      expect(allResult.cost).toBe(6000); // 1000 + 5000
      expect(allResult.requests).toBe(2);
      expect(allResult.tokens).toBe(2300); // (300 + 200) + (1000 + 800)
    });

    it('should throw UNAUTHORIZED error for non-member users', async () => {
      const nonMemberUser = await insertTestUser({
        google_user_email: 'non-member-autocomplete@example.com',
        google_user_name: 'Non Member Autocomplete User',
        is_admin: false,
      });

      const caller = await createCallerForUser(nonMemberUser.id);

      await expect(
        caller.organizations.usageDetails.getAutocomplete({
          organizationId: testOrganization.id,
        })
      ).rejects.toThrow('You do not have access to this organization');
    });
  });
});
