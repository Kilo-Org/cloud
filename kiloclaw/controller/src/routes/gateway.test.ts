import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import { registerGatewayRoutes } from './gateway';
import type { Supervisor } from '../supervisor';

function createMockSupervisor(): Supervisor {
  const state = 'running' as const;
  return {
    start: vi.fn(async () => true),
    stop: vi.fn(async () => true),
    restart: vi.fn(async () => true),
    shutdown: vi.fn(async () => undefined),
    getState: vi.fn(() => state),
    getStats: vi.fn(() => ({
      state,
      pid: 100,
      uptime: 50,
      restarts: 3,
      lastExit: { code: 1, signal: null, at: '2026-02-20T00:00:00.000Z' },
    })),
  };
}

function authHeaders(token = 'test-token'): HeadersInit {
  return { Authorization: `Bearer ${token}` };
}

describe('/gateway routes', () => {
  it('enforces bearer auth on GET /gateway/status', async () => {
    const app = new Hono();
    const supervisor = createMockSupervisor();
    registerGatewayRoutes(app, supervisor, 'test-token');

    const noAuth = await app.request('/gateway/status');
    expect(noAuth.status).toBe(401);

    const wrongAuth = await app.request('/gateway/status', { headers: authHeaders('bad-token') });
    expect(wrongAuth.status).toBe(401);

    const ok = await app.request('/gateway/status', { headers: authHeaders() });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({
      state: 'running',
      pid: 100,
      uptime: 50,
      restarts: 3,
      lastExit: { code: 1, signal: null, at: '2026-02-20T00:00:00.000Z' },
    });
  });

  it('enforces bearer auth on POST /gateway/restart', async () => {
    const app = new Hono();
    const supervisor = createMockSupervisor();
    registerGatewayRoutes(app, supervisor, 'test-token');

    const noAuth = await app.request('/gateway/restart', { method: 'POST' });
    expect(noAuth.status).toBe(401);

    const wrongAuth = await app.request('/gateway/restart', {
      method: 'POST',
      headers: authHeaders('wrong'),
    });
    expect(wrongAuth.status).toBe(401);

    const ok = await app.request('/gateway/restart', { method: 'POST', headers: authHeaders() });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true });
  });

  it('returns 401 for /gateway/status before catch-all proxy route', async () => {
    const app = new Hono();
    const supervisor = createMockSupervisor();
    registerGatewayRoutes(app, supervisor, 'test-token');
    app.all('*', c => c.json({ proxied: true }));

    const resp = await app.request('/gateway/status');
    expect(resp.status).toBe(401);
    expect(await resp.json()).toEqual({ error: 'Unauthorized' });
  });
});
