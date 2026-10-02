import { beforeAll, afterEach, describe, expect, it, jest } from '@jest/globals';

const mockConfigState = { bouncerUrl: 'https://bouncer.example.com' as string | null };

jest.mock('@/lib/config.server', () => ({
  get BOUNCER_URL() {
    return mockConfigState.bouncerUrl;
  },
  INTERNAL_API_SECRET: 'test-internal-secret',
}));

import type * as BouncerClient from '@/lib/bouncer/client';

// SWC + static ESM imports do not see jest.mock replacements on the same module id, so the client
// is loaded after the config mock is registered (same convention as the store-completion tests).
let deliverCreditEvent: typeof BouncerClient.deliverCreditEvent;
let decide: typeof BouncerClient.decide;

beforeAll(() => {
  ({ deliverCreditEvent, decide } =
    jest.requireActual<typeof BouncerClient>('@/lib/bouncer/client'));
});

const mockFetch = jest.fn() as jest.MockedFunction<typeof fetch>;
global.fetch = mockFetch;

afterEach(() => {
  mockFetch.mockReset();
  mockConfigState.bouncerUrl = 'https://bouncer.example.com';
  jest.restoreAllMocks();
});

describe('deliverCreditEvent', () => {
  it('reports a real 2xx success as delivered', async () => {
    mockFetch.mockResolvedValue(Response.json({}));
    await expect(
      deliverCreditEvent({ type: 'charge.failed', eventId: 'evt-1', userId: 'user-1' })
    ).resolves.toEqual({ delivered: true, status: 200 });
    const [url] = mockFetch.mock.calls[0] ?? [];
    expect(url).toBe('https://bouncer.example.com/api/v2/credit-event');
  });

  it('classifies a network error as a retryable failure', async () => {
    mockFetch.mockRejectedValue(new TypeError('fetch failed'));
    const result = await deliverCreditEvent({
      type: 'charge.failed',
      eventId: 'evt-2',
      userId: 'user-1',
    });
    expect(result).toEqual({
      delivered: false,
      permanent: false,
      status: null,
      error: 'TypeError',
    });
  });

  it('classifies a non-2xx response as a retryable failure carrying the status', async () => {
    mockFetch.mockResolvedValue(new Response('bad', { status: 404 }));
    const result = await deliverCreditEvent({
      type: 'charge.failed',
      eventId: 'evt-3',
      userId: 'user-1',
    });
    expect(result).toEqual({
      delivered: false,
      permanent: false,
      status: 404,
      error: 'http_404',
    });
  });

  it('classifies a missing bouncer configuration as a permanent failure without sending', async () => {
    mockConfigState.bouncerUrl = null;
    const result = await deliverCreditEvent({
      type: 'charge.failed',
      eventId: 'evt-4',
      userId: 'user-1',
    });
    expect(result).toEqual({
      delivered: false,
      permanent: true,
      status: null,
      error: 'bouncer_not_configured',
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe('decide', () => {
  it('fails open at the timeout, without an error log', async () => {
    const errors = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    mockFetch.mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
        })
    );
    const started = Date.now();
    await expect(
      decide({ requestId: 'r', tier: 'anonymous', ip: '203.0.113.7' }, { timeoutMs: 30 })
    ).resolves.toBeNull();
    expect(Date.now() - started).toBeLessThan(1000);
    expect(errors).not.toHaveBeenCalled();
  });

  it('fails open on a non-2xx response', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    mockFetch.mockResolvedValue(new Response('bad', { status: 400 }));
    await expect(
      decide({ requestId: 'r', tier: 'free', accountId: 'org:o' }, { timeoutMs: 50 })
    ).resolves.toBeNull();
  });
});
