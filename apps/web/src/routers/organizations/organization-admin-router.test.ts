import { createCallerForUser } from '@/routers/test-utils';
import { db } from '@/lib/drizzle';
import {
  organizations,
  credit_transactions,
  organization_seats_purchases,
  organization_memberships,
  organization_service_fee_exemption_history,
  organization_service_fee_exemptions,
  platform_integrations,
  kilo_pass_org_agreements,
  kilo_pass_org_allocation_plans,
  kilo_pass_org_allocation_plan_rows,
  kilo_pass_org_issuance_snapshots,
  kilo_pass_org_term_versions,
} from '@kilocode/db/schema';
import { eq, and, inArray, sql } from 'drizzle-orm';
import { insertTestUser } from '@/tests/helpers/user.helper';
import {
  createOrganization,
  addUserToOrganization,
  markOrganizationAsDeleted,
} from '@/lib/organizations/organizations';
import { KiloPassCadence, KiloPassTier } from '@/lib/kilo-pass/enums';
import { KiloPassOrgBonusMode } from '@kilocode/db/schema-types';
import { fetchExpiringTransactionsForOrganization } from '@/lib/creditExpiration';
import type { User, Organization } from '@kilocode/db/schema';
import { INTEGRATION_STATUS, PLATFORM } from '@/lib/integrations/core/constants';

jest.mock('@/lib/organizations/organization-billing', () => ({
  getOrCreateStripeCustomerIdForOrganization: jest.fn().mockResolvedValue('cus_test_admin_org'),
}));

let adminUser: User;
let adminWithoutCreditAccess: User;
let nonAdminUser: User;
let testOrganization: Organization;

describe('organization admin router', () => {
  beforeAll(async () => {
    adminUser = await insertTestUser({
      google_user_email: 'admin-org-admin@admin.example.com',
      google_user_name: 'Admin Org Admin User',
      is_admin: true,
      can_manage_credits: true,
    });

    adminWithoutCreditAccess = await insertTestUser({
      google_user_email: 'admin-without-credit-access@admin.example.com',
      google_user_name: 'Admin Without Credit Access',
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

  describe('getDetails', () => {
    beforeEach(async () => {
      await db
        .delete(platform_integrations)
        .where(eq(platform_integrations.owned_by_organization_id, testOrganization.id));
    });

    afterEach(async () => {
      await db
        .delete(platform_integrations)
        .where(eq(platform_integrations.owned_by_organization_id, testOrganization.id));
    });

    it('returns active organization integrations grouped by platform', async () => {
      await db.insert(platform_integrations).values([
        {
          owned_by_organization_id: testOrganization.id,
          platform: PLATFORM.GITHUB,
          integration_type: 'app',
          integration_status: INTEGRATION_STATUS.ACTIVE,
          platform_installation_id: 'admin-details-github-1',
        },
        {
          owned_by_organization_id: testOrganization.id,
          platform: PLATFORM.GITHUB,
          integration_type: 'app',
          integration_status: INTEGRATION_STATUS.ACTIVE,
          platform_installation_id: 'admin-details-github-2',
        },
        {
          owned_by_organization_id: testOrganization.id,
          platform: PLATFORM.LINEAR,
          integration_type: 'oauth',
          integration_status: INTEGRATION_STATUS.ACTIVE,
          platform_installation_id: 'admin-details-linear',
        },
        {
          owned_by_organization_id: testOrganization.id,
          platform: PLATFORM.SLACK,
          integration_type: 'oauth',
          integration_status: INTEGRATION_STATUS.PENDING,
          platform_installation_id: 'admin-details-slack',
        },
      ]);

      const caller = await createCallerForUser(adminUser.id);
      const result = await caller.organizations.admin.getDetails({
        organizationId: testOrganization.id,
      });

      expect(result.integrations).toEqual([
        { platform: PLATFORM.GITHUB, installation_count: 2 },
        { platform: PLATFORM.LINEAR, installation_count: 1 },
      ]);
    });
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
      expect(creditTransaction.created_by_kilo_user_id).toBe(adminUser.id);
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

    it('should reject admins without credit management access', async () => {
      const caller = await createCallerForUser(adminWithoutCreditAccess.id);

      await expect(
        caller.organizations.admin.nullifyCredits({
          organizationId: testOrganization.id,
        })
      ).rejects.toThrow('Credit management access required');
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

      const [creditTransaction] = await db
        .select({ created_by_kilo_user_id: credit_transactions.created_by_kilo_user_id })
        .from(credit_transactions)
        .where(eq(credit_transactions.organization_id, testOrganization.id));
      expect(creditTransaction.created_by_kilo_user_id).toBe(adminUser.id);
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
      expect(creditTransaction.created_by_kilo_user_id).toBe(adminUser.id);
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

    it('should reject admins without credit management access', async () => {
      const caller = await createCallerForUser(adminWithoutCreditAccess.id);

      await expect(
        caller.organizations.admin.grantCredit({
          organizationId: testOrganization.id,
          amount_usd: 10,
        })
      ).rejects.toThrow('Credit management access required');
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

  describe('creditTransactions', () => {
    it('returns creator details to admins without requiring credit management access', async () => {
      await db
        .delete(credit_transactions)
        .where(eq(credit_transactions.organization_id, testOrganization.id));
      await db.insert(credit_transactions).values({
        kilo_user_id: adminUser.id,
        created_by_kilo_user_id: adminUser.id,
        organization_id: testOrganization.id,
        amount_microdollars: 1_000_000,
        is_free: true,
      });

      const caller = await createCallerForUser(adminWithoutCreditAccess.id);
      const [transaction] = await caller.organizations.admin.creditTransactions({
        organizationId: testOrganization.id,
      });

      expect(transaction.created_by_kilo_user_id).toBe(adminUser.id);
      expect(transaction.created_by_user_name).toBe(adminUser.google_user_name);
      expect(transaction.created_by_user_email).toBe(adminUser.google_user_email);
    });
  });

  describe('nextCreditExpiration', () => {
    beforeEach(async () => {
      await db
        .delete(credit_transactions)
        .where(eq(credit_transactions.organization_id, testOrganization.id));
      await db
        .update(organizations)
        .set({
          total_microdollars_acquired: 20_000_000,
          microdollars_used: 0,
          microdollars_balance: 20_000_000,
          next_credit_expiration_at: null,
        })
        .where(eq(organizations.id, testOrganization.id));
    });

    it('returns the next expiration timestamp as UTC ISO', async () => {
      const expiryDate = '2030-03-01T12:34:56.789Z';
      await db
        .update(organizations)
        .set({ next_credit_expiration_at: expiryDate })
        .where(eq(organizations.id, testOrganization.id));
      await db.insert(credit_transactions).values({
        kilo_user_id: adminUser.id,
        organization_id: testOrganization.id,
        amount_microdollars: 20_000_000,
        is_free: true,
        expiry_date: expiryDate,
        expiration_baseline_microdollars_used: 0,
        original_baseline_microdollars_used: 0,
      });

      const caller = await createCallerForUser(adminWithoutCreditAccess.id);
      const result = await caller.organizations.admin.nextCreditExpiration({
        organizationId: testOrganization.id,
      });

      expect(result).toEqual({
        next_credit_expiration_at: expiryDate,
        next_credit_expiration_amount: 20_000_000,
      });
    });

    it('returns the next valid expiration after concurrent overdue processing', async () => {
      const expiredDate = '2024-01-01T00:00:00.000Z';
      const futureDate = '2030-01-01T00:00:00.000Z';
      await db
        .update(organizations)
        .set({ next_credit_expiration_at: expiredDate })
        .where(eq(organizations.id, testOrganization.id));
      await db.insert(credit_transactions).values([
        {
          kilo_user_id: adminUser.id,
          organization_id: testOrganization.id,
          amount_microdollars: 10_000_000,
          is_free: true,
          expiry_date: expiredDate,
          expiration_baseline_microdollars_used: 0,
          original_baseline_microdollars_used: 0,
        },
        {
          kilo_user_id: adminUser.id,
          organization_id: testOrganization.id,
          amount_microdollars: 10_000_000,
          is_free: true,
          expiry_date: futureDate,
          expiration_baseline_microdollars_used: 0,
          original_baseline_microdollars_used: 0,
        },
      ]);

      const firstCaller = await createCallerForUser(adminWithoutCreditAccess.id);
      const secondCaller = await createCallerForUser(adminWithoutCreditAccess.id);
      const results = await Promise.all([
        firstCaller.organizations.admin.nextCreditExpiration({
          organizationId: testOrganization.id,
        }),
        secondCaller.organizations.admin.nextCreditExpiration({
          organizationId: testOrganization.id,
        }),
      ]);

      expect(results).toEqual([
        {
          next_credit_expiration_at: futureDate,
          next_credit_expiration_amount: 10_000_000,
        },
        {
          next_credit_expiration_at: futureDate,
          next_credit_expiration_amount: 10_000_000,
        },
      ]);

      const expirationTransactions = await db
        .select()
        .from(credit_transactions)
        .where(
          and(
            eq(credit_transactions.organization_id, testOrganization.id),
            eq(credit_transactions.credit_category, 'credits_expired')
          )
        );
      expect(expirationTransactions).toHaveLength(1);
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

  // Regression for the "credits expiring soon" total keeping stale/removed
  // grants: an admin nullifies credits, then re-grants credits with a new
  // expiration date. The Balance page's expiring-soon total must reflect
  // only the current, still-open grant — not the nullified one on top of it.
  describe('nullifyCredits then re-grant — expiring credits total', () => {
    beforeEach(async () => {
      await db
        .update(organizations)
        .set({
          total_microdollars_acquired: 0,
          microdollars_used: 0,
          microdollars_balance: 0,
          next_credit_expiration_at: null,
        })
        .where(eq(organizations.id, testOrganization.id));

      await db
        .delete(credit_transactions)
        .where(eq(credit_transactions.organization_id, testOrganization.id));
    });

    it('does not double-count a nullified grant after re-granting with a new expiry', async () => {
      const caller = await createCallerForUser(adminUser.id);

      // 1. Grant $100 expiring in the future.
      await caller.organizations.admin.grantCredit({
        organizationId: testOrganization.id,
        amount_usd: 100,
        expiry_date: '2030-01-01T00:00:00.000Z',
      });

      // 2. Remove (nullify) all credits.
      await caller.organizations.admin.nullifyCredits({
        organizationId: testOrganization.id,
      });

      // 3. Re-add $40 with a different expiration date.
      await caller.organizations.admin.grantCredit({
        organizationId: testOrganization.id,
        amount_usd: 40,
        expiry_date: '2030-06-01T00:00:00.000Z',
      });

      const creditBlocks = await caller.organizations.getCreditBlocks({
        organizationId: testOrganization.id,
      });

      const expiringTotal = creditBlocks.creditBlocks
        .filter(block => block.expiry_date !== null)
        .reduce((sum, block) => sum + block.balance_mUsd, 0);

      // Only the $40 re-grant should count as expiring soon; the nullified
      // $100 grant must not still be summed in on top of it.
      expect(expiringTotal).toBe(40_000_000);
      expect(creditBlocks.totalBalance_mUsd).toBe(40_000_000);
    });

    it('closes out multiple still-open grants on nullification', async () => {
      const caller = await createCallerForUser(adminUser.id);

      await caller.organizations.admin.grantCredit({
        organizationId: testOrganization.id,
        amount_usd: 60,
        expiry_date: '2030-01-01T00:00:00.000Z',
      });
      await caller.organizations.admin.grantCredit({
        organizationId: testOrganization.id,
        amount_usd: 30,
        expiry_date: '2030-02-01T00:00:00.000Z',
      });

      await caller.organizations.admin.nullifyCredits({
        organizationId: testOrganization.id,
      });

      const expiring = await fetchExpiringTransactionsForOrganization(testOrganization.id);
      expect(expiring).toHaveLength(0);

      const creditBlocks = await caller.organizations.getCreditBlocks({
        organizationId: testOrganization.id,
      });
      expect(creditBlocks.totalBalance_mUsd).toBe(0);
      expect(creditBlocks.creditBlocks).toHaveLength(0);
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

  describe('getHierarchy', () => {
    it('returns parent and child organization summaries', async () => {
      const searchPrefix = `Admin Org Hierarchy ${crypto.randomUUID()}`;
      const grandparentOrganization = await createOrganization(
        `${searchPrefix} grandparent`,
        adminUser.id
      );
      const parentOrganization = await createOrganization(`${searchPrefix} parent`, adminUser.id);
      const childOrganization = await createOrganization(`${searchPrefix} child`, adminUser.id);
      const siblingOrganization = await createOrganization(`${searchPrefix} sibling`, adminUser.id);

      try {
        await db
          .update(organizations)
          .set({ parent_organization_id: grandparentOrganization.id })
          .where(eq(organizations.id, parentOrganization.id));
        await db
          .update(organizations)
          .set({ parent_organization_id: parentOrganization.id })
          .where(inArray(organizations.id, [childOrganization.id, siblingOrganization.id]));

        const caller = await createCallerForUser(adminUser.id);
        const childHierarchy = await caller.organizations.admin.getHierarchy({
          organizationId: childOrganization.id,
        });
        const parentHierarchy = await caller.organizations.admin.getHierarchy({
          organizationId: parentOrganization.id,
        });

        expect(childHierarchy.parent).toEqual({
          id: parentOrganization.id,
          name: parentOrganization.name,
        });
        expect(childHierarchy.ancestors).toEqual([
          { id: parentOrganization.id, name: parentOrganization.name },
          { id: grandparentOrganization.id, name: grandparentOrganization.name },
        ]);
        expect(childHierarchy.children).toEqual([]);
        expect(parentHierarchy.parent).toEqual({
          id: grandparentOrganization.id,
          name: grandparentOrganization.name,
        });
        expect(parentHierarchy.ancestors).toEqual([
          { id: grandparentOrganization.id, name: grandparentOrganization.name },
        ]);
        expect(parentHierarchy.children).toEqual([
          { id: childOrganization.id, name: childOrganization.name },
          { id: siblingOrganization.id, name: siblingOrganization.name },
        ]);
      } finally {
        await db
          .update(organizations)
          .set({ parent_organization_id: null })
          .where(
            inArray(organizations.id, [
              childOrganization.id,
              siblingOrganization.id,
              parentOrganization.id,
            ])
          );
        await db
          .delete(organizations)
          .where(
            inArray(organizations.id, [
              childOrganization.id,
              siblingOrganization.id,
              parentOrganization.id,
              grandparentOrganization.id,
            ])
          );
      }
    });
  });

  describe('hierarchy management', () => {
    it('creates an empty child organization under a parent organization', async () => {
      const searchPrefix = `Admin Create Child Org ${crypto.randomUUID()}`;
      const parentOrganization = await createOrganization(`${searchPrefix} parent`, adminUser.id);
      const caller = await createCallerForUser(adminUser.id);
      let childOrganizationId: string | null = null;

      try {
        const result = await caller.organizations.admin.create({
          name: `${searchPrefix} child`,
          parentOrganizationId: parentOrganization.id,
        });
        childOrganizationId = result.organization.id;

        const [childOrganization] = await db
          .select({
            parent_organization_id: organizations.parent_organization_id,
            require_seats: organizations.require_seats,
            free_trial_end_at: organizations.free_trial_end_at,
            settings: organizations.settings,
            member_count: sql<number>`(
              SELECT COUNT(*)::int
              FROM ${organization_memberships}
              WHERE ${organization_memberships.organization_id} = ${organizations.id}
            )`,
          })
          .from(organizations)
          .where(eq(organizations.id, childOrganizationId));

        expect(result.organization.parent_organization_id).toBe(parentOrganization.id);
        expect(result.organization.require_seats).toBe(false);
        expect(result.organization.free_trial_end_at).toBeNull();
        expect(result.organization.settings.suppress_trial_messaging).toBe(true);
        expect(childOrganization.parent_organization_id).toBe(parentOrganization.id);
        expect(childOrganization.require_seats).toBe(false);
        expect(childOrganization.free_trial_end_at).toBeNull();
        expect(childOrganization.settings.suppress_trial_messaging).toBe(true);
        expect(childOrganization.member_count).toBe(0);
      } finally {
        await db
          .update(organizations)
          .set({ parent_organization_id: null })
          .where(eq(organizations.parent_organization_id, parentOrganization.id));
        if (childOrganizationId) {
          await db.delete(organizations).where(eq(organizations.id, childOrganizationId));
        }
        await db.delete(organizations).where(eq(organizations.id, parentOrganization.id));
      }
    });

    it('sets an existing organization as a child organization', async () => {
      const searchPrefix = `Admin Set Child Org ${crypto.randomUUID()}`;
      const parentOrganization = await createOrganization(`${searchPrefix} parent`, adminUser.id);
      const childOrganization = await createOrganization(`${searchPrefix} child`, adminUser.id);

      try {
        const caller = await createCallerForUser(adminUser.id);
        await caller.organizations.admin.setParent({
          organizationId: childOrganization.id,
          parentOrganizationId: parentOrganization.id,
        });

        const hierarchy = await caller.organizations.admin.getHierarchy({
          organizationId: parentOrganization.id,
        });
        const [updatedChildOrganization] = await db
          .select({
            require_seats: organizations.require_seats,
            free_trial_end_at: organizations.free_trial_end_at,
            settings: organizations.settings,
          })
          .from(organizations)
          .where(eq(organizations.id, childOrganization.id));

        expect(hierarchy.children).toContainEqual({
          id: childOrganization.id,
          name: childOrganization.name,
        });
        expect(updatedChildOrganization.require_seats).toBe(false);
        expect(updatedChildOrganization.free_trial_end_at).toBeNull();
        expect(updatedChildOrganization.settings.suppress_trial_messaging).toBe(true);
      } finally {
        await db
          .update(organizations)
          .set({ parent_organization_id: null })
          .where(eq(organizations.id, childOrganization.id));
        await db
          .delete(organizations)
          .where(inArray(organizations.id, [childOrganization.id, parentOrganization.id]));
      }
    });

    it('only returns addable organizations from child autocomplete search', async () => {
      const searchPrefix = `Admin Addable Child Search ${crypto.randomUUID()}`;
      const parentOrganization = await createOrganization(`${searchPrefix} parent`, adminUser.id);
      const directChildOrganization = await createOrganization(
        `${searchPrefix} direct child`,
        adminUser.id
      );
      const parentCandidate = await createOrganization(`${searchPrefix} has child`, adminUser.id);
      const childOfCandidate = await createOrganization(
        `${searchPrefix} child of candidate`,
        adminUser.id
      );
      const addableOrganization = await createOrganization(`${searchPrefix} addable`, adminUser.id);

      try {
        await db
          .update(organizations)
          .set({ parent_organization_id: parentOrganization.id })
          .where(eq(organizations.id, directChildOrganization.id));
        await db
          .update(organizations)
          .set({ parent_organization_id: parentCandidate.id })
          .where(eq(organizations.id, childOfCandidate.id));

        const caller = await createCallerForUser(adminUser.id);
        const results = await caller.organizations.admin.search({
          search: searchPrefix,
          limit: 20,
          childOfOrganizationId: parentOrganization.id,
        });

        expect(results.map(organization => organization.id)).toEqual([addableOrganization.id]);
      } finally {
        await db
          .update(organizations)
          .set({ parent_organization_id: null })
          .where(inArray(organizations.id, [directChildOrganization.id, childOfCandidate.id]));
        await db
          .delete(organizations)
          .where(
            inArray(organizations.id, [
              addableOrganization.id,
              childOfCandidate.id,
              parentCandidate.id,
              directChildOrganization.id,
              parentOrganization.id,
            ])
          );
      }
    });

    it('returns no addable autocomplete results when the target parent is a child', async () => {
      const searchPrefix = `Admin Child Target Search ${crypto.randomUUID()}`;
      const rootOrganization = await createOrganization(`${searchPrefix} root`, adminUser.id);
      const childOrganization = await createOrganization(`${searchPrefix} child`, adminUser.id);
      const candidateOrganization = await createOrganization(
        `${searchPrefix} candidate`,
        adminUser.id
      );

      try {
        await db
          .update(organizations)
          .set({ parent_organization_id: rootOrganization.id })
          .where(eq(organizations.id, childOrganization.id));

        const caller = await createCallerForUser(adminUser.id);
        const results = await caller.organizations.admin.search({
          search: searchPrefix,
          limit: 20,
          childOfOrganizationId: childOrganization.id,
        });

        expect(results).toEqual([]);
      } finally {
        await db
          .update(organizations)
          .set({ parent_organization_id: null })
          .where(eq(organizations.id, childOrganization.id));
        await db
          .delete(organizations)
          .where(
            inArray(organizations.id, [
              candidateOrganization.id,
              childOrganization.id,
              rootOrganization.id,
            ])
          );
      }
    });

    it('rejects hierarchy cycles', async () => {
      const searchPrefix = `Admin Hierarchy Cycle ${crypto.randomUUID()}`;
      const parentOrganization = await createOrganization(`${searchPrefix} parent`, adminUser.id);
      const childOrganization = await createOrganization(`${searchPrefix} child`, adminUser.id);

      try {
        await db
          .update(organizations)
          .set({ parent_organization_id: parentOrganization.id })
          .where(eq(organizations.id, childOrganization.id));

        const caller = await createCallerForUser(adminUser.id);
        await expect(
          caller.organizations.admin.setParent({
            organizationId: parentOrganization.id,
            parentOrganizationId: childOrganization.id,
          })
        ).rejects.toThrow(
          'Cannot add a parent to an organization that already has child organizations'
        );
      } finally {
        await db
          .update(organizations)
          .set({ parent_organization_id: null })
          .where(inArray(organizations.id, [childOrganization.id, parentOrganization.id]));
        await db
          .delete(organizations)
          .where(inArray(organizations.id, [childOrganization.id, parentOrganization.id]));
      }
    });

    it('rejects adding child organizations to a child organization', async () => {
      const searchPrefix = `Admin Child Parent ${crypto.randomUUID()}`;
      const rootOrganization = await createOrganization(`${searchPrefix} root`, adminUser.id);
      const childOrganization = await createOrganization(`${searchPrefix} child`, adminUser.id);
      const newChildOrganization = await createOrganization(
        `${searchPrefix} new child`,
        adminUser.id
      );

      try {
        await db
          .update(organizations)
          .set({ parent_organization_id: rootOrganization.id })
          .where(eq(organizations.id, childOrganization.id));

        const caller = await createCallerForUser(adminUser.id);
        await expect(
          caller.organizations.admin.setParent({
            organizationId: newChildOrganization.id,
            parentOrganizationId: childOrganization.id,
          })
        ).rejects.toThrow(
          'Cannot add child organizations to an organization that is already a child'
        );

        await expect(
          caller.organizations.admin.create({
            name: `${searchPrefix} created child`,
            parentOrganizationId: childOrganization.id,
          })
        ).rejects.toThrow(
          'Cannot add child organizations to an organization that is already a child'
        );
      } finally {
        await db
          .update(organizations)
          .set({ parent_organization_id: null })
          .where(inArray(organizations.id, [childOrganization.id, newChildOrganization.id]));
        await db
          .delete(organizations)
          .where(
            inArray(organizations.id, [
              newChildOrganization.id,
              childOrganization.id,
              rootOrganization.id,
            ])
          );
      }
    });

    it('rejects adding a parent to an organization with child organizations', async () => {
      const searchPrefix = `Admin Parent Child ${crypto.randomUUID()}`;
      const parentOrganization = await createOrganization(`${searchPrefix} parent`, adminUser.id);
      const existingParentOrganization = await createOrganization(
        `${searchPrefix} existing parent`,
        adminUser.id
      );
      const existingChildOrganization = await createOrganization(
        `${searchPrefix} existing child`,
        adminUser.id
      );

      try {
        await db
          .update(organizations)
          .set({ parent_organization_id: existingParentOrganization.id })
          .where(eq(organizations.id, existingChildOrganization.id));

        const caller = await createCallerForUser(adminUser.id);
        await expect(
          caller.organizations.admin.setParent({
            organizationId: existingParentOrganization.id,
            parentOrganizationId: parentOrganization.id,
          })
        ).rejects.toThrow(
          'Cannot add a parent to an organization that already has child organizations'
        );
      } finally {
        await db
          .update(organizations)
          .set({ parent_organization_id: null })
          .where(eq(organizations.id, existingChildOrganization.id));
        await db
          .delete(organizations)
          .where(
            inArray(organizations.id, [
              existingChildOrganization.id,
              existingParentOrganization.id,
              parentOrganization.id,
            ])
          );
      }
    });

    it('rejects self-parenting', async () => {
      const organization = await createOrganization(
        `Admin Hierarchy Self Parent ${crypto.randomUUID()}`,
        adminUser.id
      );

      try {
        const caller = await createCallerForUser(adminUser.id);
        await expect(
          caller.organizations.admin.setParent({
            organizationId: organization.id,
            parentOrganizationId: organization.id,
          })
        ).rejects.toThrow('An organization cannot be its own parent');
      } finally {
        await db.delete(organizations).where(eq(organizations.id, organization.id));
      }
    });

    describe('Kilo Pass allocation guard', () => {
      const organizationIds: string[] = [];
      const agreementIds: string[] = [];
      const termVersionIds: string[] = [];

      afterEach(async () => {
        if (agreementIds.length > 0) {
          await db
            .delete(kilo_pass_org_issuance_snapshots)
            .where(inArray(kilo_pass_org_issuance_snapshots.agreement_id, agreementIds));
          await db
            .delete(kilo_pass_org_agreements)
            .where(inArray(kilo_pass_org_agreements.id, agreementIds));
        }
        if (termVersionIds.length > 0) {
          await db
            .delete(kilo_pass_org_term_versions)
            .where(inArray(kilo_pass_org_term_versions.id, termVersionIds));
        }
        if (organizationIds.length > 0) {
          await db
            .update(organizations)
            .set({ parent_organization_id: null })
            .where(inArray(organizations.id, organizationIds));
          await db.delete(organizations).where(inArray(organizations.id, organizationIds));
        }
        agreementIds.length = 0;
        termVersionIds.length = 0;
        organizationIds.length = 0;
      });

      async function createAllocatedChild(params: {
        initialCapacity: number;
        futureCapacity?: number;
        issuedCreditsOnly?: boolean;
        futureIsEffective?: boolean;
      }) {
        const prefix = `Kilo Pass hierarchy ${crypto.randomUUID()}`;
        const parent = await createOrganization(`${prefix} parent`, adminUser.id);
        const child = await createOrganization(`${prefix} child`, adminUser.id);
        const replacementParent = await createOrganization(`${prefix} replacement`, adminUser.id);
        organizationIds.push(parent.id, child.id, replacementParent.id);
        await db
          .update(organizations)
          .set({ parent_organization_id: parent.id })
          .where(eq(organizations.id, child.id));

        const [termVersion] = await db
          .insert(kilo_pass_org_term_versions)
          .values({
            version_key: crypto.randomUUID(),
            tier: KiloPassTier.Tier19,
            cadence: KiloPassCadence.Monthly,
            billing_price_microdollars_per_pass: 1,
            base_credit_microdollars_per_pass: 1,
            bonus_credit_microdollars_per_pass: 0,
            unlock_spend_microdollars_per_pass: 0,
            bonus_mode: KiloPassOrgBonusMode.AfterBase,
          })
          .returning({ id: kilo_pass_org_term_versions.id });
        termVersionIds.push(termVersion.id);

        const [agreement] = await db
          .insert(kilo_pass_org_agreements)
          .values({
            parent_organization_id: parent.id,
            term_version_id: termVersion.id,
            state: 'active',
            processing_condition: 'ready',
            purchase_channel: 'manual',
            cadence: KiloPassCadence.Monthly,
            purchased_pass_capacity: 10,
            issuance_anchor_at: new Date().toISOString(),
          })
          .returning({ id: kilo_pass_org_agreements.id });
        agreementIds.push(agreement.id);

        const capacities = [params.initialCapacity];
        if (params.futureCapacity !== undefined) capacities.push(params.futureCapacity);
        const planIntervalMs = 31 * 24 * 60 * 60 * 1000;
        const planBaseTime = Date.now() - (params.futureIsEffective ? planIntervalMs : 1_000);
        for (const [index, capacity] of capacities.entries()) {
          const [plan] = await db
            .insert(kilo_pass_org_allocation_plans)
            .values({
              agreement_id: agreement.id,
              effective_window_start: new Date(planBaseTime + index * planIntervalMs).toISOString(),
              version: index + 1,
              created_by_kilo_user_id: adminUser.id,
            })
            .returning({ id: kilo_pass_org_allocation_plans.id });
          await db.insert(kilo_pass_org_allocation_plan_rows).values({
            allocation_plan_id: plan.id,
            allocation_container_organization_id: child.id,
            pass_capacity: capacity,
          });
        }

        if (params.issuedCreditsOnly) {
          await db.insert(kilo_pass_org_issuance_snapshots).values({
            agreement_id: agreement.id,
            term_version_id: termVersion.id,
            allocation_container_organization_id: child.id,
            window_start: new Date().toISOString(),
            window_end: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
            qualifying_spend_starts_at: new Date().toISOString(),
            kind: 'regular',
            tranche_key: 'issued-credit-only',
            allocated_pass_capacity: 1,
            base_credit_microdollars: 1,
            bonus_credit_microdollars: 0,
            unlock_spend_microdollars: 0,
            bonus_mode: KiloPassOrgBonusMode.AfterBase,
          });
        }

        return { parent, child, replacementParent };
      }

      it('blocks detaching a child with a nonzero initial allocation', async () => {
        const { child } = await createAllocatedChild({ initialCapacity: 1 });
        const caller = await createCallerForUser(adminUser.id);

        await expect(
          caller.organizations.admin.setParent({
            organizationId: child.id,
            parentOrganizationId: null,
          })
        ).rejects.toThrow(
          'Cannot change organization hierarchy while it has Kilo Pass allocations'
        );
      });

      it('allows detaching a child with zero allocation despite issued credits', async () => {
        const { child } = await createAllocatedChild({
          initialCapacity: 0,
          issuedCreditsOnly: true,
        });
        const caller = await createCallerForUser(adminUser.id);

        await caller.organizations.admin.setParent({
          organizationId: child.id,
          parentOrganizationId: null,
        });

        const [updated] = await db
          .select({ parentOrganizationId: organizations.parent_organization_id })
          .from(organizations)
          .where(eq(organizations.id, child.id));
        expect(updated.parentOrganizationId).toBeNull();
      });

      it('blocks reparenting a child with a nonzero future allocation', async () => {
        const { child, replacementParent } = await createAllocatedChild({
          initialCapacity: 0,
          futureCapacity: 1,
        });
        const caller = await createCallerForUser(adminUser.id);

        await expect(
          caller.organizations.admin.setParent({
            organizationId: child.id,
            parentOrganizationId: replacementParent.id,
          })
        ).rejects.toThrow(
          'Cannot change organization hierarchy while it has Kilo Pass allocations'
        );
      });

      it('allows reparenting after a historical allocation is replaced by an effective zero plan', async () => {
        const { child, replacementParent } = await createAllocatedChild({
          initialCapacity: 1,
          futureCapacity: 0,
          futureIsEffective: true,
        });
        const caller = await createCallerForUser(adminUser.id);

        await caller.organizations.admin.setParent({
          organizationId: child.id,
          parentOrganizationId: replacementParent.id,
        });

        const [updated] = await db
          .select({ parentOrganizationId: organizations.parent_organization_id })
          .from(organizations)
          .where(eq(organizations.id, child.id));
        expect(updated.parentOrganizationId).toBe(replacementParent.id);
      });

      it('blocks reparenting while a zero allocation is only scheduled for the future', async () => {
        const { child, replacementParent } = await createAllocatedChild({
          initialCapacity: 1,
          futureCapacity: 0,
        });
        const caller = await createCallerForUser(adminUser.id);

        await expect(
          caller.organizations.admin.setParent({
            organizationId: child.id,
            parentOrganizationId: replacementParent.id,
          })
        ).rejects.toThrow(
          'Cannot change organization hierarchy while it has Kilo Pass allocations'
        );
      });

      it('allows reparenting a child with only zero allocations', async () => {
        const { child, replacementParent } = await createAllocatedChild({
          initialCapacity: 0,
          futureCapacity: 0,
        });
        const caller = await createCallerForUser(adminUser.id);

        await caller.organizations.admin.setParent({
          organizationId: child.id,
          parentOrganizationId: replacementParent.id,
        });

        const [updated] = await db
          .select({ parentOrganizationId: organizations.parent_organization_id })
          .from(organizations)
          .where(eq(organizations.id, child.id));
        expect(updated.parentOrganizationId).toBe(replacementParent.id);
      });

      it('blocks archiving a child with a nonzero allocation', async () => {
        const { child } = await createAllocatedChild({ initialCapacity: 1 });
        const caller = await createCallerForUser(adminUser.id);

        await expect(
          caller.organizations.admin.delete({ organizationId: child.id })
        ).rejects.toThrow(
          'Cannot change organization hierarchy while it has Kilo Pass allocations'
        );
      });

      it('allows archiving a child with only zero allocations', async () => {
        const { child } = await createAllocatedChild({ initialCapacity: 0 });
        const caller = await createCallerForUser(adminUser.id);

        await caller.organizations.admin.delete({ organizationId: child.id });

        const [updated] = await db
          .select({ deletedAt: organizations.deleted_at })
          .from(organizations)
          .where(eq(organizations.id, child.id));
        expect(updated.deletedAt).not.toBeNull();
      });
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

  describe('list — organization Kilo Pass tier sorting', () => {
    it('sorts by the organization-owned agreement tier selected for display', async () => {
      const searchPrefix = `Admin Kilo Pass Sort ${crypto.randomUUID()}`;
      const tier19Org = await createOrganization(`${searchPrefix} tier 19`, adminUser.id);
      const tier49Org = await createOrganization(`${searchPrefix} tier 49`, adminUser.id);
      const termVersionIds: string[] = [];
      const agreementIds: string[] = [];

      try {
        const now = new Date().toISOString();
        const terms = await db
          .insert(kilo_pass_org_term_versions)
          .values([
            {
              version_key: crypto.randomUUID(),
              tier: KiloPassTier.Tier19,
              cadence: KiloPassCadence.Monthly,
              billing_price_microdollars_per_pass: 19_000_000,
              base_credit_microdollars_per_pass: 19_000_000,
              bonus_credit_microdollars_per_pass: 4_000_000,
              unlock_spend_microdollars_per_pass: 19_000_000,
              bonus_mode: KiloPassOrgBonusMode.AfterBase,
            },
            {
              version_key: crypto.randomUUID(),
              tier: KiloPassTier.Tier49,
              cadence: KiloPassCadence.Monthly,
              billing_price_microdollars_per_pass: 49_000_000,
              base_credit_microdollars_per_pass: 49_000_000,
              bonus_credit_microdollars_per_pass: 12_000_000,
              unlock_spend_microdollars_per_pass: 49_000_000,
              bonus_mode: KiloPassOrgBonusMode.AfterBase,
            },
          ])
          .returning({ id: kilo_pass_org_term_versions.id });
        termVersionIds.push(...terms.map(term => term.id));
        const agreements = await db
          .insert(kilo_pass_org_agreements)
          .values([
            {
              parent_organization_id: tier19Org.id,
              term_version_id: terms[0]!.id,
              state: 'active',
              processing_condition: 'ready',
              purchase_channel: 'self_serve',
              cadence: KiloPassCadence.Monthly,
              purchased_pass_capacity: 2,
              issuance_anchor_at: now,
            },
            {
              parent_organization_id: tier49Org.id,
              term_version_id: terms[1]!.id,
              state: 'cancel_at_period_end',
              processing_condition: 'ready',
              purchase_channel: 'self_serve',
              cadence: KiloPassCadence.Monthly,
              purchased_pass_capacity: 2,
              issuance_anchor_at: now,
            },
          ])
          .returning({ id: kilo_pass_org_agreements.id });
        agreementIds.push(...agreements.map(agreement => agreement.id));

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
        expect(result.organizations[0]?.kilo_pass_state).toBe('active');
        expect(result.pagination.total).toBe(2);
      } finally {
        await db
          .delete(kilo_pass_org_agreements)
          .where(inArray(kilo_pass_org_agreements.id, agreementIds));
        await db
          .delete(kilo_pass_org_term_versions)
          .where(inArray(kilo_pass_org_term_versions.id, termVersionIds));
        await db
          .delete(organization_memberships)
          .where(inArray(organization_memberships.organization_id, [tier19Org.id, tier49Org.id]));
        await db
          .delete(organizations)
          .where(inArray(organizations.id, [tier19Org.id, tier49Org.id]));
      }
    });
  });

  describe('serviceFeeExemption', () => {
    async function createExemptionTestOrganization(name = 'Service fee exemption') {
      return createOrganization(`${name} ${crypto.randomUUID()}`, adminUser.id);
    }

    async function cleanupExemptionTestOrganization(organizationId: string) {
      await db
        .delete(organization_service_fee_exemptions)
        .where(eq(organization_service_fee_exemptions.organization_id, organizationId));
      await db
        .delete(organization_service_fee_exemption_history)
        .where(eq(organization_service_fee_exemption_history.organization_id, organizationId));
      await db
        .delete(organization_memberships)
        .where(eq(organization_memberships.organization_id, organizationId));
      await db.delete(organizations).where(eq(organizations.id, organizationId));
    }

    it('grants an exemption with a trimmed reason, actor, and history row', async () => {
      const org = await createExemptionTestOrganization();
      try {
        const caller = await createCallerForUser(adminUser.id);
        const result = await caller.organizations.admin.setServiceFeeExemption({
          organizationId: org.id,
          isExempt: true,
          reason: '  nonprofit partner  ',
        });

        expect(result.current).toMatchObject({
          organizationId: org.id,
          isExempt: true,
          reason: 'nonprofit partner',
          changedByKiloUserId: adminUser.id,
        });
        expect(result.current.currentHistoryId).toBe(result.history.id);
        expect(result.history).toMatchObject({
          organizationId: org.id,
          isExempt: true,
          reason: 'nonprofit partner',
          changedByKiloUserId: adminUser.id,
        });
        // Timestamps are normalized to UTC ISO at the API boundary.
        expect(new Date(result.current.changedAt).toISOString()).toBe(result.current.changedAt);
        expect(new Date(result.history.createdAt).toISOString()).toBe(result.history.createdAt);

        const view = await caller.organizations.admin.getServiceFeeExemption({
          organizationId: org.id,
        });
        expect(view.current?.isExempt).toBe(true);
        expect(view.current?.reason).toBe('nonprofit partner');
        expect(view.history).toHaveLength(1);
        expect(view.history[0].id).toBe(result.history.id);
      } finally {
        await cleanupExemptionTestOrganization(org.id);
      }
    });

    it('revokes an exemption and returns the newest history first', async () => {
      const org = await createExemptionTestOrganization();
      try {
        const caller = await createCallerForUser(adminUser.id);
        await caller.organizations.admin.setServiceFeeExemption({
          organizationId: org.id,
          isExempt: true,
          reason: 'initial grant',
        });
        const revoked = await caller.organizations.admin.setServiceFeeExemption({
          organizationId: org.id,
          isExempt: false,
          reason: 'revoked after contract review',
        });

        expect(revoked.current.isExempt).toBe(false);
        expect(revoked.current.reason).toBe('revoked after contract review');
        expect(revoked.current.currentHistoryId).toBe(revoked.history.id);

        const view = await caller.organizations.admin.getServiceFeeExemption({
          organizationId: org.id,
        });
        expect(view.current?.isExempt).toBe(false);
        expect(view.history.map(row => row.reason)).toEqual([
          'revoked after contract review',
          'initial grant',
        ]);
        expect(view.history.map(row => row.isExempt)).toEqual([false, true]);
        expect(view.history.every(row => row.changedByKiloUserId === adminUser.id)).toBe(true);
        expect(
          view.history.every(row => new Date(row.createdAt).toISOString() === row.createdAt)
        ).toBe(true);
      } finally {
        await cleanupExemptionTestOrganization(org.id);
      }
    });

    it('allows repeating the same state with a new reason and keeps the original createdAt', async () => {
      const org = await createExemptionTestOrganization();
      try {
        const caller = await createCallerForUser(adminUser.id);
        const first = await caller.organizations.admin.setServiceFeeExemption({
          organizationId: org.id,
          isExempt: true,
          reason: 'initial grant',
        });
        const second = await caller.organizations.admin.setServiceFeeExemption({
          organizationId: org.id,
          isExempt: true,
          reason: 'renewed with updated documentation',
        });

        expect(second.current.isExempt).toBe(true);
        expect(second.current.reason).toBe('renewed with updated documentation');
        expect(second.current.currentHistoryId).toBe(second.history.id);
        expect(second.current.createdAt).toBe(first.current.createdAt);

        const view = await caller.organizations.admin.getServiceFeeExemption({
          organizationId: org.id,
        });
        expect(view.history).toHaveLength(2);
        expect(view.history.map(row => row.reason)).toEqual([
          'renewed with updated documentation',
          'initial grant',
        ]);
      } finally {
        await cleanupExemptionTestOrganization(org.id);
      }
    });

    it('rejects non-admin users from reading and mutating exemption state', async () => {
      const org = await createExemptionTestOrganization();
      try {
        const caller = await createCallerForUser(nonAdminUser.id);

        await expect(
          caller.organizations.admin.getServiceFeeExemption({ organizationId: org.id })
        ).rejects.toThrow('Admin access required');
        await expect(
          caller.organizations.admin.setServiceFeeExemption({
            organizationId: org.id,
            isExempt: true,
            reason: 'non-admin attempt',
          })
        ).rejects.toThrow('Admin access required');
      } finally {
        await cleanupExemptionTestOrganization(org.id);
      }
    });

    it('rejects blank and undersized reasons', async () => {
      const org = await createExemptionTestOrganization();
      try {
        const caller = await createCallerForUser(adminUser.id);

        await expect(
          caller.organizations.admin.setServiceFeeExemption({
            organizationId: org.id,
            isExempt: true,
            reason: '   ',
          })
        ).rejects.toThrow();
        await expect(
          caller.organizations.admin.setServiceFeeExemption({
            organizationId: org.id,
            isExempt: true,
            reason: 'no',
          })
        ).rejects.toThrow();

        const view = await caller.organizations.admin.getServiceFeeExemption({
          organizationId: org.id,
        });
        expect(view.current).toBeNull();
        expect(view.history).toEqual([]);
      } finally {
        await cleanupExemptionTestOrganization(org.id);
      }
    });

    it('rejects oversized reasons', async () => {
      const org = await createExemptionTestOrganization();
      try {
        const caller = await createCallerForUser(adminUser.id);

        await expect(
          caller.organizations.admin.setServiceFeeExemption({
            organizationId: org.id,
            isExempt: true,
            reason: 'x'.repeat(501),
          })
        ).rejects.toThrow();
      } finally {
        await cleanupExemptionTestOrganization(org.id);
      }
    });

    it('maps deleted and missing organizations to NOT_FOUND', async () => {
      const org = await createExemptionTestOrganization();
      try {
        await markOrganizationAsDeleted(org.id);
        const caller = await createCallerForUser(adminUser.id);

        await expect(
          caller.organizations.admin.setServiceFeeExemption({
            organizationId: org.id,
            isExempt: true,
            reason: 'deleted organization',
          })
        ).rejects.toMatchObject({ code: 'NOT_FOUND', message: 'Organization not found' });
        await expect(
          caller.organizations.admin.setServiceFeeExemption({
            organizationId: '550e8400-e29b-41d4-a716-446655440099',
            isExempt: true,
            reason: 'missing organization',
          })
        ).rejects.toMatchObject({ code: 'NOT_FOUND', message: 'Organization not found' });
      } finally {
        await cleanupExemptionTestOrganization(org.id);
      }
    });

    it('does not expose exemption fields through customer organization APIs', async () => {
      const org = await createOrganization(
        `Customer surface ${crypto.randomUUID()}`,
        nonAdminUser.id
      );
      try {
        const adminCaller = await createCallerForUser(adminUser.id);
        await adminCaller.organizations.admin.setServiceFeeExemption({
          organizationId: org.id,
          isExempt: true,
          reason: 'granted for customer surface check',
        });

        const customerCaller = await createCallerForUser(nonAdminUser.id);
        const customerOrganizations = await customerCaller.organizations.list();
        const row = customerOrganizations.find(entry => entry.organizationId === org.id);

        expect(row).toBeDefined();
        expect(Object.keys(row ?? {}).some(key => /exempt/i.test(key))).toBe(false);
        expect(JSON.stringify(row)).not.toMatch(
          /service_fee_exemption|serviceFeeExemption|isExempt/
        );
      } finally {
        await cleanupExemptionTestOrganization(org.id);
      }
    });
  });

  describe('getKiloPassSummary', () => {
    it('returns the parent agreement as read-only information for a child organization', async () => {
      const parent = await createOrganization(
        `Admin pass parent ${crypto.randomUUID()}`,
        adminUser.id
      );
      const child = await createOrganization(
        `Admin pass child ${crypto.randomUUID()}`,
        adminUser.id
      );
      await db
        .update(organizations)
        .set({ parent_organization_id: parent.id })
        .where(eq(organizations.id, child.id));
      const [term] = await db
        .insert(kilo_pass_org_term_versions)
        .values({
          version_key: crypto.randomUUID(),
          tier: KiloPassTier.Tier49,
          cadence: KiloPassCadence.Yearly,
          billing_price_microdollars_per_pass: 49_000_000,
          base_credit_microdollars_per_pass: 49_000_000,
          bonus_credit_microdollars_per_pass: 12_000_000,
          unlock_spend_microdollars_per_pass: 49_000_000,
          bonus_mode: KiloPassOrgBonusMode.AfterBase,
        })
        .returning({ id: kilo_pass_org_term_versions.id });
      const [agreement] = await db
        .insert(kilo_pass_org_agreements)
        .values({
          parent_organization_id: parent.id,
          term_version_id: term.id,
          state: 'active',
          processing_condition: 'ready',
          purchase_channel: 'self_serve',
          cadence: KiloPassCadence.Yearly,
          purchased_pass_capacity: 4,
          issuance_anchor_at: new Date().toISOString(),
          provider_subscription_id: 'sub_admin_summary',
          provider_seat_add_on_item_id: 'si_admin_summary',
        })
        .returning({ id: kilo_pass_org_agreements.id });

      try {
        const caller = await createCallerForUser(adminUser.id);
        await expect(
          caller.organizations.admin.getKiloPassSummary({ organizationId: child.id })
        ).resolves.toMatchObject({
          managedByOrganization: { id: parent.id, name: parent.name },
          agreement: {
            state: 'active',
            processingCondition: 'ready',
            tier: KiloPassTier.Tier49,
            cadence: KiloPassCadence.Yearly,
            purchasedPassCapacity: 4,
            providerSubscriptionId: 'sub_admin_summary',
            providerSeatAddOnItemId: 'si_admin_summary',
          },
        });
      } finally {
        await db
          .delete(kilo_pass_org_agreements)
          .where(eq(kilo_pass_org_agreements.id, agreement.id));
        await db
          .delete(kilo_pass_org_term_versions)
          .where(eq(kilo_pass_org_term_versions.id, term.id));
        await db
          .update(organizations)
          .set({ parent_organization_id: null })
          .where(eq(organizations.id, child.id));
        await db
          .delete(organization_memberships)
          .where(inArray(organization_memberships.organization_id, [parent.id, child.id]));
        await db.delete(organizations).where(inArray(organizations.id, [parent.id, child.id]));
      }
    });
  });
});
