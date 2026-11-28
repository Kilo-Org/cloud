import { afterEach, describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import type { BundleBinding } from '@kilocode/secrets-client';
import type { HonoContext } from '../index';
import { INTERNAL_API_KEY_HEADER, internalApiMiddleware, validateInternalApiKey } from './auth';
import { logger } from './logger';

vi.mock('cloudflare:workers', () => ({ waitUntil: vi.fn() }));

const TEST_SECRET = 'test-internal-api-secret';

/**
 * Build an app that mirrors index.ts's mounting: the internal-key middleware is
 * applied to the `/api` router (which also mounts `/api/callbacks`). This is the
 * exact shape that previously 401'd completion callbacks before they reached the
 * token-validating handler.
 */
function buildMountedApp(secret: string | undefined = TEST_SECRET) {
  const api = new Hono<HonoContext>();
  api.use('*', internalApiMiddleware);
  api.post('/triggers/user/:userId/:triggerId', c => c.json({ reached: 'trigger' }));

  const callbacksStub = new Hono<HonoContext>().post('/execution', c =>
    c.json({ reached: 'callbacks' })
  );

  const app = new Hono<HonoContext>();
  // Order matches index.ts: `/api` is registered before `/api/callbacks`.
  app.route('/api', api);
  app.route('/api/callbacks', callbacksStub);

  const env = {
    ENVIRONMENT: 'development',
    INTERNAL_API_SECRET: { get: async () => secret },
  } as unknown as Env;
  return { app, env };
}

describe('validateInternalApiKey', () => {
  describe('header validation', () => {
    it('should reject missing API key header', () => {
      const result = validateInternalApiKey(null, TEST_SECRET);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBe('Missing internal API key');
      }
    });

    it('should reject empty API key header', () => {
      const result = validateInternalApiKey('', TEST_SECRET);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBe('Missing internal API key');
      }
    });
  });

  describe('key validation', () => {
    it('should accept valid API key', () => {
      const result = validateInternalApiKey(TEST_SECRET, TEST_SECRET);

      expect(result.success).toBe(true);
    });

    it.each(['wrong-key', `${TEST_SECRET.slice(0, -1)}X`])(
      'should reject invalid API key %s',
      key => {
        const result = validateInternalApiKey(key, TEST_SECRET);

        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error).toBe('Invalid internal API key');
        }
      }
    );
  });
});

describe('internalApiMiddleware (mounted like index.ts)', () => {
  it('exempts the /api/callbacks subtree — callbacks reach the handler without the internal key', async () => {
    const { app, env } = buildMountedApp();

    const response = await app.request('/api/callbacks/execution', { method: 'POST' }, env);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ reached: 'callbacks' });
  });

  it('still requires the internal key for non-callback /api routes', async () => {
    const { app, env } = buildMountedApp();

    const response = await app.request('/api/triggers/user/u/t', { method: 'POST' }, env);

    expect(response.status).toBe(401);
  });

  it('allows non-callback /api routes with a valid internal key', async () => {
    const { app, env } = buildMountedApp();

    const response = await app.request(
      '/api/triggers/user/u/t',
      { method: 'POST', headers: { [INTERNAL_API_KEY_HEADER]: TEST_SECRET } },
      env
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ reached: 'trigger' });
  });
});

// Synthetic fixture values only. Each source holds a different value, so a middleware that
// compared against the wrong source, or fell back to it, answers differently.
const STORE_KEY = 'store-internal-fixture-0123456789abcdef';
const BUNDLE_KEY = 'bundle-internal-fixture-0123456789abcdef';

type BundleResult = Awaited<ReturnType<BundleBinding['getBundle']>>;

function bundleWith(secrets: Record<string, string>): BundleResult {
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
    missing: [],
  };
}

/** A fresh STS binding per call: the reader keeps one bundle per binding for the isolate. */
function sourceApp(
  environment: string | undefined,
  bundle: BundleResult | 'no-binding' = bundleWith({ INTERNAL_API_SECRET: BUNDLE_KEY })
) {
  const getBundle = vi.fn<BundleBinding['getBundle']>(async () =>
    bundle === 'no-binding' ? bundleWith({}) : bundle
  );
  const storeGet = vi.fn(async () => STORE_KEY);
  const { app } = buildMountedApp();
  const env = {
    ...(environment === undefined ? {} : { ENVIRONMENT: environment }),
    INTERNAL_API_SECRET: { get: storeGet },
    ...(bundle === 'no-binding' ? {} : { STS: { getBundle } }),
  } as unknown as Env;
  const call = (key?: string, path = '/api/triggers/user/u/t') =>
    app.request(
      path,
      { method: 'POST', headers: key === undefined ? {} : { [INTERNAL_API_KEY_HEADER]: key } },
      env
    );
  return { call, getBundle, storeGet };
}

describe('internalApiMiddleware secrets source', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('accepts only the Secrets Store key and reads no bundle in development', async () => {
    const { call, getBundle, storeGet } = sourceApp('development');

    expect((await call(STORE_KEY)).status).toBe(200);
    expect((await call(BUNDLE_KEY)).status).toBe(401);
    expect((await call()).status).toBe(401);
    // Development reads the binding for every request, a keyless one included.
    expect(storeGet).toHaveBeenCalledTimes(3);
    expect(getBundle).not.toHaveBeenCalled();
  });

  it('accepts only the bundle key in production and never reads the Secrets Store', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const { call, getBundle, storeGet } = sourceApp('production');

    expect((await call()).status).toBe(401);
    expect((await call('')).status).toBe(401);
    // A keyless request loads no bundle.
    expect(getBundle).not.toHaveBeenCalled();

    expect((await call(BUNDLE_KEY)).status).toBe(200);
    expect((await call(STORE_KEY)).status).toBe(401);
    expect(getBundle).toHaveBeenCalledOnce();
    expect(storeGet).not.toHaveBeenCalled();
    const refusal = (error: string, reason: string) => [
      'Internal API authentication failed',
      { error, route: 'internal-api', secret: 'INTERNAL_API_SECRET', source: 'sts', reason },
    ];
    expect(warn.mock.calls).toEqual([
      refusal('Missing internal API key', 'missing'),
      refusal('Missing internal API key', 'missing'),
      refusal('Invalid internal API key', 'invalid'),
    ]);
  });

  it('reads nothing for the exempt callbacks subtree in production', async () => {
    const { call, getBundle, storeGet } = sourceApp('production');

    expect((await call(undefined, '/api/callbacks/execution')).status).toBe(200);
    expect(getBundle).not.toHaveBeenCalled();
    expect(storeGet).not.toHaveBeenCalled();
  });

  it.each<[string, string | undefined, BundleResult | 'no-binding', string]>([
    ['no grant', 'production', bundleWith({}), 'not_granted'],
    ['an STS denial', 'production', { status: 'denied', reason: 'unknown_workload' }, 'denied'],
    ['no STS binding in production', 'production', 'no-binding', 'binding_missing'],
    ['a staging ENVIRONMENT', 'staging', bundleWith({}), 'unsupported_environment'],
    ['no ENVIRONMENT', undefined, bundleWith({}), 'unsupported_environment'],
  ])(
    'answers a generic 503 on %s, logs fixed fields only, and never falls back',
    async (_case, environment, bundle, reason) => {
      const log = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
      const { call, getBundle, storeGet } = sourceApp(environment, bundle);

      const response = await call(STORE_KEY);

      expect(response.status).toBe(503);
      expect(response.headers.get('Retry-After')).toBe('30');
      await expect(response.json()).resolves.toEqual({
        success: false,
        error: 'Internal key unavailable',
      });
      expect(log).toHaveBeenCalledOnce();
      expect(log).toHaveBeenCalledWith('Webhook verifier secret unavailable', {
        route: 'internal-api',
        reason,
      });
      expect(storeGet).not.toHaveBeenCalled();
      if (environment !== 'production') expect(getBundle).not.toHaveBeenCalled();
    }
  );

  it('keeps the unconfigured answer for an empty bundle value', async () => {
    vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    const { call } = sourceApp('production', bundleWith({ INTERNAL_API_SECRET: '' }));

    expect((await call(BUNDLE_KEY)).status).toBe(500);
  });
});
