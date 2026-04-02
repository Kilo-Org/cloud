import { beforeEach, jest } from '@jest/globals';
import { db } from '@/lib/drizzle';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { createOrganization, addUserToOrganization } from '@/lib/organizations/organizations';
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let createCallerForUser: (userId: string) => Promise<any>;

// Test users and organization will be created dynamically
let regularUser: User;
let _adminUser: User;
let memberUser: User;
let _nonMemberUser: User;
let testOrganization: Organization;

describe('organizations subscription trpc router', () => {
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

  beforeAll(async () => {
    const mod = await import('@/routers/test-utils');
    createCallerForUser = mod.createCallerForUser;

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

  describe('get procedure', () => {
    it('should validate input schema', async () => {
      const caller = await createCallerForUser(regularUser.id);

      // Test invalid UUID
      await expect(
        caller.organizations.subscription.get({
          organizationId: 'invalid-uuid',
        })
      ).rejects.toThrow();
    });

    it('rejects non-owner members from reading subscription details', async () => {
      const caller = await createCallerForUser(memberUser.id);

      await expect(
        caller.organizations.subscription.get({
          organizationId: testOrganization.id,
        })
      ).rejects.toThrow('You do not have the required organizational role to access this feature');
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

  describe('getBillingHistory procedure', () => {
    it('returns empty history when the organization has no seat purchases', async () => {
      const caller = await createCallerForUser(regularUser.id);
      const result = await caller.organizations.subscription.getBillingHistory({
        organizationId: testOrganization.id,
      });

      expect(result).toEqual({ entries: [], hasMore: false, cursor: null });
      expect(stripeMock.invoices.list).not.toHaveBeenCalled();
    });

    it('rejects non-owner members', async () => {
      const caller = await createCallerForUser(memberUser.id);

      await expect(
        caller.organizations.subscription.getBillingHistory({
          organizationId: testOrganization.id,
        })
      ).rejects.toThrow('You do not have the required organizational role to access this feature');
    });

    it('lists invoices only for the latest seats subscription', async () => {
      await db.insert(organization_seats_purchases).values([
        {
          organization_id: testOrganization.id,
          subscription_stripe_id: 'sub_org_old',
          seat_count: 5,
          amount_usd: 25,
          starts_at: '2026-01-01T00:00:00.000Z',
          expires_at: '2026-02-01T00:00:00.000Z',
          billing_cycle: 'monthly',
          created_at: '2026-01-01T00:00:00.000Z',
        },
        {
          organization_id: testOrganization.id,
          subscription_stripe_id: 'sub_org_new',
          seat_count: 8,
          amount_usd: 40,
          starts_at: '2026-02-01T00:00:00.000Z',
          expires_at: '2026-03-01T00:00:00.000Z',
          billing_cycle: 'monthly',
          created_at: '2026-02-01T00:00:00.000Z',
        },
      ]);
      stripeMock.invoices.list.mockResolvedValue({
        data: [
          {
            id: 'inv_org_2',
            created: 1_706_745_600,
            amount_due: 4000,
            currency: 'usd',
            status: 'paid',
            hosted_invoice_url: 'https://stripe.example.test/inv_org_2',
            invoice_pdf: 'https://stripe.example.test/inv_org_2.pdf',
            lines: { data: [{ description: 'Organization seats renewal' }] },
          },
        ],
        has_more: false,
      });

      const caller = await createCallerForUser(regularUser.id);
      const result = await caller.organizations.subscription.getBillingHistory({
        organizationId: testOrganization.id,
      });

      expect(stripeMock.invoices.list).toHaveBeenCalledWith({
        customer: 'cus_test_org',
        subscription: 'sub_org_new',
        limit: 25,
      });
      expect(result).toEqual({
        entries: [
          {
            kind: 'stripe',
            id: 'inv_org_2',
            date: new Date(1_706_745_600 * 1000).toISOString(),
            amountCents: 4000,
            currency: 'usd',
            status: 'paid',
            invoiceUrl: 'https://stripe.example.test/inv_org_2',
            invoicePdfUrl: 'https://stripe.example.test/inv_org_2.pdf',
            description: 'Organization seats renewal',
          },
        ],
        hasMore: false,
        cursor: null,
      });
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
});
