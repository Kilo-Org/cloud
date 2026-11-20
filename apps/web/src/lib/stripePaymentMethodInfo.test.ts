import Stripe from 'stripe';

jest.mock('@kilocode/web-shared/lib/stripe-client', () => ({
  client: {
    paymentMethods: {
      retrieve: jest.fn(),
    },
  },
}));

import { client } from '@kilocode/web-shared/lib/stripe-client';
import { retrievePaymentMethodInfo } from './stripePaymentMethodInfo';

const mockRetrieve = client.paymentMethods.retrieve as jest.Mock;

describe('retrievePaymentMethodInfo', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns null for a null id without calling Stripe', async () => {
    await expect(retrievePaymentMethodInfo(null)).resolves.toBeNull();
    expect(mockRetrieve).not.toHaveBeenCalled();
  });

  it('returns null for an undefined id without calling Stripe', async () => {
    await expect(retrievePaymentMethodInfo(undefined)).resolves.toBeNull();
    expect(mockRetrieve).not.toHaveBeenCalled();
  });

  it('returns null when Stripe reports the resource is missing', async () => {
    mockRetrieve.mockRejectedValue(
      new Stripe.errors.StripeInvalidRequestError({
        type: 'invalid_request_error',
        code: 'resource_missing',
        message: 'No such payment method',
      })
    );

    await expect(retrievePaymentMethodInfo('pm_missing')).resolves.toBeNull();
  });

  it('rethrows a Stripe authentication failure', async () => {
    const error = new Stripe.errors.StripeAuthenticationError({
      type: 'authentication_error',
      message: 'Invalid API Key',
    });
    mockRetrieve.mockRejectedValue(error);

    await expect(retrievePaymentMethodInfo('pm_123')).rejects.toBe(error);
  });

  it('rethrows a plain error', async () => {
    mockRetrieve.mockRejectedValue(new Error('boom'));

    await expect(retrievePaymentMethodInfo('pm_123')).rejects.toThrow('boom');
  });

  it('maps a payment method to its info fields', async () => {
    mockRetrieve.mockResolvedValue({
      id: 'pm_123',
      type: 'card',
      card: { last4: '4242', brand: 'visa' },
      link: { email: 'test@example.test' },
    });

    await expect(retrievePaymentMethodInfo('pm_123')).resolves.toEqual({
      type: 'card',
      last4: '4242',
      brand: 'visa',
      linkEmail: 'test@example.test',
      stripePaymentMethodId: 'pm_123',
    });
  });
});
