import { createCallerForUser } from '@/routers/test-utils';
import { db } from '@/lib/drizzle';
import {
  organizations,
  credit_transactions,
  organization_seats_purchases,
  organization_memberships,
  kilo_pass_subscriptions,
} from '@kilocode/db/schema';
import { eq, and, inArray } from 'drizzle-orm';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { createOrganization, addUserToOrganization } from '@/lib/organizations/organizations';
import { KiloPassCadence, KiloPassTier } from '@/lib/kilo-pass/enums';
import type { User, Organization } from '@kilocode/db/schema';

let adminUser: User;
let nonAdminUser: User;
let testOrganization: Organization;

describe('organization admin router', () => {
  beforeAll(async () => {
    adminUser = await insertTestUser({
      google_user_email: 'admin-org-admin@admin.example.com',
      google_user_name: 'Admin Org Admin User',
      is_admin: true,
    });

    nonAdminUser = await insertTestUser({
      google_user_email: 'non-admin-org-admin@example.com',
      google_user_name: 'Non Admin Org Admin User',
      is_admin: false,
    });

    testOrganization = await createOrganization('Test Admin Organization', adminUser.id);
  });

  afterAll(async () => {
    await db.delete(organizations).where(eq(organizations.id, testOrganization.id));
  });

  describe('nullifyCredits', () => {
    beforeEach(async () => {
      await db
        .update(organizations)
        .set({
          total_microdollars_acquired: 5_000_000,
          microdollars_used: 0,
        })
        .where(eq(organizations.id, testOrganization.id));

      await db
        .delete(credit_transactions)
        .where(eq(credit_transactions.organization_id, testOrganization.id));
    });

    it('should successfully nullify credits with valid organization and balance', async () => {
      const caller = await createCallerForUser(adminUser.id);

      const result = await caller.organizations.admin.nullifyCredits({
        organizationId: testOrganization.id,
      });

      expect(result.message).toContain('Successfully nullified $5.00');
      expect(result.amount_usd_nullified).toBe(5);

      const [updatedOrg] = await db
        .select({
          total_microdollars_acquired: organizations.total_microdollars_acquired,
          microdollars_used: organizations.microdollars_used,
        })
        .from(organizations)
        .where(eq(organizations.id, testOrganization.id));

      expect(updatedOrg.total_microdollars_acquired - updatedOrg.microdollars_used).toBe(0);
      // After nullification, total_microdollars_acquired should equal microdollars_used (zero balance)
      expect(updatedOrg.total_microdollars_acquired).toBe(updatedOrg.microdollars_used);
    });

    it('should throw NOT_FOUND error when organization does not exist', async () => {
      const caller = await createCallerForUser(adminUser.id);
      const nonExistentOrgId = '550e8400-e29b-41d4-a716-446655440099';

      await expect(
        caller.organizations.admin.nullifyCredits({
          organizationId: nonExistentOrgId,
        })
      ).rejects.toThrow('Organization not found');
    });

    it('should throw BAD_REQUEST error when organization has no credits (balance = 0)', async () => {
      await db
        .update(organizations)
        .set({ total_microdollars_acquired: 0 })
        .where(eq(organizations.id, testOrganization.id));

      const caller = await createCallerForUser(adminUser.id);

      await expect(
        caller.organizations.admin.nullifyCredits({
          organizationId: testOrganization.id,
        })
      ).rejects.toThrow('Organization has no credits to nullify');
    });

    it('should throw BAD_REQUEST error when organization has negative balance', async () => {
      await db
        .update(organizations)
        .set({
          total_microdollars_acquired: 0,
          microdollars_used: 1_000_000,
        })
        .where(eq(organizations.id, testOrganization.id));

      const caller = await createCallerForUser(adminUser.id);

      await expect(
        caller.organizations.admin.nullifyCredits({
          organizationId: testOrganization.id,
        })
      ).rejects.toThrow('Organization has no credits to nullify');
    });

    it('should create correct credit transaction with negative amount', async () => {
      const caller = await createCallerForUser(adminUser.id);

      await caller.organizations.admin.nullifyCredits({
        organizationId: testOrganization.id,
      });

      const [creditTransaction] = await db
        .select()
        .from(credit_transactions)
        .where(
          and(
            eq(credit_transactions.organization_id, testOrganization.id),
            eq(credit_transactions.kilo_user_id, adminUser.id)
          )
        );

      expect(creditTransaction).toBeDefined();
      expect(creditTransaction.amount_microdollars).toBe(-5_000_000);
      expect(creditTransaction.is_free).toBe(true);
      expect(creditTransaction.credit_category).toBe('organization_custom');
      expect(creditTransaction.description).toBe('Admin credit nullification');
    });

    it('should use custom description when provided', async () => {
      const customDescription = 'Fraud detected - nullifying credits';
      const caller = await createCallerForUser(adminUser.id);

      await caller.organizations.admin.nullifyCredits({
        organizationId: testOrganization.id,
        description: customDescription,
      });

      const [creditTransaction] = await db
        .select()
        .from(credit_transactions)
        .where(eq(credit_transactions.organization_id, testOrganization.id));

      expect(creditTransaction.description).toBe(customDescription);
    });

    it('should trim whitespace from description', async () => {
      const descriptionWithWhitespace = '  Trimmed description  ';
      const caller = await createCallerForUser(adminUser.id);

      await caller.organizations.admin.nullifyCredits({
        organizationId: testOrganization.id,
        description: descriptionWithWhitespace,
      });

      const [creditTransaction] = await db
        .select()
        .from(credit_transactions)
        .where(eq(credit_transactions.organization_id, testOrganization.id));

      expect(creditTransaction.description).toBe('Trimmed description');
    });

    it('should use default description when empty string is provided', async () => {
      const caller = await createCallerForUser(adminUser.id);

      await caller.organizations.admin.nullifyCredits({
        organizationId: testOrganization.id,
        description: '   ',
      });

      const [creditTransaction] = await db
        .select()
        .from(credit_transactions)
        .where(eq(credit_transactions.organization_id, testOrganization.id));

      expect(creditTransaction.description).toBe('Admin credit nullification');
    });

    it('should reject non-admin users', async () => {
      const caller = await createCallerForUser(nonAdminUser.id);

      await expect(
        caller.organizations.admin.nullifyCredits({
          organizationId: testOrganization.id,
        })
      ).rejects.toThrow();
    });

    it('should validate organizationId format', async () => {
      const caller = await createCallerForUser(adminUser.id);

      await expect(
        caller.organizations.admin.nullifyCredits({
          organizationId: 'invalid-uuid',
        })
      ).rejects.toThrow();
    });

    it('should handle small balance amounts correctly', async () => {
      await db
        .update(organizations)
        .set({ total_microdollars_acquired: 1 })
        .where(eq(organizations.id, testOrganization.id));

      const caller = await createCallerForUser(adminUser.id);

      const result = await caller.organizations.admin.nullifyCredits({
        organizationId: testOrganization.id,
      });

      expect(result.amount_usd_nullified).toBe(0.000001);

      const [creditTransaction] = await db
        .select()
        .from(credit_transactions)
        .where(eq(credit_transactions.organization_id, testOrganization.id));

      expect(creditTransaction.amount_microdollars).toBe(-1);
    });
  });

  describe('grantCredit', () => {
    beforeEach(async () => {
      await db
        .update(organizations)
        .set({ total_microdollars_acquired: 0, microdollars_used: 0 })
        .where(eq(organizations.id, testOrganization.id));

      await db
        .delete(credit_transactions)
        .where(eq(credit_transactions.organization_id, testOrganization.id));
    });

    it('should successfully grant positive credits', async () => {
      const caller = await createCallerForUser(adminUser.id);
      const amount = 10;

      const result = await caller.organizations.admin.grantCredit({
        organizationId: testOrganization.id,
        amount_usd: amount,
      });

      expect(result.message).toContain(`Successfully granted $${amount} credits`);
      expect(result.amount_usd).toBe(amount);

      const [updatedOrg] = await db
        .select({
          total_microdollars_acquired: organizations.total_microdollars_acquired,
          microdollars_used: organizations.microdollars_used,
        })
        .from(organizations)
        .where(eq(organizations.id, testOrganization.id));

      expect(updatedOrg.total_microdollars_acquired - updatedOrg.microdollars_used).toBe(
        amount * 1_000_000
      );
      // total_microdollars_acquired should also increase by the grant amount
      expect(updatedOrg.total_microdollars_acquired).toBe(amount * 1_000_000);
    });

    it('should successfully grant negative credits with description', async () => {
      const caller = await createCallerForUser(adminUser.id);
      const amount = -5;
      const description = 'Correction';

      const result = await caller.organizations.admin.grantCredit({
        organizationId: testOrganization.id,
        amount_usd: amount,
        description,
      });

      expect(result.message).toContain(`Successfully granted $${amount} credits`);
      expect(result.amount_usd).toBe(amount);

      const [creditTransaction] = await db
        .select()
        .from(credit_transactions)
        .where(
          and(
            eq(credit_transactions.organization_id, testOrganization.id),
            eq(credit_transactions.amount_microdollars, amount * 1_000_000)
          )
        );

      expect(creditTransaction).toBeDefined();
      expect(creditTransaction.description).toBe(description);
    });

    it('should fail to grant negative credits without description', async () => {
      const caller = await createCallerForUser(adminUser.id);
      const amount = -5;

      await expect(
        caller.organizations.admin.grantCredit({
          organizationId: testOrganization.id,
          amount_usd: amount,
        })
      ).rejects.toThrow();
    });

    it('should fail to grant zero credits', async () => {
      const caller = await createCallerForUser(adminUser.id);

      await expect(
        caller.organizations.admin.grantCredit({
          organizationId: testOrganization.id,
          amount_usd: 0,
        })
      ).rejects.toThrow();
    });

    it('should store expiry_date on credit transaction', async () => {
      const caller = await createCallerForUser(adminUser.id);
      const expiryDate = '2024-06-01T00:00:00.000Z';

      await caller.organizations.admin.grantCredit({
        organizationId: testOrganization.id,
        amount_usd: 10,
        expiry_date: expiryDate,
      });

      const [txn] = await db
        .select()
        .from(credit_transactions)
        .where(eq(credit_transactions.organization_id, testOrganization.id));

      expect(txn).toBeDefined();
      expect(new Date(txn.expiry_date!).toISOString()).toBe(expiryDate);
      expect(txn.expiration_baseline_microdollars_used).toBe(0);
    });

    it('should store expiry from expiry_hours', async () => {
      const caller = await createCallerForUser(adminUser.id);
      const beforeMs = Date.now();

      await caller.organizations.admin.grantCredit({
        organizationId: testOrganization.id,
        amount_usd: 5,
        expiry_hours: 48,
      });

      const afterMs = Date.now();
      const [txn] = await db
        .select()
        .from(credit_transactions)
        .where(eq(credit_transactions.organization_id, testOrganization.id));

      expect(txn.expiry_date).not.toBeNull();
      const expiryMs = new Date(txn.expiry_date!).getTime();
      // Should be ~48 hours from now (within the test execution window)
      expect(expiryMs).toBeGreaterThanOrEqual(beforeMs + 48 * 3600 * 1000 - 1000);
      expect(expiryMs).toBeLessThanOrEqual(afterMs + 48 * 3600 * 1000 + 1000);
    });

    it('should pick the earlier of expiry_date and expiry_hours', async () => {
      const caller = await createCallerForUser(adminUser.id);

      // Set expiry_date far in the future and expiry_hours to 1 hour from now
      const farFuture = '2030-01-01T00:00:00.000Z';
      await caller.organizations.admin.grantCredit({
        organizationId: testOrganization.id,
        amount_usd: 5,
        expiry_date: farFuture,
        expiry_hours: 1,
      });

      const [txn] = await db
        .select()
        .from(credit_transactions)
        .where(eq(credit_transactions.organization_id, testOrganization.id));

      // expiry_hours (1h from now) is much earlier than 2030
      const expiryMs = new Date(txn.expiry_date!).getTime();
      expect(expiryMs).toBeLessThan(new Date(farFuture).getTime());
      expect(expiryMs).toBeLessThan(Date.now() + 2 * 3600 * 1000);
    });

    it('should update next_credit_expiration_at on org', async () => {
      const caller = await createCallerForUser(adminUser.id);
      const expiryDate = '2024-03-15T00:00:00.000Z';

      await caller.organizations.admin.grantCredit({
        organizationId: testOrganization.id,
        amount_usd: 10,
        expiry_date: expiryDate,
      });

      const [updatedOrg] = await db
        .select({ next_credit_expiration_at: organizations.next_credit_expiration_at })
        .from(organizations)
        .where(eq(organizations.id, testOrganization.id));

      expect(new Date(updatedOrg.next_credit_expiration_at!).toISOString()).toBe(expiryDate);
    });

    it('should keep earlier next_credit_expiration_at when granting later expiry', async () => {
      const caller = await createCallerForUser(adminUser.id);

      // First grant with earlier expiry
      await caller.organizations.admin.grantCredit({
        organizationId: testOrganization.id,
        amount_usd: 5,
        expiry_date: '2024-02-01T00:00:00.000Z',
      });

      // Second grant with later expiry
      await caller.organizations.admin.grantCredit({
        organizationId: testOrganization.id,
        amount_usd: 5,
        expiry_date: '2024-06-01T00:00:00.000Z',
      });

      const [updatedOrg] = await db
        .select({ next_credit_expiration_at: organizations.next_credit_expiration_at })
        .from(organizations)
        .where(eq(organizations.id, testOrganization.id));

      // Should still be the earlier date
      expect(new Date(updatedOrg.next_credit_expiration_at!).toISOString()).toBe(
        '2024-02-01T00:00:00.000Z'
      );
    });

    it('should ignore expiry params for negative grants', async () => {
      const caller = await createCallerForUser(adminUser.id);

      await caller.organizations.admin.grantCredit({
        organizationId: testOrganization.id,
        amount_usd: -5,
        description: 'Debit with expiry attempt',
        expiry_date: '2024-06-01T00:00:00.000Z',
        expiry_hours: 24,
      });

      const [txn] = await db
        .select()
        .from(credit_transactions)
        .where(eq(credit_transactions.organization_id, testOrganization.id));

      expect(txn.expiry_date).toBeNull();
      expect(txn.expiration_baseline_microdollars_used).toBeNull();
    });

    it('should set original_baseline_microdollars_used from org microdollars_used', async () => {
      // Set up org with some usage
      await db
        .update(organizations)
        .set({ microdollars_used: 2_000_000, total_microdollars_acquired: 5_000_000 })
        .where(eq(organizations.id, testOrganization.id));

      const caller = await createCallerForUser(adminUser.id);
      await caller.organizations.admin.grantCredit({
        organizationId: testOrganization.id,
        amount_usd: 10,
        expiry_date: '2024-06-01T00:00:00.000Z',
      });

      const [txn] = await db
        .select()
        .from(credit_transactions)
        .where(eq(credit_transactions.organization_id, testOrganization.id));

      expect(txn.original_baseline_microdollars_used).toBe(2_000_000);
      expect(txn.expiration_baseline_microdollars_used).toBe(2_000_000);
    });
  });

  describe('nullifyCredits — expiration state', () => {
    beforeEach(async () => {
      await db
        .update(organizations)
        .set({
          total_microdollars_acquired: 5_000_000,
          microdollars_used: 0,
          microdollars_balance: 5_000_000,
          next_credit_expiration_at: '2024-06-01T00:00:00.000Z',
        })
        .where(eq(organizations.id, testOrganization.id));

      await db
        .delete(credit_transactions)
        .where(eq(credit_transactions.organization_id, testOrganization.id));
    });

    it('should clear next_credit_expiration_at on nullification', async () => {
      const caller = await createCallerForUser(adminUser.id);

      await caller.organizations.admin.nullifyCredits({
        organizationId: testOrganization.id,
      });

      const [updatedOrg] = await db
        .select({
          next_credit_expiration_at: organizations.next_credit_expiration_at,
        })
        .from(organizations)
        .where(eq(organizations.id, testOrganization.id));

      expect(updatedOrg.next_credit_expiration_at).toBeNull();
    });

    it('should set microdollars_balance to 0 on nullification', async () => {
      const caller = await createCallerForUser(adminUser.id);

      await caller.organizations.admin.nullifyCredits({
        organizationId: testOrganization.id,
      });

      const [updatedOrg] = await db
        .select({
          microdollars_balance: organizations.microdollars_balance,
        })
        .from(organizations)
        .where(eq(organizations.id, testOrganization.id));

      expect(updatedOrg.microdollars_balance).toBe(0);
    });
  });

  // Regressions for the count query branches:
  //   - the stripe_status branch joins latestSubscriptions; previously the
  //     countQuery omitted that join, so any stripe_status value referenced
  //     an alias missing from the FROM clause and Postgres rejected it
  //   - the no-filter branch must not join latestSubscriptions (avoidable
  //     historical-subscription-table work on every list request)
  describe('list — count query', () => {
    it('returns a total when stripe_status filter is set', async () => {
      const [purchase] = await db
        .insert(organization_seats_purchases)
        .values({
          organization_id: testOrganization.id,
          subscription_stripe_id: 'sub_test_admin_list_stripe_status',
          subscription_status: 'active',
          seat_count: 2,
          amount_usd: 42,
          starts_at: '2026-04-01T00:00:00.000Z',
          expires_at: '2027-04-01T00:00:00.000Z',
          billing_cycle: 'yearly',
        })
        .returning();

      try {
        const caller = await createCallerForUser(adminUser.id);
        const result = await caller.organizations.admin.list({
          page: 1,
          limit: 25,
          sortBy: 'name',
          sortOrder: 'desc',
          search: '',
          mode: 'all',
          include_deleted: false,
          stripe_status: 'active',
        });

        expect(result.organizations).toBeDefined();
        expect(result.pagination).toBeDefined();
        expect(typeof result.pagination.total).toBe('number');
      } finally {
        if (purchase) {
          await db
            .delete(organization_seats_purchases)
            .where(eq(organization_seats_purchases.id, purchase.id));
        }
      }
    });

    it('returns a total when no stripe_status filter is set', async () => {
      const caller = await createCallerForUser(adminUser.id);
      const result = await caller.organizations.admin.list({
        page: 1,
        limit: 25,
        sortBy: 'name',
        sortOrder: 'desc',
        search: '',
        mode: 'all',
        include_deleted: false,
      });

      expect(result.organizations).toBeDefined();
      expect(result.pagination).toBeDefined();
      expect(typeof result.pagination.total).toBe('number');
    });

    it('does not overcount multi-member orgs when has_multiple_users is off', async () => {
      const searchName = `Admin Count No Member Join ${crypto.randomUUID()}`;
      const org = await createOrganization(searchName, adminUser.id);
      const member = await insertTestUser({
        google_user_email: `${crypto.randomUUID()}@count-no-member-join.example.com`,
      });

      try {
        await addUserToOrganization(org.id, member.id, 'member');

        const caller = await createCallerForUser(adminUser.id);
        const result = await caller.organizations.admin.list({
          page: 1,
          limit: 25,
          sortBy: 'name',
          sortOrder: 'desc',
          search: searchName,
          mode: 'all',
          include_deleted: false,
          has_multiple_users: false,
        });

        expect(result.organizations.map(organization => organization.id)).toEqual([org.id]);
        expect(result.pagination.total).toBe(1);
      } finally {
        await db.delete(organizations).where(eq(organizations.id, org.id));
      }
    });

    it('counts only non-bot non-billing-manager users for has_multiple_users totals', async () => {
      const searchName = `Admin Count Excluded Members ${crypto.randomUUID()}`;
      const org = await createOrganization(searchName, adminUser.id);
      const billingManager = await insertTestUser({
        google_user_email: `${crypto.randomUUID()}@billing-manager.example.com`,
      });
      const bot = await insertTestUser({
        google_user_email: `${crypto.randomUUID()}@bot.example.com`,
        is_bot: true,
      });
      const member = await insertTestUser({
        google_user_email: `${crypto.randomUUID()}@regular-member.example.com`,
      });

      try {
        await addUserToOrganization(org.id, billingManager.id, 'billing_manager');
        await addUserToOrganization(org.id, bot.id, 'member');

        const caller = await createCallerForUser(adminUser.id);
        const resultBeforeRegularMember = await caller.organizations.admin.list({
          page: 1,
          limit: 25,
          sortBy: 'name',
          sortOrder: 'desc',
          search: searchName,
          mode: 'all',
          include_deleted: false,
          has_multiple_users: true,
        });

        expect(resultBeforeRegularMember.organizations).toEqual([]);
        expect(resultBeforeRegularMember.pagination.total).toBe(0);

        await addUserToOrganization(org.id, member.id, 'member');

        const resultAfterRegularMember = await caller.organizations.admin.list({
          page: 1,
          limit: 25,
          sortBy: 'name',
          sortOrder: 'desc',
          search: searchName,
          mode: 'all',
          include_deleted: false,
          has_multiple_users: true,
        });

        expect(resultAfterRegularMember.organizations.map(organization => organization.id)).toEqual(
          [org.id]
        );
        expect(resultAfterRegularMember.pagination.total).toBe(1);
      } finally {
        await db.delete(organizations).where(eq(organizations.id, org.id));
      }
    });
  });

  describe('list — trial active filter', () => {
    it('uses effective trial end date and trial_active threshold', async () => {
      const searchPrefix = `Admin Trial Active ${crypto.randomUUID()}`;
      const fallbackActiveOrg = await createOrganization(`${searchPrefix} fallback`, adminUser.id);
      const explicitActiveOrg = await createOrganization(
        `${searchPrefix} explicit active`,
        adminUser.id
      );
      const endingSoonOrg = await createOrganization(`${searchPrefix} ending soon`, adminUser.id);

      try {
        await db
          .update(organizations)
          .set({
            free_trial_end_at: null,
            created_at: new Date().toISOString(),
          })
          .where(eq(organizations.id, fallbackActiveOrg.id));
        await db
          .update(organizations)
          .set({
            free_trial_end_at: new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toISOString(),
          })
          .where(eq(organizations.id, explicitActiveOrg.id));
        await db
          .update(organizations)
          .set({
            free_trial_end_at: new Date(Date.now() + 6 * 24 * 60 * 60 * 1000).toISOString(),
          })
          .where(eq(organizations.id, endingSoonOrg.id));

        const caller = await createCallerForUser(adminUser.id);
        const result = await caller.organizations.admin.list({
          page: 1,
          limit: 25,
          sortBy: 'name',
          sortOrder: 'asc',
          search: searchPrefix,
          mode: 'trial',
          include_deleted: false,
          trial_ending_in_future: true,
        });

        expect(result.organizations.map(organization => organization.id).sort()).toEqual(
          [explicitActiveOrg.id, fallbackActiveOrg.id].sort()
        );
        expect(result.pagination.total).toBe(2);
      } finally {
        await db
          .delete(organizations)
          .where(
            inArray(organizations.id, [
              fallbackActiveOrg.id,
              explicitActiveOrg.id,
              endingSoonOrg.id,
            ])
          );
      }
    });
  });

  describe('list — Kilo Pass tier sorting', () => {
    it('sorts by the joined active Kilo Pass tier selected for display', async () => {
      const searchPrefix = `Admin Kilo Pass Sort ${crypto.randomUUID()}`;
      const tier19User = await insertTestUser({
        google_user_email: `${crypto.randomUUID()}@tier19.example.com`,
      });
      const tier49User = await insertTestUser({
        google_user_email: `${crypto.randomUUID()}@tier49.example.com`,
      });
      const tier19Org = await createOrganization(`${searchPrefix} tier 19`, tier19User.id);
      const tier49Org = await createOrganization(`${searchPrefix} tier 49`, tier49User.id);
      const stripeSubscriptionIds = [
        `sub_admin_org_tier19_${crypto.randomUUID()}`,
        `sub_admin_org_tier49_${crypto.randomUUID()}`,
      ];

      try {
        const now = new Date().toISOString();
        await db.insert(kilo_pass_subscriptions).values([
          {
            kilo_user_id: tier19User.id,
            provider_subscription_id: stripeSubscriptionIds[0],
            stripe_subscription_id: stripeSubscriptionIds[0],
            tier: KiloPassTier.Tier19,
            cadence: KiloPassCadence.Monthly,
            status: 'active',
            cancel_at_period_end: false,
            current_streak_months: 1,
            started_at: now,
            ended_at: null,
            next_yearly_issue_at: null,
          },
          {
            kilo_user_id: tier49User.id,
            provider_subscription_id: stripeSubscriptionIds[1],
            stripe_subscription_id: stripeSubscriptionIds[1],
            tier: KiloPassTier.Tier49,
            cadence: KiloPassCadence.Monthly,
            status: 'active',
            cancel_at_period_end: false,
            current_streak_months: 1,
            started_at: now,
            ended_at: null,
            next_yearly_issue_at: null,
          },
        ]);

        const caller = await createCallerForUser(adminUser.id);
        const result = await caller.organizations.admin.list({
          page: 1,
          limit: 1,
          sortBy: 'kilo_pass_tier',
          sortOrder: 'asc',
          search: searchPrefix,
          mode: 'all',
          include_deleted: false,
        });

        expect(result.organizations).toHaveLength(1);
        expect(result.organizations[0]?.id).toBe(tier19Org.id);
        expect(result.organizations[0]?.kilo_pass_tier).toBe(KiloPassTier.Tier19);
        expect(result.pagination.total).toBe(2);
      } finally {
        await db
          .delete(kilo_pass_subscriptions)
          .where(inArray(kilo_pass_subscriptions.stripe_subscription_id, stripeSubscriptionIds));
        await db
          .delete(organization_memberships)
          .where(inArray(organization_memberships.organization_id, [tier19Org.id, tier49Org.id]));
        await db
          .delete(organizations)
          .where(inArray(organizations.id, [tier19Org.id, tier49Org.id]));
      }
    });
  });
});
