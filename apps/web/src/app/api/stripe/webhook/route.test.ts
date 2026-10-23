import Stripe from 'stripe';
import { headers } from 'next/headers';
import { captureException } from '@sentry/nextjs';
import { client } from '@kilocode/web-shared/lib/stripe-client';
import { getEnvVariable } from '@kilocode/web-shared/lib/dotenvx';
import { processStripePaymentEventHook } from '@/lib/stripe';
import { POST } from './route';

jest.mock('next/headers', () => ({ headers: jest.fn() }));
jest.mock('@sentry/nextjs', () => ({ captureException: jest.fn() }));
jest.mock('@/lib/stripe', () => ({ processStripePaymentEventHook: jest.fn() }));
jest.mock('@kilocode/web-shared/lib/dotenvx', () => ({
  getEnvVariable: jest.fn((key: string) =>
    key === 'STRIPE_WEBHOOK_SECRET' ? 'whsec_local_fixture' : 'local_fixture'
  ),
}));

const secret = 'whsec_local_fixture';
const body = JSON.stringify({
  id: 'evt_local_fixture',
  object: 'event',
  type: 'checkout.session.completed',
  data: { object: { id: 'cs_local_fixture' } },
});

function signatureError(): Stripe.errors.StripeSignatureVerificationError {
  try {
    client.webhooks.constructEvent(body, 'fixture', secret);
  } catch (error) {
    if (error instanceof Stripe.errors.StripeSignatureVerificationError) {
      return error;
    }
    throw error;
  }
  throw new Error('Expected SDK verification error');
}

async function deliver(
  payload = body,
  signature: string | null = client.webhooks.generateTestHeaderString({ payload, secret })
) {
  jest
    .mocked(headers)
    .mockResolvedValue(new Headers(signature === null ? {} : { 'stripe-signature': signature }));
  return POST(
    new Request('http://localhost/api/stripe/webhook', { method: 'POST', body: payload })
  );
}

describe('Stripe webhook responses', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(processStripePaymentEventHook).mockResolvedValue(undefined);
    jest
      .mocked(getEnvVariable)
      .mockImplementation((key: string) =>
        key === 'STRIPE_WEBHOOK_SECRET' ? secret : 'local_fixture'
      );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test.each([
    null,
    'fixture',
    client.webhooks.generateTestHeaderString({ payload: body, secret: 'whsec_other_fixture' }),
    client.webhooks.generateTestHeaderString({
      payload: body,
      secret,
      timestamp: Math.floor(Date.now() / 1000) - 3600,
    }),
  ])('applies the request response contract %#', async signature => {
    const response = await deliver(body, signature);
    expect(response.status).toBe(400);
    expect(await response.text()).toBe('Webhook Error');
    expect(processStripePaymentEventHook).not.toHaveBeenCalled();
    expect(captureException).not.toHaveBeenCalled();
  });

  test('refuses delivery when the signing secret is not configured', async () => {
    jest
      .mocked(getEnvVariable)
      .mockImplementation((key: string) =>
        key === 'STRIPE_WEBHOOK_SECRET' ? '' : 'local_fixture'
      );
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});

    const response = await deliver();

    expect(response.status).toBe(500);
    expect(await response.text()).toBe('Missing STRIPE_WEBHOOK_SECRET');
    expect(processStripePaymentEventHook).not.toHaveBeenCalled();
    expect(captureException).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalledWith('STRIPE_WEBHOOK_SECRET is not set');
  });

  test('acknowledges event delivery', async () => {
    const response = await deliver();
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('OK');
    expect(processStripePaymentEventHook).toHaveBeenCalledWith(JSON.parse(body));
    expect(captureException).not.toHaveBeenCalled();
  });

  test.each([new Error('local processing failure'), signatureError()])(
    'retains processing diagnostics %#',
    async error => {
      jest.mocked(processStripePaymentEventHook).mockRejectedValueOnce(error);
      const response = await deliver();
      expect(response.status).toBe(400);
      expect(await response.text()).toBe(`Webhook Error: ${error.message}`);
      expect(captureException).toHaveBeenCalledTimes(1);
      expect(captureException).toHaveBeenCalledWith(error);
    }
  );

  test('retains unexpected diagnostics', async () => {
    const error = new Error('local verification failure');
    jest.spyOn(client.webhooks, 'constructEvent').mockImplementationOnce(() => {
      throw error;
    });
    const response = await deliver();
    expect(response.status).toBe(400);
    expect(await response.text()).toBe('Webhook Error: local verification failure');
    expect(captureException).toHaveBeenCalledWith(error);
    expect(processStripePaymentEventHook).not.toHaveBeenCalled();
  });
});
