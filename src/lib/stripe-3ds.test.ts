import Stripe from 'stripe';
import { randomUUID } from 'crypto';

// Mock stripe-client before importing handleUpdateSeatCount
jest.mock('@/lib/stripe-client', () => ({
  client: {
    subscriptions: {
      retrieve: jest.fn(),
      update: jest.fn(),
    },
    invoices: {
      retrieve: jest.fn(),
    },
  },
}));

// Mock organization-seats to avoid DB calls
jest.mock('@/lib/organizations/organization-seats', () => ({
  handleSubscriptionEvent: jest.fn().mockResolvedValue(undefined),
}));

import { handleUpdateSeatCount, KNOWN_SEAT_PRICE_IDS } from './stripe';
import { client } from '@/lib/stripe-client';

// Get references to the mocked functions after import
const mockSubscriptionsRetrieve = client.subscriptions.retrieve as jest.Mock;
const mockSubscriptionsUpdate = client.subscriptions.update as jest.Mock;

describe('handleUpdateSeatCount with 3DS', () => {
  const mockSubscriptionId = 'sub_test_123';
  const mockItemId = 'si_test_456';

  beforeEach(() => {
    jest.clearAllMocks();
    KNOWN_SEAT_PRICE_IDS.add('price_test_seat');
  });

  afterEach(() => {
    KNOWN_SEAT_PRICE_IDS.delete('price_test_seat');
  });

  it('returns success when seat update completes without 3DS', async () => {
    const mockSubscription = {
      id: mockSubscriptionId,
      items: {
        data: [{ id: mockItemId, quantity: 5, price: { id: 'price_test_seat' } }],
      },
      latest_invoice: 'inv_test_789',
    };

    mockSubscriptionsRetrieve.mockResolvedValue(mockSubscription);
    mockSubscriptionsUpdate.mockResolvedValue({
      ...mockSubscription,
      items: { data: [{ id: mockItemId, quantity: 10, price: { id: 'price_test_seat' } }] },
    });

    const result = await handleUpdateSeatCount(mockSubscriptionId, 10, 5);

    expect(result).toEqual({
      success: true,
      message: 'Subscription updated to 10 seats successfully.',
    });
    expect(result.requiresAction).toBeUndefined();
    expect(result.paymentIntentClientSecret).toBeUndefined();
  });

  it('returns requiresAction when 3DS authentication is needed', async () => {
    const mockSubscription = {
      id: mockSubscriptionId,
      items: {
        data: [{ id: mockItemId, quantity: 5, price: { id: 'price_test_seat' } }],
      },
      latest_invoice: 'inv_test_789',
    };

    const mockPaymentIntentClientSecret = `pi_${randomUUID()}_secret_test`;

    // First call: initial retrieve before update
    // Second call: re-retrieve after 3DS error with expanded invoice
    mockSubscriptionsRetrieve.mockResolvedValueOnce(mockSubscription).mockResolvedValueOnce({
      ...mockSubscription,
      latest_invoice: {
        id: 'inv_test_789',
        payment_intent: {
          id: `pi_${randomUUID()}`,
          status: 'requires_action',
          client_secret: mockPaymentIntentClientSecret,
        },
      },
    });

    // Simulate Stripe throwing a card error requiring 3DS
    // Use Object.assign to set the code property which is checked in the handler
    const stripeError = Object.assign(
      new Stripe.errors.StripeCardError({
        type: 'card_error',
        message: 'Payment requires additional authentication',
      }),
      { code: 'subscription_payment_intent_requires_action' }
    );

    mockSubscriptionsUpdate.mockRejectedValue(stripeError);

    const result = await handleUpdateSeatCount(mockSubscriptionId, 10, 5);

    expect(result).toEqual({
      success: false,
      message:
        'Payment requires additional authentication. Please complete the verification process.',
      requiresAction: true,
      paymentIntentClientSecret: mockPaymentIntentClientSecret,
    });
  });

  it('throws other Stripe errors', async () => {
    const mockSubscription = {
      id: mockSubscriptionId,
      items: {
        data: [{ id: mockItemId, quantity: 5, price: { id: 'price_test_seat' } }],
      },
      latest_invoice: 'inv_test_789',
    };

    mockSubscriptionsRetrieve.mockResolvedValue(mockSubscription);

    // Simulate a different Stripe error (not 3DS related)
    const stripeError = Object.assign(
      new Stripe.errors.StripeCardError({
        type: 'card_error',
        message: 'Your card was declined',
      }),
      { code: 'card_declined' }
    );

    mockSubscriptionsUpdate.mockRejectedValue(stripeError);

    await expect(handleUpdateSeatCount(mockSubscriptionId, 10, 5)).rejects.toThrow(
      'Your card was declined'
    );
  });

  it('does not invoke proration behavior for seat decreases', async () => {
    const mockSubscription = {
      id: mockSubscriptionId,
      items: {
        data: [{ id: mockItemId, quantity: 10, price: { id: 'price_test_seat' } }],
      },
      latest_invoice: 'inv_test_789',
    };

    mockSubscriptionsRetrieve.mockResolvedValue(mockSubscription);
    mockSubscriptionsUpdate.mockResolvedValue({
      ...mockSubscription,
      items: { data: [{ id: mockItemId, quantity: 5, price: { id: 'price_test_seat' } }] },
    });

    const result = await handleUpdateSeatCount(mockSubscriptionId, 5, 10);

    // Verify the update was called with proration_behavior: 'none' for decreases
    expect(mockSubscriptionsUpdate).toHaveBeenCalledWith(
      mockSubscriptionId,
      expect.objectContaining({
        proration_behavior: 'none',
        payment_behavior: undefined,
      }),
      expect.any(Object)
    );

    expect(result.success).toBe(true);
  });

  it('invokes proration behavior for seat increases', async () => {
    const mockSubscription = {
      id: mockSubscriptionId,
      items: {
        data: [{ id: mockItemId, quantity: 5, price: { id: 'price_test_seat' } }],
      },
      latest_invoice: 'inv_test_789',
    };

    mockSubscriptionsRetrieve.mockResolvedValue(mockSubscription);
    mockSubscriptionsUpdate.mockResolvedValue({
      ...mockSubscription,
      items: { data: [{ id: mockItemId, quantity: 10, price: { id: 'price_test_seat' } }] },
    });

    await handleUpdateSeatCount(mockSubscriptionId, 10, 5);

    // Verify the update was called with proration_behavior: 'always_invoice'
    // and payment_behavior: 'allow_incomplete' for increases
    expect(mockSubscriptionsUpdate).toHaveBeenCalledWith(
      mockSubscriptionId,
      expect.objectContaining({
        proration_behavior: 'always_invoice',
        payment_behavior: 'allow_incomplete',
      }),
      expect.any(Object)
    );
  });

  it('throws when subscription has no items', async () => {
    const mockSubscription = {
      id: mockSubscriptionId,
      items: {
        data: [],
      },
    };

    mockSubscriptionsRetrieve.mockResolvedValue(mockSubscription);

    await expect(handleUpdateSeatCount(mockSubscriptionId, 10, 5)).rejects.toThrow(
      `No recognized paid seat item found in subscription ${mockSubscriptionId}`
    );
  });
});
