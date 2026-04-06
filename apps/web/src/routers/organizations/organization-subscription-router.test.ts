import { beforeEach, jest } from '@jest/globals';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { createOrganization, addUserToOrganization } from '@/lib/organizations/organizations';
import { db } from '@/lib/drizzle';
import { organization_seats_purchases } from '@kilocode/db/schema';
import type { User, Organization } from '@kilocode/db/schema';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyMock = jest.Mock<(...args: any[]) => any>;

jest.mock('@/lib/stripe-client', () => {
  const stripeMock = {
    billingPortal: { sessions: { create: jest.fn() } },
    invoices: { list: jest.fn() },
    checkout: { sessions: { create: jest.fn() } },
    createStripeCustomer: jest.fn(async () => ({ id: 'cus_test_org' })),
  };

  return {
    client: stripeMock,
    createStripeCustomer: stripeMock.createStripeCustomer,
    __stripeMock: stripeMock,
  };
});

type StripeMock = {
  billingPortal: { sessions: { create: AnyMock } };
  invoices: { list: AnyMock };
  checkout: { sessions: { create: AnyMock } };
  createStripeCustomer: AnyMock;
};

const stripeMock = jest.requireMock<{ __stripeMock: StripeMock }>(
  '@/lib/stripe-client'
).__stripeMock;

// Test users and organization will be created dynamically
let regularUser: User;
let _adminUser: User;
let memberUser: User;
let _nonMemberUser: User;
let testOrganization: Organization;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let createCallerForUser: (userId: string) => Promise<any>;

describe('organizations subscription trpc router', () => {
  beforeAll(async () => {
    ({ createCallerForUser } = await import('@/routers/test-utils'));
    // Create test users using the helper function (no hardcoded emails to avoid cross-run collisions)
    regularUser = await insertTestUser({
      google_user_name: 'Regular Subscription User',
      is_admin: false,
    });

    _adminUser = await insertTestUser({
      google_user_name: 'Admin Subscription User',
      is_admin: true,
    });

    memberUser = await insertTestUser({
      google_user_name: 'Member Subscription User',
      is_admin: false,
    });

    _nonMemberUser = await insertTestUser({
      google_user_name: 'Non Member Subscription User',
      is_admin: false,
    });

    // Create test organization using the CRUD method
    testOrganization = await createOrganization('Test Subscription Organization', regularUser.id);

    // Add member user to organization using CRUD method
    await addUserToOrganization(testOrganization.id, memberUser.id, 'member');
  });

  beforeEach(() => {
    stripeMock.billingPortal.sessions.create.mockReset();
    stripeMock.billingPortal.sessions.create.mockResolvedValue({
      url: 'https://stripe.example.test/portal',
    });
    stripeMock.invoices.list.mockReset();
    stripeMock.invoices.list.mockResolvedValue({ data: [], has_more: false });
    stripeMock.checkout.sessions.create.mockReset();
    stripeMock.checkout.sessions.create.mockResolvedValue({
      url: 'https://stripe.example.test/checkout',
    });
    stripeMock.createStripeCustomer.mockReset();
    stripeMock.createStripeCustomer.mockImplementation(async () => ({ id: 'cus_test_org' }));
  });

  describe('get procedure', () => {
    it('rejects non-owner members from reading subscription details', async () => {
      const caller = await createCallerForUser(memberUser.id);
      await expect(
        caller.organizations.subscription.get({
          organizationId: testOrganization.id,
        })
      ).rejects.toThrow('You do not have the required organizational role to access this feature');
    });

    it('should validate input schema', async () => {
      const caller = await createCallerForUser(regularUser.id);

      // Test invalid UUID
      await expect(
        caller.organizations.subscription.get({
          organizationId: 'invalid-uuid',
        })
      ).rejects.toThrow();
    });
  });

  describe('getSubscriptionStripeUrl procedure', () => {
    it('should throw UNAUTHORIZED error for non-owner members', async () => {
      const caller = await createCallerForUser(memberUser.id);

      await expect(
        caller.organizations.subscription.getSubscriptionStripeUrl({
          organizationId: testOrganization.id,
          seats: 1,
          cancelUrl: 'https://example.com',
          billingCycle: 'annual',
        })
      ).rejects.toThrow('You do not have the required organizational role to access this feature');
    });

    it('should throw UNAUTHORIZED error for non-member users', async () => {
      const caller = await createCallerForUser(_nonMemberUser.id);

      await expect(
        caller.organizations.subscription.getSubscriptionStripeUrl({
          organizationId: testOrganization.id,
          seats: 1,
          cancelUrl: 'https://example.com',
          billingCycle: 'annual',
        })
      ).rejects.toThrow('You do not have access to this organization');
    });

    it('should accept billingCycle parameter without validation error', async () => {
      const caller = await createCallerForUser(regularUser.id);

      // The call will fail because there's no Stripe customer, but it should NOT
      // fail on input validation — billingCycle: 'monthly' is a valid schema value.
      const result = caller.organizations.subscription.getSubscriptionStripeUrl({
        organizationId: testOrganization.id,
        seats: 1,
        cancelUrl: 'https://example.com',
        billingCycle: 'monthly',
      });

      // Should pass input validation (no ZodError / BAD_REQUEST), then fail downstream
      await expect(result).rejects.not.toThrow(/ZodError/);
    });

    it('should reject requests without billingCycle', async () => {
      const caller = await createCallerForUser(regularUser.id);

      // billingCycle is required (Seat Purchase 2) — omitting it must fail validation.
      const result = caller.organizations.subscription.getSubscriptionStripeUrl({
        organizationId: testOrganization.id,
        seats: 1,
        cancelUrl: 'https://example.com',
      });

      await expect(result).rejects.toThrow();
    });
  });

  describe('cancel procedure', () => {
    it('should throw UNAUTHORIZED error for non-owner users', async () => {
      const caller = await createCallerForUser(memberUser.id);

      await expect(
        caller.organizations.subscription.cancel({
          organizationId: testOrganization.id,
        })
      ).rejects.toThrow('You do not have the required organizational role to access this feature');
    });
  });

  describe('stopCancellation procedure', () => {
    it('should throw UNAUTHORIZED error for non-owner users', async () => {
      const caller = await createCallerForUser(memberUser.id);

      await expect(
        caller.organizations.subscription.stopCancellation({
          organizationId: testOrganization.id,
        })
      ).rejects.toThrow('You do not have the required organizational role to access this feature');
    });

    it('should validate input schema', async () => {
      const caller = await createCallerForUser(regularUser.id);

      // Test invalid UUID
      await expect(
        caller.organizations.subscription.stopCancellation({
          organizationId: 'invalid-uuid',
        })
      ).rejects.toThrow();
    });
  });

  describe('updateSeatCount procedure', () => {
    it('should throw UNAUTHORIZED error for non-owner users', async () => {
      const caller = await createCallerForUser(memberUser.id);

      await expect(
        caller.organizations.subscription.updateSeatCount({
          organizationId: testOrganization.id,
          newSeatCount: 10,
        })
      ).rejects.toThrow('You do not have the required organizational role to access this feature');
    });

    it('should validate input schema', async () => {
      const caller = await createCallerForUser(regularUser.id);

      // Test invalid UUID
      await expect(
        caller.organizations.subscription.updateSeatCount({
          organizationId: 'invalid-uuid',
          newSeatCount: 10,
        })
      ).rejects.toThrow();
    });

    it('should validate newSeatCount is a positive integer', async () => {
      const caller = await createCallerForUser(regularUser.id);

      // Test negative seat count
      await expect(
        caller.organizations.subscription.updateSeatCount({
          organizationId: testOrganization.id,
          newSeatCount: -1,
        })
      ).rejects.toThrow();

      // Test zero seat count
      await expect(
        caller.organizations.subscription.updateSeatCount({
          organizationId: testOrganization.id,
          newSeatCount: 0,
        })
      ).rejects.toThrow();
    });
  });

  describe('getBillingHistory', () => {
    it('rejects non-owner members', async () => {
      const caller = await createCallerForUser(memberUser.id);
      await expect(
        caller.organizations.subscription.getBillingHistory({
          organizationId: testOrganization.id,
        })
      ).rejects.toThrow('You do not have the required organizational role to access this feature');
    });

    it('returns empty when no purchase exists', async () => {
      const caller = await createCallerForUser(regularUser.id);
      const result = await caller.organizations.subscription.getBillingHistory({
        organizationId: testOrganization.id,
      });
      expect(result).toEqual({ entries: [], hasMore: false, cursor: null });
    });

    it('maps Stripe invoices through the billing history mapper', async () => {
      // Insert a fake purchase row so the procedure reaches the Stripe call.
      const [purchase] = await db
        .insert(organization_seats_purchases)
        .values({
          organization_id: testOrganization.id,
          subscription_stripe_id: 'sub_test_billing_history',
          subscription_status: 'active',
          seat_count: 2,
          amount_usd: 42,
          starts_at: '2026-04-01T00:00:00.000Z',
          expires_at: '2027-04-01T00:00:00.000Z',
          billing_cycle: 'yearly',
        })
        .returning();

      stripeMock.invoices.list.mockResolvedValue({
        data: [
          {
            id: 'in_1',
            created: 1_700_000_000,
            amount_due: 4200,
            amount_paid: 4200,
            currency: 'usd',
            status: 'paid',
            invoice_pdf: 'https://pdf.example.com/1',
            hosted_invoice_url: 'https://invoice.example.com/1',
            lines: { data: [] },
          },
        ],
        has_more: false,
      });

      const caller = await createCallerForUser(regularUser.id);
      const result = await caller.organizations.subscription.getBillingHistory({
        organizationId: testOrganization.id,
      });

      expect(result.entries).toHaveLength(1);
      expect(result.entries[0]).toMatchObject({ id: 'in_1', status: 'paid' });
      expect(result.hasMore).toBe(false);
      expect(result.cursor).toBeNull();

      // Clean up
      if (purchase) {
        const { eq } = await import('drizzle-orm');
        await db
          .delete(organization_seats_purchases)
          .where(eq(organization_seats_purchases.id, purchase.id));
      }
    });
  });
});
