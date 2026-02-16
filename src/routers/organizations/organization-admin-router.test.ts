import { createCallerForUser } from '@/routers/test-utils';
import { db } from '@/lib/drizzle';
import { organizations, credit_transactions } from '@/db/schema';
import { eq, and } from 'drizzle-orm';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { createOrganization } from '@/lib/organizations/organizations';
import type { User, Organization } from '@/db/schema';

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
});
