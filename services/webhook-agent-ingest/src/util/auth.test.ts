import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import type { HonoContext } from '../index';
import { INTERNAL_API_KEY_HEADER, internalApiMiddleware, validateInternalApiKey } from './auth';

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

  const env = { INTERNAL_API_SECRET: { get: async () => secret } } as unknown as Env;
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

    it('should reject invalid API key', () => {
      const result = validateInternalApiKey('wrong-key', TEST_SECRET);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBe('Invalid internal API key');
      }
    });
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
