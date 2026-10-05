import { beforeAll, afterEach, describe, expect, it, jest } from '@jest/globals';

const mockConfigState = { bouncerUrl: 'https://bouncer.example.com' as string | null };

jest.mock('@kilocode/web-shared/lib/config.server', () => ({
  get BOUNCER_URL() {
    return mockConfigState.bouncerUrl;
  },
  INTERNAL_API_SECRET: 'test-internal-secret',
}));

import type * as BouncerClient from '@kilocode/web-shared/lib/bouncer/client';
import { parseBouncerCreditEventBody } from '@kilocode/web-shared/lib/bouncer/credit-event-schema';

// SWC + static ESM imports do not see jest.mock replacements on the same module id, so the client
// is loaded after the config mock is registered (same convention as the store-completion tests).
let deliverCreditEvent: typeof BouncerClient.deliverCreditEvent;
let decide: typeof BouncerClient.decide;
let reportUsageEvent: typeof BouncerClient.reportUsageEvent;
let creditEventWireBody: typeof BouncerClient.creditEventWireBody;
let normalizeJa4: typeof BouncerClient.normalizeJa4;

beforeAll(() => {
  ({ deliverCreditEvent, decide, reportUsageEvent, creditEventWireBody, normalizeJa4 } =
    jest.requireActual<typeof BouncerClient>('@kilocode/web-shared/lib/bouncer/client'));
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

  it('treats a body-less 204 success as delivered without parsing a body', async () => {
    mockFetch.mockResolvedValue(new Response(null, { status: 204 }));
    await expect(
      deliverCreditEvent({ type: 'charge.failed', eventId: 'evt-204', userId: 'user-1' })
    ).resolves.toEqual({ delivered: true, status: 204 });
  });

  it('treats a non-JSON 2xx success as delivered', async () => {
    mockFetch.mockResolvedValue(
      new Response('ok', { status: 200, headers: { 'content-type': 'text/plain' } })
    );
    await expect(
      deliverCreditEvent({ type: 'charge.failed', eventId: 'evt-text', userId: 'user-1' })
    ).resolves.toEqual({ delivered: true, status: 200 });
  });

  it('still delivers when the acknowledgement body read fails after a 2xx', async () => {
    const response = new Response(null, { status: 200 });
    jest.spyOn(response, 'arrayBuffer').mockRejectedValue(new Error('read failed'));
    mockFetch.mockResolvedValue(response);
    await expect(
      deliverCreditEvent({ type: 'charge.failed', eventId: 'evt-read-fail', userId: 'user-1' })
    ).resolves.toEqual({ delivered: true, status: 200 });
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

function lastRequestBody(): Record<string, unknown> {
  const call = mockFetch.mock.calls[mockFetch.mock.calls.length - 1];
  const body = call?.[1]?.body;
  return JSON.parse(String(body)) as Record<string, unknown>;
}

describe('normalizeJa4', () => {
  it('keeps a bounded lowercase digest unchanged', () => {
    expect(normalizeJa4('t13d1516h2_8daaf6152771_b1ff8ab')).toBe('t13d1516h2_8daaf6152771_b1ff8ab');
  });

  it('trims and lowercases without otherwise rewriting the value', () => {
    expect(normalizeJa4('  T13D1516H2_8DAAF6  ')).toBe('t13d1516h2_8daaf6');
  });

  it('keeps a value at the 128-character boundary', () => {
    const value = 'a'.repeat(128);
    expect(normalizeJa4(value)).toBe(value);
  });

  it('omits an empty, over-long, or otherwise invalid value whole, never truncated', () => {
    expect(normalizeJa4(undefined)).toBeUndefined();
    expect(normalizeJa4(null)).toBeUndefined();
    expect(normalizeJa4('')).toBeUndefined();
    expect(normalizeJa4('   ')).toBeUndefined();
    expect(normalizeJa4('has space')).toBeUndefined();
    expect(normalizeJa4('has-dash')).toBeUndefined();
    expect(normalizeJa4('a'.repeat(129))).toBeUndefined();
  });
});

describe('reportUsageEvent ja4', () => {
  const baseEvent = {
    requestId: 'r-ja4',
    tier: 'anonymous' as const,
    ip: '203.0.113.7',
    inputTokens: 1,
    outputTokens: 2,
    clientAttributed: false,
    hasTools: false,
    requestedLogprobs: false,
  };

  it('sends a normalized ja4 while keeping the anonymous identity', async () => {
    mockFetch.mockResolvedValue(Response.json({}));
    await reportUsageEvent({ ...baseEvent, ja4: 'T13D1516H2_8DAA' });
    const body = lastRequestBody();
    expect(body.ja4).toBe('t13d1516h2_8daa');
    expect(body.tier).toBe('anonymous');
  });

  it('omits an invalid ja4 without dropping the whole usage event', async () => {
    mockFetch.mockResolvedValue(Response.json({}));
    await reportUsageEvent({ ...baseEvent, ja4: 'not a digest!' });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(lastRequestBody()).not.toHaveProperty('ja4');
  });

  it('omits ja4 when the request did not carry one', async () => {
    mockFetch.mockResolvedValue(Response.json({}));
    await reportUsageEvent(baseEvent);
    expect(lastRequestBody()).not.toHaveProperty('ja4');
  });
});

describe('decide ja4', () => {
  it('sends a bounded ja4 on a signed-in decide', async () => {
    mockFetch.mockResolvedValue(Response.json({ decision: 'allow', reasons: [], enforced: false }));
    await decide(
      { requestId: 'r', tier: 'free', accountId: 'user:u', ip: '203.0.113.7', ja4: 'A_B' },
      { timeoutMs: 50 }
    );
    expect(lastRequestBody().ja4).toBe('a_b');
  });
});

describe('creditEventWireBody ja4', () => {
  it('carries a normalized ja4 on a request-initiated charge.attempted', () => {
    const body = creditEventWireBody({
      type: 'charge.attempted',
      eventId: 'evt-ja4',
      userId: 'user-1',
      flow: 'topup',
      amountCents: 100,
      accountCreatedAt: new Date('2026-01-01T00:00:00Z'),
      ja4: 'A_B',
    });
    expect(body.ja4).toBe('a_b');
  });

  it('omits an invalid ja4 rather than sending it', () => {
    const body = creditEventWireBody({
      type: 'charge.attempted',
      eventId: 'evt-ja4-bad',
      userId: 'user-1',
      flow: 'topup',
      amountCents: 100,
      accountCreatedAt: new Date('2026-01-01T00:00:00Z'),
      ja4: 'x'.repeat(200),
    });
    expect(body).not.toHaveProperty('ja4');
  });

  it('never emits ja4 on a store event', () => {
    const body = creditEventWireBody({
      type: 'store.purchase',
      eventId: 'e',
      userId: 'u',
      provider: 'apple',
      referenceId: 'ref',
    });
    expect(body).not.toHaveProperty('ja4');
  });
});

describe('parseBouncerCreditEventBody ja4', () => {
  it('preserves a persisted ja4 on a charge body', () => {
    const parsed = parseBouncerCreditEventBody({
      type: 'charge.attempted',
      eventId: 'e',
      userId: 'u',
      ja4: 'a_b',
    });
    expect(parsed?.ja4).toBe('a_b');
  });

  it('preserves a charge body without ja4', () => {
    const parsed = parseBouncerCreditEventBody({
      type: 'charge.failed',
      eventId: 'e',
      userId: 'u',
    });
    expect(parsed).not.toBeNull();
    expect(parsed).not.toHaveProperty('ja4');
  });
});
