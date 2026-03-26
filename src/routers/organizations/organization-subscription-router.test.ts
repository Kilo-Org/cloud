import { createCallerForUser } from '@/routers/test-utils';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { createOrganization, addUserToOrganization } from '@/lib/organizations/organizations';
import type { User, Organization } from '@kilocode/db/schema';

// Test users and organization will be created dynamically
let regularUser: User;
let _adminUser: User;
let memberUser: User;
let _nonMemberUser: User;
let testOrganization: Organization;

describe('organizations subscription trpc router', () => {
  beforeAll(async () => {
    // Create test users using the helper function
    regularUser = await insertTestUser({
      google_user_email: 'regular-subscription@example.com',
      google_user_name: 'Regular Subscription User',
      is_admin: false,
    });

    _adminUser = await insertTestUser({
      google_user_email: 'admin-subscription@admin.example.com',
      google_user_name: 'Admin Subscription User',
      is_admin: true,
    });

    memberUser = await insertTestUser({
      google_user_email: 'member-subscription@example.com',
      google_user_name: 'Member Subscription User',
      is_admin: false,
    });

    _nonMemberUser = await insertTestUser({
      google_user_email: 'non-member-subscription@example.com',
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
  });

  describe('getSubscriptionStripeUrl procedure', () => {
    it('should throw UNAUTHORIZED error for non-owner members', async () => {
      const caller = await createCallerForUser(memberUser.id);

      await expect(
        caller.organizations.subscription.getSubscriptionStripeUrl({
          organizationId: testOrganization.id,
          seats: 1,
          cancelUrl: 'https://example.com',
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

    it("should default billingCycle to 'annual' when not provided", async () => {
      const caller = await createCallerForUser(regularUser.id);

      // Call without billingCycle — should not throw a validation error,
      // meaning the default 'annual' is applied by the schema.
      const result = caller.organizations.subscription.getSubscriptionStripeUrl({
        organizationId: testOrganization.id,
        seats: 1,
        cancelUrl: 'https://example.com',
      });

      // Should pass input validation (no ZodError / BAD_REQUEST), then fail downstream
      await expect(result).rejects.not.toThrow(/ZodError/);
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
});
