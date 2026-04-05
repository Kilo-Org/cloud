import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import { registerEnvRoutes } from './env';
import type { Supervisor } from '../supervisor';

function createMockSupervisor(state: 'running' | 'stopped' = 'running'): Supervisor {
  return {
    start: vi.fn(async () => true),
    stop: vi.fn(async () => true),
    restart: vi.fn(async () => true),
    shutdown: vi.fn(async () => undefined),
    signal: vi.fn(() => true),
    getState: vi.fn(() => state),
    getStats: vi.fn(() => ({
      state,
      pid: 100,
      uptime: 50,
      restarts: 3,
      lastExit: null,
    })),
  };
}

function authHeaders(token = 'test-token'): HeadersInit {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

describe('/_kilo/env/patch', () => {
  const originalApiKey = process.env.KILOCODE_API_KEY;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    // Restore original env to avoid pollution between tests
    if (originalApiKey === undefined) {
      delete process.env.KILOCODE_API_KEY;
    } else {
      process.env.KILOCODE_API_KEY = originalApiKey;
    }
  });

  it('rejects requests without auth', async () => {
    const app = new Hono();
    registerEnvRoutes(app, createMockSupervisor(), 'test-token');

    const resp = await app.request('/_kilo/env/patch', {
      method: 'POST',
      body: JSON.stringify({ KILOCODE_API_KEY: 'new-key' }),
      headers: { 'Content-Type': 'application/json' },
    });
    expect(resp.status).toBe(401);
  });

  it('rejects requests with wrong token', async () => {
    const app = new Hono();
    registerEnvRoutes(app, createMockSupervisor(), 'test-token');

    const resp = await app.request('/_kilo/env/patch', {
      method: 'POST',
      body: JSON.stringify({ KILOCODE_API_KEY: 'new-key' }),
      headers: authHeaders('wrong-token'),
    });
    expect(resp.status).toBe(401);
  });

  it('rejects invalid JSON body', async () => {
    const app = new Hono();
    registerEnvRoutes(app, createMockSupervisor(), 'test-token');

    const resp = await app.request('/_kilo/env/patch', {
      method: 'POST',
      body: 'not json',
      headers: authHeaders(),
    });
    expect(resp.status).toBe(400);
    expect(await resp.json()).toEqual({ error: 'Invalid JSON body' });
  });

  it('rejects non-object body (array)', async () => {
    const app = new Hono();
    registerEnvRoutes(app, createMockSupervisor(), 'test-token');

    const resp = await app.request('/_kilo/env/patch', {
      method: 'POST',
      body: JSON.stringify([1, 2]),
      headers: authHeaders(),
    });
    expect(resp.status).toBe(400);
    expect(await resp.json()).toEqual({ error: 'Body must be a JSON object' });
  });

  it('rejects empty object', async () => {
    const app = new Hono();
    registerEnvRoutes(app, createMockSupervisor(), 'test-token');

    const resp = await app.request('/_kilo/env/patch', {
      method: 'POST',
      body: JSON.stringify({}),
      headers: authHeaders(),
    });
    expect(resp.status).toBe(400);
    expect(await resp.json()).toEqual({ error: 'Body must contain at least one key' });
  });

  it('rejects keys not in the allowlist', async () => {
    const app = new Hono();
    registerEnvRoutes(app, createMockSupervisor(), 'test-token');

    const resp = await app.request('/_kilo/env/patch', {
      method: 'POST',
      body: JSON.stringify({ PATH: '/usr/bin' }),
      headers: authHeaders(),
    });
    expect(resp.status).toBe(400);
    const body = (await resp.json()) as { error: string };
    expect(body.error).toContain("'PATH' is not patchable");
  });

  it('rejects non-string values', async () => {
    const app = new Hono();
    registerEnvRoutes(app, createMockSupervisor(), 'test-token');

    const resp = await app.request('/_kilo/env/patch', {
      method: 'POST',
      body: JSON.stringify({ KILOCODE_API_KEY: 123 }),
      headers: authHeaders(),
    });
    expect(resp.status).toBe(400);
    const body = (await resp.json()) as { error: string };
    expect(body.error).toContain("'KILOCODE_API_KEY' must be a string");
  });

  it('updates process.env and signals SIGUSR1', async () => {
    const app = new Hono();
    const supervisor = createMockSupervisor('running');
    registerEnvRoutes(app, supervisor, 'test-token');

    const resp = await app.request('/_kilo/env/patch', {
      method: 'POST',
      body: JSON.stringify({ KILOCODE_API_KEY: 'fresh-jwt-token' }),
      headers: authHeaders(),
    });

    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual({ ok: true, signaled: true });

    expect(process.env.KILOCODE_API_KEY).toBe('fresh-jwt-token');
    expect(supervisor.signal).toHaveBeenCalledWith('SIGUSR1');
  });

  it('returns signaled: false when gateway is not running', async () => {
    const app = new Hono();
    const supervisor = createMockSupervisor('stopped');
    registerEnvRoutes(app, supervisor, 'test-token');

    const resp = await app.request('/_kilo/env/patch', {
      method: 'POST',
      body: JSON.stringify({ KILOCODE_API_KEY: 'fresh-jwt-token' }),
      headers: authHeaders(),
    });

    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual({ ok: true, signaled: false });

    // Env is still updated even if not signaled
    expect(process.env.KILOCODE_API_KEY).toBe('fresh-jwt-token');
    expect(supervisor.signal).not.toHaveBeenCalled();
  });

  it('does not leak through to catch-all proxy', async () => {
    const app = new Hono();
    registerEnvRoutes(app, createMockSupervisor(), 'test-token');
    app.all('*', c => c.json({ proxied: true }));

    const resp = await app.request('/_kilo/env/patch', {
      method: 'POST',
    });
    // Should hit the auth middleware, not the proxy
    expect(resp.status).toBe(401);
    expect(await resp.json()).toEqual({ error: 'Unauthorized' });
  });
});
