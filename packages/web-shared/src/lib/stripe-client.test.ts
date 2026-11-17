jest.mock('stripe', () => {
  const list = jest.fn();
  const del = jest.fn();
  return {
    __esModule: true,
    default: jest.fn(() => ({ paymentMethods: { list }, customers: { del } })),
    __mock: { list, del },
  };
});

jest.mock('@sentry/nextjs', () => ({ captureMessage: jest.fn() }));

let client: Awaited<ReturnType<typeof loadStripeClient>>;
let mockList: jest.Mock;
let mockDel: jest.Mock;
let mockCaptureMessage: jest.Mock;

// `skipStripeApi` is read once when the module loads, and the local test env
// turns it on (apps/web/.env.test.local). Reload the module with the real
// calls enabled, so the Stripe answers below are the ones under test.
async function loadStripeClient() {
  process.env.SKIP_STRIPE_API = 'false';
  jest.resetModules();
  const stripeModule = await import('@kilocode/web-shared/lib/stripe-client');
  ({ list: mockList, del: mockDel } = (
    jest.requireMock('stripe') as { __mock: { list: jest.Mock; del: jest.Mock } }
  ).__mock);
  mockCaptureMessage = (jest.requireMock('@sentry/nextjs') as { captureMessage: jest.Mock })
    .captureMessage;
  return stripeModule;
}

beforeEach(async () => {
  client = await loadStripeClient();
});

/** What Stripe throws for an id its account does not contain. */
function noSuchCustomer(customerId: string): Error {
  return Object.assign(new Error(`No such customer: '${customerId}'`), {
    type: 'StripeInvalidRequestError',
    code: 'resource_missing',
    statusCode: 404,
  });
}

describe('client', () => {
  it('retries transient Stripe failures more than the SDK default, within a bound', () => {
    const StripeConstructor = (jest.requireMock('stripe') as { default: jest.Mock }).default;

    expect(StripeConstructor).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ apiVersion: '2026-09-30.endive', maxNetworkRetries: 4 })
    );
  });
});

describe('hasPaymentMethodInStripe', () => {
  it('reports a payment method on file', async () => {
    mockList.mockResolvedValue({ data: [{ id: 'pm_1' }] });

    await expect(client.hasPaymentMethodInStripe({ stripeCustomerId: 'cus_live' })).resolves.toBe(
      true
    );
    expect(mockList).toHaveBeenCalledWith({ customer: 'cus_live', type: 'card' });
  });

  it('reports no payment method when Stripe returns none', async () => {
    mockList.mockResolvedValue({ data: [] });

    await expect(client.hasPaymentMethodInStripe({ stripeCustomerId: 'cus_live' })).resolves.toBe(
      false
    );
  });

  // Regression: the profile page reads this on every request, so a stored id
  // Stripe no longer knows (deleted customer, or a database pointing at a
  // different Stripe account) threw out of the server render and replaced the
  // whole profile with "Something went wrong".
  it('treats a customer Stripe does not know as no payment method', async () => {
    mockList.mockRejectedValue(noSuchCustomer('cus_setup_smoke_abc'));

    await expect(
      client.hasPaymentMethodInStripe({ stripeCustomerId: 'cus_setup_smoke_abc' })
    ).resolves.toBe(false);
    expect(mockCaptureMessage).toHaveBeenCalled();
  });

  it('reports an unknown customer once per cached answer', async () => {
    mockList.mockRejectedValue(noSuchCustomer('cus_setup_smoke_abc'));

    await client.hasPaymentMethodInStripe({ stripeCustomerId: 'cus_setup_smoke_abc' });
    await client.hasPaymentMethodInStripe({ stripeCustomerId: 'cus_setup_smoke_abc' });

    expect(mockList).toHaveBeenCalledTimes(1);
    expect(mockCaptureMessage).toHaveBeenCalledTimes(1);
  });

  it('still surfaces every other Stripe failure', async () => {
    mockList.mockRejectedValue(new Error('Invalid API Key provided'));

    await expect(client.hasPaymentMethodInStripe({ stripeCustomerId: 'cus_live' })).rejects.toThrow(
      'Invalid API Key provided'
    );
  });

  it('answers the second lookup for a customer without a Stripe call', async () => {
    mockList.mockResolvedValue({ data: [{ id: 'pm_1' }] });

    await expect(client.hasPaymentMethodInStripe({ stripeCustomerId: 'cus_warm' })).resolves.toBe(
      true
    );
    await expect(client.hasPaymentMethodInStripe({ stripeCustomerId: 'cus_warm' })).resolves.toBe(
      true
    );
    expect(mockList).toHaveBeenCalledTimes(1);

    // The cache is per customer: another id still goes to Stripe.
    mockList.mockResolvedValue({ data: [] });
    await expect(client.hasPaymentMethodInStripe({ stripeCustomerId: 'cus_other' })).resolves.toBe(
      false
    );
    expect(mockList).toHaveBeenCalledTimes(2);
  });

  it('does not cache a rejected lookup', async () => {
    mockList
      .mockRejectedValueOnce(new Error('Invalid API Key provided'))
      .mockResolvedValueOnce({ data: [{ id: 'pm_1' }] });

    await expect(
      client.hasPaymentMethodInStripe({ stripeCustomerId: 'cus_flaky' })
    ).rejects.toThrow('Invalid API Key provided');
    await expect(client.hasPaymentMethodInStripe({ stripeCustomerId: 'cus_flaky' })).resolves.toBe(
      true
    );
    expect(mockList).toHaveBeenCalledTimes(2);
  });

  it('serves a changed answer after the customer is invalidated', async () => {
    mockList.mockResolvedValue({ data: [{ id: 'pm_1' }] });
    await client.hasPaymentMethodInStripe({ stripeCustomerId: 'cus_changing' });

    mockList.mockResolvedValue({ data: [] });
    client.invalidateStripePaymentMethodCache('cus_changing');

    await expect(
      client.hasPaymentMethodInStripe({ stripeCustomerId: 'cus_changing' })
    ).resolves.toBe(false);
    expect(mockList).toHaveBeenCalledTimes(2);
  });

  it('asks Stripe again once the cached answer expires', async () => {
    const now = jest.spyOn(Date, 'now');
    try {
      now.mockReturnValue(new Date('2026-01-01T00:00:00Z').getTime());
      mockList.mockResolvedValue({ data: [{ id: 'pm_1' }] });
      await client.hasPaymentMethodInStripe({ stripeCustomerId: 'cus_expiring' });

      mockList.mockResolvedValue({ data: [] });
      now.mockReturnValue(new Date('2026-01-01T00:05:00Z').getTime());

      await expect(
        client.hasPaymentMethodInStripe({ stripeCustomerId: 'cus_expiring' })
      ).resolves.toBe(false);
      expect(mockList).toHaveBeenCalledTimes(2);
    } finally {
      now.mockRestore();
    }
  });
});

describe('safeDeleteStripeCustomer', () => {
  it('continues when the customer is already gone', async () => {
    mockDel.mockRejectedValue(noSuchCustomer('cus_gone'));

    await expect(client.safeDeleteStripeCustomer('cus_gone')).resolves.toBeUndefined();
  });

  it('still surfaces every other Stripe failure', async () => {
    mockDel.mockRejectedValue(new Error('Invalid API Key provided'));

    await expect(client.safeDeleteStripeCustomer('cus_gone')).rejects.toThrow(
      'Invalid API Key provided'
    );
  });
});
