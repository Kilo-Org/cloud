import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BundleBinding } from '@kilocode/secrets-client';
import { clearSecretCacheForTest, signKiloToken } from '@kilocode/worker-utils';
import { NOTIFICATIONS_AUDIENCE } from '@kilocode/worker-utils/internal-service-token-audiences';

import type { NotificationsService } from '../index';
import {
  createSecretsComparison,
  SECRETS_COMPARE_DEADLINE_MS,
  type CheckedRoute,
  type RefusedCheck,
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
// STS copies that differ from the Secrets Store values above, and a wrong presented secret.
const STS_NEXTAUTH = 'compare-nextauth-sts-fixture-0123456789abcdef';
const STS_INTERNAL = 'compare-internal-sts-fixture-0123456789abcdef';
const STS_EXPO = 'compare-expo-sts-fixture';
const WRONG_INTERNAL = 'x'.repeat(INTERNAL.length);
const FIXTURE_VALUES = [
  APNS_KEY_ONE_LINE,
  APNS_KEY_WRAPPED,
  NEXTAUTH,
  INTERNAL,
  EXPO,
  STS_NEXTAUTH,
  STS_INTERNAL,
  STS_EXPO,
  WRONG_INTERNAL,
];

const EVENT = {
  compare: 'notifications_secrets_compare',
  expo: 'notifications_secrets_compare_expo',
  refused: 'notifications_secrets_compare_refused',
  stsRead: 'notifications_secret_source_read',
  credentialRefused: 'notifications_credential_refused',
  secretUnavailable: 'notifications_secret_unavailable',
} as const;

// The route's dispatch work is faked: these specs prove where the comparison runs, not what a
// dispatch does with its recipients. No provider, database or recipient DO is reached through it.
vi.mock('../lib/internal-dispatch-push', () => ({ dispatchInternalPushCore: vi.fn() }));

const DISPATCH_PATH = '/internal/v1/dispatch';
const REFRESH_PATH = '/internal/v1/glanceable-refresh';
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
const UNAUTHORIZED = { status: 401, body: { error: 'Unauthorized' } };

type BundleResult = Awaited<ReturnType<BundleBinding['getBundle']>>;

const DENIED: BundleResult = { status: 'denied', reason: 'unknown_workload' };

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

const COMPARED_BUNDLE = {
  NOTIFICATIONS_APNS_PRIVATE_KEY: APNS_KEY_ONE_LINE,
  NEXTAUTH_SECRET: NEXTAUTH,
  INTERNAL_API_SECRET: INTERNAL,
};
const MATCHING_BUNDLE = { ...COMPARED_BUNDLE, NOTIFICATIONS_EXPO_ACCESS_TOKEN: EXPO };

function storeSecret(value: string) {
  const get = vi.fn(async () => value);
  return { secret: { get } as SecretsStoreSecret, get };
}

/**
 * Store values plus a fresh STS binding (the client keeps one bundle per binding for the isolate).
 * Compare is on in production; the source is the Secrets Store unless `source` says otherwise.
 */
function fixture(bundle: BundleResult = okBundle(MATCHING_BUNDLE), source = 'secrets-store') {
  const getBundle = vi.fn<BundleBinding['getBundle']>(async () => bundle);
  const apnsKey = storeSecret(APNS_KEY_ONE_LINE);
  const nextAuth = storeSecret(NEXTAUTH);
  const internal = storeSecret(INTERNAL);
  const expo = storeSecret(EXPO);
  const compareEnv: SecretsCompareEnv = {
    WORKER_ENV: 'production',
    SECRETS_COMPARE_ENABLED: 'true',
    SECRETS_SOURCE: source,
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

function captureLogs() {
  const spies = (['log', 'warn', 'error'] as const).map(method =>
    vi.spyOn(console, method).mockImplementation(() => undefined)
  );
  const calls = () => spies.flatMap(spy => spy.mock.calls);
  return {
    lines: (event: string) =>
      calls()
        .filter(([name]) => name === event)
        .map(([, fields]) => fields),
    // An error prints its name and message, so a value inside one would show here too.
    raw: () =>
      JSON.stringify(calls(), (_key, value: unknown) =>
        value instanceof Error ? `${value.name}: ${value.message}` : value
      ),
  };
}

function compareLine(
  checked: CheckedRoute,
  [apnsKey, nextAuth, internalApi]: readonly [boolean, boolean, boolean],
  mismatched: string[] = []
) {
  return {
    NOTIFICATIONS_APNS_PRIVATE_KEY: apnsKey,
    NEXTAUTH_SECRET: nextAuth,
    INTERNAL_API_SECRET: internalApi,
    ...checked,
    mismatched,
  };
}

function expoLine(checked: CheckedRoute, result: string) {
  return { ...checked, secret: 'NOTIFICATIONS_EXPO_ACCESS_TOKEN', result };
}

const ALL_MATCH = [true, true, true] as const;
const NONE_PROVEN = [false, false, false] as const;
const STORE_DISPATCH: CheckedRoute = { route: 'dispatch', source: 'secrets-store' };

async function runAdmitted(compareEnv: SecretsCompareEnv, checked: CheckedRoute) {
  const logs = captureLogs();
  const { ctx, settled } = lifetime();
  createSecretsComparison().admitted(compareEnv, () => ctx, checked);
  await settled();
  return logs;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('createSecretsComparison', () => {
  const refusedInternal: RefusedCheck = {
    ...STORE_DISPATCH,
    secret: 'INTERNAL_API_SECRET',
    selected: INTERNAL,
  };

  it.each([
    { SECRETS_COMPARE_ENABLED: undefined },
    { SECRETS_COMPARE_ENABLED: 'false' },
    { SECRETS_COMPARE_ENABLED: 'TRUE' },
    { SECRETS_COMPARE_ENABLED: 'on' },
    { WORKER_ENV: 'staging' },
    { WORKER_ENV: undefined },
  ])('reads nothing, the execution context included, with %o', async override => {
    const { compareEnv, getBundle, storeReads } = fixture();
    const logs = captureLogs();
    const executionCtx = vi.fn(() => lifetime().ctx);
    const compare = createSecretsComparison();
    const disabled = { ...compareEnv, ...override };

    compare.admitted(disabled, executionCtx, STORE_DISPATCH);
    compare.refused(disabled, executionCtx, refusedInternal);

    expect(executionCtx).not.toHaveBeenCalled();
    expect(getBundle).not.toHaveBeenCalled();
    expect(storeReads()).toBe(0);
    expect(logs.raw()).toBe('[]');
  });

  it('stays armed when the execution context cannot be read', async () => {
    const { compareEnv, getBundle } = fixture();
    const logs = captureLogs();
    const compare = createSecretsComparison();

    compare.admitted(
      compareEnv,
      () => {
        throw new Error('no execution context');
      },
      STORE_DISPATCH
    );
    expect(getBundle).not.toHaveBeenCalled();

    const { ctx, settled } = lifetime();
    compare.admitted(compareEnv, () => ctx, STORE_DISPATCH);
    await settled();
    expect(logs.lines(EVENT.compare)).toEqual([compareLine(STORE_DISPATCH, ALL_MATCH)]);
  });

  it('logs the three names and Expo for exact copies, once per isolate', async () => {
    const { compareEnv, getBundle, apnsKey, nextAuth, internal, expo } = fixture();
    const logs = captureLogs();
    const compare = createSecretsComparison();

    const first = lifetime();
    compare.admitted(compareEnv, () => first.ctx, STORE_DISPATCH);
    await first.settled();
    const later = lifetime();
    compare.admitted(compareEnv, () => later.ctx, STORE_DISPATCH);
    compare.admitted(compareEnv, () => later.ctx, { route: 'badges', source: 'secrets-store' });
    await later.settled();

    expect(logs.lines(EVENT.compare)).toEqual([compareLine(STORE_DISPATCH, ALL_MATCH)]);
    expect(logs.lines(EVENT.expo)).toEqual([expoLine(STORE_DISPATCH, 'match')]);
    expect(later.waitUntil).not.toHaveBeenCalled();
    expect(getBundle).toHaveBeenCalledOnce();
    for (const read of [apnsKey.get, nextAuth.get, internal.get, expo.get]) {
      expect(read).toHaveBeenCalledOnce();
    }
    for (const value of FIXTURE_VALUES) expect(logs.raw()).not.toContain(value);
  });

  it('compares the same way while sts serves and names an STS-side mismatch', async () => {
    const { compareEnv } = fixture(
      okBundle({ ...MATCHING_BUNDLE, NEXTAUTH_SECRET: STS_NEXTAUTH }),
      'sts'
    );
    const checked: CheckedRoute = { route: 'badges', source: 'sts' };

    const logs = await runAdmitted(compareEnv, checked);

    expect(logs.lines(EVENT.compare)).toEqual([
      compareLine(checked, [true, false, true], ['NEXTAUTH_SECRET']),
    ]);
    expect(logs.lines(EVENT.expo)).toEqual([expoLine(checked, 'match')]);
    for (const value of FIXTURE_VALUES) expect(logs.raw()).not.toContain(value);
  });

  it('names any byte difference, whitespace in the APNs key included', async () => {
    const { compareEnv } = fixture(
      okBundle({
        ...MATCHING_BUNDLE,
        NOTIFICATIONS_APNS_PRIVATE_KEY: APNS_KEY_WRAPPED,
        NEXTAUTH_SECRET: `${NEXTAUTH} `,
      })
    );

    const logs = await runAdmitted(compareEnv, STORE_DISPATCH);

    expect(logs.lines(EVENT.compare)).toEqual([
      compareLine(
        STORE_DISPATCH,
        [false, false, true],
        ['NOTIFICATIONS_APNS_PRIVATE_KEY', 'NEXTAUTH_SECRET']
      ),
    ]);
    for (const value of FIXTURE_VALUES) expect(logs.raw()).not.toContain(value);
  });

  it.each([
    [
      'missing from the bundle',
      okBundle(COMPARED_BUNDLE, ['NOTIFICATIONS_EXPO_ACCESS_TOKEN']),
      'unproven',
    ],
    [
      'different in the bundle',
      okBundle({ ...MATCHING_BUNDLE, NOTIFICATIONS_EXPO_ACCESS_TOKEN: STS_EXPO }),
      'mismatch',
    ],
  ])('keeps Expo on its own line when its copy is %s', async (_case, bundle, expoResult) => {
    const logs = await runAdmitted(fixture(bundle).compareEnv, STORE_DISPATCH);

    expect(logs.lines(EVENT.compare)).toEqual([compareLine(STORE_DISPATCH, ALL_MATCH)]);
    expect(logs.lines(EVENT.expo)).toEqual([expoLine(STORE_DISPATCH, expoResult)]);
  });

  it.each([
    ['a denied bundle', DENIED],
    ['a bundle without the names', okBundle({})],
    ['a bundle that reports the names missing', okBundle({}, Object.keys(MATCHING_BUNDLE))],
  ])('proves nothing and names no mismatch for %s', async (_case, bundle) => {
    const logs = await runAdmitted(fixture(bundle).compareEnv, STORE_DISPATCH);

    expect(logs.lines(EVENT.compare)).toEqual([compareLine(STORE_DISPATCH, NONE_PROVEN)]);
    expect(logs.lines(EVENT.expo)).toEqual([expoLine(STORE_DISPATCH, 'unproven')]);
  });

  it('proves nothing without the STS binding and reads no store value', async () => {
    const { compareEnv, storeReads } = fixture();

    const logs = await runAdmitted({ ...compareEnv, STS: undefined }, STORE_DISPATCH);

    expect(logs.lines(EVENT.compare)).toEqual([compareLine(STORE_DISPATCH, NONE_PROVEN)]);
    expect(logs.lines(EVENT.expo)).toEqual([expoLine(STORE_DISPATCH, 'unproven')]);
    expect(storeReads()).toBe(0);
  });

  it('proves nothing for a missing, failing or empty store value, error dropped', async () => {
    const { compareEnv, nextAuth } = fixture(
      okBundle({ ...MATCHING_BUNDLE, INTERNAL_API_SECRET: '' })
    );
    nextAuth.get.mockRejectedValue(new Error(`store read failed for ${NEXTAUTH}`));

    const logs = await runAdmitted(
      {
        ...compareEnv,
        APNS_PRIVATE_KEY: undefined,
        INTERNAL_API_SECRET: storeSecret('').secret,
      },
      STORE_DISPATCH
    );

    expect(logs.lines(EVENT.compare)).toEqual([compareLine(STORE_DISPATCH, NONE_PROVEN)]);
    for (const value of FIXTURE_VALUES) expect(logs.raw()).not.toContain(value);
  });

  it('settles nothing proven at the deadline when STS never answers', async () => {
    vi.useFakeTimers();
    const getBundle = vi.fn<BundleBinding['getBundle']>(() => new Promise(() => undefined));
    const { compareEnv } = fixture();
    const logs = captureLogs();
    const { ctx, waitUntil } = lifetime();

    const stalled = { ...compareEnv, STS: { getBundle } };
    createSecretsComparison().admitted(stalled, () => ctx, STORE_DISPATCH);
    // The comparison registers its own promise last; the secrets client may add a bounded
    // keep-alive of its own first.
    const comparison = waitUntil.mock.lastCall?.[0];
    await vi.advanceTimersByTimeAsync(SECRETS_COMPARE_DEADLINE_MS);
    await comparison;

    expect(logs.lines(EVENT.compare)).toEqual([compareLine(STORE_DISPATCH, NONE_PROVEN)]);
    expect(logs.lines(EVENT.expo)).toEqual([expoLine(STORE_DISPATCH, 'unproven')]);
  });

  it('compares only the refused name, against the value read, once per route', async () => {
    const { compareEnv, getBundle, apnsKey, nextAuth, internal, expo } = fixture();
    const logs = captureLogs();
    const compare = createSecretsComparison();
    const refuse = async (checked: RefusedCheck) => {
      const { ctx, waitUntil, settled } = lifetime();
      compare.refused(compareEnv, () => ctx, checked);
      await settled();
      return waitUntil;
    };

    await refuse(refusedInternal);
    expect(await refuse(refusedInternal)).not.toHaveBeenCalled();
    await refuse({ ...refusedInternal, route: 'glanceable_refresh' });

    expect(logs.lines(EVENT.refused)).toEqual([
      {
        route: 'dispatch',
        secret: 'INTERNAL_API_SECRET',
        source: 'secrets-store',
        result: 'match',
      },
      {
        route: 'glanceable_refresh',
        secret: 'INTERNAL_API_SECRET',
        source: 'secrets-store',
        result: 'match',
      },
    ]);
    // Only the other source is read: the guard's value is never read again, no other name is.
    expect(getBundle).toHaveBeenCalledOnce();
    for (const read of [apnsKey.get, nextAuth.get, internal.get, expo.get]) {
      expect(read).not.toHaveBeenCalled();
    }
    expect(logs.lines(EVENT.compare)).toEqual([]);
  });

  it("names a refused name's STS-side mismatch under sts, reading only the store", async () => {
    const { compareEnv, getBundle, internal } = fixture(
      okBundle({ ...MATCHING_BUNDLE, INTERNAL_API_SECRET: STS_INTERNAL }),
      'sts'
    );
    const logs = captureLogs();
    const { ctx, settled } = lifetime();

    createSecretsComparison().refused(compareEnv, () => ctx, {
      route: 'dispatch',
      source: 'sts',
      secret: 'INTERNAL_API_SECRET',
      selected: STS_INTERNAL,
    });
    await settled();

    expect(logs.lines(EVENT.refused)).toEqual([
      { route: 'dispatch', secret: 'INTERNAL_API_SECRET', source: 'sts', result: 'mismatch' },
    ]);
    expect(internal.get).toHaveBeenCalledOnce();
    expect(getBundle).not.toHaveBeenCalled();
    for (const value of FIXTURE_VALUES) expect(logs.raw()).not.toContain(value);
  });
});

describe('the sts read marker', () => {
  // The marker latches per module graph. A static import is evaluated once at file load and
  // cannot yield a fresh graph, so each spec loads its own dynamically.
  async function freshModules() {
    vi.resetModules();
    const secrets = await import('../secrets');
    const compare = await import('../secrets-compare');
    return { secrets, compare };
  }

  it('logs once for the first non-empty sts value served, never for comparisons', async () => {
    const { secrets, compare } = await freshModules();
    const { compareEnv } = fixture(okBundle(MATCHING_BUNDLE), 'sts');
    const storeEnv = { ...compareEnv, SECRETS_SOURCE: 'secrets-store' };
    const logs = captureLogs();

    // Comparisons read the bundle under either source without the marker.
    for (const [comparedEnv, source] of [
      [storeEnv, 'secrets-store'],
      [compareEnv, 'sts'],
    ] as const) {
      const { ctx, settled } = lifetime();
      const comparison = compare.createSecretsComparison();
      comparison.admitted(comparedEnv, () => ctx, { route: 'dispatch', source });
      comparison.refused(comparedEnv, () => ctx, {
        route: 'dispatch',
        source,
        secret: 'INTERNAL_API_SECRET',
        selected: INTERNAL,
      });
      await settled();
    }
    expect(logs.lines(EVENT.compare)).toHaveLength(2);
    expect(logs.lines(EVENT.refused)).toHaveLength(2);
    // Serving reads from the Secrets Store never log it.
    await secrets.readNotificationsSecret(storeEnv, 'NEXTAUTH_SECRET', lifetime().ctx);
    expect(logs.lines(EVENT.stsRead)).toEqual([]);

    const served = await secrets.readNotificationsSecret(
      compareEnv,
      'NEXTAUTH_SECRET',
      lifetime().ctx
    );
    expect(served).toBe(NEXTAUTH);
    await secrets.readNotificationsSecret(compareEnv, 'INTERNAL_API_SECRET', lifetime().ctx);
    expect(logs.lines(EVENT.stsRead)).toEqual([{ source: 'sts' }]);
    for (const value of FIXTURE_VALUES) expect(logs.raw()).not.toContain(value);
  });

  it('stays silent for an empty or failed sts read, with no store fallback', async () => {
    const { secrets } = await freshModules();
    const { compareEnv, storeReads } = fixture(
      okBundle({ NEXTAUTH_SECRET: '' }, ['INTERNAL_API_SECRET']),
      'sts'
    );
    const logs = captureLogs();

    const empty = await secrets.readNotificationsSecret(
      compareEnv,
      'NEXTAUTH_SECRET',
      lifetime().ctx
    );
    expect(empty).toBe('');
    await expect(
      secrets.readNotificationsSecret(compareEnv, 'INTERNAL_API_SECRET', lifetime().ctx)
    ).rejects.toThrow();

    expect(storeReads()).toBe(0);
    expect(logs.lines(EVENT.stsRead)).toEqual([]);
  });
});

async function bearer(userId: string, secret = NEXTAUTH) {
  const { token } = await signKiloToken({
    userId,
    // The shared test setup's user row holds a null pepper.
    pepper: null,
    secret,
    expiresInSeconds: 3600,
    env: 'production',
    audience: NOTIFICATIONS_AUDIENCE,
  });
  return token;
}

function badgesRequest(token: string | null) {
  return new Request('https://example.com/v1/badges', {
    headers: token === null ? {} : { authorization: `Bearer ${token}` },
  });
}

type InternalRequestOptions = { secret?: string | null; body?: unknown; rawBody?: string };

function internalRequest(path: string, options: InternalRequestOptions = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  // `null` omits the header; leaving it out sends the fixture's internal secret.
  if (options.secret !== null) headers['X-Internal-Secret'] = options.secret ?? INTERNAL;
  return new Request(`https://example.com${path}`, {
    method: 'POST',
    headers,
    body: options.rawBody ?? JSON.stringify(options.body ?? DISPATCH_BODY),
  });
}

async function send(service: typeof NotificationsService, serviceEnv: object, request: Request) {
  const ctx = createExecutionContext();
  const response = await new service(ctx, serviceEnv as never).fetch(request);
  const result = { status: response.status, body: await response.json().catch(() => null) };
  await waitOnExecutionContext(ctx);
  return result;
}

describe('route guards with the comparison', () => {
  // The verifier caches the Secrets Store signer per isolate; start and leave each test clean.
  beforeEach(() => {
    vi.clearAllMocks();
    clearSecretCacheForTest();
  });
  afterEach(() => clearSecretCacheForTest());

  // The comparison and the marker latch per module graph, and one graph per spec is what lets each
  // route show its own trigger. A static import is evaluated once at file load and cannot yield
  // that fresh graph, so this boundary needs the dynamic one.
  async function freshWorker() {
    vi.resetModules();
    const { NotificationsService: Service } = await import('../index');
    const { dispatchInternalPushCore } = await import('../lib/internal-dispatch-push');
    return { Service, dispatchCore: vi.mocked(dispatchInternalPushCore) };
  }

  const nextAuthLabels = (source: string) =>
    ({ route: 'badges', secret: 'NEXTAUTH_SECRET', source }) as const;

  it('keeps legacy badge answers, labels 401s and compares once after authentication', async () => {
    const { Service } = await freshWorker();
    // A denied bundle: the comparison fails, and the response must not notice.
    const { compareEnv, getBundle } = fixture(DENIED);
    const logs = captureLogs();
    const compareOffEnv = { ...env, ...compareEnv, SECRETS_COMPARE_ENABLED: undefined };
    const compareOnEnv = { ...env, ...compareEnv };
    const token = await bearer('user-compare-badges');
    const otherToken = await bearer('user-compare-badges', STS_NEXTAUTH);

    const legacy = await send(Service, compareOffEnv, badgesRequest(token));
    expect(legacy).toEqual({ status: 200, body: { buckets: [] } });
    expect(getBundle).not.toHaveBeenCalled();

    expect(await send(Service, compareOnEnv, badgesRequest(null))).toEqual(UNAUTHORIZED);
    // The Secrets Store binding is the verifier's to read, so a refused bearer compares nothing.
    expect(await send(Service, compareOnEnv, badgesRequest(otherToken))).toEqual(UNAUTHORIZED);
    expect(getBundle).not.toHaveBeenCalled();
    expect(logs.lines(EVENT.credentialRefused)).toEqual([
      { ...nextAuthLabels('secrets-store'), reason: 'missing' },
      { ...nextAuthLabels('secrets-store'), reason: 'invalid' },
    ]);

    expect(await send(Service, compareOnEnv, badgesRequest(token))).toEqual(legacy);
    expect(getBundle).toHaveBeenCalledOnce();
    const checked: CheckedRoute = { route: 'badges', source: 'secrets-store' };
    expect(logs.lines(EVENT.compare)).toEqual([compareLine(checked, NONE_PROVEN)]);
    expect(logs.lines(EVENT.expo)).toEqual([expoLine(checked, 'unproven')]);

    expect(await send(Service, compareOnEnv, badgesRequest(token))).toEqual(legacy);
    expect(getBundle).toHaveBeenCalledOnce();
    expect(logs.lines(EVENT.compare)).toHaveLength(1);
    expect(logs.lines(EVENT.refused)).toEqual([]);
    expect(logs.lines(EVENT.stsRead)).toEqual([]);
    for (const value of [...FIXTURE_VALUES, token, otherToken]) {
      expect(logs.raw()).not.toContain(value);
    }
  });

  it('serves badges only from the bundle under sts and names the signer mismatch', async () => {
    const { Service } = await freshWorker();
    const { compareEnv, nextAuth } = fixture(
      okBundle({ ...MATCHING_BUNDLE, NEXTAUTH_SECRET: STS_NEXTAUTH }),
      'sts'
    );
    const serviceEnv = { ...env, ...compareEnv };
    const logs = captureLogs();
    const storeToken = await bearer('user-compare-sts', NEXTAUTH);
    const stsToken = await bearer('user-compare-sts', STS_NEXTAUTH);

    // No fallback: a bearer signed with the Secrets Store value is refused while sts serves.
    expect(await send(Service, serviceEnv, badgesRequest(storeToken))).toEqual(UNAUTHORIZED);
    expect(await send(Service, serviceEnv, badgesRequest(storeToken))).toEqual(UNAUTHORIZED);
    expect(logs.lines(EVENT.credentialRefused)).toEqual([
      { ...nextAuthLabels('sts'), reason: 'invalid' },
      { ...nextAuthLabels('sts'), reason: 'invalid' },
    ]);
    // One refused comparison for the route, of the bundle value the check used.
    expect(logs.lines(EVENT.refused)).toEqual([
      { route: 'badges', secret: 'NEXTAUTH_SECRET', source: 'sts', result: 'mismatch' },
    ]);
    expect(nextAuth.get).toHaveBeenCalledOnce();

    expect(await send(Service, serviceEnv, badgesRequest(stsToken))).toEqual({
      status: 200,
      body: { buckets: [] },
    });
    const checked: CheckedRoute = { route: 'badges', source: 'sts' };
    expect(logs.lines(EVENT.compare)).toEqual([
      compareLine(checked, [true, false, true], ['NEXTAUTH_SECRET']),
    ]);
    expect(logs.lines(EVENT.stsRead)).toEqual([{ source: 'sts' }]);
    for (const value of [...FIXTURE_VALUES, storeToken, stsToken]) {
      expect(logs.raw()).not.toContain(value);
    }
  });

  it.each([
    ['missing', okBundle({ INTERNAL_API_SECRET: INTERNAL }, ['NEXTAUTH_SECRET'])],
    ['not_granted', okBundle({ INTERNAL_API_SECRET: INTERNAL })],
    ['denied', DENIED],
    ['empty', okBundle({ NEXTAUTH_SECRET: '' })],
  ])('answers 401 under sts with a fixed %s reason, no store read', async (reason, bundle) => {
    const { Service } = await freshWorker();
    const { compareEnv, storeReads } = fixture(bundle, 'sts');
    const logs = captureLogs();

    expect(
      await send(Service, { ...env, ...compareEnv }, badgesRequest(await bearer('user-x')))
    ).toEqual(UNAUTHORIZED);

    expect(logs.lines(EVENT.secretUnavailable)).toEqual([{ ...nextAuthLabels('sts'), reason }]);
    expect(storeReads()).toBe(0);
    expect(logs.lines(EVENT.refused)).toEqual([]);
    expect(logs.lines(EVENT.stsRead)).toEqual([]);
  });

  it('labels dispatch refusals and compares one refusal and one admission', async () => {
    const { Service, dispatchCore } = await freshWorker();
    dispatchCore.mockResolvedValue(DISPATCH_RESULT);
    const { compareEnv, getBundle, internal } = fixture();
    const logs = captureLogs();
    const compareOffEnv = { ...env, ...compareEnv, SECRETS_COMPARE_ENABLED: undefined };
    const compareOnEnv = { ...env, ...compareEnv };
    const labels = { route: 'dispatch', secret: 'INTERNAL_API_SECRET', source: 'secrets-store' };
    const dispatch = (serviceEnv: object, options?: InternalRequestOptions) =>
      send(Service, serviceEnv, internalRequest(DISPATCH_PATH, options));

    // Off: every 401 is still labelled, and nothing opens the bundle.
    expect(await dispatch(compareOffEnv, { secret: null })).toEqual(UNAUTHORIZED);
    expect(await dispatch(compareOffEnv, { secret: WRONG_INTERNAL })).toEqual(UNAUTHORIZED);
    expect(await dispatch(compareOffEnv)).toEqual({ status: 200, body: DISPATCH_RESULT });
    expect(getBundle).not.toHaveBeenCalled();
    expect(logs.lines(EVENT.credentialRefused)).toEqual([
      { ...labels, reason: 'missing' },
      { ...labels, reason: 'invalid' },
    ]);
    expect(logs.lines(EVENT.refused)).toEqual([]);
    expect(logs.lines(EVENT.compare)).toEqual([]);

    // On: a keyless request compares nothing; a refused secret compares its own name once for
    // the route, against the value the guard read and never the presented one.
    expect(await dispatch(compareOnEnv, { secret: null })).toEqual(UNAUTHORIZED);
    expect(getBundle).not.toHaveBeenCalled();
    const guardReads = internal.get.mock.calls.length;
    expect(await dispatch(compareOnEnv, { secret: WRONG_INTERNAL })).toEqual(UNAUTHORIZED);
    expect(await dispatch(compareOnEnv, { secret: WRONG_INTERNAL })).toEqual(UNAUTHORIZED);
    expect(logs.lines(EVENT.refused)).toEqual([
      {
        route: 'dispatch',
        secret: 'INTERNAL_API_SECRET',
        source: 'secrets-store',
        result: 'match',
      },
    ]);
    expect(internal.get).toHaveBeenCalledTimes(guardReads + 2);

    // A failed body check reaches neither the admitted comparison nor dispatch work.
    expect(await dispatch(compareOnEnv, { rawBody: '{not-valid-json' })).toEqual({
      status: 400,
      body: { error: 'Invalid body' },
    });
    expect(await dispatch(compareOnEnv, { body: { kind: 'low_balance' } })).toEqual({
      status: 400,
      body: { error: 'Invalid body' },
    });
    expect(dispatchCore).toHaveBeenCalledOnce();
    expect(logs.lines(EVENT.compare)).toEqual([]);

    // An admitted dispatch compares every name once and still answers from dispatch work.
    expect(await dispatch(compareOnEnv)).toEqual({ status: 200, body: DISPATCH_RESULT });
    expect(dispatchCore).toHaveBeenCalledTimes(2);
    expect(dispatchCore).toHaveBeenLastCalledWith(
      DISPATCH_BODY,
      expect.objectContaining({
        getRecipientDOStub: expect.any(Function),
        readPreferences: expect.any(Function),
      })
    );
    expect(logs.lines(EVENT.compare)).toEqual([compareLine(STORE_DISPATCH, ALL_MATCH)]);
    expect(logs.lines(EVENT.expo)).toEqual([expoLine(STORE_DISPATCH, 'match')]);
    expect(getBundle).toHaveBeenCalledOnce();

    // The badge list shares the admitted latch.
    const token = await bearer(DISPATCH_USER);
    expect(await send(Service, compareOnEnv, badgesRequest(token))).toEqual({
      status: 200,
      body: { buckets: [] },
    });
    expect(logs.lines(EVENT.compare)).toHaveLength(1);
    expect(logs.lines(EVENT.stsRead)).toEqual([]);
    for (const value of [...FIXTURE_VALUES, token]) expect(logs.raw()).not.toContain(value);
  });

  it('labels and compares the glanceable refresh guard on its own route latch', async () => {
    const { Service } = await freshWorker();
    const { compareEnv } = fixture(
      okBundle({ ...MATCHING_BUNDLE, INTERNAL_API_SECRET: STS_INTERNAL })
    );
    const refreshes: unknown[] = [];
    const serviceEnv = {
      ...env,
      ...compareEnv,
      NOTIFICATION_CHANNEL_DO: {
        idFromName: (userId: string) => userId,
        get: () => ({
          refreshGlanceableSnapshot: async (scope: unknown) => {
            refreshes.push(scope);
          },
        }),
      },
    };
    const logs = captureLogs();
    const labels = {
      route: 'glanceable_refresh',
      secret: 'INTERNAL_API_SECRET',
      source: 'secrets-store',
    };
    const body = { userId: 'user-compare-refresh', organizationId: null };
    const refresh = (secret?: string | null) =>
      send(Service, serviceEnv, internalRequest(REFRESH_PATH, { secret, body }));

    expect(await refresh(null)).toEqual(UNAUTHORIZED);
    expect(await refresh(WRONG_INTERNAL)).toEqual(UNAUTHORIZED);
    expect(logs.lines(EVENT.credentialRefused)).toEqual([
      { ...labels, reason: 'missing' },
      { ...labels, reason: 'invalid' },
    ]);
    // The STS copy differs from the store value this guard checked against.
    expect(logs.lines(EVENT.refused)).toEqual([{ ...labels, result: 'mismatch' }]);
    expect(refreshes).toEqual([]);

    expect(await refresh()).toEqual({ status: 200, body: { ok: true } });
    expect(refreshes).toEqual([body]);
    expect(logs.lines(EVENT.compare)).toEqual([
      compareLine(
        { route: 'glanceable_refresh', source: 'secrets-store' },
        [true, true, false],
        ['INTERNAL_API_SECRET']
      ),
    ]);
    for (const value of FIXTURE_VALUES) expect(logs.raw()).not.toContain(value);
  });

  it.each([
    ['missing', okBundle({ NEXTAUTH_SECRET: NEXTAUTH }, ['INTERNAL_API_SECRET'])],
    ['not_granted', okBundle({ NEXTAUTH_SECRET: NEXTAUTH })],
    ['denied', DENIED],
  ])('fails dispatch as before under sts with a fixed %s reason', async (reason, bundle) => {
    const { Service, dispatchCore } = await freshWorker();
    const { compareEnv, storeReads } = fixture(bundle, 'sts');
    const logs = captureLogs();

    const result = await send(Service, { ...env, ...compareEnv }, internalRequest(DISPATCH_PATH));

    expect(result.status).toBe(500);
    expect(logs.lines(EVENT.secretUnavailable)).toEqual([
      { route: 'dispatch', secret: 'INTERNAL_API_SECRET', source: 'sts', reason },
    ]);
    expect(storeReads()).toBe(0);
    expect(dispatchCore).not.toHaveBeenCalled();
    expect(logs.lines(EVENT.refused)).toEqual([]);
    expect(logs.lines(EVENT.compare)).toEqual([]);
    expect(logs.lines(EVENT.stsRead)).toEqual([]);
    for (const value of FIXTURE_VALUES) expect(logs.raw()).not.toContain(value);
  });

  it('labels closed-staging refusals and compares nothing outside production', async () => {
    const { Service } = await freshWorker();
    const { compareEnv, getBundle } = fixture();
    const logs = captureLogs();
    const stagingEnv = { ...env, ...compareEnv, WORKER_ENV: 'staging' };
    const closedEnv = {
      ...stagingEnv,
      INTERNAL_API_SECRET: undefined,
      NEXTAUTH_SECRET: undefined,
    };
    const token = await bearer('user-compare-staging');

    expect(await send(Service, closedEnv, internalRequest(DISPATCH_PATH))).toEqual(UNAUTHORIZED);
    expect(await send(Service, closedEnv, badgesRequest(token))).toEqual(UNAUTHORIZED);
    expect(logs.lines(EVENT.secretUnavailable)).toEqual([
      {
        route: 'dispatch',
        secret: 'INTERNAL_API_SECRET',
        source: 'secrets-store',
        reason: 'binding_missing',
      },
      { ...nextAuthLabels('secrets-store'), reason: 'binding_missing' },
    ]);

    // Even with the flag set, a staging refusal compares nothing.
    const wrong = internalRequest(DISPATCH_PATH, { secret: WRONG_INTERNAL });
    expect(await send(Service, stagingEnv, wrong)).toEqual(UNAUTHORIZED);
    expect(getBundle).not.toHaveBeenCalled();
    expect(logs.lines(EVENT.refused)).toEqual([]);
  });
});
