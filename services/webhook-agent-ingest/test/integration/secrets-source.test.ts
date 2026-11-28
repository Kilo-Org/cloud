import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BundleBinding } from '@kilocode/secrets-client';
import { deriveCallbackToken } from '@kilocode/worker-utils';
import worker from '../../src/index';
import { logger } from '../../src/util/logger';

// Synthetic fixture values only; none is a real key or signing secret. The bundle and the Secrets
// Store hold different values, so a check against the wrong source, or a fallback, answers
// differently.
const BUNDLE_INTERNAL = 'source-bundle-internal-fixture-0123456789';
const BUNDLE_CALLBACK = 'source-bundle-callback-fixture-0123456789';
const BUNDLE_NEXTAUTH = 'source-bundle-nextauth-fixture-0123456789';
const STORE_INTERNAL = 'source-store-internal-fixture-0123456789';
const STORE_CALLBACK = 'source-store-callback-fixture-0123456789';
const STORE_NEXTAUTH = 'source-store-nextauth-fixture-0123456789';
const FIXTURE_VALUES = [
  BUNDLE_INTERNAL,
  BUNDLE_CALLBACK,
  BUNDLE_NEXTAUTH,
  STORE_INTERNAL,
  STORE_CALLBACK,
  STORE_NEXTAUTH,
];
const NAMESPACE = 'user/source-user';
const TRIGGER_ID = 'source-trigger';
const REQUEST_ID = 'source-request';

const UNAUTHORIZED = { status: 401, body: { success: false, error: 'Unauthorized' } };
const UNAVAILABLE = { status: 503, body: { success: false, error: 'Internal key unavailable' } };

function storeSecret(value: string) {
  const get = vi.fn(async () => value);
  return { secret: { get } as SecretsStoreSecret, get };
}

/**
 * The deployed bindings for `environment`: a fresh STS binding (the reader keeps one bundle per
 * binding for the isolate) unless `sts` is false, and the three Secrets Store bindings.
 */
function fixture(environment: string | undefined, sts = true) {
  const getBundle = vi.fn<BundleBinding['getBundle']>(async () => ({
    status: 'ok',
    workload: 'cloudflare-webhook-agent-ingest',
    environment: 'production',
    etag: '"0123456789abcdef"',
    stale: false,
    fetchedAt: '2026-11-27T00:00:00.000Z',
    secrets: {
      INTERNAL_API_SECRET: { value: BUNDLE_INTERNAL, version: 1 },
      CALLBACK_TOKEN_SECRET: { value: BUNDLE_CALLBACK, version: 1 },
      NEXTAUTH_SECRET: { value: BUNDLE_NEXTAUTH, version: 1 },
    },
    missing: [],
  }));
  const internal = storeSecret(STORE_INTERNAL);
  const callback = storeSecret(STORE_CALLBACK);
  const nextAuth = storeSecret(STORE_NEXTAUTH);
  const serviceEnv = {
    ...env,
    ENVIRONMENT: environment,
    STS: sts ? { getBundle } : undefined,
    INTERNAL_API_SECRET: internal.secret,
    CALLBACK_TOKEN_SECRET: callback.secret,
    NEXTAUTH_SECRET: nextAuth.secret,
  };
  const storeReads = () =>
    internal.get.mock.calls.length +
    callback.get.mock.calls.length +
    nextAuth.get.mock.calls.length;
  return { serviceEnv, getBundle, storeReads };
}

/** Every console and logger line, so a test can check that no fixture value reached any. */
function captureLogs() {
  const consoleSpies = (['log', 'info', 'warn', 'error', 'debug'] as const).map(method =>
    vi.spyOn(console, method).mockImplementation(() => undefined)
  );
  const info = vi.spyOn(logger, 'info').mockImplementation(() => undefined);
  const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
  const error = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
  const raw = () => JSON.stringify([...consoleSpies, info, warn, error].map(spy => spy.mock.calls));
  return { info, warn, error, raw };
}

async function send(serviceEnv: object, request: Request) {
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, serviceEnv as Env, ctx);
  const result = {
    status: response.status,
    retryAfter: response.headers.get('Retry-After'),
    body: await response.json(),
  };
  await waitOnExecutionContext(ctx);
  return result;
}

function getTrigger(key?: string) {
  return new Request(`https://example.com/api/triggers/user/source-user/${TRIGGER_ID}`, {
    headers: key === undefined ? {} : { 'X-Internal-API-Key': key },
  });
}

async function executionCallback(secret?: string) {
  const token =
    secret === undefined
      ? undefined
      : await deriveCallbackToken({
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
      ...(token === undefined ? {} : { 'X-Callback-Token': token }),
    },
    body: JSON.stringify({
      sessionId: 'source-session',
      cloudAgentSessionId: 'source-agent-session',
      executionId: 'source-execution',
      status: 'completed',
    }),
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('production reads STS only', () => {
  it('accepts only bundle credentials, labels every 401 and logs one read marker', async () => {
    const { serviceEnv, getBundle, storeReads } = fixture('production');
    const logs = captureLogs();
    const strip = ({ status, body }: { status: number; body: unknown }) => ({ status, body });

    // A request without a credential loads no bundle.
    expect(strip(await send(serviceEnv, getTrigger()))).toEqual(UNAUTHORIZED);
    expect(strip(await send(serviceEnv, await executionCallback()))).toEqual(UNAUTHORIZED);
    expect(getBundle).not.toHaveBeenCalled();

    // No fallback: the Secrets Store copies are refused while STS serves other values.
    expect(strip(await send(serviceEnv, getTrigger(STORE_INTERNAL)))).toEqual(UNAUTHORIZED);
    expect(strip(await send(serviceEnv, await executionCallback(STORE_CALLBACK)))).toEqual(
      UNAUTHORIZED
    );

    expect((await send(serviceEnv, getTrigger(BUNDLE_INTERNAL))).status).toBe(404);
    expect(strip(await send(serviceEnv, await executionCallback(BUNDLE_CALLBACK)))).toEqual({
      status: 404,
      body: { success: false, error: 'Request not found' },
    });
    expect(getBundle).toHaveBeenCalledOnce();
    expect(storeReads()).toBe(0);

    expect(logs.warn.mock.calls.filter(([message]) => message.endsWith('failed'))).toEqual([
      [
        'Internal API authentication failed',
        {
          error: 'Missing internal API key',
          route: 'internal-api',
          secret: 'INTERNAL_API_SECRET',
          source: 'sts',
          reason: 'missing',
        },
      ],
      [
        'Callback authentication failed',
        {
          route: 'execution-callback',
          secret: 'CALLBACK_TOKEN_SECRET',
          source: 'sts',
          reason: 'missing',
        },
      ],
      [
        'Internal API authentication failed',
        {
          error: 'Invalid internal API key',
          route: 'internal-api',
          secret: 'INTERNAL_API_SECRET',
          source: 'sts',
          reason: 'invalid',
        },
      ],
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
    expect(
      logs.info.mock.calls.filter(([message]) => message === 'Webhook secret source read succeeded')
    ).toEqual([['Webhook secret source read succeeded', { source: 'sts' }]]);
    expect(logs.error).not.toHaveBeenCalled();
    for (const value of FIXTURE_VALUES) expect(logs.raw()).not.toContain(value);
  });

  it('answers a generic 503 without the STS binding and never reads the Secrets Store', async () => {
    const { serviceEnv, storeReads } = fixture('production', false);
    const logs = captureLogs();

    expect(await send(serviceEnv, getTrigger(STORE_INTERNAL))).toEqual({
      ...UNAVAILABLE,
      retryAfter: '30',
    });
    expect(await send(serviceEnv, await executionCallback(STORE_CALLBACK))).toEqual({
      ...UNAVAILABLE,
      retryAfter: '30',
    });
    expect(storeReads()).toBe(0);
    expect(logs.error.mock.calls).toEqual([
      ['Webhook verifier secret unavailable', { route: 'internal-api', reason: 'binding_missing' }],
      [
        'Webhook verifier secret unavailable',
        { route: 'execution-callback', reason: 'binding_missing' },
      ],
    ]);
    for (const value of FIXTURE_VALUES) expect(logs.raw()).not.toContain(value);
  });
});

describe('development reads its own bindings', () => {
  it('accepts only the Secrets Store values and reads no bundle', async () => {
    const { serviceEnv, getBundle, storeReads } = fixture('development');
    captureLogs();

    expect((await send(serviceEnv, getTrigger(STORE_INTERNAL))).status).toBe(404);
    expect((await send(serviceEnv, getTrigger(BUNDLE_INTERNAL))).status).toBe(401);
    expect((await send(serviceEnv, await executionCallback(STORE_CALLBACK))).status).toBe(404);
    expect((await send(serviceEnv, await executionCallback(BUNDLE_CALLBACK))).status).toBe(401);
    expect(getBundle).not.toHaveBeenCalled();
    expect(storeReads()).toBe(4);
  });
});

describe('any other environment reads nothing', () => {
  it.each(['staging', undefined])(
    'answers a generic 503 for ENVIRONMENT %j and reads neither source',
    async environment => {
      const { serviceEnv, getBundle, storeReads } = fixture(environment);
      const logs = captureLogs();

      expect(await send(serviceEnv, getTrigger(BUNDLE_INTERNAL))).toEqual({
        ...UNAVAILABLE,
        retryAfter: '30',
      });
      expect(await send(serviceEnv, await executionCallback(STORE_CALLBACK))).toEqual({
        ...UNAVAILABLE,
        retryAfter: '30',
      });
      expect(getBundle).not.toHaveBeenCalled();
      expect(storeReads()).toBe(0);
      expect(logs.error.mock.calls).toEqual([
        [
          'Webhook verifier secret unavailable',
          { route: 'internal-api', reason: 'unsupported_environment' },
        ],
        [
          'Webhook verifier secret unavailable',
          { route: 'execution-callback', reason: 'unsupported_environment' },
        ],
      ]);
    }
  );
});
