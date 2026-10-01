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
  const stripeModule = await import('@/lib/stripe-client');
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

  it('still surfaces every other Stripe failure', async () => {
    mockList.mockRejectedValue(new Error('Invalid API Key provided'));

    await expect(client.hasPaymentMethodInStripe({ stripeCustomerId: 'cus_live' })).rejects.toThrow(
      'Invalid API Key provided'
    );
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
