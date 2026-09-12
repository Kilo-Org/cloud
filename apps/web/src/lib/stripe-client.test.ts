const mockPaymentMethodsList = jest.fn();

jest.mock('stripe', () => ({
  __esModule: true,
  default: jest.fn(() => ({
    paymentMethods: { list: mockPaymentMethodsList },
  })),
}));

jest.mock('@sentry/nextjs', () => ({
  captureMessage: jest.fn(),
}));

describe('hasPaymentMethodInStripe', () => {
  beforeAll(() => {
    if (!process.env.STRIPE_SECRET_KEY) {
      process.env.STRIPE_SECRET_KEY = 'sk_test_has_payment_method';
    }
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('reports a card when the customer has one', async () => {
    mockPaymentMethodsList.mockResolvedValue({ data: [{ id: 'pm_1' }] });
    const { hasPaymentMethodInStripe } = await import('./stripe-client');

    await expect(hasPaymentMethodInStripe({ stripeCustomerId: 'cus_with_card' })).resolves.toBe(
      true
    );
    expect(mockPaymentMethodsList).toHaveBeenCalledWith({
      customer: 'cus_with_card',
      type: 'card',
    });
  });

  it('reports no card when the customer exists but has none', async () => {
    mockPaymentMethodsList.mockResolvedValue({ data: [] });
    const { hasPaymentMethodInStripe } = await import('./stripe-client');

    await expect(hasPaymentMethodInStripe({ stripeCustomerId: 'cus_no_card' })).resolves.toBe(
      false
    );
  });

  it('reports no card when the Stripe customer no longer exists', async () => {
    mockPaymentMethodsList.mockRejectedValue({
      type: 'StripeInvalidRequestError',
      code: 'resource_missing',
      message: "No such customer: 'cus_deleted'",
    });
    const { hasPaymentMethodInStripe } = await import('./stripe-client');

    await expect(hasPaymentMethodInStripe({ stripeCustomerId: 'cus_deleted' })).resolves.toBe(
      false
    );
  });

  it('rethrows unrelated Stripe errors', async () => {
    mockPaymentMethodsList.mockRejectedValue(new Error('network down'));
    const { hasPaymentMethodInStripe } = await import('./stripe-client');

    await expect(hasPaymentMethodInStripe({ stripeCustomerId: 'cus_ok' })).rejects.toThrow(
      'network down'
    );
  });
});
