import { describe, test, expect, beforeEach } from '@jest/globals';
import { handleSubscriptionEvent } from '@/lib/organizations/organization-seats';
import type { User, Organization, CreditTransaction } from '@/db/schema';
import {
  organization_seats_purchases,
  organization_memberships,
  organizations,
  credit_transactions,
} from '@/db/schema';
import { db } from '@/lib/drizzle';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { eq, and } from 'drizzle-orm';
import type Stripe from 'stripe';
import { createOrganization } from '@/lib/organizations/organizations';
import { toMicrodollars } from '@/lib/utils';
import { STRIPE_TEAMS_SUBSCRIPTION_PRODUCT_ID } from '@/lib/config.server';

// Validate required environment variables at module load time
if (STRIPE_TEAMS_SUBSCRIPTION_PRODUCT_ID?.trim() === '') {
  throw new Error(
    'STRIPE_TEAMS_SUBSCRIPTION_PRODUCT_ID must be set in test environment (.env.test)'
  );
}

// Helper function to create a mock Stripe subscription
function createMockSubscription(overrides: Partial<Stripe.Subscription> = {}): Stripe.Subscription {
  const baseSubscription = {
    id: `sub_test_${Math.random().toString(36).substring(7)}`,
    object: 'subscription',
    application: null,
    application_fee_percent: null,
    automatic_tax: {
      enabled: false,
      liability: null,
      disabled_reason: null,
    },
    billing_cycle_anchor: 1234567890,
    billing_thresholds: null,
    cancel_at: null,
    cancel_at_period_end: false,
    canceled_at: null,
    cancellation_details: null,
    collection_method: 'charge_automatically',
    created: 1234567890,
    currency: 'usd',
    customer: 'cus_test_customer',
    days_until_due: null,
    default_payment_method: null,
    default_source: null,
    default_tax_rates: [],
    description: null,
    discounts: [],
    ended_at: null,
    invoice_settings: {
      issuer: { type: 'self' },
      account_tax_ids: null,
    },
    items: {
      object: 'list',
      data: [
        {
          id: 'si_test_item',
          object: 'subscription_item',
          billing_thresholds: null,
          created: 1234567890,
          metadata: {},
          discounts: [],
          plan: {
            id: 'plan_test',
            object: 'plan',
            active: true,
            amount: 1000,
            amount_decimal: '1000',
            billing_scheme: 'per_unit',
            created: 1234567890,
            currency: 'usd',
            interval: 'month',
            interval_count: 1,
            livemode: false,
            metadata: {},
            meter: null,
            nickname: null,
            product: 'prod_test',
            tiers_mode: null,
            transform_usage: null,
            trial_period_days: null,
            usage_type: 'licensed',
          },
          price: {
            id: 'price_test',
            object: 'price',
            active: true,
            billing_scheme: 'per_unit',
            created: 1234567890,
            currency: 'usd',
            custom_unit_amount: null,
            livemode: false,
            lookup_key: null,
            metadata: {},
            nickname: null,
            product: 'prod_test',
            recurring: {
              interval: 'month',
              interval_count: 1,
              trial_period_days: null,
              usage_type: 'licensed',
              meter: null,
            },
            tax_behavior: 'unspecified',
            tiers_mode: null,
            transform_quantity: null,
            type: 'recurring',
            unit_amount: 1000, // $10.00 in cents
            unit_amount_decimal: '1000',
          },
          quantity: 5,
          subscription: 'sub_test',
          tax_rates: [],
          current_period_end: 1234567890 + 2592000,
          current_period_start: 1234567890,
        },
      ],
      has_more: false,
      url: '/v1/subscription_items',
    },
    latest_invoice: null,
    livemode: false,
    metadata: {
      type: 'organization_seats',
      kiloUserId: 'test-user-123',
      organizationId: 'org-test-123',
      seats: '5',
    },
    next_pending_invoice_item_invoice: null,
    on_behalf_of: null,
    pause_collection: null,
    payment_settings: {
      payment_method_options: null,
      payment_method_types: null,
      save_default_payment_method: 'off',
    },
    pending_invoice_item_interval: null,
    pending_setup_intent: null,
    pending_update: null,
    schedule: null,
    start_date: 1234567890,
    status: 'active',
    test_clock: null,
    transfer_data: null,
    trial_end: null,
    trial_settings: { end_behavior: { missing_payment_method: 'create_invoice' } },
    trial_start: null,
    ...overrides,
  } as Stripe.Subscription;

  return { ...baseSubscription, ...overrides };
}

// Helper function to get credit transactions for an organization
async function getCreditTransactionsForOrg(organizationId: string): Promise<CreditTransaction[]> {
  return await db
    .select()
    .from(credit_transactions)
    .where(eq(credit_transactions.organization_id, organizationId));
}

// Helper function to get organization balance
async function getOrganizationBalance(organizationId: string): Promise<number> {
  const org = await db
    .select({
      total_microdollars_acquired: organizations.total_microdollars_acquired,
      microdollars_used: organizations.microdollars_used,
    })
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .then(rows => rows[0]);
  return (org?.total_microdollars_acquired ?? 0) - (org?.microdollars_used ?? 0);
}

describe('handleSubscriptionEvent', () => {
  let testUser: User;
  let testOrganization: Organization;
  let mockSubscription: Stripe.Subscription;

  beforeEach(async () => {
    testUser = await insertTestUser();
    testOrganization = await createOrganization('Test Organization', testUser.id);

    mockSubscription = createMockSubscription({
      metadata: {
        type: 'organization_seats',
        kiloUserId: testUser.id,
        organizationId: testOrganization.id,
        seats: '5',
      },
    });
  });

  test.skip('should create a new organization seat purchase record and grant credits', async () => {
    const idempotencyKey = 'test-idempotency-key-1';

    // Get initial balance
    const initialBalance = await getOrganizationBalance(testOrganization.id);

    await handleSubscriptionEvent(mockSubscription, idempotencyKey, true);

    const purchases = await db
      .select()
      .from(organization_seats_purchases)
      .where(eq(organization_seats_purchases.idempotency_key, idempotencyKey));

    expect(purchases).toHaveLength(1);
    expect(purchases[0].subscription_stripe_id).toBe(mockSubscription.id);
    expect(purchases[0].organization_id).toBe(testOrganization.id);
    expect(purchases[0].seat_count).toBe(5);
    expect(purchases[0].amount_usd).toBe(50); // 5 seats * $10.00
    expect(purchases[0].idempotency_key).toBe(idempotencyKey);
    expect(purchases[0].subscription_status).toBe('active');

    // Check that credit transaction was created (first subscription in interval)
    const creditTransactions = await getCreditTransactionsForOrg(testOrganization.id);
    expect(creditTransactions).toHaveLength(1);
    expect(creditTransactions[0].amount_microdollars).toBe(toMicrodollars(5 * 20)); // 5 seats * $20
    expect(creditTransactions[0].is_free).toBe(true);
    expect(creditTransactions[0].description).toBe('Seats credit for 5 seats');
    expect(creditTransactions[0].organization_id).toBe(testOrganization.id);
    expect(creditTransactions[0].kilo_user_id).toBe(testUser.id);

    // Check that organization balance was updated
    const finalBalance = await getOrganizationBalance(testOrganization.id);
    expect(finalBalance).toBe(initialBalance + toMicrodollars(5 * 20));
  });

  test.skip('should not create duplicate records with same idempotency key and not grant duplicate credits', async () => {
    const idempotencyKey = 'test-idempotency-key-duplicate';

    // Get initial balance
    const initialBalance = await getOrganizationBalance(testOrganization.id);

    // First call
    await handleSubscriptionEvent(mockSubscription, idempotencyKey, true);

    // Second call with same idempotency key
    await handleSubscriptionEvent(mockSubscription, idempotencyKey);

    const purchases = await db
      .select()
      .from(organization_seats_purchases)
      .where(eq(organization_seats_purchases.idempotency_key, idempotencyKey));

    expect(purchases).toHaveLength(1);

    // Check that only one credit transaction was created
    const creditTransactions = await getCreditTransactionsForOrg(testOrganization.id);
    expect(creditTransactions).toHaveLength(1);

    // Check that balance was only updated once
    const finalBalance = await getOrganizationBalance(testOrganization.id);
    expect(finalBalance).toBe(initialBalance + toMicrodollars(5 * 20));
  });

  test('should generate auto idempotency key when not provided', async () => {
    await handleSubscriptionEvent(mockSubscription, undefined);

    const purchases = await db
      .select()
      .from(organization_seats_purchases)
      .where(eq(organization_seats_purchases.organization_id, testOrganization.id));

    expect(purchases).toHaveLength(1);
    expect(purchases[0].idempotency_key).toBeDefined();
    expect(purchases[0].subscription_status).toBe('active');
  });

  test('should always add user as owner regardless of event type', async () => {
    const newUser = await insertTestUser();
    const newOrganization = await createOrganization('New Organization');

    const subscription = createMockSubscription({
      metadata: {
        type: 'organization_seats',
        kiloUserId: newUser.id,
        organizationId: newOrganization.id,
        seats: '3',
      },
    });

    // Test with isSubscriptionCreateEvent = false (should still add as owner)
    await handleSubscriptionEvent(subscription, 'test-always-owner');

    // Check that user was added as owner
    const membership = await db
      .select()
      .from(organization_memberships)
      .where(
        and(
          eq(organization_memberships.organization_id, newOrganization.id),
          eq(organization_memberships.kilo_user_id, newUser.id)
        )
      );

    expect(membership).toHaveLength(1);
    expect(membership[0].role).toBe('owner');
  });

  test('should handle different seat counts and pricing correctly', async () => {
    const subscription = createMockSubscription({
      metadata: {
        type: 'organization_seats',
        kiloUserId: testUser.id,
        organizationId: testOrganization.id,
        seats: '10',
      },
      items: {
        object: 'list',
        data: [
          {
            ...mockSubscription.items.data[0],
            quantity: 10,
            price: {
              ...mockSubscription.items.data[0].price,
              unit_amount: 1500, // $15.00 in cents
            },
          },
        ],
        has_more: false,
        url: '/v1/subscription_items',
      },
    });

    await handleSubscriptionEvent(subscription, 'test-pricing');

    const purchases = await db
      .select()
      .from(organization_seats_purchases)
      .where(eq(organization_seats_purchases.idempotency_key, 'test-pricing'));

    expect(purchases).toHaveLength(1);
    expect(purchases[0].seat_count).toBe(10);
    expect(purchases[0].amount_usd).toBe(150); // 10 seats * $15.00
    expect(purchases[0].subscription_status).toBe('active');
  });

  test('should handle zero quantity gracefully', async () => {
    const subscription = createMockSubscription({
      metadata: {
        type: 'organization_seats',
        kiloUserId: testUser.id,
        organizationId: testOrganization.id,
        seats: '1', // Use 1 instead of 0 since schema requires positive number
      },
      items: {
        object: 'list',
        data: [
          {
            ...mockSubscription.items.data[0],
            quantity: 0, // But quantity can be 0
          },
        ],
        has_more: false,
        url: '/v1/subscription_items',
      },
    });

    await handleSubscriptionEvent(subscription, 'test-zero-quantity');

    const purchases = await db
      .select()
      .from(organization_seats_purchases)
      .where(eq(organization_seats_purchases.idempotency_key, 'test-zero-quantity'));

    expect(purchases).toHaveLength(1);
    expect(purchases[0].seat_count).toBe(0);
    expect(purchases[0].amount_usd).toBe(0);
  });

  test('should handle missing unit_amount gracefully', async () => {
    const subscription = createMockSubscription({
      metadata: {
        type: 'organization_seats',
        kiloUserId: testUser.id,
        organizationId: testOrganization.id,
        seats: '5',
      },
      items: {
        object: 'list',
        data: [
          {
            ...mockSubscription.items.data[0],
            price: {
              ...mockSubscription.items.data[0].price,
              unit_amount: null,
            },
          },
        ],
        has_more: false,
        url: '/v1/subscription_items',
      },
    });

    await handleSubscriptionEvent(subscription, 'test-no-amount');

    const purchases = await db
      .select()
      .from(organization_seats_purchases)
      .where(eq(organization_seats_purchases.idempotency_key, 'test-no-amount'));

    expect(purchases).toHaveLength(1);
    expect(purchases[0].amount_usd).toBe(0);
  });

  test('should throw error when no line items exist', async () => {
    const subscription = createMockSubscription({
      items: {
        object: 'list',
        data: [],
        has_more: false,
        url: '/v1/subscription_items',
      },
    });

    await expect(handleSubscriptionEvent(subscription, 'test-no-items')).rejects.toThrow(
      'No period end found in invoice line items'
    );
  });

  test('should throw error when line item has no current_period_end', async () => {
    const subscription = createMockSubscription({
      items: {
        object: 'list',
        data: [
          {
            ...mockSubscription.items.data[0],
            current_period_end: null as unknown as number,
          },
        ],
        has_more: false,
        url: '/v1/subscription_items',
      },
    });

    await expect(handleSubscriptionEvent(subscription, 'test-no-period-end')).rejects.toThrow(
      'No period end found in invoice line items'
    );
  });

  test('should correctly parse expires_at from current_period_end', async () => {
    const periodEnd = Math.floor(Date.now() / 1000) + 2592000; // 30 days from now
    const subscription = createMockSubscription({
      metadata: {
        type: 'organization_seats',
        kiloUserId: testUser.id,
        organizationId: testOrganization.id,
        seats: '5',
      },
      items: {
        object: 'list',
        data: [
          {
            ...mockSubscription.items.data[0],
            current_period_end: periodEnd,
          },
        ],
        has_more: false,
        url: '/v1/subscription_items',
      },
    });

    await handleSubscriptionEvent(subscription, 'test-expires-at');

    const purchases = await db
      .select()
      .from(organization_seats_purchases)
      .where(eq(organization_seats_purchases.idempotency_key, 'test-expires-at'));

    expect(purchases).toHaveLength(1);
    const expectedDate = new Date(periodEnd * 1000);
    const actualDate = new Date(purchases[0].expires_at);
    expect(actualDate.getTime()).toBe(expectedDate.getTime());
  });

  test('should handle concurrent calls with same idempotency key', async () => {
    const idempotencyKey = 'test-concurrent-calls';

    // Simulate concurrent calls
    const promises = [
      handleSubscriptionEvent(mockSubscription, idempotencyKey),
      handleSubscriptionEvent(mockSubscription, idempotencyKey),
      handleSubscriptionEvent(mockSubscription, idempotencyKey),
    ];

    await Promise.all(promises);

    const purchases = await db
      .select()
      .from(organization_seats_purchases)
      .where(eq(organization_seats_purchases.idempotency_key, idempotencyKey));

    // Should only have one record despite multiple concurrent calls
    expect(purchases).toHaveLength(1);
  });

  test('should validate subscription metadata schema', async () => {
    const invalidSubscription = createMockSubscription({
      metadata: {
        type: 'organization_seats',
        kiloUserId: testUser.id,
        organizationId: testOrganization.id,
        seats: 'invalid-number', // Invalid seats value
      },
    });

    await expect(
      handleSubscriptionEvent(invalidSubscription, 'test-invalid-metadata')
    ).rejects.toThrow();
  });

  test('should handle missing metadata gracefully', async () => {
    const subscriptionWithoutMetadata = createMockSubscription({
      metadata: {},
    });

    await expect(
      handleSubscriptionEvent(subscriptionWithoutMetadata, 'test-no-metadata')
    ).rejects.toThrow();
  });

  test('should zero out seat count and amount when subscription has ended_at value', async () => {
    const endedSubscription = createMockSubscription({
      metadata: {
        type: 'organization_seats',
        kiloUserId: testUser.id,
        organizationId: testOrganization.id,
        seats: '5',
      },
      ended_at: Math.floor(Date.now() / 1000), // Set ended_at to current timestamp
      status: 'canceled',
    });

    const idempotencyKey = 'test-ended-subscription';
    await handleSubscriptionEvent(endedSubscription, idempotencyKey);

    const purchases = await db
      .select()
      .from(organization_seats_purchases)
      .where(eq(organization_seats_purchases.idempotency_key, idempotencyKey));

    expect(purchases).toHaveLength(1);
    expect(purchases[0].subscription_stripe_id).toBe(endedSubscription.id);
    expect(purchases[0].organization_id).toBe(testOrganization.id);
    expect(purchases[0].seat_count).toBe(0); // Should be zeroed out
    expect(purchases[0].amount_usd).toBe(0); // Should be zeroed out
    expect(purchases[0].idempotency_key).toBe(idempotencyKey);
    expect(purchases[0].subscription_status).toBe('ended');
  });

  test('should handle ended subscription with high seat count and amount', async () => {
    const endedSubscription = createMockSubscription({
      metadata: {
        type: 'organization_seats',
        kiloUserId: testUser.id,
        organizationId: testOrganization.id,
        seats: '100', // High seat count
      },
      ended_at: Math.floor(Date.now() / 1000) - 3600, // Ended 1 hour ago
      status: 'canceled',
      items: {
        object: 'list',
        data: [
          {
            ...mockSubscription.items.data[0],
            quantity: 100, // High quantity
            price: {
              ...mockSubscription.items.data[0].price,
              unit_amount: 5000, // $50.00 per seat
            },
          },
        ],
        has_more: false,
        url: '/v1/subscription_items',
      },
    });

    const idempotencyKey = 'test-ended-high-value';
    await handleSubscriptionEvent(endedSubscription, idempotencyKey);

    const purchases = await db
      .select()
      .from(organization_seats_purchases)
      .where(eq(organization_seats_purchases.idempotency_key, idempotencyKey));

    expect(purchases).toHaveLength(1);
    // Even with high original values, should be zeroed out due to ended_at
    expect(purchases[0].seat_count).toBe(0);
    expect(purchases[0].amount_usd).toBe(0);
    expect(purchases[0].subscription_status).toBe('ended');
  });
});

describe('Organization seat count tracking', () => {
  let testUser: User;
  let testOrganization: Organization;

  beforeEach(async () => {
    testUser = await insertTestUser();
    testOrganization = await createOrganization('Test Organization', testUser.id);
  });

  test('should update organization seat_count when handling first subscription event', async () => {
    const subscription = createMockSubscription({
      metadata: {
        type: 'organization_seats',
        kiloUserId: testUser.id,
        organizationId: testOrganization.id,
        seats: '10',
      },
      items: {
        object: 'list',
        data: [
          {
            ...createMockSubscription().items.data[0],
            quantity: 10,
            current_period_start: Math.floor(Date.now() / 1000),
            current_period_end: Math.floor(Date.now() / 1000) + 2592000,
          },
        ],
        has_more: false,
        url: '/v1/subscription_items',
      },
    });

    await handleSubscriptionEvent(subscription, 'test-first-subscription');

    // Check that organization seat_count was updated
    const updatedOrg = await db
      .select()
      .from(organizations)
      .where(eq(organizations.id, testOrganization.id))
      .then(rows => rows[0]);

    expect(updatedOrg.seat_count).toBe(10);
  });

  test('should immediately grant seats when upgrading (higher seat count)', async () => {
    const baseTime = Math.floor(Date.now() / 1000);

    // First subscription with 5 seats
    const firstSubscription = createMockSubscription({
      metadata: {
        type: 'organization_seats',
        kiloUserId: testUser.id,
        organizationId: testOrganization.id,
        seats: '5',
      },
      items: {
        object: 'list',
        data: [
          {
            ...createMockSubscription().items.data[0],
            quantity: 5,
            current_period_start: baseTime,
            current_period_end: baseTime + 2592000,
          },
        ],
        has_more: false,
        url: '/v1/subscription_items',
      },
    });

    await handleSubscriptionEvent(firstSubscription, 'test-first-5-seats');

    // Verify organization has 5 seats
    let updatedOrg = await db
      .select()
      .from(organizations)
      .where(eq(organizations.id, testOrganization.id))
      .then(rows => rows[0]);
    expect(updatedOrg.seat_count).toBe(5);

    // Upgrade to 15 seats with a more recent starts_at (immediate upgrade)
    const upgradeSubscription = createMockSubscription({
      metadata: {
        type: 'organization_seats',
        kiloUserId: testUser.id,
        organizationId: testOrganization.id,
        seats: '15',
      },
      items: {
        object: 'list',
        data: [
          {
            ...createMockSubscription().items.data[0],
            quantity: 15,
            current_period_start: baseTime + 1000, // More recent starts_at
            current_period_end: baseTime + 2592000 + 1000,
          },
        ],
        has_more: false,
        url: '/v1/subscription_items',
      },
    });

    await handleSubscriptionEvent(upgradeSubscription, 'test-upgrade-15-seats');

    // Should immediately grant 15 seats since it has more recent starts_at
    updatedOrg = await db
      .select()
      .from(organizations)
      .where(eq(organizations.id, testOrganization.id))
      .then(rows => rows[0]);
    expect(updatedOrg.seat_count).toBe(15);
  });

  test('should not downgrade seats until next billing cycle (more recent starts_at)', async () => {
    const baseTime = Math.floor(Date.now() / 1000);

    // First subscription with 20 seats
    const firstSubscription = createMockSubscription({
      metadata: {
        type: 'organization_seats',
        kiloUserId: testUser.id,
        organizationId: testOrganization.id,
        seats: '20',
        planType: 'teams',
      },
      items: {
        object: 'list',
        data: [
          {
            ...createMockSubscription().items.data[0],
            quantity: 20,
            current_period_start: baseTime,
            current_period_end: baseTime + 2592000,
          },
        ],
        has_more: false,
        url: '/v1/subscription_items',
      },
    });

    await handleSubscriptionEvent(firstSubscription, 'test-first-20-seats');

    // Verify organization has 20 seats
    let updatedOrg = await db
      .select()
      .from(organizations)
      .where(eq(organizations.id, testOrganization.id))
      .then(rows => rows[0]);
    expect(updatedOrg.seat_count).toBe(20);

    // Downgrade to 8 seats in the same billing period (same starts_at)
    const downgradeSubscription = createMockSubscription({
      metadata: {
        type: 'organization_seats',
        kiloUserId: testUser.id,
        organizationId: testOrganization.id,
        seats: '8',
        planType: 'teams',
      },
      items: {
        object: 'list',
        data: [
          {
            ...createMockSubscription().items.data[0],
            quantity: 8,
            current_period_start: baseTime, // Same billing period
            current_period_end: baseTime + 2592000,
          },
        ],
        has_more: false,
        url: '/v1/subscription_items',
      },
    });

    await handleSubscriptionEvent(downgradeSubscription, 'test-downgrade-8-seats');

    // Should still have 20 seats (no downgrade in same billing period)
    updatedOrg = await db
      .select()
      .from(organizations)
      .where(eq(organizations.id, testOrganization.id))
      .then(rows => rows[0]);
    expect(updatedOrg.seat_count).toBe(20);

    // Now simulate next billing cycle with lower seat count
    const nextBillingCycleSubscription = createMockSubscription({
      metadata: {
        type: 'organization_seats',
        kiloUserId: testUser.id,
        organizationId: testOrganization.id,
        seats: '8',
      },
      items: {
        object: 'list',
        data: [
          {
            ...createMockSubscription().items.data[0],
            quantity: 8,
            current_period_start: baseTime + 2592000, // Next billing period
            current_period_end: baseTime + 5184000,
          },
        ],
        has_more: false,
        url: '/v1/subscription_items',
      },
    });

    await handleSubscriptionEvent(nextBillingCycleSubscription, 'test-next-billing-8-seats');

    // Now should downgrade to 8 seats
    updatedOrg = await db
      .select()
      .from(organizations)
      .where(eq(organizations.id, testOrganization.id))
      .then(rows => rows[0]);
    expect(updatedOrg.seat_count).toBe(8);
  });

  test('should handle multiple subscription events and use most recent starts_at', async () => {
    const baseTime = Math.floor(Date.now() / 1000);

    // Create multiple subscription events with different starts_at dates
    const subscriptions = [
      {
        seats: 10,
        starts_at: baseTime,
        idempotency: 'test-multi-1',
      },
      {
        seats: 15,
        starts_at: baseTime + 1000, // 1000 seconds later
        idempotency: 'test-multi-2',
      },
      {
        seats: 5,
        starts_at: baseTime + 500, // Between the other two
        idempotency: 'test-multi-3',
      },
      {
        seats: 25,
        starts_at: baseTime + 2000, // Most recent
        idempotency: 'test-multi-4',
      },
    ];

    // Process all subscriptions
    for (const sub of subscriptions) {
      const subscription = createMockSubscription({
        metadata: {
          type: 'organization_seats',
          kiloUserId: testUser.id,
          organizationId: testOrganization.id,
          seats: sub.seats.toString(),
        },
        items: {
          object: 'list',
          data: [
            {
              ...createMockSubscription().items.data[0],
              quantity: sub.seats,
              current_period_start: sub.starts_at,
              current_period_end: sub.starts_at + 2592000,
            },
          ],
          has_more: false,
          url: '/v1/subscription_items',
        },
      });

      await handleSubscriptionEvent(subscription, sub.idempotency);
    }

    // Should use the seat count from the most recent starts_at (25 seats)
    const updatedOrg = await db
      .select()
      .from(organizations)
      .where(eq(organizations.id, testOrganization.id))
      .then(rows => rows[0]);
    expect(updatedOrg.seat_count).toBe(25);
  });

  test('should handle zero seats correctly', async () => {
    const baseTime = Math.floor(Date.now() / 1000);

    // First give some seats
    const firstSubscription = createMockSubscription({
      metadata: {
        type: 'organization_seats',
        kiloUserId: testUser.id,
        organizationId: testOrganization.id,
        seats: '10',
      },
      items: {
        object: 'list',
        data: [
          {
            ...createMockSubscription().items.data[0],
            quantity: 10,
            current_period_start: baseTime,
            current_period_end: baseTime + 2592000,
          },
        ],
        has_more: false,
        url: '/v1/subscription_items',
      },
    });

    await handleSubscriptionEvent(firstSubscription, 'test-zero-first');

    // Then simulate subscription cancellation (zero seats) in next billing cycle
    const canceledSubscription = createMockSubscription({
      metadata: {
        type: 'organization_seats',
        kiloUserId: testUser.id,
        organizationId: testOrganization.id,
        seats: '1', // Metadata still needs positive number
      },
      ended_at: baseTime + 2592000 + 1000, // Subscription ended
      items: {
        object: 'list',
        data: [
          {
            ...createMockSubscription().items.data[0],
            quantity: 0, // But quantity can be 0
            current_period_start: baseTime + 2592000,
            current_period_end: baseTime + 5184000,
          },
        ],
        has_more: false,
        url: '/v1/subscription_items',
      },
    });

    await handleSubscriptionEvent(canceledSubscription, 'test-zero-canceled');

    // Should now have 0 seats
    const updatedOrg = await db
      .select()
      .from(organizations)
      .where(eq(organizations.id, testOrganization.id))
      .then(rows => rows[0]);
    expect(updatedOrg.seat_count).toBe(0);
  });

  test('should handle same starts_at with different seat counts (use latest processed)', async () => {
    const baseTime = Math.floor(Date.now() / 1000);

    // Two subscriptions with same starts_at but different seat counts
    const firstSubscription = createMockSubscription({
      metadata: {
        type: 'organization_seats',
        kiloUserId: testUser.id,
        organizationId: testOrganization.id,
        seats: '10',
      },
      items: {
        object: 'list',
        data: [
          {
            ...createMockSubscription().items.data[0],
            quantity: 10,
            current_period_start: baseTime,
            current_period_end: baseTime + 2592000,
          },
        ],
        has_more: false,
        url: '/v1/subscription_items',
      },
    });

    const secondSubscription = createMockSubscription({
      metadata: {
        type: 'organization_seats',
        kiloUserId: testUser.id,
        organizationId: testOrganization.id,
        seats: '15',
      },
      items: {
        object: 'list',
        data: [
          {
            ...createMockSubscription().items.data[0],
            quantity: 15,
            current_period_start: baseTime, // Same starts_at
            current_period_end: baseTime + 2592000,
          },
        ],
        has_more: false,
        url: '/v1/subscription_items',
      },
    });

    await handleSubscriptionEvent(firstSubscription, 'test-same-starts-1');
    await handleSubscriptionEvent(secondSubscription, 'test-same-starts-2');

    // With same starts_at, the query will return one of them (database dependent)
    // The important thing is that it uses the seat count from the most recent starts_at
    const updatedOrg = await db
      .select()
      .from(organizations)
      .where(eq(organizations.id, testOrganization.id))
      .then(rows => rows[0]);

    // Should be either 10 or 15, depending on which record the database returns first
    // when multiple records have the same starts_at
    expect([10, 15]).toContain(updatedOrg.seat_count);
  });

  test('should maintain seat count consistency across transaction', async () => {
    const baseTime = Math.floor(Date.now() / 1000);

    const subscription = createMockSubscription({
      metadata: {
        type: 'organization_seats',
        kiloUserId: testUser.id,
        organizationId: testOrganization.id,
        seats: '12',
      },
      items: {
        object: 'list',
        data: [
          {
            ...createMockSubscription().items.data[0],
            quantity: 12,
            current_period_start: baseTime,
            current_period_end: baseTime + 2592000,
          },
        ],
        has_more: false,
        url: '/v1/subscription_items',
      },
    });

    await handleSubscriptionEvent(subscription, 'test-transaction-consistency');

    // Verify both the purchase record and organization seat count are consistent
    const [purchase, organization] = await Promise.all([
      db
        .select()
        .from(organization_seats_purchases)
        .where(eq(organization_seats_purchases.idempotency_key, 'test-transaction-consistency'))
        .then(rows => rows[0]),
      db
        .select()
        .from(organizations)
        .where(eq(organizations.id, testOrganization.id))
        .then(rows => rows[0]),
    ]);

    expect(purchase.seat_count).toBe(12);
    expect(organization.seat_count).toBe(12);
  });

  test('should handle complex scenario: upgrade, downgrade, then upgrade again', async () => {
    const baseTime = Math.floor(Date.now() / 1000);

    // Start with 5 seats
    const initialSubscription = createMockSubscription({
      metadata: {
        type: 'organization_seats',
        kiloUserId: testUser.id,
        organizationId: testOrganization.id,
        seats: '5',
      },
      items: {
        object: 'list',
        data: [
          {
            ...createMockSubscription().items.data[0],
            quantity: 5,
            current_period_start: baseTime,
            current_period_end: baseTime + 2592000,
          },
        ],
        has_more: false,
        url: '/v1/subscription_items',
      },
    });

    await handleSubscriptionEvent(initialSubscription, 'test-complex-1');

    // Upgrade to 20 seats (more recent starts_at)
    const upgradeSubscription = createMockSubscription({
      metadata: {
        type: 'organization_seats',
        kiloUserId: testUser.id,
        organizationId: testOrganization.id,
        seats: '20',
      },
      items: {
        object: 'list',
        data: [
          {
            ...createMockSubscription().items.data[0],
            quantity: 20,
            current_period_start: baseTime + 1000,
            current_period_end: baseTime + 2592000 + 1000,
          },
        ],
        has_more: false,
        url: '/v1/subscription_items',
      },
    });

    await handleSubscriptionEvent(upgradeSubscription, 'test-complex-2');

    // Should have 20 seats
    let updatedOrg = await db
      .select()
      .from(organizations)
      .where(eq(organizations.id, testOrganization.id))
      .then(rows => rows[0]);
    expect(updatedOrg.seat_count).toBe(20);

    // Downgrade to 3 seats (even more recent starts_at)
    const downgradeSubscription = createMockSubscription({
      metadata: {
        type: 'organization_seats',
        kiloUserId: testUser.id,
        organizationId: testOrganization.id,
        seats: '3',
      },
      items: {
        object: 'list',
        data: [
          {
            ...createMockSubscription().items.data[0],
            quantity: 3,
            current_period_start: baseTime + 2000,
            current_period_end: baseTime + 2592000 + 2000,
          },
        ],
        has_more: false,
        url: '/v1/subscription_items',
      },
    });

    await handleSubscriptionEvent(downgradeSubscription, 'test-complex-3');

    // Should now have 3 seats
    updatedOrg = await db
      .select()
      .from(organizations)
      .where(eq(organizations.id, testOrganization.id))
      .then(rows => rows[0]);
    expect(updatedOrg.seat_count).toBe(3);

    // Upgrade again to 25 seats (most recent starts_at)
    const finalUpgradeSubscription = createMockSubscription({
      metadata: {
        type: 'organization_seats',
        kiloUserId: testUser.id,
        organizationId: testOrganization.id,
        seats: '25',
      },
      items: {
        object: 'list',
        data: [
          {
            ...createMockSubscription().items.data[0],
            quantity: 25,
            current_period_start: baseTime + 3000,
            current_period_end: baseTime + 2592000 + 3000,
          },
        ],
        has_more: false,
        url: '/v1/subscription_items',
      },
    });

    await handleSubscriptionEvent(finalUpgradeSubscription, 'test-complex-4');

    // Should have 25 seats
    updatedOrg = await db
      .select()
      .from(organizations)
      .where(eq(organizations.id, testOrganization.id))
      .then(rows => rows[0]);
    expect(updatedOrg.seat_count).toBe(25);
  });

  test('should handle out-of-order subscription events correctly', async () => {
    const baseTime = Math.floor(Date.now() / 1000);

    // Process events out of chronological order
    // Event 3: Most recent (should be final result)
    const futureSubscription = createMockSubscription({
      metadata: {
        type: 'organization_seats',
        kiloUserId: testUser.id,
        organizationId: testOrganization.id,
        seats: '30',
        planType: 'teams',
      },
      items: {
        object: 'list',
        data: [
          {
            ...createMockSubscription().items.data[0],
            quantity: 30,
            current_period_start: baseTime + 5000, // Most recent
            current_period_end: baseTime + 2592000 + 5000,
          },
        ],
        has_more: false,
        url: '/v1/subscription_items',
      },
    });

    // Event 1: Oldest
    const oldSubscription = createMockSubscription({
      metadata: {
        type: 'organization_seats',
        kiloUserId: testUser.id,
        organizationId: testOrganization.id,
        seats: '10',
        planType: 'teams',
      },
      items: {
        object: 'list',
        data: [
          {
            ...createMockSubscription().items.data[0],
            quantity: 10,
            current_period_start: baseTime, // Oldest
            current_period_end: baseTime + 2592000,
          },
        ],
        has_more: false,
        url: '/v1/subscription_items',
      },
    });

    // Event 2: Middle
    const middleSubscription = createMockSubscription({
      metadata: {
        type: 'organization_seats',
        kiloUserId: testUser.id,
        organizationId: testOrganization.id,
        seats: '20',
        planType: 'teams',
      },
      items: {
        object: 'list',
        data: [
          {
            ...createMockSubscription().items.data[0],
            quantity: 20,
            current_period_start: baseTime + 2500, // Middle
            current_period_end: baseTime + 2592000 + 2500,
          },
        ],
        has_more: false,
        url: '/v1/subscription_items',
      },
    });

    // Process in non-chronological order: future, old, middle
    await handleSubscriptionEvent(futureSubscription, 'test-order-1');
    await handleSubscriptionEvent(oldSubscription, 'test-order-2');
    await handleSubscriptionEvent(middleSubscription, 'test-order-3');

    // Should always use the most recent starts_at (30 seats)
    const updatedOrg = await db
      .select()
      .from(organizations)
      .where(eq(organizations.id, testOrganization.id))
      .then(rows => rows[0]);
    expect(updatedOrg.seat_count).toBe(30);
  });

  test('should handle subscription with very old starts_at after newer ones', async () => {
    const baseTime = Math.floor(Date.now() / 1000);

    // First, create a recent subscription
    const recentSubscription = createMockSubscription({
      metadata: {
        type: 'organization_seats',
        kiloUserId: testUser.id,
        organizationId: testOrganization.id,
        seats: '15',
        planType: 'teams',
      },
      items: {
        object: 'list',
        data: [
          {
            ...createMockSubscription().items.data[0],
            quantity: 15,
            current_period_start: baseTime + 1000,
            current_period_end: baseTime + 2592000 + 1000,
          },
        ],
        has_more: false,
        url: '/v1/subscription_items',
      },
    });

    await handleSubscriptionEvent(recentSubscription, 'test-old-starts-1');

    // Verify we have 15 seats
    let updatedOrg = await db
      .select()
      .from(organizations)
      .where(eq(organizations.id, testOrganization.id))
      .then(rows => rows[0]);
    expect(updatedOrg.seat_count).toBe(15);

    // Now process a subscription with much older starts_at
    const oldSubscription = createMockSubscription({
      metadata: {
        type: 'organization_seats',
        kiloUserId: testUser.id,
        organizationId: testOrganization.id,
        seats: '50',
        planType: 'teams',
      },
      items: {
        object: 'list',
        data: [
          {
            ...createMockSubscription().items.data[0],
            quantity: 50,
            current_period_start: baseTime - 10000, // Much older
            current_period_end: baseTime - 10000 + 2592000,
          },
        ],
        has_more: false,
        url: '/v1/subscription_items',
      },
    });

    await handleSubscriptionEvent(oldSubscription, 'test-old-starts-2');

    // Should still have 15 seats (from more recent starts_at)
    updatedOrg = await db
      .select()
      .from(organizations)
      .where(eq(organizations.id, testOrganization.id))
      .then(rows => rows[0]);
    expect(updatedOrg.seat_count).toBe(15);
  });

  test.skip('should NOT grant credits for subsequent subscription updates in same interval', async () => {
    const baseTime = Math.floor(Date.now() / 1000);
    const initialBalance = await getOrganizationBalance(testOrganization.id);

    // First subscription event (should grant credits)
    const firstSubscription = createMockSubscription({
      metadata: {
        type: 'organization_seats',
        kiloUserId: testUser.id,
        organizationId: testOrganization.id,
        seats: '5',
      },
      items: {
        object: 'list',
        data: [
          {
            ...createMockSubscription().items.data[0],
            quantity: 5,
            current_period_start: baseTime,
            current_period_end: baseTime + 2592000,
          },
        ],
        has_more: false,
        url: '/v1/subscription_items',
      },
    });

    await handleSubscriptionEvent(firstSubscription, 'test-first-credits', true);

    // Check credits were granted for first subscription
    let creditTransactions = await getCreditTransactionsForOrg(testOrganization.id);
    expect(creditTransactions).toHaveLength(1);
    expect(creditTransactions[0].amount_microdollars).toBe(toMicrodollars(5 * 20));

    const currentBalance = await getOrganizationBalance(testOrganization.id);
    expect(currentBalance).toBe(initialBalance + toMicrodollars(5 * 20));

    // Second subscription event with SAME starts_at (should NOT grant credits)
    const secondSubscription = createMockSubscription({
      id: `sub_test_${Math.random().toString(36).substring(7)}`, // Different subscription ID
      metadata: {
        type: 'organization_seats',
        kiloUserId: testUser.id,
        organizationId: testOrganization.id,
        seats: '8', // Different seat count
      },
      items: {
        object: 'list',
        data: [
          {
            ...createMockSubscription().items.data[0],
            quantity: 8,
            current_period_start: baseTime, // SAME starts_at
            current_period_end: baseTime + 2592000,
          },
        ],
        has_more: false,
        url: '/v1/subscription_items',
      },
    });

    await handleSubscriptionEvent(secondSubscription, 'test-second-no-credits');

    // Check that NO additional credits were granted
    creditTransactions = await getCreditTransactionsForOrg(testOrganization.id);
    expect(creditTransactions).toHaveLength(1); // Still only 1 credit transaction

    // Check that balance didn't change
    const finalBalance = await getOrganizationBalance(testOrganization.id);
    expect(finalBalance).toBe(currentBalance); // Same as before second subscription
  });

  test.skip('should grant credits for new billing cycle but not for updates within same cycle', async () => {
    const baseTime = Math.floor(Date.now() / 1000);
    const initialBalance = await getOrganizationBalance(testOrganization.id);

    // First billing cycle - should grant credits
    const firstCycleSubscription = createMockSubscription({
      metadata: {
        type: 'organization_seats',
        kiloUserId: testUser.id,
        organizationId: testOrganization.id,
        seats: '3',
      },
      items: {
        object: 'list',
        data: [
          {
            ...createMockSubscription().items.data[0],
            quantity: 3,
            current_period_start: baseTime,
            current_period_end: baseTime + 2592000,
          },
        ],
        has_more: false,
        url: '/v1/subscription_items',
      },
    });

    await handleSubscriptionEvent(firstCycleSubscription, 'test-cycle1-credits', true);

    // Check credits were granted
    let creditTransactions = await getCreditTransactionsForOrg(testOrganization.id);
    expect(creditTransactions).toHaveLength(1);
    expect(creditTransactions[0].amount_microdollars).toBe(toMicrodollars(3 * 20));

    let currentBalance = await getOrganizationBalance(testOrganization.id);
    expect(currentBalance).toBe(initialBalance + toMicrodollars(3 * 20));

    // Update within same cycle - should NOT grant credits
    const sameCycleUpdate = createMockSubscription({
      id: `sub_test_${Math.random().toString(36).substring(7)}`,
      metadata: {
        type: 'organization_seats',
        kiloUserId: testUser.id,
        organizationId: testOrganization.id,
        seats: '5',
      },
      items: {
        object: 'list',
        data: [
          {
            ...createMockSubscription().items.data[0],
            quantity: 5,
            current_period_start: baseTime, // Same cycle
            current_period_end: baseTime + 2592000,
          },
        ],
        has_more: false,
        url: '/v1/subscription_items',
      },
    });

    await handleSubscriptionEvent(sameCycleUpdate, 'test-cycle1-update');

    // No additional credits
    creditTransactions = await getCreditTransactionsForOrg(testOrganization.id);
    expect(creditTransactions).toHaveLength(1);

    currentBalance = await getOrganizationBalance(testOrganization.id);
    expect(currentBalance).toBe(initialBalance + toMicrodollars(3 * 20));

    // Next billing cycle - should grant credits again
    const nextCycleSubscription = createMockSubscription({
      id: `sub_test_${Math.random().toString(36).substring(7)}`,
      metadata: {
        type: 'organization_seats',
        kiloUserId: testUser.id,
        organizationId: testOrganization.id,
        seats: '7',
      },
      items: {
        object: 'list',
        data: [
          {
            ...createMockSubscription().items.data[0],
            quantity: 7,
            current_period_start: baseTime + 2592000, // Next cycle
            current_period_end: baseTime + 5184000,
          },
        ],
        has_more: false,
        url: '/v1/subscription_items',
      },
    });

    await handleSubscriptionEvent(nextCycleSubscription, 'test-cycle2-credits', true);

    // Should have 2 credit transactions now
    creditTransactions = await getCreditTransactionsForOrg(testOrganization.id);
    expect(creditTransactions).toHaveLength(2);

    // Find the new credit transaction
    const newCreditTransaction = creditTransactions.find(ct =>
      ct.credit_category?.includes(nextCycleSubscription.id)
    );
    expect(newCreditTransaction).toBeDefined();
    expect(newCreditTransaction!.amount_microdollars).toBe(toMicrodollars(7 * 20));

    // Balance should include both credit grants
    const finalBalance = await getOrganizationBalance(testOrganization.id);
    expect(finalBalance).toBe(initialBalance + toMicrodollars(3 * 20) + toMicrodollars(7 * 20));
  });

  test('should not grant credits when subscription has ended', async () => {
    const initialBalance = await getOrganizationBalance(testOrganization.id);

    const endedSubscription = createMockSubscription({
      metadata: {
        type: 'organization_seats',
        kiloUserId: testUser.id,
        organizationId: testOrganization.id,
        seats: '10',
      },
      ended_at: Math.floor(Date.now() / 1000), // Subscription ended
      status: 'canceled',
    });

    await handleSubscriptionEvent(endedSubscription, 'test-ended-no-credits');

    // No credits should be granted for ended subscriptions
    const creditTransactions = await getCreditTransactionsForOrg(testOrganization.id);
    expect(creditTransactions).toHaveLength(0);

    // Balance should remain unchanged
    const finalBalance = await getOrganizationBalance(testOrganization.id);
    expect(finalBalance).toBe(initialBalance);
  });

  test('should not grant credits when seat count is zero', async () => {
    const initialBalance = await getOrganizationBalance(testOrganization.id);

    const zeroSeatsSubscription = createMockSubscription({
      metadata: {
        type: 'organization_seats',
        kiloUserId: testUser.id,
        organizationId: testOrganization.id,
        seats: '1', // Metadata needs positive number
      },
      items: {
        object: 'list',
        data: [
          {
            ...createMockSubscription().items.data[0],
            quantity: 0, // But actual quantity is 0
          },
        ],
        has_more: false,
        url: '/v1/subscription_items',
      },
    });

    await handleSubscriptionEvent(zeroSeatsSubscription, 'test-zero-seats-no-credits');

    // No credits should be granted for zero seats
    const creditTransactions = await getCreditTransactionsForOrg(testOrganization.id);
    expect(creditTransactions).toHaveLength(0);

    // Balance should remain unchanged
    const finalBalance = await getOrganizationBalance(testOrganization.id);
    expect(finalBalance).toBe(initialBalance);
  });
});

describe('Organization plan type updates from subscription', () => {
  let testUser: User;
  let testOrganization: Organization;

  beforeEach(async () => {
    testUser = await insertTestUser();
    testOrganization = await createOrganization('Test Organization', testUser.id);
  });

  test('should update organization plan from enterprise to teams when teams subscription is purchased', async () => {
    // Set organization to enterprise plan initially (simulating enterprise trial)
    await db
      .update(organizations)
      .set({ plan: 'enterprise' })
      .where(eq(organizations.id, testOrganization.id));

    const base = createMockSubscription();
    const baseItem = base.items.data[0];
    const teamsSubscription = createMockSubscription({
      metadata: {
        type: 'stripe-checkout-seats',
        kiloUserId: testUser.id,
        organizationId: testOrganization.id,
        seats: '5',
        planType: 'teams',
      },
      items: {
        ...base.items,
        data: [
          {
            ...baseItem,
            quantity: 5,
            current_period_start: Math.floor(Date.now() / 1000),
            current_period_end: Math.floor(Date.now() / 1000) + 2592000,
            price: {
              ...baseItem.price,
              product: STRIPE_TEAMS_SUBSCRIPTION_PRODUCT_ID,
            },
            plan: {
              ...baseItem.plan,
              product: STRIPE_TEAMS_SUBSCRIPTION_PRODUCT_ID,
            },
          },
        ],
      },
    });

    // Handle the subscription event (simulating checkout completion)
    await handleSubscriptionEvent(teamsSubscription, 'test-teams-subscription', true);

    // Verify organization plan was updated to teams
    const updatedOrg = await db
      .select()
      .from(organizations)
      .where(eq(organizations.id, testOrganization.id))
      .then(rows => rows[0]);

    expect(updatedOrg.plan).toBe('teams');
    expect(updatedOrg.seat_count).toBe(5);
  });
});
