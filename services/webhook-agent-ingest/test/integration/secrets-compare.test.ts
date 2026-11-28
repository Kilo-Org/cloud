import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BundleBinding } from '@kilocode/secrets-client';
import { deriveCallbackToken } from '@kilocode/worker-utils';
import worker from '../../src/index';
import {
  createSecretsComparison,
  SECRETS_COMPARE_DEADLINE_MS,
  SECRETS_COMPARE_EVENT,
  SECRETS_COMPARE_REFUSED_EVENT,
  type CheckedSecret,
  type SecretsCompareEnv,
} from '../../src/secrets-compare';
import { logger } from '../../src/util/logger';

// Synthetic fixture values only; none is a real key or signing secret.
const INTERNAL = 'compare-internal-fixture-0123456789abcdef';
const CALLBACK = 'compare-callback-fixture-0123456789abcdef';
const NEXTAUTH = 'compare-nextauth-fixture-0123456789abcdef';
const FIXTURE_VALUES = [INTERNAL, CALLBACK, NEXTAUTH];
/** A checked value that neither source holds now. */
const STALE = 'compare-stale-fixture-0123456789abcdef';

/** An internal API key accepted under the Secrets Store source, and the value it checked. */
const ADMITTED: CheckedSecret = {
  route: 'internal-api',
  source: 'secrets-store',
  selected: INTERNAL,
};
const ADMITTED_LABELS = { route: 'internal-api', source: 'secrets-store', mismatched: [] };

const ALL_TRUE = {
  INTERNAL_API_SECRET: true,
  CALLBACK_TOKEN_SECRET: true,
  NEXTAUTH_SECRET: true,
  ...ADMITTED_LABELS,
};
const ALL_FALSE = {
  INTERNAL_API_SECRET: false,
  CALLBACK_TOKEN_SECRET: false,
  NEXTAUTH_SECRET: false,
  ...ADMITTED_LABELS,
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
    refusedResults: () =>
      log.mock.calls.filter(([event]) => event === SECRETS_COMPARE_REFUSED_EVENT).map(([, r]) => r),
    raw: () => JSON.stringify(spies.map(spy => spy.mock.calls)),
  };
}

async function runOnce(compareEnv: SecretsCompareEnv, checked: CheckedSecret = ADMITTED) {
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
  it.each<[string, Partial<SecretsCompareEnv>]>([
    ['the flag is absent', { SECRETS_COMPARE_ENABLED: undefined }],
    ['the flag is "false"', { SECRETS_COMPARE_ENABLED: 'false' }],
    ['the flag is "1"', { SECRETS_COMPARE_ENABLED: '1' }],
    ['the flag is "TRUE"', { SECRETS_COMPARE_ENABLED: 'TRUE' }],
    ['the environment is development', { ENVIRONMENT: 'development' }],
    ['the environment is absent', { ENVIRONMENT: undefined }],
  ])('does no work when %s, accepted or refused', async (_case, override) => {
    const { compareEnv, getBundle, storeReads } = fixture();
    const logs = captureLogs();
    const executionCtx = vi.fn(() => lifetime().ctx);
    const compare = createSecretsComparison();

    compare.admitted({ ...compareEnv, ...override }, executionCtx, ADMITTED);
    compare.refused({ ...compareEnv, ...override }, executionCtx, ADMITTED);

    expect(executionCtx).not.toHaveBeenCalled();
    expect(getBundle).not.toHaveBeenCalled();
    expect(storeReads()).toBe(0);
    expect(logs.results()).toEqual([]);
    expect(logs.refusedResults()).toEqual([]);
  });

  it('logs only the three names with true for exact copies, once per isolate', async () => {
    const { compareEnv, getBundle, internal, callback, nextAuth } = fixture();
    const logs = captureLogs();
    const compare = createSecretsComparison();

    const first = lifetime();
    compare.admitted(compareEnv, () => first.ctx, ADMITTED);
    await first.settled();
    const later = lifetime();
    compare.admitted(compareEnv, () => later.ctx, ADMITTED);
    compare.admitted(compareEnv, () => later.ctx, ADMITTED);
    await later.settled();

    expect(logs.results()).toEqual([ALL_TRUE]);
    expect(first.waitUntil).toHaveBeenCalledOnce();
    expect(later.waitUntil).not.toHaveBeenCalled();
    expect(getBundle).toHaveBeenCalledOnce();
    // The route's own name uses the value the request was checked against.
    expect(internal.get).not.toHaveBeenCalled();
    expect(callback.get).toHaveBeenCalledOnce();
    expect(nextAuth.get).toHaveBeenCalledOnce();
    for (const value of FIXTURE_VALUES) expect(logs.raw()).not.toContain(value);
  });

  it('compares the checked value under sts with the Secrets Store and names each mismatch', async () => {
    const { compareEnv, getBundle, storeReads } = fixture();

    const logs = await runOnce(
      { ...compareEnv, SECRETS_SOURCE: 'sts' },
      { route: 'execution-callback', source: 'sts', selected: STALE }
    );

    expect(logs.results()).toEqual([
      {
        ...ALL_TRUE,
        CALLBACK_TOKEN_SECRET: false,
        route: 'execution-callback',
        source: 'sts',
        mismatched: ['CALLBACK_TOKEN_SECRET'],
      },
    ]);
    // The two other names come from the one bundle; each name reads the Secrets Store once.
    expect(getBundle).toHaveBeenCalledOnce();
    expect(storeReads()).toBe(3);
    for (const value of [...FIXTURE_VALUES, STALE]) expect(logs.raw()).not.toContain(value);
  });

  it('compares only the route name after a refusal, once per route', async () => {
    const { compareEnv, getBundle, internal, callback, nextAuth } = fixture();
    const logs = captureLogs();
    const compare = createSecretsComparison();
    const run = async (checked: CheckedSecret) => {
      const { ctx, settled } = lifetime();
      compare.refused({ ...compareEnv, SECRETS_SOURCE: 'sts' }, () => ctx, checked);
      await settled();
    };

    await run({ route: 'internal-api', source: 'sts', selected: INTERNAL });
    await run({ route: 'internal-api', source: 'sts', selected: STALE });
    await run({ route: 'execution-callback', source: 'sts', selected: STALE });

    expect(logs.refusedResults()).toEqual([
      { route: 'internal-api', secret: 'INTERNAL_API_SECRET', source: 'sts', result: 'match' },
      {
        route: 'execution-callback',
        secret: 'CALLBACK_TOKEN_SECRET',
        source: 'sts',
        result: 'mismatch',
      },
    ]);
    expect(internal.get).toHaveBeenCalledOnce();
    expect(callback.get).toHaveBeenCalledOnce();
    expect(nextAuth.get).not.toHaveBeenCalled();
    expect(getBundle).not.toHaveBeenCalled();
    // A refusal never uses up the isolate's accepted comparison.
    const { ctx, settled } = lifetime();
    compare.admitted(compareEnv, () => ctx, ADMITTED);
    await settled();
    expect(logs.results()).toEqual([ALL_TRUE]);
    for (const value of [...FIXTURE_VALUES, STALE]) expect(logs.raw()).not.toContain(value);
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
      {
        ...ALL_TRUE,
        CALLBACK_TOKEN_SECRET: false,
        NEXTAUTH_SECRET: false,
        mismatched: ['CALLBACK_TOKEN_SECRET', 'NEXTAUTH_SECRET'],
      },
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

    createSecretsComparison().admitted(compareEnv, () => ctx, ADMITTED);
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

    const logs = await runOnce(
      { ...compareEnv, CALLBACK_TOKEN_SECRET: storeSecret('').secret },
      { ...ADMITTED, selected: '' }
    );

    expect(logs.results()).toEqual([ALL_FALSE]);
    for (const value of FIXTURE_VALUES) expect(logs.raw()).not.toContain(value);
  });

  it('skips without a readable execution context and stays armed', async () => {
    const { compareEnv, getBundle } = fixture();
    const logs = captureLogs();
    const compare = createSecretsComparison();

    expect(() =>
      compare.admitted(
        compareEnv,
        () => {
          throw new Error('This context has no ExecutionContext');
        },
        ADMITTED
      )
    ).not.toThrow();
    expect(getBundle).not.toHaveBeenCalled();

    const { ctx, settled } = lifetime();
    compare.admitted(compareEnv, () => ctx, ADMITTED);
    await settled();
    expect(logs.results()).toEqual([ALL_TRUE]);
  });

  it('settles every name false at the deadline when STS never answers', async () => {
    vi.useFakeTimers();
    const getBundle = vi.fn<BundleBinding['getBundle']>(() => new Promise(() => undefined));
    const { compareEnv } = fixture();
    const logs = captureLogs();
    const { ctx, waitUntil } = lifetime();

    createSecretsComparison().admitted({ ...compareEnv, STS: { getBundle } }, () => ctx, ADMITTED);
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

  function getTrigger(key?: string) {
    return new Request(`https://example.com/api/triggers/user/compare-user/${TRIGGER_ID}`, {
      headers: key === undefined ? {} : { 'X-Internal-API-Key': key },
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

  it('labels every 401 and compares under sts within its read budget', async () => {
    const { compareEnv, getBundle, storeReads } = fixture();
    const logs = captureLogs();
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const compareOnEnv = { ...env, ...compareEnv, SECRETS_SOURCE: 'sts' };
    const offEnv = { ...compareOnEnv, SECRETS_COMPARE_ENABLED: undefined };

    const accepted = await send(offEnv, getTrigger(INTERNAL));
    expect(accepted.status).toBe(404);
    const acceptedCallback = await send(offEnv, await executionCallback(CALLBACK));
    expect(acceptedCallback.status).toBe(404);
    const refusal = await send(offEnv, getTrigger('wrong-key'));
    expect(refusal).toEqual({ status: 401, body: { success: false, error: 'Unauthorized' } });
    expect(storeReads()).toBe(0);

    // A missing key starts no comparison; a refused one compares its own name once per route.
    expect(await send(compareOnEnv, getTrigger())).toEqual(refusal);
    expect(storeReads()).toBe(0);
    expect(await send(compareOnEnv, getTrigger('wrong-key'))).toEqual(refusal);
    expect(await send(compareOnEnv, getTrigger('wrong-key'))).toEqual(refusal);
    expect(await send(compareOnEnv, await executionCallback('wrong-secret'))).toEqual(refusal);
    expect(storeReads()).toBe(2);

    // The first accepted request compares all three names, once per isolate.
    expect(await send(compareOnEnv, getTrigger(INTERNAL))).toEqual(accepted);
    expect(await send(compareOnEnv, await executionCallback(CALLBACK))).toEqual(acceptedCallback);
    expect(storeReads()).toBe(5);
    expect(getBundle).toHaveBeenCalledOnce();

    expect(logs.refusedResults()).toEqual([
      { route: 'internal-api', secret: 'INTERNAL_API_SECRET', source: 'sts', result: 'match' },
      {
        route: 'execution-callback',
        secret: 'CALLBACK_TOKEN_SECRET',
        source: 'sts',
        result: 'match',
      },
    ]);
    expect(logs.results()).toEqual([{ ...ALL_TRUE, source: 'sts' }]);

    const internalRefusal = (error: string, reason: string) => [
      'Internal API authentication failed',
      { error, route: 'internal-api', secret: 'INTERNAL_API_SECRET', source: 'sts', reason },
    ];
    expect(
      warn.mock.calls.filter(([message]) => String(message).endsWith('authentication failed'))
    ).toEqual([
      internalRefusal('Invalid internal API key', 'invalid'),
      internalRefusal('Missing internal API key', 'missing'),
      internalRefusal('Invalid internal API key', 'invalid'),
      internalRefusal('Invalid internal API key', 'invalid'),
      [
        'Callback authentication failed',
        {
          route: 'execution-callback',
          secret: 'CALLBACK_TOKEN_SECRET',
          source: 'sts',
          reason: 'invalid',
        },
      ],
    ]);
    for (const value of FIXTURE_VALUES) expect(logs.raw()).not.toContain(value);
  });
});
