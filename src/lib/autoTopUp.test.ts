import { cleanupDbForTest, db } from '@/lib/drizzle';
import { auto_top_up_configs, kilocode_users, organizations } from '@/db/schema';
import type { User, Organization } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { createOrganization } from '@/lib/organizations/organizations';
import { maybePerformAutoTopUp, maybePerformOrganizationAutoTopUp } from '@/lib/autoTopUp';
import {
  AUTO_TOP_UP_THRESHOLD_DOLLARS,
  ORG_AUTO_TOP_UP_THRESHOLD_DOLLARS,
} from '@/lib/autoTopUpConstants';
import type { UserForBalance } from '@/lib/UserForBalance';
import {
  credit_transactions,
  kilo_pass_issuance_items,
  kilo_pass_issuances,
  kilo_pass_subscriptions,
} from '@/db/schema';
import {
  KiloPassCadence,
  KiloPassIssuanceItemKind,
  type KiloPassIssuanceSource,
  KiloPassTier,
} from '@/lib/kilo-pass/enums';
import crypto from 'node:crypto';

// Convert dollars to microdollars
const toMicrodollars = (dollars: number) => dollars * 1_000_000;

// Mock email sending to avoid CustomerIO errors in tests
jest.mock('@/lib/email', () => ({
  sendAutoTopUpFailedEmail: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@/lib/stripe-client', () => {
  return {
    client: {
      invoices: {
        create: jest.fn(function (this: void) {}),
        pay: jest.fn(function (this: void) {}),
      },
      invoiceItems: {
        create: jest.fn(function (this: void) {}),
      },
    },
  };
});

// Helper to create UserForBalance from test user
function toUserForBalance(user: User): UserForBalance {
  return {
    id: user.id,
    total_microdollars_acquired: user.total_microdollars_acquired,
    microdollars_used: user.microdollars_used,
    next_credit_expiration_at: user.next_credit_expiration_at,
    updated_at: user.updated_at,
    auto_top_up_enabled: user.auto_top_up_enabled,
  };
}

describe('autoTopUp', () => {
  let testUser: User;
  let testOrg: Organization;
  let orgOwner: User;

  beforeAll(async () => {
    // Create test user for user auto-top-up tests
    testUser = await insertTestUser({
      google_user_email: `auto-topup-test-${Date.now()}@example.com`,
      google_user_name: 'Auto TopUp Test User',
      stripe_customer_id: `cus_test_${Date.now()}`,
      auto_top_up_enabled: false,
      total_microdollars_acquired: 0,
      microdollars_used: 0,
    });

    // Create test org owner
    orgOwner = await insertTestUser({
      google_user_email: `org-owner-${Date.now()}@example.com`,
      google_user_name: 'Org Owner',
      stripe_customer_id: `cus_org_owner_${Date.now()}`,
    });

    // Create test organization
    testOrg = await createOrganization('Auto TopUp Test Org', orgOwner.id);
    await db
      .update(organizations)
      .set({
        stripe_customer_id: `cus_org_${Date.now()}`,
        auto_top_up_enabled: false,
      })
      .where(eq(organizations.id, testOrg.id));
  });

  afterAll(async () => {
    // Cleanup
    if (testUser?.id) {
      await db
        .delete(auto_top_up_configs)
        .where(eq(auto_top_up_configs.owned_by_user_id, testUser.id));
    }
    if (testOrg?.id) {
      await db
        .delete(auto_top_up_configs)
        .where(eq(auto_top_up_configs.owned_by_organization_id, testOrg.id));
      await db.delete(organizations).where(eq(organizations.id, testOrg.id));
    }
  });

  describe('maybePerformAutoTopUp (user)', () => {
    beforeEach(async () => {
      // Reset user state before each test
      await db
        .update(kilocode_users)
        .set({
          auto_top_up_enabled: false,
          total_microdollars_acquired: 0,
          microdollars_used: 0,
        })
        .where(eq(kilocode_users.id, testUser.id));
      await db
        .delete(auto_top_up_configs)
        .where(eq(auto_top_up_configs.owned_by_user_id, testUser.id));
    });

    it('does nothing when auto_top_up_enabled is false', async () => {
      const user = toUserForBalance({
        ...testUser,
        auto_top_up_enabled: false,
        total_microdollars_acquired: 0,
        microdollars_used: 0,
      });

      await maybePerformAutoTopUp(user);

      // Verify no config was created
      const config = await db.query.auto_top_up_configs.findFirst({
        where: eq(auto_top_up_configs.owned_by_user_id, testUser.id),
      });
      expect(config).toBeUndefined();
    });

    it('does nothing when balance is above threshold', async () => {
      const balanceAboveThreshold = toMicrodollars(AUTO_TOP_UP_THRESHOLD_DOLLARS + 10);
      const user = toUserForBalance({
        ...testUser,
        auto_top_up_enabled: true,
        total_microdollars_acquired: balanceAboveThreshold,
        microdollars_used: 0,
      });

      await maybePerformAutoTopUp(user);

      // Verify no config was created (no lock acquired)
      const config = await db.query.auto_top_up_configs.findFirst({
        where: eq(auto_top_up_configs.owned_by_user_id, testUser.id),
      });
      expect(config).toBeUndefined();
    });

    it('disables auto-top-up when no config exists (no payment method saved)', async () => {
      // Enable auto-top-up on user but don't create config
      await db
        .update(kilocode_users)
        .set({ auto_top_up_enabled: true })
        .where(eq(kilocode_users.id, testUser.id));

      const user = toUserForBalance({
        ...testUser,
        auto_top_up_enabled: true,
        total_microdollars_acquired: 0,
        microdollars_used: 0,
      });

      await maybePerformAutoTopUp(user);

      // Verify auto_top_up_enabled was set to false
      const updatedUser = await db.query.kilocode_users.findFirst({
        where: eq(kilocode_users.id, testUser.id),
      });
      expect(updatedUser?.auto_top_up_enabled).toBe(false);
    });

    it('returns concurrent_attempt_in_progress when lock is held', async () => {
      // Create config with recent attempt_started_at (lock held)
      await db.insert(auto_top_up_configs).values({
        owned_by_user_id: testUser.id,
        stripe_payment_method_id: 'pm_test_123',
        amount_cents: 5000,
        attempt_started_at: new Date().toISOString(), // Lock is held
      });

      await db
        .update(kilocode_users)
        .set({ auto_top_up_enabled: true })
        .where(eq(kilocode_users.id, testUser.id));

      const user = toUserForBalance({
        ...testUser,
        auto_top_up_enabled: true,
        total_microdollars_acquired: 0,
        microdollars_used: 0,
      });

      // This should return early due to concurrent attempt
      await maybePerformAutoTopUp(user);

      // Verify the lock is still held (attempt_started_at not cleared)
      const config = await db.query.auto_top_up_configs.findFirst({
        where: eq(auto_top_up_configs.owned_by_user_id, testUser.id),
      });
      expect(config?.attempt_started_at).not.toBeNull();
    });

    // Note: Testing no_stripe_customer_id scenario is difficult because stripe_customer_id is NOT NULL in schema.
    // In practice, this would only happen if the column constraint was removed or data was corrupted.
    // The code handles this case, but we skip testing it to avoid violating DB constraints.

    it('releases lock after balance becomes sufficient', async () => {
      // Create config
      await db.insert(auto_top_up_configs).values({
        owned_by_user_id: testUser.id,
        stripe_payment_method_id: 'pm_test_123',
        amount_cents: 5000,
      });

      // Enable auto-top-up with low balance initially
      await db
        .update(kilocode_users)
        .set({
          auto_top_up_enabled: true,
          total_microdollars_acquired: 0,
          microdollars_used: 0,
        })
        .where(eq(kilocode_users.id, testUser.id));

      // Increase balance above threshold BEFORE calling auto-top-up
      // This simulates a race condition where balance increases between the initial check and lock acquisition
      await db
        .update(kilocode_users)
        .set({
          total_microdollars_acquired: toMicrodollars(AUTO_TOP_UP_THRESHOLD_DOLLARS + 10),
        })
        .where(eq(kilocode_users.id, testUser.id));

      const user = toUserForBalance({
        ...testUser,
        auto_top_up_enabled: true,
        total_microdollars_acquired: 0, // Pass old balance to trigger the check
        microdollars_used: 0,
      });

      // Call auto-top-up - it should acquire lock, re-check balance, and release lock
      await maybePerformAutoTopUp(user);

      // Verify lock was released
      const config = await db.query.auto_top_up_configs.findFirst({
        where: eq(auto_top_up_configs.owned_by_user_id, testUser.id),
      });
      expect(config?.attempt_started_at).toBeNull();

      // Verify auto-top-up is still enabled (not disabled)
      const updatedUser = await db.query.kilocode_users.findFirst({
        where: eq(kilocode_users.id, testUser.id),
      });
      expect(updatedUser?.auto_top_up_enabled).toBe(true);
    });
  });

  describe('maybePerformOrganizationAutoTopUp', () => {
    beforeEach(async () => {
      // Reset org state before each test
      await db
        .update(organizations)
        .set({
          auto_top_up_enabled: false,
        })
        .where(eq(organizations.id, testOrg.id));
      await db
        .delete(auto_top_up_configs)
        .where(eq(auto_top_up_configs.owned_by_organization_id, testOrg.id));
    });

    it('does nothing when auto_top_up_enabled is false', async () => {
      const org = {
        id: testOrg.id,
        auto_top_up_enabled: false,
        total_microdollars_acquired: 0,
        microdollars_used: 0,
      };

      await maybePerformOrganizationAutoTopUp(org);

      // Verify no config was created
      const config = await db.query.auto_top_up_configs.findFirst({
        where: eq(auto_top_up_configs.owned_by_organization_id, testOrg.id),
      });
      expect(config).toBeUndefined();
    });

    it('does nothing when balance is above threshold', async () => {
      const balanceAboveThreshold = toMicrodollars(AUTO_TOP_UP_THRESHOLD_DOLLARS + 10);
      const org = {
        id: testOrg.id,
        auto_top_up_enabled: true,
        total_microdollars_acquired: balanceAboveThreshold,
        microdollars_used: 0,
      };

      await maybePerformOrganizationAutoTopUp(org);

      // Verify no config was created (no lock acquired)
      const config = await db.query.auto_top_up_configs.findFirst({
        where: eq(auto_top_up_configs.owned_by_organization_id, testOrg.id),
      });
      expect(config).toBeUndefined();
    });

    it('disables auto-top-up when no config exists (no payment method saved)', async () => {
      // Enable auto-top-up on org but don't create config
      await db
        .update(organizations)
        .set({ auto_top_up_enabled: true })
        .where(eq(organizations.id, testOrg.id));

      const org = {
        id: testOrg.id,
        auto_top_up_enabled: true,
        total_microdollars_acquired: 0,
        microdollars_used: 0,
      };

      await maybePerformOrganizationAutoTopUp(org);

      // Verify auto_top_up_enabled was set to false
      const updatedOrg = await db.query.organizations.findFirst({
        where: eq(organizations.id, testOrg.id),
      });
      expect(updatedOrg?.auto_top_up_enabled).toBe(false);
    });

    it('returns concurrent_attempt_in_progress when lock is held', async () => {
      // Create config with recent attempt_started_at (lock held)
      await db.insert(auto_top_up_configs).values({
        owned_by_organization_id: testOrg.id,
        stripe_payment_method_id: 'pm_test_org_123',
        amount_cents: 5000,
        attempt_started_at: new Date().toISOString(), // Lock is held
      });

      await db
        .update(organizations)
        .set({ auto_top_up_enabled: true })
        .where(eq(organizations.id, testOrg.id));

      const org = {
        id: testOrg.id,
        auto_top_up_enabled: true,
        total_microdollars_acquired: 0,
        microdollars_used: 0,
      };

      // This should return early due to concurrent attempt
      await maybePerformOrganizationAutoTopUp(org);

      // Verify the lock is still held (attempt_started_at not cleared)
      const config = await db.query.auto_top_up_configs.findFirst({
        where: eq(auto_top_up_configs.owned_by_organization_id, testOrg.id),
      });
      expect(config?.attempt_started_at).not.toBeNull();
    });

    it('disables auto-top-up when org has no stripe_customer_id', async () => {
      // Create config for org
      await db.insert(auto_top_up_configs).values({
        owned_by_organization_id: testOrg.id,
        stripe_payment_method_id: 'pm_test_org_123',
        amount_cents: 5000,
      });

      // Enable auto-top-up
      await db
        .update(organizations)
        .set({ auto_top_up_enabled: true })
        .where(eq(organizations.id, testOrg.id));

      // Remove stripe_customer_id (organizations.stripe_customer_id is nullable)
      await db
        .update(organizations)
        .set({ stripe_customer_id: null })
        .where(eq(organizations.id, testOrg.id));

      const org = {
        id: testOrg.id,
        auto_top_up_enabled: true,
        total_microdollars_acquired: 0,
        microdollars_used: 0,
      };

      await maybePerformOrganizationAutoTopUp(org);

      // Verify auto_top_up_enabled was set to false
      const updatedOrg = await db.query.organizations.findFirst({
        where: eq(organizations.id, testOrg.id),
      });
      expect(updatedOrg?.auto_top_up_enabled).toBe(false);

      // Verify disabled_reason was set
      const config = await db.query.auto_top_up_configs.findFirst({
        where: eq(auto_top_up_configs.owned_by_organization_id, testOrg.id),
      });
      expect(config?.disabled_reason).toBe('no_stripe_customer');
    });

    it('releases lock after balance becomes sufficient', async () => {
      // Create config
      await db.insert(auto_top_up_configs).values({
        owned_by_organization_id: testOrg.id,
        stripe_payment_method_id: 'pm_test_org_123',
        amount_cents: 5000,
      });

      // Enable auto-top-up with low balance initially
      await db
        .update(organizations)
        .set({
          auto_top_up_enabled: true,
        })
        .where(eq(organizations.id, testOrg.id));

      // Increase balance above threshold BEFORE calling auto-top-up
      // This simulates a race condition where balance increases between the initial check and lock acquisition
      const aboveThreshold = toMicrodollars(ORG_AUTO_TOP_UP_THRESHOLD_DOLLARS + 10);
      await db
        .update(organizations)
        .set({
          total_microdollars_acquired: aboveThreshold,
        })
        .where(eq(organizations.id, testOrg.id));

      const org = {
        id: testOrg.id,
        auto_top_up_enabled: true,
        total_microdollars_acquired: 0,
        microdollars_used: 0,
      };

      // Call auto-top-up - it should acquire lock, re-check balance, and release lock
      await maybePerformOrganizationAutoTopUp(org);

      // Verify lock was released
      const config = await db.query.auto_top_up_configs.findFirst({
        where: eq(auto_top_up_configs.owned_by_organization_id, testOrg.id),
      });
      expect(config?.attempt_started_at).toBeNull();

      // Verify auto-top-up is still enabled (not disabled)
      const updatedOrg = await db.query.organizations.findFirst({
        where: eq(organizations.id, testOrg.id),
      });
      expect(updatedOrg?.auto_top_up_enabled).toBe(true);
    });
  });

  describe('balance threshold checks', () => {
    beforeEach(async () => {
      await db
        .update(organizations)
        .set({ auto_top_up_enabled: false })
        .where(eq(organizations.id, testOrg.id));
      await db
        .delete(auto_top_up_configs)
        .where(eq(auto_top_up_configs.owned_by_organization_id, testOrg.id));
    });

    it('triggers auto-top-up at exactly threshold - 0.01', async () => {
      const justBelowThreshold = toMicrodollars(ORG_AUTO_TOP_UP_THRESHOLD_DOLLARS - 0.01);

      await db
        .update(organizations)
        .set({ auto_top_up_enabled: true })
        .where(eq(organizations.id, testOrg.id));

      const org = {
        id: testOrg.id,
        auto_top_up_enabled: true,
        total_microdollars_acquired: justBelowThreshold,
        microdollars_used: 0,
      };

      await maybePerformOrganizationAutoTopUp(org);

      // Should have attempted (and failed due to no config), disabling auto-top-up
      const updatedOrg = await db.query.organizations.findFirst({
        where: eq(organizations.id, testOrg.id),
      });
      expect(updatedOrg?.auto_top_up_enabled).toBe(false);
    });

    it('does not trigger auto-top-up at exactly threshold', async () => {
      const exactlyAtThreshold = toMicrodollars(ORG_AUTO_TOP_UP_THRESHOLD_DOLLARS);

      const org = {
        id: testOrg.id,
        auto_top_up_enabled: true,
        total_microdollars_acquired: exactlyAtThreshold,
        microdollars_used: 0,
      };

      // Reset org state
      await db
        .update(organizations)
        .set({ auto_top_up_enabled: true })
        .where(eq(organizations.id, testOrg.id));

      await maybePerformOrganizationAutoTopUp(org);

      // Should NOT have attempted - auto_top_up_enabled should still be true
      const updatedOrg = await db.query.organizations.findFirst({
        where: eq(organizations.id, testOrg.id),
      });
      expect(updatedOrg?.auto_top_up_enabled).toBe(true);
    });
  });
});

describe('maybePerformAutoTopUp with Kilo Pass', () => {
  beforeEach(async () => {
    await cleanupDbForTest();
    jest.clearAllMocks();
  });

  test('does not trigger auto top up when user has active Kilo Pass and bonus credits are not yet received for current period', async () => {
    const user = await insertTestUser({
      auto_top_up_enabled: true,
      total_microdollars_acquired: 0,
      microdollars_used: 10_000_000, // -$10 balance (below $5 threshold)
    });

    await db.insert(auto_top_up_configs).values({
      owned_by_user_id: user.id,
      stripe_payment_method_id: 'pm_test_123',
      amount_cents: 5000,
      disabled_reason: null,
    });

    await db.insert(kilo_pass_subscriptions).values({
      kilo_user_id: user.id,
      stripe_subscription_id: `sub_test_${Math.random()}`,
      tier: KiloPassTier.Tier19,
      cadence: KiloPassCadence.Monthly,
      status: 'active',
      cancel_at_period_end: false,
      started_at: new Date('2026-01-01T00:00:00.000Z').toISOString(),
      ended_at: null,
      current_streak_months: 1,
      next_yearly_issue_at: null,
    });

    const { client } = await import('@/lib/stripe-client');
    const { maybePerformAutoTopUp } = await import('@/lib/autoTopUp');

    await maybePerformAutoTopUp(user);

    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(client.invoices.create).not.toHaveBeenCalled();
  });

  test('triggers auto top up when user has active Kilo Pass and bonus credits are already received for current period', async () => {
    const user = await insertTestUser({
      auto_top_up_enabled: true,
      total_microdollars_acquired: 0,
      microdollars_used: 10_000_000, // -$10 balance (below $5 threshold)
    });

    await db.insert(auto_top_up_configs).values({
      owned_by_user_id: user.id,
      stripe_payment_method_id: 'pm_test_123',
      amount_cents: 5000,
      disabled_reason: null,
    });

    const stripeSubscriptionId = `sub_test_${Math.random()}`;
    const insertedSub = await db
      .insert(kilo_pass_subscriptions)
      .values({
        kilo_user_id: user.id,
        stripe_subscription_id: stripeSubscriptionId,
        tier: KiloPassTier.Tier19,
        cadence: KiloPassCadence.Monthly,
        status: 'active',
        cancel_at_period_end: false,
        started_at: new Date('2026-01-01T00:00:00.000Z').toISOString(),
        ended_at: null,
        current_streak_months: 1,
        next_yearly_issue_at: null,
      })
      .returning({ id: kilo_pass_subscriptions.id });

    const subscriptionId = insertedSub[0]?.id;
    if (!subscriptionId) throw new Error('Failed to create kilo_pass_subscriptions row');

    const insertedIssuance = await db
      .insert(kilo_pass_issuances)
      .values({
        kilo_pass_subscription_id: subscriptionId,
        issue_month: '2026-01-01',
        source: 'cron' as KiloPassIssuanceSource,
        stripe_invoice_id: null,
      })
      .returning({ id: kilo_pass_issuances.id });

    const issuanceId = insertedIssuance[0]?.id;
    if (!issuanceId) throw new Error('Failed to create kilo_pass_issuances row');

    const creditTxId = crypto.randomUUID();
    await db.insert(credit_transactions).values({
      id: creditTxId,
      kilo_user_id: user.id,
      amount_microdollars: 1000,
      is_free: true,
      description: 'test bonus credit tx',
      original_baseline_microdollars_used: user.microdollars_used,
      stripe_payment_id: `pi_test_${Math.random()}`,
      created_at: new Date().toISOString(),
      organization_id: null,
      check_category_uniqueness: false,
    });

    await db.insert(kilo_pass_issuance_items).values({
      kilo_pass_issuance_id: issuanceId,
      kind: KiloPassIssuanceItemKind.Bonus,
      credit_transaction_id: creditTxId,
      amount_usd: 1,
      bonus_percent_applied: 0.1,
    });

    const { client } = await import('@/lib/stripe-client');
    (client.invoices.create as jest.Mock).mockResolvedValue({ id: 'inv_test_1' });
    (client.invoiceItems.create as jest.Mock).mockResolvedValue({ id: 'ii_test_1' });
    (client.invoices.pay as jest.Mock).mockResolvedValue({ status: 'paid' });

    const { maybePerformAutoTopUp } = await import('@/lib/autoTopUp');

    await maybePerformAutoTopUp(user);

    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(client.invoices.create).toHaveBeenCalledTimes(1);
  });
});
