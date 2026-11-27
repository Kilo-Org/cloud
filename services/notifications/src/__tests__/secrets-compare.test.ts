import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BundleBinding } from '@kilocode/secrets-client';
import { clearSecretCacheForTest, signKiloToken } from '@kilocode/worker-utils';
import { NOTIFICATIONS_AUDIENCE } from '@kilocode/worker-utils/internal-service-token-audiences';

import { NotificationsService } from '../index';
import {
  createSecretsComparison,
  SECRETS_COMPARE_DEADLINE_MS,
  type SecretsCompareEnv,
} from '../secrets-compare';

// Synthetic fixture values only; none is a real key or signing secret.
const APNS_KEY_ONE_LINE =
  '-----BEGIN PRIVATE KEY-----QUFBQUFhcG5zLWZpeHR1cmU=-----END PRIVATE KEY-----';
const APNS_KEY_WRAPPED =
  '-----BEGIN PRIVATE KEY-----\nQUFBQUFh\ncG5zLWZpeHR1cmU=\n-----END PRIVATE KEY-----\n';
const NEXTAUTH = 'compare-nextauth-fixture-0123456789abcdef';
const INTERNAL = 'compare-internal-fixture-0123456789abcdef';
const EXPO = 'compare-expo-fixture';
const FIXTURE_VALUES = [APNS_KEY_ONE_LINE, APNS_KEY_WRAPPED, NEXTAUTH, INTERNAL, EXPO];
const COMPARE_EVENT = 'notifications_secrets_compare';

// The route's dispatch work is faked: these specs prove where the comparison runs, not what a
// dispatch does with its recipients. No provider, database or recipient DO is reached through it.
vi.mock('../lib/internal-dispatch-push', () => ({ dispatchInternalPushCore: vi.fn() }));

const DISPATCH_USER = 'user-compare-dispatch';
const DISPATCH_BODY = {
  kind: 'low_balance',
  recipientUserIds: [DISPATCH_USER],
  organizationId: 'org-compare',
  organizationName: 'Compare Fixture Org',
  minimumBalanceUsd: 10,
};
const DISPATCH_RESULT = {
  perRecipient: [{ userId: DISPATCH_USER, outcome: 'delivered' as const }],
};

type BundleResult = Awaited<ReturnType<BundleBinding['getBundle']>>;

function okBundle(secrets: Record<string, string>, missing: string[] = []): BundleResult {
  return {
    status: 'ok',
    workload: 'notifications',
    environment: 'production',
    etag: '"0123456789abcdef"',
    stale: false,
    fetchedAt: '2026-11-27T00:00:00.000Z',
    secrets: Object.fromEntries(
      Object.entries(secrets).map(([name, value]) => [name, { value, version: 1 }])
    ),
    missing,
  };
}

const MATCHING_BUNDLE = {
  NOTIFICATIONS_APNS_PRIVATE_KEY: APNS_KEY_ONE_LINE,
  NOTIFICATIONS_EXPO_ACCESS_TOKEN: EXPO,
  NEXTAUTH_SECRET: NEXTAUTH,
  INTERNAL_API_SECRET: INTERNAL,
};

function storeSecret(value: string) {
  const get = vi.fn(async () => value);
  return { secret: { get } as SecretsStoreSecret, get };
}

/**
 * Store values the Worker serves today plus a fresh STS binding (the client keeps one bundle per
 * binding for the isolate). Compare is on and the source is the Secrets Store unless overridden.
 */
function fixture(bundle: BundleResult = okBundle(MATCHING_BUNDLE)) {
  const getBundle = vi.fn<BundleBinding['getBundle']>(async () => bundle);
  const apnsKey = storeSecret(APNS_KEY_ONE_LINE);
  const nextAuth = storeSecret(NEXTAUTH);
  const internal = storeSecret(INTERNAL);
  const expo = storeSecret(EXPO);
  const compareEnv: SecretsCompareEnv = {
    SECRETS_COMPARE_ENABLED: 'true',
    SECRETS_SOURCE: 'secrets-store',
    STS: { getBundle },
    APNS_PRIVATE_KEY: apnsKey.secret,
    NEXTAUTH_SECRET: nextAuth.secret,
    INTERNAL_API_SECRET: internal.secret,
    EXPO_ACCESS_TOKEN: expo.secret,
  };
  const storeReads = () =>
    apnsKey.get.mock.calls.length +
    nextAuth.get.mock.calls.length +
    internal.get.mock.calls.length +
    expo.get.mock.calls.length;
  return { compareEnv, getBundle, apnsKey, nextAuth, internal, expo, storeReads };
}

function lifetime() {
  const pending: Array<Promise<unknown>> = [];
  const waitUntil = vi.fn((promise: Promise<unknown>) => {
    pending.push(promise);
  });
  return { ctx: { waitUntil }, waitUntil, settled: () => Promise.all(pending) };
}

function captureCompareLogs() {
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  return {
    results: () => log.mock.calls.filter(([event]) => event === COMPARE_EVENT).map(([, r]) => r),
    raw: () => JSON.stringify(log.mock.calls),
  };
}

async function runOnce(compareEnv: SecretsCompareEnv) {
  const logs = captureCompareLogs();
  const { ctx, settled } = lifetime();
  createSecretsComparison()(compareEnv, ctx);
  await settled();
  return logs;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('createSecretsComparison', () => {
  it.each([undefined, 'false', '1', 'TRUE', 'on'])(
    'does no work while SECRETS_COMPARE_ENABLED is %s',
    async flag => {
      const { compareEnv, getBundle, storeReads } = fixture();
      const logs = captureCompareLogs();
      const { ctx, waitUntil } = lifetime();

      createSecretsComparison()({ ...compareEnv, SECRETS_COMPARE_ENABLED: flag }, ctx);

      expect(waitUntil).not.toHaveBeenCalled();
      expect(getBundle).not.toHaveBeenCalled();
      expect(storeReads()).toBe(0);
      expect(logs.results()).toEqual([]);
    }
  );

  it.each([undefined, 'sts'])('does no work while SECRETS_SOURCE is %s', async source => {
    const { compareEnv, getBundle, storeReads } = fixture();
    const { ctx, waitUntil } = lifetime();

    createSecretsComparison()({ ...compareEnv, SECRETS_SOURCE: source }, ctx);

    expect(waitUntil).not.toHaveBeenCalled();
    expect(getBundle).not.toHaveBeenCalled();
    expect(storeReads()).toBe(0);
  });

  it('logs only the three names with true for exact copies, once per isolate', async () => {
    const { compareEnv, getBundle, apnsKey, nextAuth, internal, expo } = fixture();
    const logs = captureCompareLogs();
    const compare = createSecretsComparison();

    const first = lifetime();
    compare(compareEnv, first.ctx);
    await first.settled();
    const later = lifetime();
    compare(compareEnv, later.ctx);
    compare(compareEnv, later.ctx);
    await later.settled();

    expect(logs.results()).toEqual([
      { NOTIFICATIONS_APNS_PRIVATE_KEY: true, NEXTAUTH_SECRET: true, INTERNAL_API_SECRET: true },
    ]);
    expect(later.waitUntil).not.toHaveBeenCalled();
    expect(getBundle).toHaveBeenCalledOnce();
    expect(apnsKey.get).toHaveBeenCalledOnce();
    expect(nextAuth.get).toHaveBeenCalledOnce();
    expect(internal.get).toHaveBeenCalledOnce();
    // Expo is not part of this check.
    expect(expo.get).not.toHaveBeenCalled();
    for (const value of FIXTURE_VALUES) expect(logs.raw()).not.toContain(value);
  });

  it('reports false for any byte difference, an APNs key that differs only in whitespace included', async () => {
    const { compareEnv } = fixture(
      okBundle({
        NOTIFICATIONS_APNS_PRIVATE_KEY: APNS_KEY_WRAPPED,
        NEXTAUTH_SECRET: `${NEXTAUTH} `,
        INTERNAL_API_SECRET: INTERNAL,
      })
    );

    const logs = await runOnce(compareEnv);

    expect(logs.results()).toEqual([
      { NOTIFICATIONS_APNS_PRIVATE_KEY: false, NEXTAUTH_SECRET: false, INTERNAL_API_SECRET: true },
    ]);
    for (const value of FIXTURE_VALUES) expect(logs.raw()).not.toContain(value);
  });

  it.each([
    ['a denied bundle', { status: 'denied', reason: 'unknown_workload' } satisfies BundleResult],
    ['a bundle without the names', okBundle({})],
    [
      'a bundle that reports the names missing',
      okBundle({}, ['NOTIFICATIONS_APNS_PRIVATE_KEY', 'NEXTAUTH_SECRET', 'INTERNAL_API_SECRET']),
    ],
  ])('reports every name false for %s', async (_case, bundle) => {
    const logs = await runOnce(fixture(bundle).compareEnv);

    expect(logs.results()).toEqual([
      { NOTIFICATIONS_APNS_PRIVATE_KEY: false, NEXTAUTH_SECRET: false, INTERNAL_API_SECRET: false },
    ]);
  });

  it('reports every name false without the STS binding and reads no store value', async () => {
    const { compareEnv, storeReads } = fixture();

    const logs = await runOnce({ ...compareEnv, STS: undefined });

    expect(logs.results()).toEqual([
      { NOTIFICATIONS_APNS_PRIVATE_KEY: false, NEXTAUTH_SECRET: false, INTERNAL_API_SECRET: false },
    ]);
    expect(storeReads()).toBe(0);
  });

  it('reports false for a missing, failing or empty store value and drops the error', async () => {
    const { compareEnv, nextAuth } = fixture(
      okBundle({ ...MATCHING_BUNDLE, INTERNAL_API_SECRET: '' })
    );
    nextAuth.get.mockRejectedValue(new Error(`store read failed for ${NEXTAUTH}`));

    const logs = await runOnce({
      ...compareEnv,
      APNS_PRIVATE_KEY: undefined,
      INTERNAL_API_SECRET: storeSecret('').secret,
    });

    expect(logs.results()).toEqual([
      { NOTIFICATIONS_APNS_PRIVATE_KEY: false, NEXTAUTH_SECRET: false, INTERNAL_API_SECRET: false },
    ]);
    for (const value of FIXTURE_VALUES) expect(logs.raw()).not.toContain(value);
  });

  it('settles every name false at the deadline when STS never answers', async () => {
    vi.useFakeTimers();
    const getBundle = vi.fn<BundleBinding['getBundle']>(() => new Promise(() => undefined));
    const { compareEnv } = fixture();
    const logs = captureCompareLogs();
    const { ctx, waitUntil } = lifetime();

    createSecretsComparison()({ ...compareEnv, STS: { getBundle } }, ctx);
    // Only the comparison's own promise; the secrets client may add its bounded keep-alive.
    const comparison = waitUntil.mock.calls[0][0];
    await vi.advanceTimersByTimeAsync(SECRETS_COMPARE_DEADLINE_MS);
    await comparison;

    expect(logs.results()).toEqual([
      { NOTIFICATIONS_APNS_PRIVATE_KEY: false, NEXTAUTH_SECRET: false, INTERNAL_API_SECRET: false },
    ]);
  });
});

async function bearer(userId: string) {
  const { token } = await signKiloToken({
    userId,
    // The shared test setup's user row holds a null pepper.
    pepper: null,
    secret: NEXTAUTH,
    expiresInSeconds: 3600,
    env: 'production',
    audience: NOTIFICATIONS_AUDIENCE,
  });
  return token;
}

async function listBadges(
  service: typeof NotificationsService,
  serviceEnv: object,
  token: string | null
) {
  const ctx = createExecutionContext();
  const instance = new service(ctx, serviceEnv as never);
  const response = await instance.fetch(
    new Request('https://example.com/v1/badges', {
      headers: token === null ? {} : { authorization: `Bearer ${token}` },
    })
  );
  const result = { status: response.status, body: await response.json() };
  await waitOnExecutionContext(ctx);
  return result;
}

describe('GET /v1/badges with the comparison', () => {
  // The verifier caches the Secrets Store signer per isolate; start and leave each test clean.
  beforeEach(() => clearSecretCacheForTest());
  afterEach(() => clearSecretCacheForTest());

  it('keeps the legacy answers and compares once, after authentication only', async () => {
    // A denied bundle: the comparison fails, and the response must not notice.
    const { compareEnv, getBundle } = fixture({ status: 'denied', reason: 'unknown_workload' });
    const logs = captureCompareLogs();
    const legacyEnv = { ...env, ...compareEnv, SECRETS_COMPARE_ENABLED: undefined };
    const compareOnEnv = { ...env, ...compareEnv };
    const token = await bearer('user-compare-badges');

    const legacy = await listBadges(NotificationsService, legacyEnv, token);
    expect(legacy).toEqual({ status: 200, body: { buckets: [] } });
    expect(getBundle).not.toHaveBeenCalled();

    expect(await listBadges(NotificationsService, compareOnEnv, null)).toEqual({
      status: 401,
      body: { error: 'Unauthorized' },
    });
    expect(getBundle).not.toHaveBeenCalled();

    expect(await listBadges(NotificationsService, compareOnEnv, token)).toEqual(legacy);
    expect(getBundle).toHaveBeenCalledOnce();
    expect(logs.results()).toEqual([
      { NOTIFICATIONS_APNS_PRIVATE_KEY: false, NEXTAUTH_SECRET: false, INTERNAL_API_SECRET: false },
    ]);

    expect(await listBadges(NotificationsService, compareOnEnv, token)).toEqual(legacy);
    expect(getBundle).toHaveBeenCalledOnce();
    expect(logs.results()).toHaveLength(1);
  });
});

describe('POST /internal/v1/dispatch with the comparison', () => {
  // The verifier caches the Secrets Store signer per isolate; start and leave each test clean.
  beforeEach(() => clearSecretCacheForTest());
  afterEach(() => clearSecretCacheForTest());

  // The comparison latches per module graph, and one graph per spec is what lets this route show
  // its own trigger while the badge spec above keeps its own latch. A static import is evaluated
  // once at file load and cannot yield that fresh graph, so this boundary needs the dynamic one.
  async function freshRoute() {
    vi.resetModules();
    const { NotificationsService: Service } = await import('../index');
    const { dispatchInternalPushCore } = await import('../lib/internal-dispatch-push');
    return { Service, dispatchCore: vi.mocked(dispatchInternalPushCore) };
  }

  async function postDispatch(
    service: typeof NotificationsService,
    serviceEnv: object,
    options: { secret?: string | null; body?: unknown; rawBody?: string } = {}
  ) {
    const ctx = createExecutionContext();
    const instance = new service(ctx, serviceEnv as never);
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    // `null` omits the header; leaving it out sends the fixture's internal secret.
    if (options.secret !== null) headers['X-Internal-Secret'] = options.secret ?? INTERNAL;
    const response = await instance.fetch(
      new Request('https://example.com/internal/v1/dispatch', {
        method: 'POST',
        headers,
        body: options.rawBody ?? JSON.stringify(options.body ?? DISPATCH_BODY),
      })
    );
    const result = { status: response.status, body: await response.json() };
    await waitOnExecutionContext(ctx);
    return result;
  }

  it('compares once after the secret and body checks, before dispatch, and shares the latch', async () => {
    const { Service, dispatchCore } = await freshRoute();
    dispatchCore.mockResolvedValue(DISPATCH_RESULT);
    const { compareEnv, getBundle } = fixture();
    const logs = captureCompareLogs();
    const compareOffEnv = { ...env, ...compareEnv, SECRETS_COMPARE_ENABLED: undefined };
    const compareOnEnv = { ...env, ...compareEnv };
    const token = await bearer('user-compare-dispatch');

    // Off: the route answers from dispatch work and never opens the bundle.
    expect(await postDispatch(Service, compareOffEnv, { secret: null })).toEqual({
      status: 401,
      body: { error: 'Unauthorized' },
    });
    expect(await postDispatch(Service, compareOffEnv)).toEqual({
      status: 200,
      body: DISPATCH_RESULT,
    });
    expect(dispatchCore).toHaveBeenCalledOnce();
    expect(getBundle).not.toHaveBeenCalled();
    expect(logs.results()).toEqual([]);

    // On, but rejected: neither the secret check nor the body check passes, so the comparison is
    // never reached and the latch stays unused.
    expect(await postDispatch(Service, compareOnEnv, { secret: null })).toEqual({
      status: 401,
      body: { error: 'Unauthorized' },
    });
    expect(
      await postDispatch(Service, compareOnEnv, { secret: 'x'.repeat(INTERNAL.length) })
    ).toEqual({ status: 401, body: { error: 'Unauthorized' } });
    expect(await postDispatch(Service, compareOnEnv, { rawBody: '{not-valid-json' })).toEqual({
      status: 400,
      body: { error: 'Invalid body' },
    });
    expect(await postDispatch(Service, compareOnEnv, { body: { kind: 'low_balance' } })).toEqual({
      status: 400,
      body: { error: 'Invalid body' },
    });
    expect(dispatchCore).toHaveBeenCalledOnce();
    expect(getBundle).not.toHaveBeenCalled();
    expect(logs.results()).toEqual([]);

    // The successful dispatch compares once, before dispatch work, and still answers from it.
    expect(await postDispatch(Service, compareOnEnv)).toEqual({
      status: 200,
      body: DISPATCH_RESULT,
    });
    expect(dispatchCore).toHaveBeenCalledTimes(2);
    expect(dispatchCore).toHaveBeenLastCalledWith(
      DISPATCH_BODY,
      expect.objectContaining({
        getRecipientDOStub: expect.any(Function),
        readPreferences: expect.any(Function),
      })
    );
    expect(getBundle).toHaveBeenCalledOnce();
    expect(logs.results()).toEqual([
      { NOTIFICATIONS_APNS_PRIVATE_KEY: true, NEXTAUTH_SECRET: true, INTERNAL_API_SECRET: true },
    ]);

    // The badge list shares the latch: a later authenticated list does not compare again.
    expect(await listBadges(Service, compareOnEnv, token)).toEqual({
      status: 200,
      body: { buckets: [] },
    });
    expect(getBundle).toHaveBeenCalledOnce();
    expect(logs.results()).toHaveLength(1);

    for (const value of FIXTURE_VALUES) expect(logs.raw()).not.toContain(value);
  });
});
