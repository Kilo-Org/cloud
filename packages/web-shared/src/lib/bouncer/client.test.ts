import { afterEach, describe, expect, it } from '@jest/globals';

jest.mock('@/lib/config.server', () => ({
  BOUNCER_URL: 'https://bouncer.example.com',
  INTERNAL_API_SECRET: 'test-internal-secret',
}));

import { decide, reportCreditEvent, reportUsageEvent } from '@/lib/bouncer/client';

const mockFetch = jest.fn() as jest.MockedFunction<typeof fetch>;
global.fetch = mockFetch;

function sentBody(): Record<string, unknown> {
  const init = mockFetch.mock.calls[0]?.[1];
  return JSON.parse(String(init?.body)) as Record<string, unknown>;
}

afterEach(() => {
  mockFetch.mockReset();
  jest.restoreAllMocks();
});

describe('reportCreditEvent', () => {
  it('sends the event with the internal key and only the fields bouncer accepts', async () => {
    mockFetch.mockResolvedValue(Response.json({ decision: 'allow', reasons: [], enforced: false }));
    await reportCreditEvent({
      type: 'charge.attempted',
      eventId: 'evt-1',
      userId: 'user-1',
      orgId: null,
      flow: 'topup',
      amountCents: 1999.6,
      accountCreatedAt: '2026-01-02T03:04:05Z',
      ipCountry: 'de',
      cardCountry: 'not-a-country',
      ip: '203.0.113.7',
    });
    const [url, init] = mockFetch.mock.calls[0] ?? [];
    expect(url).toBe('https://bouncer.example.com/api/v1/credit-event');
    expect(new Headers(init?.headers).get('x-internal-api-key')).toBe('test-internal-secret');
    expect(sentBody()).toStrictEqual({
      type: 'charge.attempted',
      eventId: 'evt-1',
      userId: 'user-1',
      flow: 'topup',
      amountCents: 2000,
      accountCreatedAt: '2026-01-02T03:04:05.000Z',
      ipCountry: 'DE',
      ip: '203.0.113.7',
    });
  });

  it('resolves when bouncer is down', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    mockFetch.mockRejectedValue(new TypeError('fetch failed'));
    await expect(
      reportCreditEvent({ type: 'charge.failed', eventId: 'evt-2', userId: 'user-1' })
    ).resolves.toBeUndefined();
  });
});

describe('reportUsageEvent', () => {
  it('drops an invalid sample count and caps the feature length', async () => {
    mockFetch.mockResolvedValue(Response.json({}));
    await reportUsageEvent({
      requestId: 'req-1',
      accountId: 'user:user-1',
      inputTokens: 10,
      outputTokens: 5,
      clientAttributed: true,
      feature: 'x'.repeat(100),
      hasTools: true,
      requestedLogprobs: false,
      samples: 0,
      promptSimHash: null,
    });
    const body = sentBody();
    expect(body).not.toHaveProperty('samples');
    expect(body).not.toHaveProperty('promptSimHash');
    expect(body.feature).toHaveLength(64);
  });
});

describe('decide', () => {
  it('returns the verdict', async () => {
    const verdict = {
      decision: 'throttle',
      reasons: ['rate:limit'],
      retryAfterMs: 2000,
      enforced: false,
    };
    mockFetch.mockResolvedValue(Response.json(verdict));
    await expect(
      decide({ requestId: 'r', tier: 'paid', accountId: 'user:u' }, { timeoutMs: 50 })
    ).resolves.toEqual(verdict);
  });

  it('returns null at the timeout, without an error log', async () => {
    const errors = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    // A fetch that settles only when its signal aborts, like a hung upstream.
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

  it('returns null on an error status', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    mockFetch.mockResolvedValue(new Response('bad', { status: 400 }));
    await expect(
      decide({ requestId: 'r', tier: 'free', accountId: 'org:o' }, { timeoutMs: 50 })
    ).resolves.toBeNull();
  });
});
