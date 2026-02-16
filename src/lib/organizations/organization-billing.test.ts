import { describe, test, expect, beforeEach } from '@jest/globals';
import {
  getOrCreateStripeCustomerIdForOrganization,
  processTopupForOrganization,
} from '@/lib/organizations/organization-billing';
import {
  createOrganization,
  findOrganizationByStripeCustomerId,
} from '@/lib/organizations/organizations';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { db } from '@/lib/drizzle';
import { organizations, credit_transactions } from '@/db/schema';
import { eq } from 'drizzle-orm';
import type { User, Organization } from '@/db/schema';
import type Stripe from 'stripe';

describe('getOrCreateStripeCustomerIdForOrganization', () => {
  let testUser: User;
  let testOrganization: Organization;

  beforeEach(async () => {
    // Create test user and organization
    testUser = await insertTestUser();
    testOrganization = await createOrganization('Test Organization', testUser.id);
  });

  test('should create a Stripe customer for organization without existing stripe_customer_id', async () => {
    const mockStripeCustomer: Stripe.Customer = {
      id: 'cus_test_123',
      object: 'customer',
      created: Math.floor(Date.now() / 1000),
      email: null,
      livemode: false,
      balance: 0,
      default_source: null,
      description: null,
      invoice_settings: {
        custom_fields: null,
        default_payment_method: null,
        footer: null,
        rendering_options: null,
      },
      metadata: {},
      shipping: null,
    };

    const mockCreateStripeCustomer = async (params: {
      metadata: { organizationId: string };
    }): Promise<Stripe.Customer> => {
      expect(params).toEqual({
        metadata: {
          organizationId: testOrganization.id,
        },
      });
      return mockStripeCustomer;
    };

    const result = await getOrCreateStripeCustomerIdForOrganization(
      testOrganization.id,
      mockCreateStripeCustomer
    );

    expect(result).toBe('cus_test_123');
  });

  test('should return existing organization if stripe_customer_id already exists', async () => {
    // Update organization to have a stripe_customer_id
    const existingStripeCustomerId = 'cus_existing_123';
    await db
      .update(organizations)
      .set({ stripe_customer_id: existingStripeCustomerId })
      .where(eq(organizations.id, testOrganization.id));

    const mockCreateStripeCustomer = async (): Promise<Stripe.Customer> => {
      throw new Error('Should not be called');
    };

    const result = await getOrCreateStripeCustomerIdForOrganization(
      testOrganization.id,
      mockCreateStripeCustomer
    );

    expect(result).toBe(existingStripeCustomerId);
  });

  test('should throw error if organization does not exist', async () => {
    // Use a valid UUID format that doesn't exist in the database
    const nonExistentOrgId = '00000000-0000-0000-0000-000000000000';

    const mockCreateStripeCustomer = async (): Promise<Stripe.Customer> => {
      throw new Error('Should not be called');
    };

    await expect(
      getOrCreateStripeCustomerIdForOrganization(nonExistentOrgId, mockCreateStripeCustomer)
    ).rejects.toThrow('Organization not found');
  });

  test('should handle Stripe API errors', async () => {
    const stripeError = new Error('Stripe API error');

    const mockCreateStripeCustomer = async (): Promise<Stripe.Customer> => {
      throw stripeError;
    };

    await expect(
      getOrCreateStripeCustomerIdForOrganization(testOrganization.id, mockCreateStripeCustomer)
    ).rejects.toThrow('Stripe API error');
  });

  test('should work with organization created without user', async () => {
    // Create organization without a user
    const orgWithoutUser = await createOrganization('Org Without User', null);

    const mockStripeCustomer: Stripe.Customer = {
      id: 'cus_test_789',
      object: 'customer',
      created: Math.floor(Date.now() / 1000),
      email: null,
      livemode: false,
      balance: 0,
      default_source: null,
      description: null,
      invoice_settings: {
        custom_fields: null,
        default_payment_method: null,
        footer: null,
        rendering_options: null,
      },
      metadata: {},
      shipping: null,
    };

    const mockCreateStripeCustomer = async (params: {
      metadata: { organizationId: string };
    }): Promise<Stripe.Customer> => {
      expect(params).toEqual({
        metadata: {
          organizationId: orgWithoutUser.id,
        },
      });
      return mockStripeCustomer;
    };

    const result = await getOrCreateStripeCustomerIdForOrganization(
      orgWithoutUser.id,
      mockCreateStripeCustomer
    );

    expect(result).toBe('cus_test_789');
  });

  test('should preserve other organization fields when updating stripe_customer_id', async () => {
    // Update organization with additional data
    const updatedBalance = 50000; // 50 dollars in microdollars
    await db
      .update(organizations)
      .set({ microdollars_balance: updatedBalance })
      .where(eq(organizations.id, testOrganization.id));

    const mockStripeCustomer: Stripe.Customer = {
      id: 'cus_test_preserve',
      object: 'customer',
      created: Math.floor(Date.now() / 1000),
      email: null,
      livemode: false,
      balance: 0,
      default_source: null,
      description: null,
      invoice_settings: {
        custom_fields: null,
        default_payment_method: null,
        footer: null,
        rendering_options: null,
      },
      metadata: {},
      shipping: null,
    };

    const mockCreateStripeCustomer = async (): Promise<Stripe.Customer> => {
      return mockStripeCustomer;
    };

    const result = await getOrCreateStripeCustomerIdForOrganization(
      testOrganization.id,
      mockCreateStripeCustomer
    );

    expect(result).toBe('cus_test_preserve');

    const updated = await db.query.organizations.findFirst({
      where: eq(organizations.id, testOrganization.id),
    });
    expect(updated?.stripe_customer_id).toBe('cus_test_preserve');
    expect(updated?.microdollars_balance).toBe(updatedBalance);
  });

  test('should create new organization and then create Stripe customer', async () => {
    // Create a fresh organization for this test
    const freshOrg = await createOrganization('Fresh Organization', testUser.id);

    const mockStripeCustomer: Stripe.Customer = {
      id: 'cus_fresh_123',
      object: 'customer',
      created: Math.floor(Date.now() / 1000),
      email: null,
      livemode: false,
      balance: 0,
      default_source: null,
      description: null,
      invoice_settings: {
        custom_fields: null,
        default_payment_method: null,
        footer: null,
        rendering_options: null,
      },
      metadata: {},
      shipping: null,
    };

    const mockCreateStripeCustomer = async (params: {
      metadata: { organizationId: string };
    }): Promise<Stripe.Customer> => {
      expect(params).toEqual({
        metadata: {
          organizationId: freshOrg.id,
        },
      });
      return mockStripeCustomer;
    };

    // Verify organization starts without stripe_customer_id
    expect(freshOrg.stripe_customer_id).toBeNull();

    const result = await getOrCreateStripeCustomerIdForOrganization(
      freshOrg.id,
      mockCreateStripeCustomer
    );

    expect(result).toBe('cus_fresh_123');

    // Verify the database was actually updated
    const updatedOrg = await db.query.organizations.findFirst({
      where: eq(organizations.id, freshOrg.id),
    });
    expect(updatedOrg?.stripe_customer_id).toBe('cus_fresh_123');
  });

  test('should handle race condition where organization already has stripe_customer_id', async () => {
    // This test simulates the case where the organization already has a stripe_customer_id
    // when we check, so we should return it without calling Stripe
    await db
      .update(organizations)
      .set({ stripe_customer_id: 'cus_race_condition' })
      .where(eq(organizations.id, testOrganization.id));

    const mockCreateStripeCustomer = async (): Promise<Stripe.Customer> => {
      throw new Error('Should not be called');
    };

    const result = await getOrCreateStripeCustomerIdForOrganization(
      testOrganization.id,
      mockCreateStripeCustomer
    );

    expect(result).toBe('cus_race_condition');
  });

  test('should throw error when database update returns no rows', async () => {
    // This test simulates a race condition where another process updates the organization
    // between the initial check and the update operation
    const mockStripeCustomer: Stripe.Customer = {
      id: 'cus_test_race',
      object: 'customer',
      created: Math.floor(Date.now() / 1000),
      email: null,
      livemode: false,
      balance: 0,
      default_source: null,
      description: null,
      invoice_settings: {
        custom_fields: null,
        default_payment_method: null,
        footer: null,
        rendering_options: null,
      },
      metadata: {},
      shipping: null,
    };

    // Create a fresh organization
    const freshOrg = await createOrganization('Race Condition Org', testUser.id);

    const mockCreateStripeCustomer = async (): Promise<Stripe.Customer> => {
      // While Stripe customer is being created, another process updates the org
      await db
        .update(organizations)
        .set({ stripe_customer_id: 'cus_other_process' })
        .where(eq(organizations.id, freshOrg.id));

      return mockStripeCustomer;
    };

    // This should throw an error because the update will return no rows
    await expect(
      getOrCreateStripeCustomerIdForOrganization(freshOrg.id, mockCreateStripeCustomer)
    ).rejects.toThrow('Failed to create Stripe customer for organization');
  });
});

describe('findOrganizationByStripeCustomerId', () => {
  let testUser: User;
  let testOrganization: Organization;

  beforeEach(async () => {
    // Create test user and organization
    testUser = await insertTestUser();
    testOrganization = await createOrganization('Test Organization', testUser.id);
  });

  test('should return organization when stripe_customer_id exists', async () => {
    const stripeCustomerId = 'cus_find_test_unique_123';

    // Update organization to have a stripe_customer_id
    await db
      .update(organizations)
      .set({ stripe_customer_id: stripeCustomerId })
      .where(eq(organizations.id, testOrganization.id));

    const result = await findOrganizationByStripeCustomerId(stripeCustomerId);

    expect(result).toBeTruthy();
    expect(result?.id).toBe(testOrganization.id);
    expect(result?.name).toBe('Test Organization');
    expect(result?.stripe_customer_id).toBe(stripeCustomerId);
  });

  test('should return null when stripe_customer_id does not exist', async () => {
    const nonExistentStripeCustomerId = 'cus_find_nonexistent_unique_123';

    const result = await findOrganizationByStripeCustomerId(nonExistentStripeCustomerId);

    expect(result).toBeNull();
  });

  test('should return null when stripe_customer_id is null in database', async () => {
    // testOrganization starts with null stripe_customer_id by default
    const result = await findOrganizationByStripeCustomerId('cus_find_any_unique_123');

    expect(result).toBeNull();
  });

  test('should return correct organization when multiple organizations exist', async () => {
    const stripeCustomerId1 = 'cus_find_multi_unique_123';
    const stripeCustomerId2 = 'cus_find_multi_unique_456';

    // Create another organization
    const testUser2 = await insertTestUser();
    const testOrganization2 = await createOrganization('Second Organization', testUser2.id);

    // Update both organizations with different stripe_customer_ids
    await db
      .update(organizations)
      .set({ stripe_customer_id: stripeCustomerId1 })
      .where(eq(organizations.id, testOrganization.id));

    await db
      .update(organizations)
      .set({ stripe_customer_id: stripeCustomerId2 })
      .where(eq(organizations.id, testOrganization2.id));

    // Test finding first organization
    const result1 = await findOrganizationByStripeCustomerId(stripeCustomerId1);
    expect(result1).toBeTruthy();
    expect(result1?.id).toBe(testOrganization.id);
    expect(result1?.name).toBe('Test Organization');
    expect(result1?.stripe_customer_id).toBe(stripeCustomerId1);

    // Test finding second organization
    const result2 = await findOrganizationByStripeCustomerId(stripeCustomerId2);
    expect(result2).toBeTruthy();
    expect(result2?.id).toBe(testOrganization2.id);
    expect(result2?.name).toBe('Second Organization');
    expect(result2?.stripe_customer_id).toBe(stripeCustomerId2);
  });

  test('should work with transaction parameter', async () => {
    const stripeCustomerId = 'cus_find_txn_unique_123';

    // Update organization to have a stripe_customer_id
    await db
      .update(organizations)
      .set({ stripe_customer_id: stripeCustomerId })
      .where(eq(organizations.id, testOrganization.id));

    // Test with transaction
    await db.transaction(async txn => {
      const result = await findOrganizationByStripeCustomerId(stripeCustomerId, txn);

      expect(result).toBeTruthy();
      expect(result?.id).toBe(testOrganization.id);
      expect(result?.stripe_customer_id).toBe(stripeCustomerId);
    });
  });

  test('should handle empty string stripe_customer_id', async () => {
    const result = await findOrganizationByStripeCustomerId('');

    expect(result).toBeNull();
  });

  test('should preserve all organization fields when found', async () => {
    const stripeCustomerId = 'cus_find_preserve_unique_123';
    const updatedBalance = 50000; // 50 dollars in microdollars

    // Update organization with stripe_customer_id and balance
    await db
      .update(organizations)
      .set({
        stripe_customer_id: stripeCustomerId,
        microdollars_balance: updatedBalance,
      })
      .where(eq(organizations.id, testOrganization.id));

    const result = await findOrganizationByStripeCustomerId(stripeCustomerId);

    expect(result).toBeTruthy();
    expect(result?.id).toBe(testOrganization.id);
    expect(result?.name).toBe('Test Organization');
    expect(result?.stripe_customer_id).toBe(stripeCustomerId);
    expect(result?.microdollars_balance).toBe(updatedBalance);
    expect(result?.auto_top_up_enabled).toBe(false);
    expect(result?.created_at).toBeDefined();
    expect(result?.updated_at).toBeDefined();
  });
});

describe('processTopupForOrganization', () => {
  let testUser: User;
  let testOrganization: Organization;

  beforeEach(async () => {
    // Create test user and organization
    testUser = await insertTestUser();
    testOrganization = await createOrganization('Test Organization', testUser.id);
  });

  test('should process Stripe topup for organization', async () => {
    const amountInCents = 5000; // $50
    const stripePaymentId = 'pi_test_stripe_123';
    const config = { type: 'stripe' as const, stripe_payment_id: stripePaymentId };

    const initialBalance = testOrganization.microdollars_balance;

    await processTopupForOrganization(testUser.id, testOrganization.id, amountInCents, config);

    // Verify organization balance was updated
    const updatedOrg = await db.query.organizations.findFirst({
      where: eq(organizations.id, testOrganization.id),
    });

    const expectedBalanceIncrease = amountInCents * 10_000; // Convert to microdollars
    expect(updatedOrg?.microdollars_balance).toBe(initialBalance + expectedBalanceIncrease);
    expect(updatedOrg?.total_microdollars_acquired).toBe(
      testOrganization.total_microdollars_acquired + expectedBalanceIncrease
    );

    // Verify credit transaction was created
    const creditTransaction = await db.query.credit_transactions.findFirst({
      where: eq(credit_transactions.stripe_payment_id, stripePaymentId),
    });

    expect(creditTransaction).toBeTruthy();
    expect(creditTransaction?.kilo_user_id).toBe(testUser.id);
    expect(creditTransaction?.organization_id).toBe(testOrganization.id);
    expect(creditTransaction?.amount_microdollars).toBe(expectedBalanceIncrease);
    expect(creditTransaction?.is_free).toBe(false);
    expect(creditTransaction?.description).toBe('Organization top-up via stripe');
    expect(creditTransaction?.stripe_payment_id).toBe(stripePaymentId);
  });

  test('should handle multiple topups correctly', async () => {
    const firstAmount = 2500; // $25
    const secondAmount = 7500; // $75
    const stripePaymentId1 = 'pi_test_first_123';
    const stripePaymentId2 = 'pi_test_second_456';

    const initialBalance = testOrganization.microdollars_balance;

    // First topup
    await processTopupForOrganization(testUser.id, testOrganization.id, firstAmount, {
      type: 'stripe',
      stripe_payment_id: stripePaymentId1,
    });

    // Second topup
    await processTopupForOrganization(testUser.id, testOrganization.id, secondAmount, {
      type: 'stripe',
      stripe_payment_id: stripePaymentId2,
    });

    // Verify final balance
    const updatedOrg = await db.query.organizations.findFirst({
      where: eq(organizations.id, testOrganization.id),
    });

    const expectedTotalIncrease = (firstAmount + secondAmount) * 10_000;
    expect(updatedOrg?.microdollars_balance).toBe(initialBalance + expectedTotalIncrease);
    expect(updatedOrg?.total_microdollars_acquired).toBe(
      testOrganization.total_microdollars_acquired + expectedTotalIncrease
    );

    // Verify both credit transactions were created
    const transactions = await db.query.credit_transactions.findMany({
      where: eq(credit_transactions.organization_id, testOrganization.id),
    });

    expect(transactions).toHaveLength(2);
    expect(transactions.some(t => t.stripe_payment_id === stripePaymentId1)).toBe(true);
    expect(transactions.some(t => t.stripe_payment_id === stripePaymentId2)).toBe(true);
  });

  test('should handle organization with existing balance', async () => {
    const existingBalance = 25000; // $25 in microdollars
    const amountInCents = 3000; // $30

    // Set existing balance
    await db
      .update(organizations)
      .set({ microdollars_balance: existingBalance })
      .where(eq(organizations.id, testOrganization.id));

    await processTopupForOrganization(testUser.id, testOrganization.id, amountInCents, {
      type: 'stripe',
      stripe_payment_id: 'pi_test_existing_balance',
    });

    // Verify balance was added to existing balance
    const updatedOrg = await db.query.organizations.findFirst({
      where: eq(organizations.id, testOrganization.id),
    });

    const expectedBalanceIncrease = amountInCents * 10_000;
    expect(updatedOrg?.microdollars_balance).toBe(existingBalance + expectedBalanceIncrease);
    // total_microdollars_acquired should also increase (org starts at 0 acquired, then we set balance to 25000 without updating acquired)
    expect(updatedOrg?.total_microdollars_acquired).toBe(
      testOrganization.total_microdollars_acquired + expectedBalanceIncrease
    );
  });

  test('should update organization updated_at timestamp', async () => {
    const originalUpdatedAt = testOrganization.updated_at;

    // Wait a bit to ensure timestamp difference
    await new Promise(resolve => setTimeout(resolve, 10));

    await processTopupForOrganization(testUser.id, testOrganization.id, 1000, {
      type: 'stripe',
      stripe_payment_id: 'pi_test_timestamp',
    });

    const updatedOrg = await db.query.organizations.findFirst({
      where: eq(organizations.id, testOrganization.id),
    });

    expect(new Date(updatedOrg!.updated_at).getTime()).toBeGreaterThan(
      new Date(originalUpdatedAt).getTime()
    );
  });

  test('should handle zero amount correctly', async () => {
    const amountInCents = 0;
    const initialBalance = testOrganization.microdollars_balance;

    await processTopupForOrganization(testUser.id, testOrganization.id, amountInCents, {
      type: 'stripe',
      stripe_payment_id: 'pi_test_zero_amount',
    });

    // Verify balance remains unchanged
    const updatedOrg = await db.query.organizations.findFirst({
      where: eq(organizations.id, testOrganization.id),
    });

    expect(updatedOrg?.microdollars_balance).toBe(initialBalance);

    // Verify credit transaction was still created with zero amount
    const creditTransaction = await db.query.credit_transactions.findFirst({
      where: eq(credit_transactions.stripe_payment_id, 'pi_test_zero_amount'),
    });

    expect(creditTransaction).toBeTruthy();
    expect(creditTransaction?.amount_microdollars).toBe(0);
  });

  test('should preserve other organization fields when updating balance', async () => {
    const amountInCents = 1500; // $15

    await processTopupForOrganization(testUser.id, testOrganization.id, amountInCents, {
      type: 'stripe',
      stripe_payment_id: 'pi_test_preserve_fields',
    });

    const updatedOrg = await db.query.organizations.findFirst({
      where: eq(organizations.id, testOrganization.id),
    });

    // Verify other fields are preserved
    expect(updatedOrg?.id).toBe(testOrganization.id);
    expect(updatedOrg?.name).toBe(testOrganization.name);
    expect(updatedOrg?.created_at).toBe(testOrganization.created_at);
    expect(updatedOrg?.auto_top_up_enabled).toBe(testOrganization.auto_top_up_enabled);
    expect(updatedOrg?.stripe_customer_id).toBe(testOrganization.stripe_customer_id);
  });
});
