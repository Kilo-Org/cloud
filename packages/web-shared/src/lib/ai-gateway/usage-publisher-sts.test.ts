const mockConfig: { USAGE_INGEST_URL?: string; USAGE_INGEST_PUBLISH_SECRET?: string } = {};
jest.mock('@kilocode/web-shared/lib/config.server', () => ({
  get USAGE_INGEST_URL() {
    return mockConfig.USAGE_INGEST_URL;
  },
  get USAGE_INGEST_PUBLISH_SECRET() {
    return mockConfig.USAGE_INGEST_PUBLISH_SECRET;
  },
}));
jest.mock('@sentry/nextjs', () => ({ captureException: jest.fn() }));

// The real token client over a fake mint transport, so its per-process cache, renewal, denial and
// backoff are the ones the publisher gets. Only the HTTP mint, the Vercel identity and the Vercel
// runtime are replaced.
const mockMint = jest.fn<Promise<MintResult>, [MintRequest]>();
const mockHttpOptions: unknown[] = [];
const mockIdentityOptions: unknown[] = [];
const mockCacheOptions: unknown[] = [];
const mockWaitUntil = jest.fn<void, [Promise<unknown>]>();
/** Each identity or mint module evaluation, so a legacy publication can prove it loaded neither. */
const mockModuleLoads: string[] = [];
jest.mock('@vercel/functions', () => ({
  getCache: (options: unknown) => {
    mockCacheOptions.push(options);
    return {};
  },
  waitUntil: (promise: Promise<unknown>) => mockWaitUntil(promise),
}));
jest.mock('@kilocode/service-token-client/vercel', () => {
  mockModuleLoads.push('service-token-client/vercel');
  return {
    vercelIdentity: (options: unknown) => {
      mockIdentityOptions.push(options);
      return async () => 'synthetic-identity';
    },
  };
});
jest.mock('@kilocode/service-token-client', () => {
  mockModuleLoads.push('service-token-client');
  const actual = jest.requireActual<typeof ServiceTokenClient>('@kilocode/service-token-client');
  return {
    ...actual,
    createHttpServiceTokens: (options: unknown) => {
      mockHttpOptions.push(options);
      return actual.createServiceTokens(request => mockMint(request), {
        attemptTimeoutMs: actual.HTTP_ATTEMPT_TIMEOUT_MS,
      });
    },
  };
});

import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import { STS_ISSUERS, STS_USAGE_PUBLISH } from '@kilocode/sts-contracts';
import type { MintRequest, MintResult } from '@kilocode/sts-contracts';
import type * as ServiceTokenClient from '@kilocode/service-token-client';
import {
  toUsageRecordWireBody,
  type EnkryptUsageWriteInput,
  type ExaUsageRecord,
  type LlmUsageQueueMessage,
} from '@kilocode/usage-contracts';
import type * as PublisherModule from './usage-publisher';
import type * as CredentialModule from './usage-publish-credential';

const PRODUCTION_ORIGIN = 'https://usage-ingest.engineering-e11.workers.dev';
const STAGING_ORIGIN = 'https://usage-ingest-staging.engineering-e11.workers.dev';
const SECRET = 'synthetic-publisher-secret';
const TOKEN_1 = 'synthetic-sts-token-1';
const TOKEN_2 = 'synthetic-sts-token-2';
const PRODUCTION = { VERCEL_ENV: 'production', VERCEL_TARGET_ENV: 'production' };
const STAGING = { VERCEL_ENV: 'preview', VERCEL_TARGET_ENV: 'staging' };
const PREVIEW = { VERCEL_ENV: 'preview', VERCEL_TARGET_ENV: 'preview' };
const LOCAL = { VERCEL_ENV: undefined, VERCEL_TARGET_ENV: undefined };
const PRODUCTION_URL = `${PRODUCTION_ORIGIN}/usage`;
const STAGING_URL = `${STAGING_ORIGIN}/usage`;
const DENIED_SCOPE: MintResult = {
  status: 'ok',
  tokens: [{ status: 'denied', ...STS_USAGE_PUBLISH, reason: 'scope_not_allowed' }],
};
const START = 1_800_000_000_000;

// Fixtures: only `id` matters to the publisher; it serializes whatever it is given.
const payload = {
  core: { id: '3f2504e0-4f89-11d3-9a0c-0305e82c3301' },
} as unknown as LlmUsageQueueMessage;
const enkrypt = { id: 'synthetic-enkrypt-usage' } as unknown as EnkryptUsageWriteInput;
const exa = { id: 'synthetic-exa-usage' } as unknown as ExaUsageRecord;

const ENV_KEYS = ['USAGE_PUBLISHER_AUTH', 'VERCEL_ENV', 'VERCEL_TARGET_ENV', 'VERCEL_REGION'];
const originalEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
const mockFetch = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>();
let warn: jest.SpiedFunction<typeof console.warn>;
let info: jest.SpiedFunction<typeof console.info>;

function setEnv(values: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

/** A fresh publisher and token client: the client is per process, so per module instance. */
function load(): { publisher: typeof PublisherModule; credential: typeof CredentialModule } {
  let publisher: typeof PublisherModule | undefined;
  let credential: typeof CredentialModule | undefined;
  jest.isolateModules(() => {
    publisher = jest.requireActual<typeof PublisherModule>('./usage-publisher');
    credential = jest.requireActual<typeof CredentialModule>('./usage-publish-credential');
  });
  if (!publisher || !credential) throw new Error('modules did not load');
  return { publisher, credential };
}

function issued(token: string, lifetimeSeconds = 300): MintResult {
  return {
    status: 'ok',
    tokens: [
      {
        status: 'issued',
        ...STS_USAGE_PUBLISH,
        token,
        jti: `jti-${token}`,
        expiresAt: Math.floor(Date.now() / 1000) + lifetimeSeconds,
      },
    ],
  };
}

/** Resolves after `ms` on the fake clock. */
function fakeDelay(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

function accepted(): Promise<Response> {
  return Promise.resolve(new Response(null, { status: 202 }));
}

function sentUrls(): unknown[] {
  return mockFetch.mock.calls.map(([url]) => url);
}

function sentAuthorizations(): unknown[] {
  return mockFetch.mock.calls.map(([, init]) => new Headers(init?.headers).get('authorization'));
}

/** Advances fake time in 10 ms steps until `work` settles, so no unrelated timer runs early. */
async function settle<T>(work: Promise<T>): Promise<{ value: T; settledAt: number }> {
  // Widened, since the callbacks below assign it where control flow cannot see.
  let settledAt = null as number | null;
  void work.then(
    () => (settledAt = Date.now()),
    () => (settledAt = Date.now())
  );
  for (let step = 0; step < 12_000 && settledAt === null; step++) {
    await jest.advanceTimersByTimeAsync(10);
  }
  if (settledAt === null) throw new Error('the publication did not settle');
  return { value: await work, settledAt };
}

function expectNoStsWork(): void {
  expect(mockMint).not.toHaveBeenCalled();
  expect(mockHttpOptions).toEqual([]);
  expect(mockIdentityOptions).toEqual([]);
  expect(mockCacheOptions).toEqual([]);
  expect(mockWaitUntil).not.toHaveBeenCalled();
  expect(mockModuleLoads).toEqual([]);
}

function expectNoSecretOrTokenLogged(...tokens: string[]): void {
  const logged = JSON.stringify([warn.mock.calls, info.mock.calls]);
  for (const value of [SECRET, ...tokens]) expect(logged).not.toContain(value);
}

beforeEach(() => {
  // The publisher imports the STS token module on demand, outside `load()`'s isolated registry; a
  // fresh registry gives every test its own token client.
  jest.resetModules();
  mockModuleLoads.length = 0;
  setEnv({ USAGE_PUBLISHER_AUTH: undefined, VERCEL_REGION: undefined, ...PRODUCTION });
  mockConfig.USAGE_INGEST_URL = `${PRODUCTION_ORIGIN}/usage`;
  mockConfig.USAGE_INGEST_PUBLISH_SECRET = SECRET;
  mockMint.mockReset();
  mockWaitUntil.mockReset();
  mockHttpOptions.length = 0;
  mockIdentityOptions.length = 0;
  mockCacheOptions.length = 0;
  mockFetch.mockReset();
  jest.spyOn(globalThis, 'fetch').mockImplementation(mockFetch);
  jest.spyOn(Math, 'random').mockReturnValue(0);
  warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  info = jest.spyOn(console, 'info').mockImplementation(() => {});
});

afterEach(() => {
  setEnv(originalEnv);
  jest.restoreAllMocks();
  jest.useRealTimers();
});

describe('usagePublisherAuth', () => {
  test.each([
    [undefined, 'legacy'],
    ['legacy', 'legacy'],
    ['sts', 'sts'],
    ['', null],
    ['dual', null],
    ['STS', null],
    [' sts', null],
    ['legacy,sts', null],
  ])('reads %j as %j', (value, expected) => {
    expect(load().credential.usagePublisherAuth(value)).toBe(expected);
  });
});

describe('stsPublishTarget', () => {
  test('binds production and the staging custom environment to their own origin', () => {
    const { stsPublishTarget } = load().credential;
    expect(stsPublishTarget(PRODUCTION, PRODUCTION_URL)).toEqual({
      origin: PRODUCTION_ORIGIN,
      environment: 'production',
    });
    expect(stsPublishTarget(STAGING, STAGING_URL)).toEqual({
      origin: STAGING_ORIGIN,
      environment: 'staging',
    });
  });

  test.each([
    ['production with the staging URL', PRODUCTION, STAGING_URL],
    ['staging with the production URL', STAGING, PRODUCTION_URL],
    ['a preview', PREVIEW, PRODUCTION_URL],
    ['no Vercel environment', LOCAL, PRODUCTION_URL],
    ['production targeting staging', { ...PRODUCTION, VERCEL_TARGET_ENV: 'staging' }, STAGING_URL],
    ['a missing URL', PRODUCTION, undefined],
    ['a trailing slash', PRODUCTION, `${PRODUCTION_URL}/`],
    ['an explicit port', PRODUCTION, `${PRODUCTION_ORIGIN}:443/usage`],
    ['plain http', PRODUCTION, PRODUCTION_URL.replace('https:', 'http:')],
    ['credentials', PRODUCTION, PRODUCTION_URL.replace('https://', 'https://user:pass@')],
    ['a query', PRODUCTION, `${PRODUCTION_URL}?fixture=1`],
    ['a fragment', PRODUCTION, `${PRODUCTION_URL}#fixture`],
    ['a sibling path', PRODUCTION, `${PRODUCTION_ORIGIN}/exa-usage`],
    ['a longer host', PRODUCTION, `${PRODUCTION_ORIGIN}.example.test/usage`],
    ['another spelling', PRODUCTION, PRODUCTION_URL.replace('usage-ingest', 'USAGE-INGEST')],
  ])('has no target for %s', (_label, runtime, url) => {
    expect(load().credential.stsPublishTarget(runtime, url)).toBeNull();
  });
});

describe('USAGE_PUBLISHER_AUTH legacy', () => {
  test.each([undefined, 'legacy'])(
    'with %j sends the secret to the configured URL and does no STS work',
    async mode => {
      setEnv({ USAGE_PUBLISHER_AUTH: mode });
      mockConfig.USAGE_INGEST_URL = 'https://usage.example.test/usage';
      mockFetch.mockImplementation(accepted);
      const { publisher } = load();

      expect(await publisher.enqueueUsage(payload)).toEqual({ kind: 'accepted' });
      expect(await publisher.enqueueEnkryptUsage(enkrypt)).toEqual({ kind: 'accepted' });
      expect(publisher.isExaUsagePublicationConfigured()).toBe(true);
      expect(mockFetch.mock.calls[0]).toEqual([
        'https://usage.example.test/usage',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', Authorization: `Bearer ${SECRET}` },
          body: JSON.stringify(toUsageRecordWireBody(payload)),
          signal: expect.any(AbortSignal),
          cache: 'no-store',
          redirect: 'manual',
        },
      ]);
      expect(sentUrls()).toEqual([
        'https://usage.example.test/usage',
        'https://usage.example.test/enkrypt-usage',
      ]);
      expectNoStsWork();
    }
  );

  test('keeps the secret on the exact STS origin too: only the switch selects STS', async () => {
    mockFetch.mockImplementation(accepted);
    const { publisher } = load();
    expect(await publisher.enqueueUsage(payload)).toEqual({ kind: 'accepted' });
    expect(sentAuthorizations()).toEqual([`Bearer ${SECRET}`]);
    expectNoStsWork();
  });
});

describe('USAGE_PUBLISHER_AUTH sts', () => {
  beforeEach(() => {
    setEnv({ USAGE_PUBLISHER_AUTH: 'sts' });
  });

  test('loads the identity and mint modules only for an STS token read', async () => {
    mockMint.mockImplementation(async () => issued(TOKEN_1));
    mockFetch.mockImplementation(accepted);
    const { publisher } = load();
    expect(publisher.isExaUsagePublicationConfigured()).toBe(true);
    expect(mockModuleLoads).toEqual([]);

    expect(await publisher.enqueueUsage(payload)).toEqual({ kind: 'accepted' });
    expect([...mockModuleLoads].sort()).toEqual([
      'service-token-client',
      'service-token-client/vercel',
    ]);
  });

  test('production: fixed origin and path per kind, one production token, no secret', async () => {
    mockMint.mockImplementation(async () => issued('synthetic-sts-token-1'));
    mockFetch.mockImplementation(accepted);
    const { publisher } = load();

    expect(publisher.isExaUsagePublicationConfigured()).toBe(true);
    expect(await publisher.enqueueUsage(payload, { retryTransientFailures: true })).toEqual({
      kind: 'accepted',
    });
    expect(await publisher.enqueueEnkryptUsage(enkrypt)).toEqual({ kind: 'accepted' });
    expect(await publisher.enqueueExaUsage(exa)).toEqual({ kind: 'accepted' });

    expect(mockFetch.mock.calls[0]).toEqual([
      `${PRODUCTION_ORIGIN}/usage`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          Authorization: 'Bearer synthetic-sts-token-1',
        },
        body: JSON.stringify(toUsageRecordWireBody(payload)),
        signal: expect.any(AbortSignal),
        cache: 'no-store',
        redirect: 'manual',
      },
    ]);
    expect(sentUrls()).toEqual([
      `${PRODUCTION_ORIGIN}/usage`,
      `${PRODUCTION_ORIGIN}/enkrypt-usage`,
      `${PRODUCTION_ORIGIN}/exa-usage`,
    ]);
    expect(sentAuthorizations()).toEqual(Array(3).fill('Bearer synthetic-sts-token-1'));
    // One mint serves all three: the token client is per process.
    expect(mockMint.mock.calls).toEqual([[{ tokens: [{ ...STS_USAGE_PUBLISH }] }]]);
    expect(mockHttpOptions).toEqual([
      { stsUrl: STS_ISSUERS.production, getIdentityToken: expect.any(Function) },
    ]);
    expect(mockIdentityOptions).toEqual([
      { stsAudience: STS_ISSUERS.production, cache: expect.anything() },
    ]);
    expect(mockCacheOptions).toEqual([
      { namespace: 'sts-exchange', keyHashFunction: expect.any(Function) },
    ]);
    expect(JSON.stringify(mockFetch.mock.calls)).not.toContain(SECRET);
    expect(warn).not.toHaveBeenCalled();
    expectNoSecretOrTokenLogged('synthetic-sts-token-1');
  });

  test('staging: staging origin and issuer, with no publish secret configured', async () => {
    setEnv(STAGING);
    mockConfig.USAGE_INGEST_URL = `${STAGING_ORIGIN}/usage`;
    mockConfig.USAGE_INGEST_PUBLISH_SECRET = undefined;
    mockMint.mockImplementation(async () => issued('synthetic-sts-token-staging'));
    mockFetch.mockImplementation(accepted);
    const { publisher } = load();

    expect(publisher.isExaUsagePublicationConfigured()).toBe(true);
    expect(await publisher.enqueueExaUsage(exa)).toEqual({ kind: 'accepted' });
    expect(sentUrls()).toEqual([`${STAGING_ORIGIN}/exa-usage`]);
    expect(sentAuthorizations()).toEqual(['Bearer synthetic-sts-token-staging']);
    expect(mockHttpOptions).toEqual([
      { stsUrl: STS_ISSUERS.staging, getIdentityToken: expect.any(Function) },
    ]);
  });

  test.each([
    ['an unknown switch value', { USAGE_PUBLISHER_AUTH: 'dual' }, PRODUCTION_URL],
    ['an empty switch value', { USAGE_PUBLISHER_AUTH: '' }, PRODUCTION_URL],
    ['production configured with the staging URL', {}, STAGING_URL],
    ['staging configured with the production URL', STAGING, PRODUCTION_URL],
    ['a preview', PREVIEW, PRODUCTION_URL],
    ['a local process', LOCAL, PRODUCTION_URL],
    ['an arbitrary configured URL', {}, 'https://usage.example.test/usage'],
    ['a loopback URL', {}, 'http://127.0.0.1:8787/usage'],
    ['a missing URL', {}, undefined],
  ])('publishes nothing for %s, without minting or using the secret', async (_label, env, url) => {
    setEnv(env);
    mockConfig.USAGE_INGEST_URL = url;
    const { publisher } = load();

    expect(publisher.isExaUsagePublicationConfigured()).toBe(false);
    for (const outcome of [
      await publisher.enqueueUsage(payload, { retryTransientFailures: true }),
      await publisher.enqueueEnkryptUsage(enkrypt),
      await publisher.enqueueExaUsage(exa),
    ]) {
      expect(outcome).toEqual({ kind: 'unavailable', reason: 'publisher_not_configured' });
    }
    expect(mockFetch).not.toHaveBeenCalled();
    expectNoStsWork();
  });

  test.each([
    ['a denied scope', DENIED_SCOPE],
    ['a rejected identity', { status: 'identity_rejected' }],
  ] satisfies [string, MintResult][])(
    '%s launches nothing, ends not_sent at once and stays denied without asking STS again',
    async (_label, result) => {
      mockMint.mockResolvedValue(result);
      const { publisher } = load();

      const notSent = { kind: 'not_sent', reason: 'sts_token_denied' };
      expect(await publisher.enqueueUsage(payload, { retryTransientFailures: true })).toEqual(
        notSent
      );
      expect(await publisher.enqueueEnkryptUsage(enkrypt)).toEqual(notSent);
      expect(mockMint).toHaveBeenCalledTimes(1);
      expect(mockFetch).not.toHaveBeenCalled();
      expect(warn.mock.calls).toEqual([
        [
          'usage enqueue unavailable',
          { usageId: payload.core.id, execution_region: 'unknown', ...notSent },
        ],
        [
          'usage enqueue unavailable',
          {
            usageId: enkrypt.id,
            usage_kind: 'enkrypt_usage',
            execution_region: 'unknown',
            ...notSent,
          },
        ],
      ]);
      expectNoSecretOrTokenLogged();
    }
  );

  test('a receiver refusal is final: no second send, and never with the secret', async () => {
    mockMint.mockImplementation(async () => issued(TOKEN_1));
    mockFetch.mockResolvedValue(new Response(null, { status: 401 }));
    const { publisher } = load();

    expect(await publisher.enqueueUsage(payload, { retryTransientFailures: true })).toEqual({
      kind: 'unavailable',
      reason: 'http_401',
    });
    expect(sentAuthorizations()).toEqual([`Bearer ${TOKEN_1}`]);
  });

  test('transient receiver failures retry with the held token, read per attempt', async () => {
    mockMint.mockImplementation(async () => issued(TOKEN_1));
    mockFetch
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(null, { status: 429 }))
      .mockImplementationOnce(accepted);
    const { publisher } = load();

    expect(await publisher.enqueueUsage(payload, { retryTransientFailures: true })).toEqual({
      kind: 'accepted',
    });
    expect(sentAuthorizations()).toEqual(Array(3).fill(`Bearer ${TOKEN_1}`));
    expect(mockMint).toHaveBeenCalledTimes(1);
    expectNoSecretOrTokenLogged(TOKEN_1);
  });

  test('a cold STS failure ends not_sent; the next one mints after the backoff', async () => {
    jest.useFakeTimers({ now: START });
    mockMint
      .mockResolvedValueOnce({ status: 'unavailable', retryAfterSeconds: 1 })
      .mockImplementationOnce(async () => issued(TOKEN_1));
    mockFetch.mockImplementation(accepted);
    const { publisher } = load();

    const first = await settle(publisher.enqueueUsage(payload, { retryTransientFailures: true }));
    expect(first.value).toEqual({ kind: 'not_sent', reason: 'sts_token_unavailable' });
    expect(first.settledAt - START).toBeLessThanOrEqual(publisher.USAGE_ENQUEUE_STS_FIRST_TOKEN_MS);
    expect(mockFetch).not.toHaveBeenCalled();
    // No retry inside the publication: the token client backs off 2 s before its next mint.
    expect(warn.mock.calls.map(([message]) => message)).toEqual(['usage enqueue unavailable']);

    await jest.advanceTimersByTimeAsync(2_000);
    const second = await settle(publisher.enqueueEnkryptUsage(enkrypt));
    expect(second.value).toEqual({ kind: 'accepted' });
    expect(mockMint).toHaveBeenCalledTimes(2);
    expect(sentAuthorizations()).toEqual([`Bearer ${TOKEN_1}`]);
  });

  test.each([
    ['retried', 2_000, { retryTransientFailures: true }],
    ['single-attempt', 1_000, { retryTransientFailures: false }],
  ])(
    'a hung first mint ends a %s publication not_sent within %s ms, the read left to waitUntil',
    async (_label, windowMs, options) => {
      jest.useFakeTimers({ now: START });
      mockMint.mockImplementation(() => new Promise<MintResult>(() => {}));
      const { publisher } = load();

      const { value, settledAt } = await settle(publisher.enqueueUsage(payload, options));
      expect(value).toEqual({ kind: 'not_sent', reason: 'sts_token_unavailable' });
      expect(settledAt - START).toBeLessThanOrEqual(windowMs);
      expect(mockMint).toHaveBeenCalledTimes(1);
      expect(mockFetch).not.toHaveBeenCalled();
      expect(mockWaitUntil).toHaveBeenCalled();
      expect(JSON.stringify(warn.mock.calls)).not.toContain('duplicate_possible');
    }
  );

  test('a token after a launched send fails as unavailable, never not_sent', async () => {
    jest.useFakeTimers({ now: START });
    // A 45 s token is served for 15 s: the 503 answers after that, so the retry needs a new one.
    mockMint
      .mockImplementationOnce(async () => issued(TOKEN_1, 45))
      .mockResolvedValue({ status: 'unavailable', retryAfterSeconds: 1 });
    mockFetch.mockImplementation(async () => {
      await fakeDelay(16_000);
      return new Response(null, { status: 503 });
    });
    const { publisher } = load();

    const { value, settledAt } = await settle(
      publisher.enqueueUsage(payload, { retryTransientFailures: true })
    );
    expect(value).toEqual({ kind: 'unavailable', reason: 'sts_token_unavailable' });
    expect(settledAt - START).toBeLessThanOrEqual(publisher.USAGE_ENQUEUE_RETRY_BUDGET_MS);
    expect(sentAuthorizations()).toEqual([`Bearer ${TOKEN_1}`]);
    // Each later attempt asks the client once, which mints only after its own backoff.
    expect(mockMint.mock.calls.length).toBeLessThanOrEqual(publisher.USAGE_ENQUEUE_MAX_ATTEMPTS);
    expect(warn).toHaveBeenLastCalledWith('usage enqueue unavailable', {
      usageId: payload.core.id,
      execution_region: 'unknown',
      kind: 'unavailable',
      reason: 'sts_token_unavailable',
      duplicate_possible: true,
    });
    expectNoSecretOrTokenLogged(TOKEN_1);
  });

  test('a cold mint inside the 1 s single window leaves the send its 1 s reserve', async () => {
    jest.useFakeTimers({ now: START });
    mockMint.mockImplementation(async () => {
      await fakeDelay(900);
      return issued(TOKEN_1);
    });
    mockFetch.mockImplementation(accepted);
    const timeout = jest.spyOn(AbortSignal, 'timeout');
    const { publisher } = load();

    expect((await settle(publisher.enqueueUsage(payload))).value).toEqual({ kind: 'accepted' });
    const [[sendTimeoutMs]] = timeout.mock.calls;
    expect(sendTimeoutMs).toBeGreaterThanOrEqual(publisher.USAGE_ENQUEUE_STS_FIRST_SEND_RESERVE_MS);
    expect(sendTimeoutMs).toBeLessThanOrEqual(publisher.USAGE_ENQUEUE_TIMEOUT_MS - 900);
  });

  test('a single-attempt mint slower than its 1 s window launches nothing', async () => {
    jest.useFakeTimers({ now: START });
    mockMint.mockImplementation(async () => {
      await fakeDelay(1_500);
      return issued(TOKEN_1);
    });
    mockFetch.mockImplementation(accepted);
    const { publisher } = load();

    const { value, settledAt } = await settle(publisher.enqueueUsage(payload));
    expect(value).toEqual({ kind: 'not_sent', reason: 'sts_token_unavailable' });
    expect(settledAt - START).toBeLessThanOrEqual(
      publisher.USAGE_ENQUEUE_STS_SINGLE_FIRST_TOKEN_MS
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test.each([
    ['retried', 2_000, { retryTransientFailures: true }],
    ['single-attempt', 1_000, { retryTransientFailures: false }],
  ])(
    'a %s first token read that returns after its %s ms window launches nothing',
    async (_label, windowMs, options) => {
      jest.useFakeTimers({ now: START });
      // The token is ready at once, but the publisher resumes only after the window, and so the
      // send reserve, has passed, as when the event loop stalls before any timer runs.
      const fakeNow = performance.now.bind(performance);
      let stalledMs = 0;
      jest.spyOn(performance, 'now').mockImplementation(() => fakeNow() + stalledMs);
      mockMint.mockImplementation(async () => {
        stalledMs = windowMs + 1;
        return issued(TOKEN_1);
      });
      mockFetch.mockImplementation(accepted);
      const { publisher } = load();

      expect((await settle(publisher.enqueueUsage(payload, options))).value).toEqual({
        kind: 'not_sent',
        reason: 'sts_token_unavailable',
      });
      expect(mockMint).toHaveBeenCalledTimes(1);
      expect(mockFetch).not.toHaveBeenCalled();
      expect(JSON.stringify(warn.mock.calls)).not.toContain('duplicate_possible');
      expectNoSecretOrTokenLogged(TOKEN_1);
    }
  );

  test('a warm token gives the single-attempt send its whole 2 s window', async () => {
    jest.useFakeTimers({ now: START });
    mockMint.mockImplementation(async () => issued(TOKEN_1));
    mockFetch.mockImplementation(accepted);
    const { publisher } = load();

    expect((await settle(publisher.enqueueUsage(payload))).value).toEqual({ kind: 'accepted' });
    const timeout = jest.spyOn(AbortSignal, 'timeout');
    expect((await settle(publisher.enqueueUsage(payload))).value).toEqual({ kind: 'accepted' });
    const [[sendTimeoutMs]] = timeout.mock.calls;
    // At most one 10 ms settle step passes before the send.
    expect(sendTimeoutMs).toBeGreaterThanOrEqual(publisher.USAGE_ENQUEUE_TIMEOUT_MS - 10);
    expect(sendTimeoutMs).toBeLessThanOrEqual(publisher.USAGE_ENQUEUE_TIMEOUT_MS);
    expect(mockMint).toHaveBeenCalledTimes(1);
    expect(sentAuthorizations()).toEqual([`Bearer ${TOKEN_1}`, `Bearer ${TOKEN_1}`]);
  });

  test('renews in the background, and never sends a token inside its 30 s margin', async () => {
    jest.useFakeTimers({ now: START });
    mockMint
      .mockImplementationOnce(async () => issued(TOKEN_1))
      .mockResolvedValueOnce({ status: 'unavailable', retryAfterSeconds: 60 })
      .mockImplementationOnce(async () => issued(TOKEN_2));
    mockFetch.mockImplementation(accepted);
    const { publisher } = load();

    expect((await settle(publisher.enqueueUsage(payload))).value).toEqual({ kind: 'accepted' });
    // Past the 240 s renewal point: the held token is still served while a renewal starts.
    await jest.advanceTimersByTimeAsync(241_000);
    expect((await settle(publisher.enqueueEnkryptUsage(enkrypt))).value).toEqual({
      kind: 'accepted',
    });
    expect(mockMint).toHaveBeenCalledTimes(2);
    expect(mockWaitUntil).toHaveBeenCalled();

    // Past 270 s, inside the margin, with the renewal backing off for 60 s: the old token is not
    // sent, and nothing was launched, so the publication ends not_sent.
    await jest.advanceTimersByTimeAsync(30_000);
    expect((await settle(publisher.enqueueExaUsage(exa))).value).toEqual({
      kind: 'not_sent',
      reason: 'sts_token_unavailable',
    });
    expect(mockMint).toHaveBeenCalledTimes(2);

    // After the client's backoff the next publication mints and sends the new token.
    await jest.advanceTimersByTimeAsync(31_000);
    expect((await settle(publisher.enqueueExaUsage(exa))).value).toEqual({ kind: 'accepted' });
    expect(mockMint).toHaveBeenCalledTimes(3);
    expect(sentAuthorizations()).toEqual([
      `Bearer ${TOKEN_1}`,
      `Bearer ${TOKEN_1}`,
      `Bearer ${TOKEN_2}`,
    ]);
    expectNoSecretOrTokenLogged(TOKEN_1, TOKEN_2);
  });
});
