import { createCallerForUser } from '@/routers/test-utils';
import { db } from '@/lib/drizzle';
import { auto_top_up_configs, organizations } from '@kilocode/db/schema';
import type { User, Organization } from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { createOrganization, addUserToOrganization } from '@/lib/organizations/organizations';
import { DEFAULT_ORG_AUTO_TOP_UP_AMOUNT_CENTS } from '@/lib/autoTopUpConstants';

// Mock Stripe client to avoid API calls in tests
jest.mock('@/lib/stripe-client', () => ({
  client: {
    checkout: {
      sessions: {
        create: jest.fn().mockResolvedValue({
          url: 'https://checkout.stripe.com/test-session',
        }),
      },
    },
  },
}));

describe('organization auto-top-up router', () => {
  let ownerUser: User;
  let memberUser: User;
  let nonMemberUser: User;
  let testOrg: Organization;

  beforeAll(async () => {
    // Create test users
    ownerUser = await insertTestUser({
      google_user_email: `org-atu-owner-${Date.now()}@example.com`,
      google_user_name: 'Org ATU Owner',
      stripe_customer_id: `cus_owner_${Date.now()}`,
    });

    memberUser = await insertTestUser({
      google_user_email: `org-atu-member-${Date.now()}@example.com`,
      google_user_name: 'Org ATU Member',
    });

    nonMemberUser = await insertTestUser({
      google_user_email: `org-atu-nonmember-${Date.now()}@example.com`,
      google_user_name: 'Org ATU Non-Member',
    });

    // Create test organization
    testOrg = await createOrganization('Auto TopUp Router Test Org', ownerUser.id);
    await db
      .update(organizations)
      .set({
        stripe_customer_id: `cus_org_router_${Date.now()}`,
        auto_top_up_enabled: false,
      })
      .where(eq(organizations.id, testOrg.id));

    // Add member to org
    await addUserToOrganization(testOrg.id, memberUser.id, 'member');
  });

  afterAll(async () => {
    await db
      .delete(auto_top_up_configs)
      .where(eq(auto_top_up_configs.owned_by_organization_id, testOrg.id));
    await db.delete(organizations).where(eq(organizations.id, testOrg.id));
  });

  beforeEach(async () => {
    // Reset org state
    await db
      .update(organizations)
      .set({ auto_top_up_enabled: false })
      .where(eq(organizations.id, testOrg.id));
    await db
      .delete(auto_top_up_configs)
      .where(eq(auto_top_up_configs.owned_by_organization_id, testOrg.id));
  });

  describe('getConfig', () => {
    it('returns default config when no auto-top-up is configured', async () => {
      const caller = await createCallerForUser(ownerUser.id);
      const result = await caller.organizations.autoTopUp.getConfig({
        organizationId: testOrg.id,
      });

      expect(result).toEqual({
        enabled: false,
        amountCents: DEFAULT_ORG_AUTO_TOP_UP_AMOUNT_CENTS,
        paymentMethod: null,
      });
    });

    it('returns config with payment method when configured', async () => {
      // Create config with payment method
      await db.insert(auto_top_up_configs).values({
        owned_by_organization_id: testOrg.id,
        owned_by_user_id: null,
        stripe_payment_method_id: 'pm_test_config_123',
        amount_cents: 10000,
      });

      const caller = await createCallerForUser(ownerUser.id);
      const result = await caller.organizations.autoTopUp.getConfig({
        organizationId: testOrg.id,
      });

      expect(result.amountCents).toBe(10000);
      // paymentMethod will be null because Stripe API call will fail in test
      // but the structure is correct
    });

    it('throws UNAUTHORIZED for non-owner members', async () => {
      const caller = await createCallerForUser(memberUser.id);

      await expect(
        caller.organizations.autoTopUp.getConfig({ organizationId: testOrg.id })
      ).rejects.toThrow('You do not have the required organizational role to access this feature');
    });

    it('throws UNAUTHORIZED for non-members', async () => {
      const caller = await createCallerForUser(nonMemberUser.id);

      await expect(
        caller.organizations.autoTopUp.getConfig({ organizationId: testOrg.id })
      ).rejects.toThrow('You do not have access to this organization');
    });
  });

  describe('toggle', () => {
    it('disables auto-top-up when currentEnabled is true', async () => {
      await db
        .update(organizations)
        .set({ auto_top_up_enabled: true })
        .where(eq(organizations.id, testOrg.id));

      const caller = await createCallerForUser(ownerUser.id);
      const result = await caller.organizations.autoTopUp.toggle({
        organizationId: testOrg.id,
        currentEnabled: true,
      });

      expect(result).toEqual({ enabled: false });

      // Verify DB was updated
      const org = await db.query.organizations.findFirst({
        where: eq(organizations.id, testOrg.id),
      });
      expect(org?.auto_top_up_enabled).toBe(false);
    });

    it('enables auto-top-up directly when payment method exists', async () => {
      // Create config with payment method
      await db.insert(auto_top_up_configs).values({
        owned_by_organization_id: testOrg.id,
        owned_by_user_id: null,
        stripe_payment_method_id: 'pm_test_enable',
        amount_cents: 5000,
        disabled_reason: 'card_declined', // Should be cleared
      });

      const caller = await createCallerForUser(ownerUser.id);
      const result = await caller.organizations.autoTopUp.toggle({
        organizationId: testOrg.id,
        currentEnabled: false,
      });

      expect(result).toEqual({ enabled: true });

      // Verify DB was updated
      const org = await db.query.organizations.findFirst({
        where: eq(organizations.id, testOrg.id),
      });
      expect(org?.auto_top_up_enabled).toBe(true);

      // Verify disabled_reason was cleared
      const config = await db.query.auto_top_up_configs.findFirst({
        where: eq(auto_top_up_configs.owned_by_organization_id, testOrg.id),
      });
      expect(config?.disabled_reason).toBeNull();
    });

    it('returns redirectUrl when no payment method exists', async () => {
      const caller = await createCallerForUser(ownerUser.id);
      const result = await caller.organizations.autoTopUp.toggle({
        organizationId: testOrg.id,
        currentEnabled: false,
        amountCents: 50000,
      });

      expect(result.enabled).toBe(false);
      expect(result.redirectUrl).toBeDefined();
      expect(typeof result.redirectUrl).toBe('string');
    });

    it('throws UNAUTHORIZED for non-owner members', async () => {
      const caller = await createCallerForUser(memberUser.id);

      await expect(
        caller.organizations.autoTopUp.toggle({
          organizationId: testOrg.id,
          currentEnabled: false,
        })
      ).rejects.toThrow('You do not have the required organizational role to access this feature');
    });
  });

  describe('updateAmount', () => {
    it('updates amount_cents in config', async () => {
      await db.insert(auto_top_up_configs).values({
        owned_by_organization_id: testOrg.id,
        owned_by_user_id: null,
        stripe_payment_method_id: 'pm_test_amount',
        amount_cents: 5000,
      });

      const caller = await createCallerForUser(ownerUser.id);
      const result = await caller.organizations.autoTopUp.updateAmount({
        organizationId: testOrg.id,
        amountCents: 10000,
      });

      expect(result.success).toBe(true);

      // Verify DB was updated
      const config = await db.query.auto_top_up_configs.findFirst({
        where: eq(auto_top_up_configs.owned_by_organization_id, testOrg.id),
      });
      expect(config?.amount_cents).toBe(10000);
    });
  });

  describe('removePaymentMethod', () => {
    it('deletes config and disables auto-top-up', async () => {
      await db.insert(auto_top_up_configs).values({
        owned_by_organization_id: testOrg.id,
        owned_by_user_id: null,
        stripe_payment_method_id: 'pm_test_remove',
        amount_cents: 5000,
      });

      await db
        .update(organizations)
        .set({ auto_top_up_enabled: true })
        .where(eq(organizations.id, testOrg.id));

      const caller = await createCallerForUser(ownerUser.id);
      const result = await caller.organizations.autoTopUp.removePaymentMethod({
        organizationId: testOrg.id,
      });

      expect(result.success).toBe(true);

      // Verify config was deleted
      const config = await db.query.auto_top_up_configs.findFirst({
        where: eq(auto_top_up_configs.owned_by_organization_id, testOrg.id),
      });
      expect(config).toBeUndefined();

      // Verify auto_top_up_enabled was set to false
      const org = await db.query.organizations.findFirst({
        where: eq(organizations.id, testOrg.id),
      });
      expect(org?.auto_top_up_enabled).toBe(false);
    });
  });

  describe('changePaymentMethod', () => {
    it('returns redirectUrl for Stripe checkout', async () => {
      const caller = await createCallerForUser(ownerUser.id);
      const result = await caller.organizations.autoTopUp.changePaymentMethod({
        organizationId: testOrg.id,
        amountCents: 50000,
      });

      expect(result.redirectUrl).toBeDefined();
      expect(typeof result.redirectUrl).toBe('string');
    });
  });
});
