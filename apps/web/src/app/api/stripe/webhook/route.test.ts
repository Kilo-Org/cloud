import Stripe from 'stripe';
import { headers } from 'next/headers';
import { captureException } from '@sentry/nextjs';
import { client } from '@kilocode/web-shared/lib/stripe-client';
import { processStripePaymentEventHook } from '@/lib/stripe';
import { POST } from './route';

jest.mock('next/headers', () => ({ headers: jest.fn() }));
jest.mock('@sentry/nextjs', () => ({ captureException: jest.fn() }));
jest.mock('@/lib/stripe', () => ({ processStripePaymentEventHook: jest.fn() }));
jest.mock('@kilocode/web-shared/lib/dotenvx', () => ({
  getEnvVariable: () => 'whsec_local_fixture',
}));

const secret = 'whsec_local_fixture';
const body = JSON.stringify({
  id: 'evt_local_fixture',
  object: 'event',
  type: 'checkout.session.completed',
  data: { object: { id: 'cs_local_fixture' } },
});

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
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test.each([
    null,
    'fixture',
    client.webhooks.generateTestHeaderString({ payload: body, secret: 'whsec_other_fixture' }),
  ])('applies the request response contract %#', async signature => {
    const response = await deliver(body, signature);
    expect(response.status).toBe(400);
    expect(await response.text()).toBe('Webhook Error');
    expect(processStripePaymentEventHook).not.toHaveBeenCalled();
    expect(captureException).not.toHaveBeenCalled();
  });

  test('acknowledges event delivery', async () => {
    const response = await deliver();
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('OK');
    expect(processStripePaymentEventHook).toHaveBeenCalledWith(JSON.parse(body));
    expect(captureException).not.toHaveBeenCalled();
  });

  test.each([
    new Error('local processing failure'),
    new Stripe.errors.StripeSignatureVerificationError('fixture', body, {
      message: 'local processing failure',
    }),
  ])('retains processing diagnostics %#', async error => {
    jest.mocked(processStripePaymentEventHook).mockRejectedValueOnce(error);
    const response = await deliver();
    expect(response.status).toBe(400);
    expect(await response.text()).toBe('Webhook Error: local processing failure');
    expect(captureException).toHaveBeenCalledTimes(1);
    expect(captureException).toHaveBeenCalledWith(error);
  });

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
