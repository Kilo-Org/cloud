import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { debugRoutesGate } from './debug-gate';

function mountDebugApp() {
  const app = new Hono<AppEnv>();
  app.use('/debug/*', debugRoutesGate);
  app.get('/debug/ping', c => c.json({ ok: true }));
  return app;
}

async function jsonBody(res: Response): Promise<Record<string, unknown>> {
  return res.json();
}

describe('debugRoutesGate', () => {
  it('returns 404 when DEBUG_ROUTES is not enabled', async () => {
    const app = mountDebugApp();
    const res = await app.request('/debug/ping', {}, {} as never);
    expect(res.status).toBe(404);
    const body = await jsonBody(res);
    expect(body.error).toBe('Debug routes are disabled');
  });

  it('returns 403 when enabled but no secret is configured', async () => {
    const app = mountDebugApp();
    const res = await app.request('/debug/ping', {}, { DEBUG_ROUTES: 'true' } as never);
    expect(res.status).toBe(403);
  });

  it('returns 403 when secret is set but header is missing', async () => {
    const app = mountDebugApp();
    const res = await app.request('/debug/ping', {}, {
      DEBUG_ROUTES: 'true',
      DEBUG_ROUTES_SECRET: 'my-secret',
    } as never);
    expect(res.status).toBe(403);
  });

  it('returns 403 when header does not match secret', async () => {
    const app = mountDebugApp();
    const res = await app.request('/debug/ping', { headers: { 'x-debug-api-key': 'wrong' } }, {
      DEBUG_ROUTES: 'true',
      DEBUG_ROUTES_SECRET: 'my-secret',
    } as never);
    expect(res.status).toBe(403);
  });

  it('allows access when debug header matches secret', async () => {
    const app = mountDebugApp();
    const res = await app.request('/debug/ping', { headers: { 'x-debug-api-key': 'my-secret' } }, {
      DEBUG_ROUTES: 'true',
      DEBUG_ROUTES_SECRET: 'my-secret',
    } as never);
    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    expect(body.ok).toBe(true);
  });

  it('allows access via internal API key even without debug secret', async () => {
    const app = mountDebugApp();
    const res = await app.request(
      '/debug/ping',
      { headers: { 'x-internal-api-key': 'internal-secret' } },
      {
        DEBUG_ROUTES: 'true',
        INTERNAL_API_SECRET: 'internal-secret',
      } as never
    );
    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    expect(body.ok).toBe(true);
  });

  it('rejects wrong internal API key', async () => {
    const app = mountDebugApp();
    const res = await app.request(
      '/debug/ping',
      { headers: { 'x-internal-api-key': 'wrong-key' } },
      {
        DEBUG_ROUTES: 'true',
        INTERNAL_API_SECRET: 'internal-secret',
        DEBUG_ROUTES_SECRET: 'my-secret',
      } as never
    );
    // Falls through to debug secret check, which also fails (no x-debug-api-key header)
    expect(res.status).toBe(403);
  });
});
