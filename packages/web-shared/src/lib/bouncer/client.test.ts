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
import { signupOperationId } from '@kilocode/web-shared/lib/bouncer/signup';
import { normalizeEmail } from '@kilocode/web-shared/lib/email-address';

// SWC + static ESM imports do not see jest.mock replacements on the same module id, so the client
// is loaded after the config mock is registered (same convention as the store-completion tests).
let deliverCreditEvent: typeof BouncerClient.deliverCreditEvent;
let decide: typeof BouncerClient.decide;
let reportUsageEvent: typeof BouncerClient.reportUsageEvent;
let creditEventWireBody: typeof BouncerClient.creditEventWireBody;
let usageEventWireBody: typeof BouncerClient.usageEventWireBody;
let normalizeJa4: typeof BouncerClient.normalizeJa4;
let signupDecide: typeof BouncerClient.signupDecide;

beforeAll(() => {
  ({
    deliverCreditEvent,
    decide,
    reportUsageEvent,
    creditEventWireBody,
    usageEventWireBody,
    normalizeJa4,
    signupDecide,
  } = jest.requireActual<typeof BouncerClient>('@kilocode/web-shared/lib/bouncer/client'));
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

  it('returns a valid verdict, including its internal flags', async () => {
    const verdict = {
      enforced: true,
      code: 'spend_limited',
      retryAfterMs: 2_000,
      spendWatch: true,
      flags: [
        { name: 'spend:watch', decision: 'throttle', enforced: true, until: 5, source: 'payer' },
      ],
    };
    mockFetch.mockResolvedValue(Response.json(verdict));
    await expect(
      decide({ requestId: 'r', tier: 'paid', accountId: 'user:u' }, { timeoutMs: 50 })
    ).resolves.toEqual(verdict);
  });

  it.each([
    ['the pre-enforcement verdict', { decision: 'allow', reasons: [], enforced: false }],
    ['an unknown code', { enforced: true, code: 'banned', spendWatch: false, flags: [] }],
    ['a missing spendWatch', { enforced: false, flags: [] }],
    ['a non-object body', 'allow'],
  ])('fails open on %s', async (_name, body) => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    mockFetch.mockResolvedValue(Response.json(body));
    await expect(
      decide({ requestId: 'r', tier: 'paid', accountId: 'user:u' }, { timeoutMs: 50 })
    ).resolves.toBeNull();
  });

  it('sends the payer facts as ISO time and non-negative integers', async () => {
    mockFetch.mockResolvedValue(Response.json({ enforced: false, spendWatch: false, flags: [] }));
    await decide(
      {
        requestId: 'r',
        tier: 'paid',
        accountId: 'org:o',
        userId: 'actor-u',
        accountCreatedAt: '2026-04-29 01:16:12.945+00',
        usedMicrodollars: 5_000_000_000,
        acquiredMicrodollars: -1,
      },
      { timeoutMs: 50 }
    );
    const body = lastRequestBody();
    expect(body.accountId).toBe('org:o');
    expect(body.userId).toBe('actor-u');
    expect(body.accountCreatedAt).toBe('2026-04-29T01:16:12.945Z');
    expect(body.usedMicrodollars).toBe(5_000_000_000);
    expect(body).not.toHaveProperty('acquiredMicrodollars');
  });
});

describe('signupOperationId', () => {
  it('uses the same privacy-safe identity for normalized aliases and provider retries', () => {
    const operationId = signupOperationId(normalizeEmail(' First.Last+google@Googlemail.com '));
    expect(operationId).toMatch(/^signup:[a-f0-9]{64}$/);
    expect(operationId).toBe(signupOperationId(normalizeEmail('firstlast+github@gmail.com')));
    expect(operationId).not.toContain('firstlast');
    expect(operationId).not.toBe(signupOperationId(normalizeEmail('other@gmail.com')));
  });
});

describe('signupDecide', () => {
  const request = { operationId: 'signup:operation-1', ip: '203.0.113.7' };
  const flag = {
    name: 'signup:burst',
    decision: 'throttle',
    enforced: true,
    until: 1_800_000_000_000,
    source: 'ip',
  };

  it('accepts a complete known enforced rejection', async () => {
    const verdict = {
      enforced: true,
      code: 'signup_rate_limited',
      retryAfterMs: 2_000,
      flags: [flag],
    };
    mockFetch.mockResolvedValue(Response.json(verdict));
    expect((await signupDecide(request))?.enforced).toBe(true);
  });

  it('keeps rejection when request-order skew extends a 30-day deadline', async () => {
    mockFetch.mockResolvedValue(
      Response.json({
        enforced: true,
        code: 'signup_rate_limited',
        retryAfterMs: 30 * 24 * 60 * 60 * 1000 + 1,
        flags: [flag],
      })
    );
    expect((await signupDecide(request))?.enforced).toBe(true);
  });

  it('preserves shadow flags without manufacturing enforcement', async () => {
    const verdict = { enforced: false, flags: [{ ...flag, enforced: false, decision: 'review' }] };
    mockFetch.mockResolvedValue(Response.json(verdict));
    expect((await signupDecide({ ...request, ip: '2001:db8::1' }))?.enforced).toBe(false);
  });

  it.each([
    ['unknown code', { enforced: true, code: 'restricted', retryAfterMs: 1, flags: [] }],
    ['missing code', { enforced: true, retryAfterMs: 1, flags: [] }],
    ['missing deadline', { enforced: true, code: 'signup_rate_limited', flags: [] }],
    [
      'negative deadline',
      { enforced: true, code: 'signup_rate_limited', retryAfterMs: -1, flags: [] },
    ],
    [
      'unbounded deadline',
      {
        enforced: true,
        code: 'signup_rate_limited',
        retryAfterMs: Number.MAX_SAFE_INTEGER,
        flags: [],
      },
    ],
    [
      'fractional deadline',
      { enforced: true, code: 'signup_rate_limited', retryAfterMs: 0.5, flags: [] },
    ],
    ['missing flags', { enforced: false }],
    ['unknown flag', { enforced: false, flags: [{ ...flag, name: 'other:flag' }] }],
    ['unknown field', { enforced: false, flags: [], spendWatch: false }],
    ['shadow rejection code', { enforced: false, code: 'signup_rate_limited', flags: [] }],
    ['too many flags', { enforced: false, flags: [flag, flag, flag, flag] }],
    ['non-object response', 'allow'],
  ])('fails open on %s', async (_name, verdict) => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    mockFetch.mockResolvedValue(Response.json(verdict));
    await expect(signupDecide(request)).resolves.toBeNull();
  });

  it.each([
    { ...request, operationId: '' },
    { ...request, operationId: 'a'.repeat(129) },
    { ...request, ip: 'not-an-ip' },
    { ...request, ip: 'fe80::1%eth0' },
  ])('fails open without sending an invalid request: %j', async body => {
    await expect(signupDecide(body)).resolves.toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('accepts admission at the operation ID length boundary', async () => {
    mockFetch.mockResolvedValue(
      Response.json({ enforced: true, code: 'signup_rate_limited', retryAfterMs: 1, flags: [flag] })
    );
    expect((await signupDecide({ ...request, operationId: 'a'.repeat(128) }))?.enforced).toBe(true);
  });

  it('fails open on transport failure', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    mockFetch.mockRejectedValue(new TypeError('fetch failed'));
    await expect(signupDecide(request)).resolves.toBeNull();
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('fails open within the transport deadline and never retries', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    mockFetch.mockImplementation((_url, init) => {
      const { promise, reject } = Promise.withResolvers<Response>();
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      return promise;
    });
    const started = Date.now();
    await expect(signupDecide(request, { timeoutMs: 30 })).resolves.toBeNull();
    expect(Date.now() - started).toBeLessThan(1000);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it.each([400, 401, 404, 500])('fails open on HTTP %s', async status => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    mockFetch.mockResolvedValue(new Response('bad', { status }));
    await expect(signupDecide(request)).resolves.toBeNull();
  });

  it('fails open on non-JSON success', async () => {
    mockFetch.mockResolvedValue(new Response('not-json'));
    await expect(signupDecide(request)).resolves.toBeNull();
  });

  it('fails open without configuration', async () => {
    mockConfigState.bouncerUrl = null;
    await expect(signupDecide(request)).resolves.toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe('usage event and charge cost fields', () => {
  it('carries the charged cost on the usage wire body', () => {
    const body = usageEventWireBody({
      requestId: 'r',
      accountId: 'user:u',
      inputTokens: 1,
      outputTokens: 2,
      clientAttributed: true,
      hasTools: false,
      requestedLogprobs: false,
      costMicrodollars: 1234.4,
    });
    expect(body.costMicrodollars).toBe(1234);
  });

  it('carries the payer usage on charge.attempted', () => {
    const body = creditEventWireBody({
      type: 'charge.attempted',
      eventId: 'evt-used',
      userId: 'user-1',
      flow: 'topup',
      amountCents: 100,
      accountCreatedAt: new Date('2026-01-01T00:00:00Z'),
      accountUsedMicrodollars: 42_000_000,
    });
    expect(body.accountUsedMicrodollars).toBe(42_000_000);
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
    mockFetch.mockResolvedValue(Response.json({ enforced: false, spendWatch: false, flags: [] }));
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
