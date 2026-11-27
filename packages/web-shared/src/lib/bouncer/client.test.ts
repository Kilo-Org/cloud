import { beforeAll, beforeEach, afterEach, describe, expect, it, jest } from '@jest/globals';

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
import { BOUNCER_TOKEN_WAIT_MS, createBouncerAuth, type BouncerAuth } from './sts-auth';

// SWC + static ESM imports do not see jest.mock replacements on the same module id, so the client
// is loaded after the config mock is registered (same convention as the store-completion tests).
let deliverCreditEvent: typeof BouncerClient.deliverCreditEvent;
let decide: typeof BouncerClient.decide;
let reportUsageEvent: typeof BouncerClient.reportUsageEvent;
let creditEventWireBody: typeof BouncerClient.creditEventWireBody;
let usageEventWireBody: typeof BouncerClient.usageEventWireBody;
let normalizeJa4: typeof BouncerClient.normalizeJa4;
let signupDecide: typeof BouncerClient.signupDecide;
let chargeDecide: typeof BouncerClient.chargeDecide;
let releaseDecideLease: typeof BouncerClient.releaseDecideLease;

beforeAll(() => {
  ({
    deliverCreditEvent,
    decide,
    reportUsageEvent,
    creditEventWireBody,
    usageEventWireBody,
    normalizeJa4,
    signupDecide,
    chargeDecide,
    releaseDecideLease,
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
    expect((url as URL).href).toBe('https://bouncer.example.com/api/v2/credit-event');
  });

  it('does not double the separator of an endpoint that ends with one', async () => {
    mockConfigState.bouncerUrl = 'https://bouncer.example.com/';
    mockFetch.mockResolvedValue(Response.json({}));
    await expect(
      deliverCreditEvent({ type: 'charge.failed', eventId: 'evt-slash', userId: 'user-1' })
    ).resolves.toEqual({ delivered: true, status: 200 });
    const [url] = mockFetch.mock.calls[0] ?? [];
    expect((url as URL).href).toBe('https://bouncer.example.com/api/v2/credit-event');
  });

  it('never follows a redirect and counts a 3xx as a retryable failure', async () => {
    mockFetch.mockResolvedValue(
      new Response(null, { status: 307, headers: { location: 'https://elsewhere.example/' } })
    );
    await expect(
      deliverCreditEvent({ type: 'charge.failed', eventId: 'evt-307', userId: 'user-1' })
    ).resolves.toEqual({ delivered: false, permanent: false, status: 307, error: 'http_307' });
    expect(mockFetch.mock.calls[0]?.[1]?.redirect).toBe('manual');
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

  it('requires an https or loopback bouncer endpoint', async () => {
    mockConfigState.bouncerUrl = 'http://bouncer.example.com';
    const result = await deliverCreditEvent({
      type: 'charge.failed',
      eventId: 'evt-5',
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
  it('requires an https or loopback bouncer endpoint', async () => {
    mockConfigState.bouncerUrl = 'http://bouncer.example.com';
    await expect(
      decide({ requestId: 'r', tier: 'anonymous', ip: '203.0.113.7' }, { timeoutMs: 50 })
    ).resolves.toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });

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

describe('chargeDecide', () => {
  const request = {
    requestId: 'checkout:r',
    accountId: 'user:u',
    userId: 'u',
    ip: '203.0.113.7',
    ja4: 'JA4_ABC',
    stage: 'checkout' as const,
    flow: 'kilo_pass' as const,
  };

  it('returns an enforced verdict with its internal flags', async () => {
    const verdict = {
      enforced: true,
      code: 'charge_blocked',
      flags: [
        { name: 'card_testing', decision: 'block', enforced: true, until: 1_800_000_000_000 },
      ],
    };
    mockFetch.mockResolvedValue(Response.json(verdict));
    await expect(chargeDecide(request)).resolves.toEqual(verdict);
  });

  it('sends the normalized request to the charge-decide endpoint', async () => {
    mockFetch.mockResolvedValue(Response.json({ enforced: false, flags: [] }));
    await chargeDecide(request);
    const [url] = mockFetch.mock.calls[0] ?? [];
    expect((url as URL).href).toBe('https://bouncer.example.com/api/v1/charge-decide');
    expect(lastRequestBody()).toEqual({
      requestId: 'checkout:r',
      accountId: 'user:u',
      userId: 'u',
      ip: '203.0.113.7',
      ja4: 'ja4_abc',
      stage: 'checkout',
      flow: 'kilo_pass',
    });
  });

  it('fails open on a 404 from an older bouncer deploy', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    mockFetch.mockResolvedValue(new Response('not found', { status: 404 }));
    await expect(chargeDecide(request)).resolves.toBeNull();
  });

  it('fails open at the timeout', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    mockFetch.mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
        })
    );
    await expect(chargeDecide(request, { timeoutMs: 30 })).resolves.toBeNull();
  });

  it.each([
    ['an unknown code and a malformed flag', { enforced: true, code: 'banned', flags: [{}] }],
    ['a non-string code and no flags', { enforced: true, code: 7 }],
  ])('keeps an enforced verdict with %s', async (_name, body) => {
    mockFetch.mockResolvedValue(Response.json(body));
    await expect(chargeDecide(request)).resolves.toEqual({ enforced: true, flags: [] });
  });

  it('keeps the known flags of an enforced verdict whose code is unknown', async () => {
    const flag = { name: 'card_testing', decision: 'block', enforced: true, until: null };
    mockFetch.mockResolvedValue(
      Response.json({ enforced: true, code: 'something_new', flags: [flag] })
    );
    await expect(chargeDecide(request)).resolves.toEqual({ enforced: true, flags: [flag] });
  });

  it('drops the flags list when any entry has an unknown shape', async () => {
    mockFetch.mockResolvedValue(
      Response.json({ enforced: true, flags: [{ name: 'card_testing', decision: 'block' }] })
    );
    await expect(chargeDecide(request)).resolves.toEqual({ enforced: true, flags: [] });
  });

  it.each([
    ['a non-boolean enforced', { enforced: 'yes', flags: [] }],
    ['a non-object body', 'allow'],
    ['a body without enforced', { code: 'charge_blocked', flags: [] }],
  ])('fails open on %s', async (_name, body) => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    mockFetch.mockResolvedValue(Response.json(body));
    await expect(chargeDecide(request)).resolves.toBeNull();
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

  it('accepts a manual ban rejection', async () => {
    mockFetch.mockResolvedValue(
      Response.json({
        enforced: true,
        code: 'signup_rate_limited',
        retryAfterMs: 30 * 24 * 60 * 60 * 1000,
        flags: [
          { name: 'signup:banned', decision: 'block', enforced: true, until: null, source: 'ja4' },
        ],
      })
    );
    expect((await signupDecide(request))?.enforced).toBe(true);
  });

  it('preserves shadow flags without manufacturing enforcement', async () => {
    const verdict = { enforced: false, flags: [{ ...flag, enforced: false, decision: 'review' }] };
    mockFetch.mockResolvedValue(Response.json(verdict));
    expect((await signupDecide({ ...request, ip: '2001:db8::1' }))?.enforced).toBe(false);
  });

  it.each([undefined, null, '', 'has space', 'a'.repeat(129)])(
    'preserves an enforceable IP rejection when JA4 is absent or invalid: %s',
    async ja4 => {
      mockFetch.mockResolvedValue(
        Response.json({
          enforced: true,
          code: 'signup_rate_limited',
          retryAfterMs: 2_000,
          flags: [flag],
        })
      );
      expect((await signupDecide({ ...request, ja4 }))?.enforced).toBe(true);
    }
  );

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
    ['non-object response', 'allow'],
  ])('returns unavailable on %s', async (_name, verdict) => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    mockFetch.mockResolvedValue(Response.json(verdict));
    await expect(signupDecide(request)).resolves.toBeNull();
  });

  it.each([
    { ...request, operationId: '' },
    { ...request, operationId: 'a'.repeat(129) },
    { ...request, ip: 'not-an-ip' },
    { ...request, ip: 'fe80::1%eth0' },
  ])('returns unavailable without sending an invalid request: %j', async body => {
    await expect(signupDecide(body)).resolves.toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('accepts admission at the operation ID length boundary', async () => {
    mockFetch.mockResolvedValue(
      Response.json({ enforced: true, code: 'signup_rate_limited', retryAfterMs: 1, flags: [flag] })
    );
    expect((await signupDecide({ ...request, operationId: 'a'.repeat(128) }))?.enforced).toBe(true);
  });

  describe('step-up', () => {
    const stepUp = {
      enforced: true,
      code: 'signup_step_up',
      methods: ['apple'],
      flags: [
        { ...flag, name: 'signup:busy' },
        { ...flag, name: 'signup:domain', source: 'domain' },
      ],
    };

    it('accepts a step-up verdict with the busy and domain flags', async () => {
      mockFetch.mockResolvedValue(Response.json(stepUp));
      await expect(signupDecide(request)).resolves.toEqual(stepUp);
    });

    it('accepts eight flags and rejects nine', async () => {
      jest.spyOn(console, 'error').mockImplementation(() => undefined);
      const flags = (count: number) => Array.from({ length: count }, () => flag);
      mockFetch.mockResolvedValueOnce(Response.json({ ...stepUp, flags: flags(8) }));
      expect((await signupDecide(request))?.enforced).toBe(true);
      mockFetch.mockResolvedValueOnce(Response.json({ ...stepUp, flags: flags(9) }));
      await expect(signupDecide(request)).resolves.toBeNull();
      mockFetch.mockResolvedValueOnce(
        Response.json({ enforced: false, flags: flags(9).map(f => ({ ...f, enforced: false })) })
      );
      await expect(signupDecide(request)).resolves.toBeNull();
    });

    it.each([
      ['missing methods', { ...stepUp, methods: undefined }],
      ['empty methods', { ...stepUp, methods: [] }],
      ['too many methods', { ...stepUp, methods: Array.from({ length: 9 }, () => 'apple') }],
      ['uppercase method', { ...stepUp, methods: ['Apple'] }],
      ['method with a space', { ...stepUp, methods: ['app le'] }],
      ['over-long method', { ...stepUp, methods: ['a'.repeat(33)] }],
      ['non-string method', { ...stepUp, methods: [1] }],
      ['step-up deadline', { ...stepUp, retryAfterMs: 1 }],
      ['rate-limit methods', { ...stepUp, code: 'signup_rate_limited', retryAfterMs: 1 }],
      ['shadow step-up', { ...stepUp, enforced: false }],
    ])('returns unavailable on %s', async (_name, verdict) => {
      jest.spyOn(console, 'error').mockImplementation(() => undefined);
      mockFetch.mockResolvedValue(Response.json(verdict));
      await expect(signupDecide(request)).resolves.toBeNull();
    });

    it('sends the method and normalized email domain', async () => {
      mockFetch.mockResolvedValue(Response.json({ enforced: false, flags: [] }));
      await signupDecide({ ...request, method: 'email', emailDomain: ' Example.TEST ' });
      expect(lastRequestBody()).toEqual({
        ...request,
        method: 'email',
        emailDomain: 'example.test',
      });
    });

    it.each([
      { method: 'Email' },
      { method: 'a'.repeat(33) },
      { emailDomain: 'bücher.example.test' },
      { emailDomain: '' },
    ])('omits an invalid step-up field but still asks for admission: %j', async fields => {
      mockFetch.mockResolvedValue(Response.json({ enforced: false, flags: [] }));
      expect((await signupDecide({ ...request, ...fields }))?.enforced).toBe(false);
      expect(lastRequestBody()).toEqual(request);
    });
  });

  it('returns unavailable on transport failure', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    mockFetch.mockRejectedValue(new TypeError('fetch failed'));
    await expect(signupDecide(request)).resolves.toBeNull();
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('returns unavailable within the transport deadline and never retries', async () => {
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

  it.each([400, 401, 404, 500])('returns unavailable on HTTP %s', async status => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    mockFetch.mockResolvedValue(new Response('bad', { status }));
    await expect(signupDecide(request)).resolves.toBeNull();
  });

  it('returns unavailable on non-JSON success', async () => {
    mockFetch.mockResolvedValue(new Response('not-json'));
    await expect(signupDecide(request)).resolves.toBeNull();
  });

  it('returns unavailable without configuration', async () => {
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

  it('sends siwc only when the request ran on a ChatGPT subscription', () => {
    const event = {
      requestId: 'r',
      accountId: 'user:u',
      inputTokens: 1,
      outputTokens: 2,
      clientAttributed: true,
      hasTools: false,
      requestedLogprobs: false,
    };
    expect(usageEventWireBody({ ...event, siwc: true }).siwc).toBe(true);
    expect(usageEventWireBody({ ...event, siwc: false })).not.toHaveProperty('siwc');
    expect(usageEventWireBody(event)).not.toHaveProperty('siwc');
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
  return JSON.parse(body as string) as Record<string, unknown>;
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

describe('STS headers from the installed Bouncer auth', () => {
  const headersOf = jest.fn<BouncerAuth['headers']>();
  const rejected = jest.fn<BouncerAuth['rejected']>();

  beforeEach(() => {
    headersOf.mockImplementation(async ({ scope }) => ({
      'x-kilo-caller': 'kilocode-app',
      authorization: `Bearer token-for-${scope}`,
    }));
    globalThis.__kilocodeBouncerAuth = { headers: headersOf, rejected };
    mockFetch.mockResolvedValue(Response.json({ enforced: false, spendWatch: false, flags: [] }));
  });

  afterEach(() => {
    globalThis.__kilocodeBouncerAuth = undefined;
    headersOf.mockReset();
    rejected.mockReset();
  });

  function sent(): { path: string; headers: Headers } {
    const [url, init] = mockFetch.mock.calls[0] ?? [];
    return { path: (url as URL).pathname, headers: new Headers(init?.headers) };
  }

  it.each([
    [
      'decide',
      () => decide({ requestId: 'r', tier: 'anonymous', ip: '203.0.113.7' }, { timeoutMs: 1000 }),
      '/api/v1/decide',
      'bouncer:decide',
      true,
    ],
    [
      'charge-decide',
      () =>
        chargeDecide({
          requestId: 'r',
          accountId: 'user:u',
          userId: 'u',
          stage: 'checkout',
          flow: 'topup',
        }),
      '/api/v1/charge-decide',
      'bouncer:decide',
      true,
    ],
    [
      'release',
      () => releaseDecideLease({ requestId: 'r', accountId: 'user:u' }),
      '/api/v1/release',
      'bouncer:decide',
      false,
    ],
    [
      'usage-event',
      () =>
        reportUsageEvent({
          requestId: 'r',
          tier: 'anonymous',
          ip: '203.0.113.7',
          inputTokens: 1,
          outputTokens: 2,
          clientAttributed: false,
          hasTools: false,
          requestedLogprobs: false,
        }),
      '/api/v1/usage-event',
      'bouncer:usage.write',
      false,
    ],
    [
      'credit-event',
      () => deliverCreditEvent({ type: 'charge.failed', eventId: 'evt-sts', userId: 'user-1' }),
      '/api/v2/credit-event',
      'bouncer:usage.write',
      false,
    ],
    [
      'signup-decide',
      () => signupDecide({ operationId: 'signup:operation-1', ip: '203.0.113.7' }),
      '/api/v1/signup-decide',
      'bouncer:signup.decide',
      true,
    ],
  ] as const)(
    '%s asks for %s (waits: %s) and sends it with the legacy key',
    async (_name, call, path, scope, wait) => {
      await call();
      expect(headersOf).toHaveBeenCalledWith({
        scope,
        wait,
        origin: 'https://bouncer.example.com',
        signal: expect.any(AbortSignal),
      });
      const { path: sentPath, headers } = sent();
      expect(sentPath).toBe(path);
      expect(headers.get('authorization')).toBe(`Bearer token-for-${scope}`);
      expect(headers.get('x-kilo-caller')).toBe('kilocode-app');
      expect(headers.get('x-internal-api-key')).toBe('test-internal-secret');
      expect(headers.get('content-type')).toBe('application/json');
    }
  );

  it('sends neither the caller nor a bearer when nothing is installed', async () => {
    globalThis.__kilocodeBouncerAuth = undefined;
    await decide({ requestId: 'r', tier: 'anonymous', ip: '203.0.113.7' }, { timeoutMs: 1000 });
    const { headers } = sent();
    expect(headers.get('authorization')).toBeNull();
    expect(headers.get('x-kilo-caller')).toBeNull();
    expect(headers.get('x-internal-api-key')).toBe('test-internal-secret');
  });

  function authorizationOf(index: number): string | null {
    return new Headers(mockFetch.mock.calls[index]?.[1]?.headers).get('authorization');
  }

  it('reports a 401 to a decide that carried a token and sends it once more without the token', async () => {
    const verdict = { enforced: false, spendWatch: false, flags: [] };
    mockFetch
      .mockResolvedValueOnce(new Response('refused', { status: 401 }))
      .mockResolvedValueOnce(Response.json(verdict));
    await expect(
      decide({ requestId: 'r', tier: 'anonymous', ip: '203.0.113.7' }, { timeoutMs: 1000 })
    ).resolves.toEqual(verdict);
    expect(rejected).toHaveBeenCalledWith('bouncer:decide');
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(authorizationOf(0)).toBe('Bearer token-for-bouncer:decide');
    expect(authorizationOf(1)).toBeNull();
    const retried = new Headers(mockFetch.mock.calls[1]?.[1]?.headers);
    expect(retried.get('x-internal-api-key')).toBe('test-internal-secret');
    expect(retried.get('x-kilo-caller')).toBe('kilocode-app');
    // Both sends share the call's one deadline.
    expect(mockFetch.mock.calls[1]?.[1]?.signal).toBe(mockFetch.mock.calls[0]?.[1]?.signal);
  });

  it('reports a 401 to a release but never resends it, and retries a decide at most once', async () => {
    mockFetch.mockResolvedValue(new Response(null, { status: 401 }));
    await releaseDecideLease({ requestId: 'r', accountId: 'user:u' });
    expect(rejected).toHaveBeenCalledWith('bouncer:decide');
    expect(mockFetch).toHaveBeenCalledTimes(1);

    mockFetch.mockClear();
    mockFetch.mockImplementation(async () => new Response(null, { status: 401 }));
    await expect(
      decide({ requestId: 'r', tier: 'anonymous', ip: '203.0.113.7' }, { timeoutMs: 1000 })
    ).resolves.toBeNull();
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('neither reports nor resends a 401 to a call without a token, or a 403', async () => {
    headersOf.mockResolvedValue({ 'x-kilo-caller': 'kilocode-app' });
    mockFetch.mockImplementation(async () => new Response(null, { status: 401 }));
    await decide({ requestId: 'r', tier: 'anonymous', ip: '203.0.113.7' }, { timeoutMs: 1000 });
    expect(rejected).not.toHaveBeenCalled();
    expect(mockFetch).toHaveBeenCalledTimes(1);

    mockFetch.mockClear();
    mockFetch.mockImplementation(async () => new Response(null, { status: 403 }));
    headersOf.mockResolvedValue({ authorization: 'Bearer t' });
    await decide({ requestId: 'r', tier: 'anonymous', ip: '203.0.113.7' }, { timeoutMs: 1000 });
    expect(rejected).not.toHaveBeenCalled();
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('sends the legacy key alone when the token headers cannot be read', async () => {
    headersOf.mockRejectedValue(new Error('auth failed'));
    await deliverCreditEvent({ type: 'charge.failed', eventId: 'evt-auth', userId: 'user-1' });
    const { headers } = sent();
    expect(headers.get('authorization')).toBeNull();
    expect(headers.get('x-internal-api-key')).toBe('test-internal-secret');
  });

  it('asks for no token when the endpoint is unconfigured', async () => {
    mockConfigState.bouncerUrl = null;
    await decide({ requestId: 'r', tier: 'anonymous', ip: '203.0.113.7' }, { timeoutMs: 1000 });
    expect(headersOf).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe('a decide whose STS mint hangs', () => {
  // `AbortSignal.timeout` runs on a timer Jest does not fake; this stand-in aborts with the same
  // `TimeoutError` on a faked timer, so the deadline is driven deterministically.
  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(AbortSignal, 'timeout').mockImplementation(ms => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new DOMException('timed out', 'TimeoutError')), ms);
      return controller.signal;
    });
    mockConfigState.bouncerUrl = 'https://bouncer.kiloapps.io';
    globalThis.__kilocodeBouncerAuth = createBouncerAuth({
      caller: 'kilocode-ai-gateway',
      scopes: ['bouncer:decide', 'bouncer:usage.write'],
      flag: () => 'dual',
      // The exchanged Vercel token is held, but the mint never answers.
      loadTransport: async () => ({
        read: async () => await Promise.withResolvers<string>().promise,
        exchangeReady: async () => true,
      }),
      waitUntil: () => undefined,
      log: () => undefined,
    });
    // Bouncer answers only when the call's signal aborts, as a hung request would.
    mockFetch.mockImplementation(async (_url, init) => {
      const aborted = Promise.withResolvers<Response>();
      const signal = init?.signal;
      if (signal?.aborted) aborted.reject(signal.reason);
      signal?.addEventListener('abort', () => aborted.reject(signal.reason));
      return await aborted.promise;
    });
  });

  afterEach(() => {
    globalThis.__kilocodeBouncerAuth = undefined;
    jest.useRealTimers();
  });

  function legacyOnly(): void {
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const headers = new Headers(mockFetch.mock.calls[0]?.[1]?.headers);
    expect(headers.get('authorization')).toBeNull();
    expect(headers.get('x-internal-api-key')).toBe('test-internal-secret');
    expect(headers.get('x-kilo-caller')).toBe('kilocode-ai-gateway');
  }

  it('waits for the token out of the decide timeout and ends at that timeout', async () => {
    let settled = false;
    const call = decide(
      { requestId: 'r', tier: 'anonymous', ip: '203.0.113.7' },
      { timeoutMs: 1000 }
    ).then(verdict => {
      settled = true;
      return verdict;
    });
    await jest.advanceTimersByTimeAsync(BOUNCER_TOKEN_WAIT_MS);
    legacyOnly();
    await jest.advanceTimersByTimeAsync(1000 - BOUNCER_TOKEN_WAIT_MS - 1);
    expect(settled).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    await expect(call).resolves.toBeNull();
  });

  it('cuts the token wait at a decide timeout shorter than the wait', async () => {
    let settled = false;
    const call = decide(
      { requestId: 'r', tier: 'anonymous', ip: '203.0.113.7' },
      { timeoutMs: 100 }
    ).then(verdict => {
      settled = true;
      return verdict;
    });
    await jest.advanceTimersByTimeAsync(99);
    expect(settled).toBe(false);
    expect(mockFetch).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    await expect(call).resolves.toBeNull();
    legacyOnly();
  });
});

describe('bouncerEnabledForDeployment', () => {
  // A fresh module per test, so the once-per-instance config error starts unlogged.
  function freshCheck(): typeof BouncerClient.bouncerEnabledForDeployment {
    let check: typeof BouncerClient.bouncerEnabledForDeployment | undefined;
    jest.isolateModules(() => {
      check = jest.requireActual<typeof BouncerClient>(
        '@kilocode/web-shared/lib/bouncer/client'
      ).bouncerEnabledForDeployment;
    });
    if (!check) throw new Error('client module did not load');
    return check;
  }

  it('enables a Vercel production deployment without VERCEL_TARGET_ENV, with no error', () => {
    const errors = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const check = freshCheck();
    expect(check({ VERCEL_ENV: 'production' })).toBe(true);
    expect(check({ VERCEL_ENV: 'production', VERCEL_TARGET_ENV: 'production' })).toBe(true);
    expect(errors).not.toHaveBeenCalled();
  });

  it('keeps Bouncer on a production deployment whose target says staging, with one error', () => {
    const errors = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const check = freshCheck();
    const runtime = { VERCEL_ENV: 'production', VERCEL_TARGET_ENV: 'staging' };
    expect(check(runtime)).toBe(true);
    expect(check(runtime)).toBe(true);
    expect(errors).toHaveBeenCalledTimes(1);
    expect(errors.mock.calls[0]?.[0]).toContain('[bouncer] config error');
  });

  it.each(['staging', 'preview'])(
    'disables a VERCEL_ENV=preview deployment targeting %s',
    target => {
      expect(freshCheck()({ VERCEL_ENV: 'preview', VERCEL_TARGET_ENV: target })).toBe(false);
    }
  );

  it.each([{}, { VERCEL_ENV: 'development' }])('leaves %j to BOUNCER_URL, as before', runtime => {
    expect(freshCheck()(runtime)).toBe(true);
  });
});

describe('a preview or staging deployment with BOUNCER_URL set', () => {
  const runtimeNames = ['VERCEL_ENV', 'VERCEL_TARGET_ENV'] as const;
  const saved = Object.fromEntries(runtimeNames.map(name => [name, process.env[name]]));

  afterEach(() => {
    for (const name of runtimeNames) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  });

  it.each(['staging', 'preview'])(
    'sends no Bouncer request when targeting %s, as with BOUNCER_URL unset',
    async target => {
      process.env.VERCEL_ENV = 'preview';
      process.env.VERCEL_TARGET_ENV = target;
      mockFetch.mockResolvedValue(Response.json({ enforced: false, flags: [] }));
      await expect(
        decide({ requestId: 'r', tier: 'anonymous', ip: '203.0.113.7' }, { timeoutMs: 50 })
      ).resolves.toBeNull();
      await expect(
        signupDecide({ operationId: 'signup:operation-preview', ip: '203.0.113.7' })
      ).resolves.toBeNull();
      await expect(
        deliverCreditEvent({ type: 'charge.failed', eventId: 'evt-preview', userId: 'user-1' })
      ).resolves.toEqual({
        delivered: false,
        permanent: true,
        status: null,
        error: 'bouncer_not_configured',
      });
      expect(mockFetch).not.toHaveBeenCalled();
    }
  );

  it('still calls Bouncer on Vercel production', async () => {
    process.env.VERCEL_ENV = 'production';
    process.env.VERCEL_TARGET_ENV = 'production';
    mockFetch.mockResolvedValue(Response.json({}));
    await expect(
      deliverCreditEvent({ type: 'charge.failed', eventId: 'evt-production', userId: 'user-1' })
    ).resolves.toEqual({ delivered: true, status: 200 });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});
