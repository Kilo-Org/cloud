import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BundleBinding } from '@kilocode/secrets-client';
import { clearSecretCacheForTest, signKiloToken } from '@kilocode/worker-utils';
import { authenticateToken, type AuthEnv } from './auth';
import {
  createSecretsComparison,
  SECRETS_COMPARE_DEADLINE_MS,
  SECRETS_COMPARE_EVENT,
  secretsComparison,
  type SecretsCompareEnv,
} from './secrets-compare';
import { STS_SOURCE_READ_EVENT } from './secrets';

const LEGACY = 'legacy-signer-fixture-value';
const DIFFERENT = 'bundle-signer-fixture-other';
const WRONG_SIGNER = 'wrong-signer-fixture-value';
const FIXTURE_VALUES = [LEGACY, DIFFERENT, WRONG_SIGNER];
const ROUTE = 'connect_ticket';
const USER_ID = 'user-compare-fixture';

type BundleResult = Awaited<ReturnType<BundleBinding['getBundle']>>;

function okBundle(secrets: Record<string, string>, missing: string[] = []): BundleResult {
  return {
    status: 'ok',
    workload: 'event-service',
    environment: 'production',
    etag: '"0123456789abcdef"',
    stale: false,
    fetchedAt: '2026-11-28T00:00:00.000Z',
    secrets: Object.fromEntries(
      Object.entries(secrets).map(([name, value]) => [name, { value, version: 1 }])
    ),
    missing,
  };
}

/** A fresh binding per test: the client keeps one bundle per binding for the isolate. */
function stsBinding(result: BundleResult) {
  const getBundle = vi.fn<BundleBinding['getBundle']>(async () => result);
  return { binding: { getBundle } satisfies BundleBinding, getBundle };
}

function legacySecret(value: string | Promise<never>) {
  const get = vi.fn(async () => value);
  return { secret: { get }, get };
}

function fakeContext() {
  const pending: Promise<unknown>[] = [];
  const waitUntil = vi.fn((promise: Promise<unknown>) => {
    pending.push(promise);
  });
  return { ctx: { waitUntil }, waitUntil, settle: () => Promise.all(pending) };
}

/** A context whose `waitUntil` refuses work, as a finished invocation's does. */
function throwingContext() {
  return {
    waitUntil: () => {
      throw new Error('waitUntil refused');
    },
  };
}

/**
 * Waits one zero-delay task, after which every queued microtask has run. It proves a negative: a
 * read the hook had started would already be visible. No duration is guessed.
 */
function flushTasks() {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, 0);
  return promise;
}

function captureLogs() {
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  return {
    lines: (event: string) =>
      log.mock.calls.filter(call => call[0] === event).map(call => call[1] as unknown),
    /** Every argument any console line carried, serialised, to prove no value reached a log. */
    text: () => JSON.stringify([log.mock.calls, warn.mock.calls, error.mock.calls]),
  };
}

function expectNoFixtureValue(text: string) {
  for (const value of FIXTURE_VALUES) expect(text).not.toContain(value);
}

const ENABLED = { WORKER_ENV: 'production', SECRETS_COMPARE_ENABLED: 'true' } as const;

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('createSecretsComparison', () => {
  it('reuses the selected legacy value and reads only the bundle', async () => {
    const logs = captureLogs();
    const legacy = legacySecret(LEGACY);
    const sts = stsBinding(okBundle({ NEXTAUTH_SECRET: LEGACY }));
    const { ctx, waitUntil, settle } = fakeContext();
    const env = { ...ENABLED, NEXTAUTH_SECRET: legacy.secret, STS: sts.binding };

    createSecretsComparison().admitted(env, ctx, { route: ROUTE, selected: LEGACY });
    await settle();

    expect(waitUntil).toHaveBeenCalledOnce();
    expect(legacy.get).not.toHaveBeenCalled();
    expect(sts.getBundle).toHaveBeenCalledOnce();
    expect(logs.lines(SECRETS_COMPARE_EVENT)).toEqual([
      { route: ROUTE, secret: 'NEXTAUTH_SECRET', source: 'secrets-store', result: 'match' },
    ]);
    expect(logs.lines(STS_SOURCE_READ_EVENT)).toEqual([]);
    expectNoFixtureValue(logs.text());
  });

  it('reports a byte difference as a mismatch without logging either value', async () => {
    const logs = captureLogs();
    const sts = stsBinding(okBundle({ NEXTAUTH_SECRET: DIFFERENT }));
    const { ctx, settle } = fakeContext();
    const env = { ...ENABLED, NEXTAUTH_SECRET: legacySecret(LEGACY).secret, STS: sts.binding };

    createSecretsComparison().admitted(env, ctx, { route: ROUTE, selected: LEGACY });
    await settle();

    expect(logs.lines(SECRETS_COMPARE_EVENT)).toEqual([
      { route: ROUTE, secret: 'NEXTAUTH_SECRET', source: 'secrets-store', result: 'mismatch' },
    ]);
    expectNoFixtureValue(logs.text());
  });

  it('compares the selected bundle value with the legacy binding under the sts source', async () => {
    const logs = captureLogs();
    const legacy = legacySecret(LEGACY);
    const sts = stsBinding(okBundle({ NEXTAUTH_SECRET: LEGACY }));
    const { ctx, settle } = fakeContext();
    const env = {
      ...ENABLED,
      SECRETS_SOURCE: 'sts',
      NEXTAUTH_SECRET: legacy.secret,
      STS: sts.binding,
    };

    createSecretsComparison().admitted(env, ctx, { route: ROUTE, selected: LEGACY });
    await settle();

    expect(legacy.get).toHaveBeenCalledOnce();
    expect(sts.getBundle).not.toHaveBeenCalled();
    expect(logs.lines(SECRETS_COMPARE_EVENT)).toEqual([
      { route: ROUTE, secret: 'NEXTAUTH_SECRET', source: 'sts', result: 'match' },
    ]);
    expect(logs.lines(STS_SOURCE_READ_EVENT)).toEqual([]);
  });

  it.each<[string, 'secrets-store' | 'sts', BundleResult, string]>([
    ['the bundle lacks the name', 'secrets-store', okBundle({}, ['NEXTAUTH_SECRET']), LEGACY],
    [
      'STS denies the bundle',
      'secrets-store',
      { status: 'denied', reason: 'unknown_workload' },
      LEGACY,
    ],
    ['the bundle value is empty', 'secrets-store', okBundle({ NEXTAUTH_SECRET: '' }), LEGACY],
    ['the legacy value is empty', 'sts', okBundle({ NEXTAUTH_SECRET: LEGACY }), ''],
  ])('reports unproven when %s', async (_case, source, bundle, legacyValue) => {
    const logs = captureLogs();
    const { ctx, settle } = fakeContext();
    const env = {
      ...ENABLED,
      SECRETS_SOURCE: source,
      NEXTAUTH_SECRET: legacySecret(legacyValue).secret,
      STS: stsBinding(bundle).binding,
    };

    createSecretsComparison().admitted(env, ctx, { route: ROUTE, selected: LEGACY });
    await settle();

    expect(logs.lines(SECRETS_COMPARE_EVENT)).toEqual([
      { route: ROUTE, secret: 'NEXTAUTH_SECRET', source, result: 'unproven' },
    ]);
  });

  it('reads nothing and reports unproven without the STS binding', async () => {
    const logs = captureLogs();
    const legacy = legacySecret(LEGACY);
    const { ctx, settle } = fakeContext();

    createSecretsComparison().admitted({ ...ENABLED, NEXTAUTH_SECRET: legacy.secret }, ctx, {
      route: ROUTE,
      selected: LEGACY,
    });
    await settle();

    expect(legacy.get).not.toHaveBeenCalled();
    expect(logs.lines(SECRETS_COMPARE_EVENT)).toEqual([
      { route: ROUTE, secret: 'NEXTAUTH_SECRET', source: 'secrets-store', result: 'unproven' },
    ]);
  });

  it('settles as unproven at its deadline when a read never answers', async () => {
    vi.useFakeTimers();
    const logs = captureLogs();
    const { ctx, waitUntil, settle } = fakeContext();
    // Under the sts source the other read is the legacy binding, which never answers here.
    const env = {
      ...ENABLED,
      SECRETS_SOURCE: 'sts',
      NEXTAUTH_SECRET: legacySecret(new Promise<never>(() => {})).secret,
      STS: stsBinding(okBundle({ NEXTAUTH_SECRET: LEGACY })).binding,
    };

    createSecretsComparison().admitted(env, ctx, { route: ROUTE, selected: LEGACY });
    // The hook returned with the comparison still running under the request's `waitUntil`.
    expect(waitUntil).toHaveBeenCalledOnce();
    expect(logs.lines(SECRETS_COMPARE_EVENT)).toEqual([]);

    await vi.advanceTimersByTimeAsync(SECRETS_COMPARE_DEADLINE_MS);
    await settle();

    expect(logs.lines(SECRETS_COMPARE_EVENT)).toEqual([
      { route: ROUTE, secret: 'NEXTAUTH_SECRET', source: 'sts', result: 'unproven' },
    ]);
  });

  it('runs once per isolate', async () => {
    captureLogs();
    const sts = stsBinding(okBundle({ NEXTAUTH_SECRET: LEGACY }));
    const { ctx, waitUntil, settle } = fakeContext();
    const env = { ...ENABLED, NEXTAUTH_SECRET: legacySecret(LEGACY).secret, STS: sts.binding };
    const comparison = createSecretsComparison();

    comparison.admitted(env, ctx, { route: ROUTE, selected: LEGACY });
    comparison.admitted(env, ctx, { route: ROUTE, selected: LEGACY });
    await settle();

    expect(waitUntil).toHaveBeenCalledOnce();
    expect(sts.getBundle).toHaveBeenCalledOnce();
  });

  it.each<Partial<SecretsCompareEnv>>([
    { SECRETS_COMPARE_ENABLED: undefined },
    { SECRETS_COMPARE_ENABLED: '' },
    { SECRETS_COMPARE_ENABLED: 'false' },
    { SECRETS_COMPARE_ENABLED: 'TRUE' },
    { WORKER_ENV: 'development' },
    { WORKER_ENV: undefined },
    { SECRETS_SOURCE: 'infisical' },
  ])('touches neither the context nor a source when gated off by %o', async override => {
    const legacy = legacySecret(LEGACY);
    const sts = stsBinding(okBundle({ NEXTAUTH_SECRET: LEGACY }));
    const { ctx, waitUntil, settle } = fakeContext();
    const env = { ...ENABLED, NEXTAUTH_SECRET: legacy.secret, STS: sts.binding };
    const comparison = createSecretsComparison();

    comparison.admitted({ ...env, ...override }, ctx, { route: ROUTE, selected: LEGACY });

    expect(waitUntil).not.toHaveBeenCalled();
    expect(legacy.get).not.toHaveBeenCalled();
    expect(sts.getBundle).not.toHaveBeenCalled();

    // A gated call leaves the hook armed.
    captureLogs();
    comparison.admitted(env, ctx, { route: ROUTE, selected: LEGACY });
    await settle();
    expect(waitUntil).toHaveBeenCalledOnce();
  });

  it('skips a call without an execution context and stays armed', async () => {
    const logs = captureLogs();
    const sts = stsBinding(okBundle({ NEXTAUTH_SECRET: LEGACY }));
    const env = { ...ENABLED, NEXTAUTH_SECRET: legacySecret(LEGACY).secret, STS: sts.binding };
    const comparison = createSecretsComparison();

    comparison.admitted(env, undefined, { route: ROUTE, selected: LEGACY });
    expect(sts.getBundle).not.toHaveBeenCalled();

    const { ctx, settle } = fakeContext();
    comparison.admitted(env, ctx, { route: ROUTE, selected: LEGACY });
    await settle();
    expect(logs.lines(SECRETS_COMPARE_EVENT)).toEqual([
      { route: ROUTE, secret: 'NEXTAUTH_SECRET', source: 'secrets-store', result: 'match' },
    ]);
  });

  it('starts no read until waitUntil has registered the work', async () => {
    const logs = captureLogs();
    const sts = stsBinding(okBundle({ NEXTAUTH_SECRET: LEGACY }));
    const env = { ...ENABLED, NEXTAUTH_SECRET: legacySecret(LEGACY).secret, STS: sts.binding };
    const pending: Promise<unknown>[] = [];
    const readsAtRegistration: number[] = [];
    const ctx = {
      waitUntil: (promise: Promise<unknown>) => {
        readsAtRegistration.push(sts.getBundle.mock.calls.length);
        pending.push(promise);
      },
    };

    createSecretsComparison().admitted(env, ctx, { route: ROUTE, selected: LEGACY });

    expect(readsAtRegistration).toEqual([0]);
    // The comparison begins in a later microtask, never inside the caller's own call.
    expect(sts.getBundle).not.toHaveBeenCalled();
    await Promise.all(pending);
    expect(sts.getBundle).toHaveBeenCalledOnce();
    expect(logs.lines(SECRETS_COMPARE_EVENT)).toEqual([
      { route: ROUTE, secret: 'NEXTAUTH_SECRET', source: 'secrets-store', result: 'match' },
    ]);
  });

  it('starts nothing and stays armed when waitUntil throws', async () => {
    const logs = captureLogs();
    const legacy = legacySecret(LEGACY);
    const sts = stsBinding(okBundle({ NEXTAUTH_SECRET: LEGACY }));
    const env = { ...ENABLED, NEXTAUTH_SECRET: legacy.secret, STS: sts.binding };
    const comparison = createSecretsComparison();

    expect(() =>
      comparison.admitted(env, throwingContext(), { route: ROUTE, selected: LEGACY })
    ).not.toThrow();
    await flushTasks();

    expect(sts.getBundle).not.toHaveBeenCalled();
    expect(legacy.get).not.toHaveBeenCalled();
    expect(logs.lines(SECRETS_COMPARE_EVENT)).toEqual([]);

    // The latch was not spent: the next usable context samples.
    const { ctx, settle } = fakeContext();
    comparison.admitted(env, ctx, { route: ROUTE, selected: LEGACY });
    await settle();
    expect(sts.getBundle).toHaveBeenCalledOnce();
    expect(logs.lines(SECRETS_COMPARE_EVENT)).toEqual([
      { route: ROUTE, secret: 'NEXTAUTH_SECRET', source: 'secrets-store', result: 'match' },
    ]);
  });
});

describe('authenticateToken with the source comparison', () => {
  async function bearer(secret: string) {
    const { token } = await signKiloToken({
      userId: USER_ID,
      pepper: 'pepper-current',
      secret,
      expiresInSeconds: 3600,
      env: 'production',
      extra: { tokenSource: 'kilo-chat' },
    });
    return token;
  }

  const getUserPepper = async () => ({ pepper: 'pepper-current', blocked: false });

  /** The module's isolate hook, backed by a fresh one so every test starts armed. */
  function freshHook() {
    const fresh = createSecretsComparison();
    return vi.spyOn(secretsComparison, 'admitted').mockImplementation(fresh.admitted);
  }

  function compareEnv(legacy: { get(): Promise<string> }, sts: BundleBinding): AuthEnv {
    return {
      ...ENABLED,
      NEXTAUTH_SECRET: legacy,
      STS: sts,
      HYPERDRIVE: { connectionString: 'postgres://test' },
    };
  }

  beforeEach(() => {
    clearSecretCacheForTest();
  });

  it('compares the exact value this request read, with no second legacy read', async () => {
    const logs = captureLogs();
    const hook = freshHook();
    const legacy = legacySecret(LEGACY);
    const sts = stsBinding(okBundle({ NEXTAUTH_SECRET: LEGACY }));
    const { ctx, settle } = fakeContext();
    const env = compareEnv(legacy.secret, sts.binding);

    await expect(
      authenticateToken(await bearer(LEGACY), env, { getUserPepper, ctx })
    ).resolves.toEqual({ userId: USER_ID });
    await settle();

    expect(hook).toHaveBeenCalledExactlyOnceWith(env, ctx, { route: ROUTE, selected: LEGACY });
    expect(legacy.get).toHaveBeenCalledOnce();
    expect(sts.getBundle).toHaveBeenCalledOnce();
    expect(logs.lines(SECRETS_COMPARE_EVENT)).toEqual([
      { route: ROUTE, secret: 'NEXTAUTH_SECRET', source: 'secrets-store', result: 'match' },
    ]);
    expectNoFixtureValue(logs.text());
  });

  it('skips an acceptance answered from the verifier cache and stays armed', async () => {
    const logs = captureLogs();
    const hook = freshHook();
    const legacy = legacySecret(LEGACY);
    const sts = stsBinding(okBundle({ NEXTAUTH_SECRET: LEGACY }));
    const { ctx, waitUntil, settle } = fakeContext();
    const env = compareEnv(legacy.secret, sts.binding);

    // A refused bearer reads and caches the signer first; it never starts a comparison.
    await expect(
      authenticateToken(await bearer(WRONG_SIGNER), env, { getUserPepper, ctx })
    ).resolves.toBeNull();
    // The accepted bearer is verified against the cached value: no value of its own, no check,
    // and no second read of either source.
    await expect(
      authenticateToken(await bearer(LEGACY), env, { getUserPepper, ctx })
    ).resolves.toEqual({ userId: USER_ID });

    expect(hook).not.toHaveBeenCalled();
    expect(waitUntil).not.toHaveBeenCalled();
    expect(legacy.get).toHaveBeenCalledOnce();
    expect(sts.getBundle).not.toHaveBeenCalled();
    expect(logs.lines(SECRETS_COMPARE_EVENT)).toEqual([]);

    // The next acceptance whose own read supplies the value is still compared.
    clearSecretCacheForTest();
    await expect(
      authenticateToken(await bearer(LEGACY), env, { getUserPepper, ctx })
    ).resolves.toEqual({ userId: USER_ID });
    await settle();

    expect(hook).toHaveBeenCalledExactlyOnceWith(env, ctx, { route: ROUTE, selected: LEGACY });
    expect(legacy.get).toHaveBeenCalledTimes(2);
    expect(sts.getBundle).toHaveBeenCalledOnce();
    expect(logs.lines(SECRETS_COMPARE_EVENT)).toEqual([
      { route: ROUTE, secret: 'NEXTAUTH_SECRET', source: 'secrets-store', result: 'match' },
    ]);
  });

  it('keeps a valid acceptance when the context refuses background work', async () => {
    const logs = captureLogs();
    const hook = freshHook();
    const legacy = legacySecret(LEGACY);
    const sts = stsBinding(okBundle({ NEXTAUTH_SECRET: LEGACY }));
    const env = compareEnv(legacy.secret, sts.binding);

    await expect(
      authenticateToken(await bearer(LEGACY), env, { getUserPepper, ctx: throwingContext() })
    ).resolves.toEqual({ userId: USER_ID });
    await flushTasks();

    expect(hook).toHaveBeenCalledOnce();
    expect(legacy.get).toHaveBeenCalledOnce();
    expect(sts.getBundle).not.toHaveBeenCalled();
    expect(logs.lines(SECRETS_COMPARE_EVENT)).toEqual([]);

    // The next acceptance whose own read supplies the value, with a usable context, samples.
    clearSecretCacheForTest();
    const { ctx, settle } = fakeContext();
    await expect(
      authenticateToken(await bearer(LEGACY), env, { getUserPepper, ctx })
    ).resolves.toEqual({ userId: USER_ID });
    await settle();

    expect(sts.getBundle).toHaveBeenCalledOnce();
    expect(logs.lines(SECRETS_COMPARE_EVENT)).toEqual([
      { route: ROUTE, secret: 'NEXTAUTH_SECRET', source: 'secrets-store', result: 'match' },
    ]);
  });

  it('answers before the comparison settles and keeps the answer on a mismatch', async () => {
    const logs = captureLogs();
    freshHook();
    const sts = stsBinding(okBundle({ NEXTAUTH_SECRET: DIFFERENT }));
    const { ctx, waitUntil, settle } = fakeContext();
    const env = compareEnv(legacySecret(LEGACY).secret, sts.binding);

    await expect(
      authenticateToken(await bearer(LEGACY), env, { getUserPepper, ctx })
    ).resolves.toEqual({ userId: USER_ID });
    expect(waitUntil).toHaveBeenCalled();
    await settle();

    expect(logs.lines(SECRETS_COMPARE_EVENT)).toEqual([
      { route: ROUTE, secret: 'NEXTAUTH_SECRET', source: 'secrets-store', result: 'mismatch' },
    ]);
    expectNoFixtureValue(logs.text());
  });

  it('keeps the verifier cache lazy and reads nothing extra when the comparison is off', async () => {
    captureLogs();
    freshHook();
    const legacy = legacySecret(LEGACY);
    const sts = stsBinding(okBundle({ NEXTAUTH_SECRET: LEGACY }));
    const { ctx, waitUntil } = fakeContext();
    const env = { ...compareEnv(legacy.secret, sts.binding), SECRETS_COMPARE_ENABLED: undefined };
    const token = await bearer(LEGACY);

    await authenticateToken(token, env, { getUserPepper, ctx });
    await authenticateToken(token, env, { getUserPepper, ctx });

    expect(legacy.get).toHaveBeenCalledOnce();
    expect(sts.getBundle).not.toHaveBeenCalled();
    expect(waitUntil).not.toHaveBeenCalled();
  });

  it.each([
    ['a missing bearer', null],
    ['an invalid bearer', 'not-a-jwt'],
  ])('never compares after %s', async (_case, token) => {
    captureLogs();
    const hook = freshHook();
    const sts = stsBinding(okBundle({ NEXTAUTH_SECRET: LEGACY }));
    const { ctx, waitUntil } = fakeContext();
    const env = compareEnv(legacySecret(LEGACY).secret, sts.binding);

    await expect(authenticateToken(token, env, { getUserPepper, ctx })).resolves.toBeNull();

    expect(hook).not.toHaveBeenCalled();
    expect(waitUntil).not.toHaveBeenCalled();
    expect(sts.getBundle).not.toHaveBeenCalled();
  });
});
