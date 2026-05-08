import { describe, test, expect, beforeEach } from '@jest/globals';
import {
  getOrCreateStripeCustomerIdForOrganization,
  getTopUpConfirmationRecipientsForOrganization,
  processTopupForOrganization,
} from '@/lib/organizations/organization-billing';
import {
  addUserToOrganization,
  createOrganization,
  findOrganizationByStripeCustomerId,
  inviteUserToOrganization,
} from '@/lib/organizations/organizations';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { db } from '@/lib/drizzle';
import {
  organizations,
  credit_transactions,
  organization_audit_logs,
  transactional_email_log,
} from '@kilocode/db/schema';
import { and, eq } from 'drizzle-orm';
import type { User, Organization } from '@kilocode/db/schema';
import type Stripe from 'stripe';
import { SYSTEM_AUTO_TOP_UP_USER_ID } from '@/lib/autoTopUpConstants';

type SendViaMailgunParams = { to: string; subject: string; html: string; replyTo?: string };
const captureExceptionMock = jest.fn();
jest.mock('@sentry/nextjs', () => ({
  captureException: (...args: unknown[]) => captureExceptionMock(...args),
  captureMessage: () => {},
}));

const sendViaMailgunMock = jest.fn<Promise<boolean>, [SendViaMailgunParams]>(async () => true);
const verifyEmailMock = jest.fn<Promise<boolean>, [string]>(async () => true);
const mockResolveStripeReceiptUrl = jest.fn<
  Promise<string | null>,
  [string, { skipInAutomatedTest?: boolean }?]
>(async () => null);

jest.mock('@/lib/email-mailgun', () => ({
  sendViaMailgun: (params: SendViaMailgunParams) => sendViaMailgunMock(params),
}));

jest.mock('@/lib/email-neverbounce', () => ({
  verifyEmail: (email: string) => verifyEmailMock(email),
}));

jest.mock('@/lib/credits', () => ({
  resolveStripeReceiptUrl: (...args: [string, { skipInAutomatedTest?: boolean }?]) =>
    mockResolveStripeReceiptUrl(...args),
}));

function getOrganizationTopUpEmailMarkers(stripePaymentId: string) {
  return db.query.transactional_email_log.findMany({
    where: and(
      eq(transactional_email_log.email_type, 'organization_credits_top_up_confirmation'),
      eq(transactional_email_log.idempotency_key, stripePaymentId)
    ),
  });
}

function formatUtcDate(date: Date): string {
  return date.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

describe('getOrCreateStripeCustomerIdForOrganization', () => {
  let testUser: User;
  let testOrganization: Organization;

  beforeEach(async () => {
    sendViaMailgunMock.mockClear().mockResolvedValue(true);
    verifyEmailMock.mockClear().mockResolvedValue(true);
    mockResolveStripeReceiptUrl.mockClear().mockResolvedValue(null);
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
      .set({ total_microdollars_acquired: updatedBalance })
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
    expect(updated?.total_microdollars_acquired).toBe(updatedBalance);
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
    sendViaMailgunMock.mockClear().mockResolvedValue(true);
    verifyEmailMock.mockClear().mockResolvedValue(true);
    mockResolveStripeReceiptUrl.mockClear().mockResolvedValue(null);
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
        total_microdollars_acquired: updatedBalance,
      })
      .where(eq(organizations.id, testOrganization.id));

    const result = await findOrganizationByStripeCustomerId(stripeCustomerId);

    expect(result).toBeTruthy();
    expect(result?.id).toBe(testOrganization.id);
    expect(result?.name).toBe('Test Organization');
    expect(result?.stripe_customer_id).toBe(stripeCustomerId);
    expect(result?.total_microdollars_acquired).toBe(updatedBalance);
    expect(result?.auto_top_up_enabled).toBe(false);
    expect(result?.created_at).toBeDefined();
    expect(result?.updated_at).toBeDefined();
  });
});

describe('getTopUpConfirmationRecipientsForOrganization', () => {
  test('returns active owner and billing manager emails', async () => {
    const owner = await insertTestUser({ google_user_email: 'owner@example.com' });
    const billingManager = await insertTestUser({
      google_user_email: 'billing-manager@example.com',
    });
    const member = await insertTestUser({ google_user_email: 'member@example.com' });
    const duplicateBillingManager = await insertTestUser({
      google_user_email: 'duplicate-billing-manager@example.com',
    });
    const botOwner = await insertTestUser({
      google_user_email: 'bot-owner@example.com',
      is_bot: true,
    });
    const organization = await createOrganization('Test Organization', owner.id);

    await addUserToOrganization(organization.id, billingManager.id, 'billing_manager');
    await addUserToOrganization(organization.id, duplicateBillingManager.id, 'billing_manager');
    await addUserToOrganization(organization.id, member.id, 'member');
    await addUserToOrganization(organization.id, botOwner.id, 'owner');
    await inviteUserToOrganization(
      organization.id,
      owner.id,
      'invited-billing-manager@example.com',
      'billing_manager'
    );
    await inviteUserToOrganization(organization.id, owner.id, 'invited-owner@example.com', 'owner');

    const recipients = await getTopUpConfirmationRecipientsForOrganization(organization.id);

    expect(recipients.sort()).toEqual([
      'billing-manager@example.com',
      'duplicate-billing-manager@example.com',
      'owner@example.com',
    ]);
    expect(new Set(recipients).size).toBe(recipients.length);
  });
});

describe('processTopupForOrganization', () => {
  let testUser: User;
  let testOrganization: Organization;

  beforeEach(async () => {
    captureExceptionMock.mockClear();
    sendViaMailgunMock.mockClear().mockResolvedValue(true);
    verifyEmailMock.mockClear().mockResolvedValue(true);
    mockResolveStripeReceiptUrl.mockClear().mockResolvedValue(null);
    // Create test user and organization
    testUser = await insertTestUser();
    testOrganization = await createOrganization('Test Organization', testUser.id);
  });

  test('should process Stripe topup for organization', async () => {
    const amountInCents = 5000; // $50
    const stripePaymentId = 'pi_test_stripe_123';
    const config = { type: 'stripe' as const, stripe_payment_id: stripePaymentId };
    mockResolveStripeReceiptUrl.mockResolvedValueOnce('https://pay.stripe.test/receipts/pi');

    const initialBalance =
      testOrganization.total_microdollars_acquired - testOrganization.microdollars_used;

    await processTopupForOrganization(testUser.id, testOrganization.id, amountInCents, config);

    // Verify organization balance was updated
    const updatedOrg = await db.query.organizations.findFirst({
      where: eq(organizations.id, testOrganization.id),
    });

    const expectedBalanceIncrease = amountInCents * 10_000; // Convert to microdollars
    const computedBalance =
      (updatedOrg?.total_microdollars_acquired ?? 0) - (updatedOrg?.microdollars_used ?? 0);
    expect(computedBalance).toBe(initialBalance + expectedBalanceIncrease);
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

    expect(mockResolveStripeReceiptUrl).toHaveBeenCalledWith(stripePaymentId);
    expect(sendViaMailgunMock).toHaveBeenCalledTimes(1);
    const [topUpEmail] = sendViaMailgunMock.mock.calls[0];
    expect(topUpEmail.to).toBe(testUser.google_user_email);
    expect(topUpEmail.subject).toBe('Your Kilo org credit top-up');
    expect(topUpEmail.html).toContain('Team credits added');
    expect(topUpEmail.html).toContain('Amount:</strong> $50.00 USD');
    expect(topUpEmail.html).toContain('Credits:</strong> $50.00 USD');
    expect(topUpEmail.html).toContain(
      'A Kilo credit top-up has been processed for Test Organization. The credits are now available to the organization.'
    );
    expect(topUpEmail.html).toContain(`/organizations/${testOrganization.id}/payment-details`);
    expect(topUpEmail.html).toContain('https://pay.stripe.test/receipts/pi');

    const emailMarkers = await getOrganizationTopUpEmailMarkers(stripePaymentId);
    expect(emailMarkers).toHaveLength(1);
    expect(emailMarkers[0]).toMatchObject({
      email_type: 'organization_credits_top_up_confirmation',
      idempotency_key: stripePaymentId,
      user_id: testUser.id,
      organization_id: testOrganization.id,
    });
  });

  test('sends org auto top-up email variant when requested', async () => {
    const amountInCents = 2500;
    const stripePaymentId = 'ch_test_org_auto_topup';
    mockResolveStripeReceiptUrl.mockResolvedValueOnce('https://pay.stripe.test/receipts/ch');

    await processTopupForOrganization(
      SYSTEM_AUTO_TOP_UP_USER_ID,
      testOrganization.id,
      amountInCents,
      {
        type: 'stripe',
        stripe_payment_id: stripePaymentId,
      },
      { isAutoTopUp: true }
    );

    expect(mockResolveStripeReceiptUrl).toHaveBeenCalledWith('ch_test_org_auto_topup');
    expect(sendViaMailgunMock).toHaveBeenCalledTimes(1);
    const [topUpEmail] = sendViaMailgunMock.mock.calls[0];
    expect(topUpEmail.to).toBe(testUser.google_user_email);
    expect(topUpEmail.subject).toBe('Kilo team auto top-up successful');
    expect(topUpEmail.html).toContain('Team auto top-up was successful');
    expect(topUpEmail.html).toContain('$25.00 USD');
    expect(topUpEmail.html).toContain(
      'Test Organization was automatically topped up so your team can keep using Kilo without interruption. The new credits are available now.'
    );
    expect(topUpEmail.html).toContain(`/organizations/${testOrganization.id}/payment-details`);
    expect(topUpEmail.html).toContain('https://pay.stripe.test/receipts/ch');

    const emailMarkers = await getOrganizationTopUpEmailMarkers(stripePaymentId);
    expect(emailMarkers).toHaveLength(1);
    expect(emailMarkers[0]).toMatchObject({
      email_type: 'organization_credits_top_up_confirmation',
      idempotency_key: stripePaymentId,
      user_id: null,
      organization_id: testOrganization.id,
    });
  });

  test('sends org top-up confirmation to active owners and billing managers only', async () => {
    const billingManager = await insertTestUser({
      google_user_email: 'billing-manager-send@example.com',
    });
    const member = await insertTestUser({ google_user_email: 'member-send@example.com' });
    await addUserToOrganization(testOrganization.id, billingManager.id, 'billing_manager');
    await addUserToOrganization(testOrganization.id, member.id, 'member');
    await inviteUserToOrganization(
      testOrganization.id,
      testUser.id,
      'invited-owner-send@example.com',
      'owner'
    );

    await processTopupForOrganization(testUser.id, testOrganization.id, 1200, {
      type: 'stripe',
      stripe_payment_id: 'pi_test_recipient_policy',
    });

    expect(sendViaMailgunMock).toHaveBeenCalledTimes(2);
    expect(sendViaMailgunMock.mock.calls.map(([params]) => params.to).sort()).toEqual([
      'billing-manager-send@example.com',
      testUser.google_user_email,
    ]);
  });

  test('keeps org top-up marker when at least one recipient succeeds', async () => {
    const billingManager = await insertTestUser({
      google_user_email: 'billing-manager-partial-success@example.com',
    });
    await addUserToOrganization(testOrganization.id, billingManager.id, 'billing_manager');
    const stripePaymentId = 'pi_test_partial_success_keeps_marker';
    sendViaMailgunMock.mockImplementation(async params =>
      params.to === testUser.google_user_email ? false : true
    );

    await processTopupForOrganization(testUser.id, testOrganization.id, 1200, {
      type: 'stripe',
      stripe_payment_id: stripePaymentId,
    });

    expect(sendViaMailgunMock).toHaveBeenCalledTimes(2);
    expect(sendViaMailgunMock.mock.calls.map(([params]) => params.to).sort()).toEqual([
      'billing-manager-partial-success@example.com',
      testUser.google_user_email,
    ]);
    expect(await getOrganizationTopUpEmailMarkers(stripePaymentId)).toHaveLength(1);
  });

  test('clears org top-up marker when all recipient failures are retryable', async () => {
    const billingManager = await insertTestUser({
      google_user_email: 'billing-manager-total-failure@example.com',
    });
    await addUserToOrganization(testOrganization.id, billingManager.id, 'billing_manager');
    const stripePaymentId = 'pi_test_total_retryable_failure_clears_marker';
    sendViaMailgunMock.mockResolvedValue(false);

    await processTopupForOrganization(testUser.id, testOrganization.id, 1200, {
      type: 'stripe',
      stripe_payment_id: stripePaymentId,
    });

    expect(sendViaMailgunMock).toHaveBeenCalledTimes(2);
    expect(await getOrganizationTopUpEmailMarkers(stripePaymentId)).toHaveLength(0);
  });

  test('keeps org top-up marker for terminal NeverBounce failures and continues to later recipients', async () => {
    const billingManager = await insertTestUser({
      google_user_email: 'billing-manager-neverbounce-continues@example.com',
    });
    await addUserToOrganization(testOrganization.id, billingManager.id, 'billing_manager');
    const stripePaymentId = 'pi_test_neverbounce_keeps_marker_and_continues';
    verifyEmailMock.mockImplementation(async email => email !== testUser.google_user_email);

    await processTopupForOrganization(testUser.id, testOrganization.id, 1200, {
      type: 'stripe',
      stripe_payment_id: stripePaymentId,
    });

    expect(verifyEmailMock).toHaveBeenCalledTimes(2);
    expect(verifyEmailMock.mock.calls.map(([email]) => email).sort()).toEqual([
      'billing-manager-neverbounce-continues@example.com',
      testUser.google_user_email,
    ]);
    expect(sendViaMailgunMock).toHaveBeenCalledTimes(1);
    expect(sendViaMailgunMock.mock.calls[0][0].to).toBe(
      'billing-manager-neverbounce-continues@example.com'
    );
    expect(await getOrganizationTopUpEmailMarkers(stripePaymentId)).toHaveLength(1);
  });

  test('keeps org top-up marker when all recipient failures are terminal NeverBounce rejections', async () => {
    const stripePaymentId = 'pi_test_neverbounce_terminal_marker';
    verifyEmailMock.mockResolvedValue(false);

    await processTopupForOrganization(testUser.id, testOrganization.id, 1200, {
      type: 'stripe',
      stripe_payment_id: stripePaymentId,
    });

    expect(sendViaMailgunMock).not.toHaveBeenCalled();
    expect(await getOrganizationTopUpEmailMarkers(stripePaymentId)).toHaveLength(1);
  });

  test('clears org top-up marker when terminal and retryable failures both occur without a successful send', async () => {
    const billingManager = await insertTestUser({
      google_user_email: 'billing-manager-mixed-failure@example.com',
    });
    await addUserToOrganization(testOrganization.id, billingManager.id, 'billing_manager');
    const stripePaymentId = 'pi_test_mixed_terminal_retryable_failure_clears_marker';
    verifyEmailMock.mockImplementation(async email => email !== testUser.google_user_email);
    sendViaMailgunMock.mockImplementation(async params =>
      params.to === 'billing-manager-mixed-failure@example.com' ? false : true
    );

    await processTopupForOrganization(testUser.id, testOrganization.id, 1200, {
      type: 'stripe',
      stripe_payment_id: stripePaymentId,
    });

    expect(sendViaMailgunMock).toHaveBeenCalledTimes(1);
    expect(verifyEmailMock.mock.calls.map(([email]) => email).sort()).toEqual([
      'billing-manager-mixed-failure@example.com',
      testUser.google_user_email,
    ]);
    expect(sendViaMailgunMock.mock.calls[0][0].to).toBe(
      'billing-manager-mixed-failure@example.com'
    );
    expect(await getOrganizationTopUpEmailMarkers(stripePaymentId)).toHaveLength(0);
  });

  test('processes org top-up without email when there are no eligible recipients', async () => {
    const organizationWithoutRecipients = await createOrganization('No Recipients', null);
    const stripePaymentId = 'pi_test_no_eligible_org_recipients';

    await processTopupForOrganization(
      SYSTEM_AUTO_TOP_UP_USER_ID,
      organizationWithoutRecipients.id,
      1200,
      {
        type: 'stripe',
        stripe_payment_id: stripePaymentId,
      }
    );

    const creditTransaction = await db.query.credit_transactions.findFirst({
      where: eq(credit_transactions.stripe_payment_id, stripePaymentId),
    });
    expect(creditTransaction?.organization_id).toBe(organizationWithoutRecipients.id);
    expect(sendViaMailgunMock).not.toHaveBeenCalled();
    const emailMarkers = await getOrganizationTopUpEmailMarkers(stripePaymentId);
    expect(emailMarkers).toHaveLength(1);
    expect(emailMarkers[0]).toMatchObject({
      email_type: 'organization_credits_top_up_confirmation',
      idempotency_key: stripePaymentId,
      user_id: null,
      organization_id: organizationWithoutRecipients.id,
    });
  });

  test('duplicate no-recipient org top-up does not email recipients added later', async () => {
    const organizationWithoutRecipients = await createOrganization('No Recipients Later', null);
    const laterOwner = await insertTestUser({ google_user_email: 'later-owner@example.com' });
    const stripePaymentId = 'pi_test_no_eligible_org_recipients_terminal';

    await processTopupForOrganization(
      SYSTEM_AUTO_TOP_UP_USER_ID,
      organizationWithoutRecipients.id,
      1200,
      {
        type: 'stripe',
        stripe_payment_id: stripePaymentId,
      }
    );

    await addUserToOrganization(organizationWithoutRecipients.id, laterOwner.id, 'owner');
    sendViaMailgunMock.mockClear();

    await processTopupForOrganization(
      SYSTEM_AUTO_TOP_UP_USER_ID,
      organizationWithoutRecipients.id,
      1200,
      {
        type: 'stripe',
        stripe_payment_id: stripePaymentId,
      }
    );

    expect(sendViaMailgunMock).not.toHaveBeenCalled();
    expect(await getOrganizationTopUpEmailMarkers(stripePaymentId)).toHaveLength(1);
  });

  test('recipient lookup failures do not reject after credit commit', async () => {
    const stripePaymentId = 'pi_test_recipient_lookup_failure_is_best_effort';
    const amountInCents = 1200;
    const originalSelect = db.select;
    const selectMock = jest.spyOn(db, 'select');
    selectMock.mockImplementation(fields => {
      if (
        fields &&
        typeof fields === 'object' &&
        'dailyUsageLimitUsdMicrodollars' in fields &&
        'currentDailyUsageUsdMicrodollars' in fields
      ) {
        throw new Error('recipient lookup failed');
      }

      return Reflect.apply(originalSelect, db, fields === undefined ? [] : [fields]);
    });

    try {
      await expect(
        processTopupForOrganization(testUser.id, testOrganization.id, amountInCents, {
          type: 'stripe',
          stripe_payment_id: stripePaymentId,
        })
      ).resolves.toBeUndefined();
    } finally {
      selectMock.mockRestore();
    }

    const updatedOrg = await db.query.organizations.findFirst({
      where: eq(organizations.id, testOrganization.id),
    });
    expect(updatedOrg?.total_microdollars_acquired).toBe(
      testOrganization.total_microdollars_acquired + amountInCents * 10_000
    );
    expect(sendViaMailgunMock).not.toHaveBeenCalled();
    expect(await getOrganizationTopUpEmailMarkers(stripePaymentId)).toHaveLength(0);
    expect(captureExceptionMock).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: expect.objectContaining({
          source: 'organization_credits_topup_email',
          failure_type: 'recipient_lookup',
        }),
      })
    );
  });

  test('receipt lookup failures are reported separately from recipient lookup failures', async () => {
    const stripePaymentId = 'pi_test_receipt_lookup_failure_is_best_effort';
    const amountInCents = 1200;
    mockResolveStripeReceiptUrl.mockRejectedValueOnce(new Error('receipt lookup failed'));

    await expect(
      processTopupForOrganization(testUser.id, testOrganization.id, amountInCents, {
        type: 'stripe',
        stripe_payment_id: stripePaymentId,
      })
    ).resolves.toBeUndefined();

    const updatedOrg = await db.query.organizations.findFirst({
      where: eq(organizations.id, testOrganization.id),
    });
    expect(updatedOrg?.total_microdollars_acquired).toBe(
      testOrganization.total_microdollars_acquired + amountInCents * 10_000
    );
    expect(sendViaMailgunMock).not.toHaveBeenCalled();
    expect(await getOrganizationTopUpEmailMarkers(stripePaymentId)).toHaveLength(0);
    expect(captureExceptionMock).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: expect.objectContaining({
          source: 'organization_credits_topup_email',
          failure_type: 'receipt_lookup',
        }),
      })
    );
    expect(captureExceptionMock).not.toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: expect.objectContaining({ failure_type: 'recipient_lookup' }),
      })
    );
  });

  test('does not duplicate balance, audit log, or email marker for repeated payment id', async () => {
    const amountInCents = 5000;
    const stripePaymentId = 'pi_test_duplicate_org_topup';
    const expectedBalanceIncrease = amountInCents * 10_000;

    await processTopupForOrganization(testUser.id, testOrganization.id, amountInCents, {
      type: 'stripe',
      stripe_payment_id: stripePaymentId,
    });
    sendViaMailgunMock.mockClear();

    await processTopupForOrganization(testUser.id, testOrganization.id, amountInCents, {
      type: 'stripe',
      stripe_payment_id: stripePaymentId,
    });

    const updatedOrg = await db.query.organizations.findFirst({
      where: eq(organizations.id, testOrganization.id),
    });
    expect(updatedOrg?.total_microdollars_acquired).toBe(
      testOrganization.total_microdollars_acquired + expectedBalanceIncrease
    );

    const transactions = await db.query.credit_transactions.findMany({
      where: and(
        eq(credit_transactions.organization_id, testOrganization.id),
        eq(credit_transactions.stripe_payment_id, stripePaymentId)
      ),
    });
    expect(transactions).toHaveLength(1);

    const auditLogs = await db.query.organization_audit_logs.findMany({
      where: and(
        eq(organization_audit_logs.organization_id, testOrganization.id),
        eq(organization_audit_logs.action, 'organization.purchase_credits')
      ),
    });
    expect(auditLogs).toHaveLength(1);

    const emailMarkers = await getOrganizationTopUpEmailMarkers(stripePaymentId);
    expect(emailMarkers).toHaveLength(1);
    expect(sendViaMailgunMock).not.toHaveBeenCalled();
  });

  test('duplicate payment id recovers missing org top-up email marker using original purchase date', async () => {
    const amountInCents = 5000;
    const stripePaymentId = 'pi_test_org_topup_email_recovery';

    await processTopupForOrganization(testUser.id, testOrganization.id, amountInCents, {
      type: 'stripe',
      stripe_payment_id: stripePaymentId,
    });
    const [creditTransaction] = await db
      .update(credit_transactions)
      .set({ created_at: '2026-01-07T08:30:00.000Z' })
      .where(eq(credit_transactions.stripe_payment_id, stripePaymentId))
      .returning({ createdAt: credit_transactions.created_at });

    const [storedCreditTransaction] = await db
      .select({ createdAt: credit_transactions.created_at })
      .from(credit_transactions)
      .where(eq(credit_transactions.stripe_payment_id, stripePaymentId))
      .limit(1);
    expect(creditTransaction).toEqual(storedCreditTransaction);
    if (!creditTransaction) throw new Error('Expected credit transaction to be created');

    await db
      .delete(transactional_email_log)
      .where(eq(transactional_email_log.idempotency_key, stripePaymentId));
    sendViaMailgunMock.mockClear();

    await processTopupForOrganization(testUser.id, testOrganization.id, amountInCents, {
      type: 'stripe',
      stripe_payment_id: stripePaymentId,
    });

    expect(sendViaMailgunMock).toHaveBeenCalledTimes(1);
    const [topUpEmail] = sendViaMailgunMock.mock.calls[0];
    expect(topUpEmail.subject).toBe('Your Kilo org credit top-up');
    expect(topUpEmail.html).toContain(formatUtcDate(new Date(creditTransaction.createdAt)));

    const emailMarkers = await getOrganizationTopUpEmailMarkers(stripePaymentId);
    expect(emailMarkers).toHaveLength(1);

    const updatedOrg = await db.query.organizations.findFirst({
      where: eq(organizations.id, testOrganization.id),
    });
    expect(updatedOrg?.total_microdollars_acquired).toBe(
      testOrganization.total_microdollars_acquired + amountInCents * 10_000
    );
  });

  test('duplicate payment id skips email for a different organization when no matching credit transaction exists', async () => {
    const otherUser = await insertTestUser();
    const otherOrganization = await createOrganization('Other Organization', otherUser.id);
    const amountInCents = 5000;
    const stripePaymentId = 'pi_test_cross_org_duplicate_payment';

    await processTopupForOrganization(otherUser.id, otherOrganization.id, amountInCents, {
      type: 'stripe',
      stripe_payment_id: stripePaymentId,
    });
    await db
      .delete(transactional_email_log)
      .where(eq(transactional_email_log.idempotency_key, stripePaymentId));
    sendViaMailgunMock.mockClear();

    await processTopupForOrganization(testUser.id, testOrganization.id, amountInCents, {
      type: 'stripe',
      stripe_payment_id: stripePaymentId,
    });

    const updatedOrg = await db.query.organizations.findFirst({
      where: eq(organizations.id, testOrganization.id),
    });
    expect(updatedOrg?.total_microdollars_acquired).toBe(
      testOrganization.total_microdollars_acquired
    );
    expect(sendViaMailgunMock).not.toHaveBeenCalled();

    const emailMarkers = await db.query.transactional_email_log.findMany({
      where: eq(transactional_email_log.idempotency_key, stripePaymentId),
    });
    expect(emailMarkers).toHaveLength(0);
  });

  test('duplicate payment id skips email for same organization when amount does not match existing credit transaction', async () => {
    const amountInCents = 5000;
    const stripePaymentId = 'pi_test_org_duplicate_amount_mismatch';

    await processTopupForOrganization(testUser.id, testOrganization.id, amountInCents, {
      type: 'stripe',
      stripe_payment_id: stripePaymentId,
    });
    await db
      .delete(transactional_email_log)
      .where(eq(transactional_email_log.idempotency_key, stripePaymentId));
    sendViaMailgunMock.mockClear();

    await processTopupForOrganization(testUser.id, testOrganization.id, amountInCents + 100, {
      type: 'stripe',
      stripe_payment_id: stripePaymentId,
    });

    const updatedOrg = await db.query.organizations.findFirst({
      where: eq(organizations.id, testOrganization.id),
    });
    expect(updatedOrg?.total_microdollars_acquired).toBe(
      testOrganization.total_microdollars_acquired + amountInCents * 10_000
    );
    expect(sendViaMailgunMock).not.toHaveBeenCalled();

    const emailMarkers = await db.query.transactional_email_log.findMany({
      where: eq(transactional_email_log.idempotency_key, stripePaymentId),
    });
    expect(emailMarkers).toHaveLength(0);
  });

  test('should handle multiple topups correctly', async () => {
    const firstAmount = 2500; // $25
    const secondAmount = 7500; // $75
    const stripePaymentId1 = 'pi_test_first_123';
    const stripePaymentId2 = 'pi_test_second_456';

    const initialBalance =
      testOrganization.total_microdollars_acquired - testOrganization.microdollars_used;

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
    const computedBalance =
      (updatedOrg?.total_microdollars_acquired ?? 0) - (updatedOrg?.microdollars_used ?? 0);
    expect(computedBalance).toBe(initialBalance + expectedTotalIncrease);
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
      .set({ total_microdollars_acquired: existingBalance })
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
    const computedBalance =
      (updatedOrg?.total_microdollars_acquired ?? 0) - (updatedOrg?.microdollars_used ?? 0);
    expect(computedBalance).toBe(existingBalance + expectedBalanceIncrease);
    expect(updatedOrg?.total_microdollars_acquired).toBe(existingBalance + expectedBalanceIncrease);
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
    const initialBalance =
      testOrganization.total_microdollars_acquired - testOrganization.microdollars_used;

    await processTopupForOrganization(testUser.id, testOrganization.id, amountInCents, {
      type: 'stripe',
      stripe_payment_id: 'pi_test_zero_amount',
    });

    // Verify balance remains unchanged
    const updatedOrg = await db.query.organizations.findFirst({
      where: eq(organizations.id, testOrganization.id),
    });

    const computedBalanceZero =
      (updatedOrg?.total_microdollars_acquired ?? 0) - (updatedOrg?.microdollars_used ?? 0);
    expect(computedBalanceZero).toBe(initialBalance);

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
