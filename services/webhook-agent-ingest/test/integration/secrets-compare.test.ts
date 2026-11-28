import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BundleBinding } from '@kilocode/secrets-client';
import { deriveCallbackToken } from '@kilocode/worker-utils';
import worker from '../../src/index';
import {
  createSecretsComparison,
  SECRETS_COMPARE_DEADLINE_MS,
  SECRETS_COMPARE_EVENT,
  type SecretsCompareEnv,
} from '../../src/secrets-compare';

// Synthetic fixture values only; none is a real key or signing secret.
const INTERNAL = 'compare-internal-fixture-0123456789abcdef';
const CALLBACK = 'compare-callback-fixture-0123456789abcdef';
const NEXTAUTH = 'compare-nextauth-fixture-0123456789abcdef';
const FIXTURE_VALUES = [INTERNAL, CALLBACK, NEXTAUTH];

const ALL_TRUE = { INTERNAL_API_SECRET: true, CALLBACK_TOKEN_SECRET: true, NEXTAUTH_SECRET: true };
const ALL_FALSE = {
  INTERNAL_API_SECRET: false,
  CALLBACK_TOKEN_SECRET: false,
  NEXTAUTH_SECRET: false,
};

type BundleResult = Awaited<ReturnType<BundleBinding['getBundle']>>;

function okBundle(secrets: Record<string, string>, missing: string[] = []): BundleResult {
  return {
    status: 'ok',
    workload: 'cloudflare-webhook-agent-ingest',
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
  INTERNAL_API_SECRET: INTERNAL,
  CALLBACK_TOKEN_SECRET: CALLBACK,
  NEXTAUTH_SECRET: NEXTAUTH,
};

function storeSecret(value: string) {
  const get = vi.fn(async () => value);
  return { secret: { get } as SecretsStoreSecret, get };
}

/**
 * Store values the Worker serves today plus a fresh STS binding (the reader keeps one bundle per
 * binding for the isolate). Compare is on, in production, with the Secrets Store source.
 */
function fixture(bundle: BundleResult = okBundle(MATCHING_BUNDLE)) {
  const getBundle = vi.fn<BundleBinding['getBundle']>(async () => bundle);
  const internal = storeSecret(INTERNAL);
  const callback = storeSecret(CALLBACK);
  const nextAuth = storeSecret(NEXTAUTH);
  const compareEnv = {
    ENVIRONMENT: 'production',
    SECRETS_COMPARE_ENABLED: 'true',
    SECRETS_SOURCE: 'secrets-store',
    STS: { getBundle },
    INTERNAL_API_SECRET: internal.secret,
    CALLBACK_TOKEN_SECRET: callback.secret,
    NEXTAUTH_SECRET: nextAuth.secret,
  } satisfies SecretsCompareEnv;
  const storeReads = () =>
    internal.get.mock.calls.length +
    callback.get.mock.calls.length +
    nextAuth.get.mock.calls.length;
  return { compareEnv, getBundle, internal, callback, nextAuth, storeReads };
}

function lifetime() {
  const pending: Array<Promise<unknown>> = [];
  const waitUntil = vi.fn((promise: Promise<unknown>) => {
    pending.push(promise);
  });
  return { ctx: { waitUntil }, waitUntil, settled: () => Promise.all(pending) };
}

/** Every console line, so a test can check that no fixture value reached any of them. */
function captureLogs() {
  const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map(method =>
    vi.spyOn(console, method).mockImplementation(() => undefined)
  );
  const [log] = spies;
  return {
    results: () =>
      log.mock.calls.filter(([event]) => event === SECRETS_COMPARE_EVENT).map(([, r]) => r),
    raw: () => JSON.stringify(spies.map(spy => spy.mock.calls)),
  };
}

async function runOnce(compareEnv: SecretsCompareEnv) {
  const logs = captureLogs();
  const { ctx, settled } = lifetime();
  createSecretsComparison()(compareEnv, () => ctx);
  await settled();
  return logs;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('createSecretsComparison', () => {
  it.each<[string, Partial<SecretsCompareEnv>]>([
    ['the flag is absent', { SECRETS_COMPARE_ENABLED: undefined }],
    ['the flag is "false"', { SECRETS_COMPARE_ENABLED: 'false' }],
    ['the flag is "1"', { SECRETS_COMPARE_ENABLED: '1' }],
    ['the flag is "TRUE"', { SECRETS_COMPARE_ENABLED: 'TRUE' }],
    ['SECRETS_SOURCE is absent', { SECRETS_SOURCE: undefined }],
    ['SECRETS_SOURCE is sts', { SECRETS_SOURCE: 'sts' }],
    ['the environment is development', { ENVIRONMENT: 'development' }],
    ['the environment is absent', { ENVIRONMENT: undefined }],
  ])('does no work when %s', async (_case, override) => {
    const { compareEnv, getBundle, storeReads } = fixture();
    const logs = captureLogs();
    const executionCtx = vi.fn(() => lifetime().ctx);

    createSecretsComparison()({ ...compareEnv, ...override }, executionCtx);

    expect(executionCtx).not.toHaveBeenCalled();
    expect(getBundle).not.toHaveBeenCalled();
    expect(storeReads()).toBe(0);
    expect(logs.results()).toEqual([]);
  });

  it('logs only the three names with true for exact copies, once per isolate', async () => {
    const { compareEnv, getBundle, internal, callback, nextAuth } = fixture();
    const logs = captureLogs();
    const compare = createSecretsComparison();

    const first = lifetime();
    compare(compareEnv, () => first.ctx);
    await first.settled();
    const later = lifetime();
    compare(compareEnv, () => later.ctx);
    compare(compareEnv, () => later.ctx);
    await later.settled();

    expect(logs.results()).toEqual([ALL_TRUE]);
    expect(first.waitUntil).toHaveBeenCalledOnce();
    expect(later.waitUntil).not.toHaveBeenCalled();
    expect(getBundle).toHaveBeenCalledOnce();
    expect(internal.get).toHaveBeenCalledOnce();
    expect(callback.get).toHaveBeenCalledOnce();
    expect(nextAuth.get).toHaveBeenCalledOnce();
    for (const value of FIXTURE_VALUES) expect(logs.raw()).not.toContain(value);
  });

  it('reports false for any byte difference, whitespace included', async () => {
    const { compareEnv } = fixture(
      okBundle({
        INTERNAL_API_SECRET: INTERNAL,
        CALLBACK_TOKEN_SECRET: `${CALLBACK}\n`,
        NEXTAUTH_SECRET: ` ${NEXTAUTH}`,
      })
    );

    const logs = await runOnce(compareEnv);

    expect(logs.results()).toEqual([
      { INTERNAL_API_SECRET: true, CALLBACK_TOKEN_SECRET: false, NEXTAUTH_SECRET: false },
    ]);
    for (const value of FIXTURE_VALUES) expect(logs.raw()).not.toContain(value);
  });

  it.each([
    ['a denied bundle', { status: 'denied', reason: 'unknown_workload' } satisfies BundleResult],
    ['a bundle without the names (no grant)', okBundle({})],
    [
      'a bundle that reports the names missing',
      okBundle({}, ['INTERNAL_API_SECRET', 'CALLBACK_TOKEN_SECRET', 'NEXTAUTH_SECRET']),
    ],
  ])('reports every name false for %s', async (_case, bundle) => {
    const logs = await runOnce(fixture(bundle).compareEnv);

    expect(logs.results()).toEqual([ALL_FALSE]);
  });

  it('reports every name false within the deadline when STS throws', async () => {
    vi.useFakeTimers();
    const { compareEnv, getBundle } = fixture();
    getBundle.mockRejectedValue(new Error(`transport failed near ${INTERNAL}`));
    const logs = captureLogs();
    const { ctx, waitUntil } = lifetime();

    createSecretsComparison()(compareEnv, () => ctx);
    const comparison = waitUntil.mock.calls[0][0];
    await vi.advanceTimersByTimeAsync(SECRETS_COMPARE_DEADLINE_MS);
    await comparison;

    expect(logs.results()).toEqual([ALL_FALSE]);
    // The reader's own first-load backoff (5 s, then 10 s) within its 25 s window; no retry here.
    expect(getBundle.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(getBundle.mock.calls.length).toBeLessThanOrEqual(3);
    for (const value of FIXTURE_VALUES) expect(logs.raw()).not.toContain(value);
  });

  it('reports every name false without the STS binding and reads no store value', async () => {
    const { compareEnv, storeReads } = fixture();

    const logs = await runOnce({ ...compareEnv, STS: undefined });

    expect(logs.results()).toEqual([ALL_FALSE]);
    expect(storeReads()).toBe(0);
  });

  it('reports false for a missing, failing or empty store value and drops the error', async () => {
    const { compareEnv, nextAuth } = fixture(
      okBundle({ ...MATCHING_BUNDLE, CALLBACK_TOKEN_SECRET: '' })
    );
    nextAuth.get.mockRejectedValue(new Error(`store read failed for ${NEXTAUTH}`));

    const logs = await runOnce({
      ...compareEnv,
      INTERNAL_API_SECRET: undefined as unknown as SecretsStoreSecret,
      CALLBACK_TOKEN_SECRET: storeSecret('').secret,
    });

    expect(logs.results()).toEqual([ALL_FALSE]);
    for (const value of FIXTURE_VALUES) expect(logs.raw()).not.toContain(value);
  });

  it('skips without a readable execution context and stays armed', async () => {
    const { compareEnv, getBundle } = fixture();
    const logs = captureLogs();
    const compare = createSecretsComparison();

    expect(() =>
      compare(compareEnv, () => {
        throw new Error('This context has no ExecutionContext');
      })
    ).not.toThrow();
    expect(getBundle).not.toHaveBeenCalled();

    const { ctx, settled } = lifetime();
    compare(compareEnv, () => ctx);
    await settled();
    expect(logs.results()).toEqual([ALL_TRUE]);
  });

  it('settles every name false at the deadline when STS never answers', async () => {
    vi.useFakeTimers();
    const getBundle = vi.fn<BundleBinding['getBundle']>(() => new Promise(() => undefined));
    const { compareEnv } = fixture();
    const logs = captureLogs();
    const { ctx, waitUntil } = lifetime();

    createSecretsComparison()({ ...compareEnv, STS: { getBundle } }, () => ctx);
    const comparison = waitUntil.mock.calls[0][0];
    await vi.advanceTimersByTimeAsync(SECRETS_COMPARE_DEADLINE_MS);
    await comparison;

    expect(logs.results()).toEqual([ALL_FALSE]);
  });
});

describe('authenticated routes with the comparison', () => {
  const NAMESPACE = 'user/compare-user';
  const TRIGGER_ID = 'compare-trigger';
  const REQUEST_ID = 'compare-request';

  async function send(serviceEnv: object, request: Request) {
    const ctx = createExecutionContext();
    const response = await worker.fetch(request, serviceEnv as Env, ctx);
    const result = { status: response.status, body: await response.json() };
    await waitOnExecutionContext(ctx);
    return result;
  }

  function getTrigger(key: string) {
    return new Request(`https://example.com/api/triggers/user/compare-user/${TRIGGER_ID}`, {
      headers: { 'X-Internal-API-Key': key },
    });
  }

  async function executionCallback(secret: string) {
    const token = await deriveCallbackToken({
      secret,
      scope: 'webhook-execution-callback',
      resourceParts: [NAMESPACE, TRIGGER_ID, REQUEST_ID],
    });
    return new Request('https://example.com/api/callbacks/execution', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-webhook-namespace': NAMESPACE,
        'x-webhook-trigger-id': TRIGGER_ID,
        'x-webhook-request-id': REQUEST_ID,
        'X-Callback-Token': token,
      },
      body: JSON.stringify({
        sessionId: 'compare-session',
        cloudAgentSessionId: 'compare-agent-session',
        executionId: 'compare-execution',
        status: 'completed',
      }),
    });
  }

  it('keeps the legacy answers and compares once, after authentication only', async () => {
    // A denied bundle: the comparison fails, and no response may notice.
    const { compareEnv, getBundle, internal } = fixture({
      status: 'denied',
      reason: 'unknown_workload',
    });
    const logs = captureLogs();
    const legacyEnv = { ...env, ...compareEnv, SECRETS_COMPARE_ENABLED: undefined };
    const compareOnEnv = { ...env, ...compareEnv };

    const legacyTrigger = await send(legacyEnv, getTrigger(INTERNAL));
    expect(legacyTrigger.status).toBe(404);
    const legacyCallback = await send(legacyEnv, await executionCallback(CALLBACK));
    expect(legacyCallback.status).toBe(404);
    const legacyRefusal = await send(legacyEnv, getTrigger('wrong-key'));
    expect(legacyRefusal.status).toBe(401);
    expect(getBundle).not.toHaveBeenCalled();

    expect(await send(compareOnEnv, getTrigger('wrong-key'))).toEqual(legacyRefusal);
    expect(await send(compareOnEnv, await executionCallback('wrong-secret'))).toEqual({
      status: 401,
      body: { success: false, error: 'Unauthorized' },
    });
    expect(getBundle).not.toHaveBeenCalled();
    expect(logs.results()).toEqual([]);

    const storeReadsBefore = internal.get.mock.calls.length;
    expect(await send(compareOnEnv, getTrigger(INTERNAL))).toEqual(legacyTrigger);
    expect(getBundle).toHaveBeenCalledOnce();
    // One read authenticates the request, one feeds the comparison.
    expect(internal.get.mock.calls.length - storeReadsBefore).toBe(2);
    expect(logs.results()).toEqual([ALL_FALSE]);

    // The isolate has compared once; an authenticated callback adds nothing.
    expect(await send(compareOnEnv, await executionCallback(CALLBACK))).toEqual(legacyCallback);
    expect(await send(compareOnEnv, getTrigger(INTERNAL))).toEqual(legacyTrigger);
    expect(getBundle).toHaveBeenCalledOnce();
    expect(logs.results()).toHaveLength(1);
    for (const value of FIXTURE_VALUES) expect(logs.raw()).not.toContain(value);
  });
});
