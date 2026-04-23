import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import { registerEnvRoutes, type EnvRoutesDeps } from './env';
import type { ReloadGatewaySecretsResult } from '../gateway-rpc';
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

function defaultSuccessDeps(): EnvRoutesDeps {
  const okResult: ReloadGatewaySecretsResult = { ok: true };
  return {
    migrate: vi.fn(() => ({ filesScanned: 0, filesModified: 0, profilesMigrated: 0 })),
    reload: vi.fn(() => okResult),
  };
}

describe('/_kilo/env/patch', () => {
  const originalApiKey = process.env.KILOCODE_API_KEY;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    if (originalApiKey === undefined) {
      delete process.env.KILOCODE_API_KEY;
    } else {
      process.env.KILOCODE_API_KEY = originalApiKey;
    }
  });

  it('rejects requests without auth', async () => {
    const app = new Hono();
    registerEnvRoutes(app, createMockSupervisor(), 'test-token', defaultSuccessDeps());

    const resp = await app.request('/_kilo/env/patch', {
      method: 'POST',
      body: JSON.stringify({ KILOCODE_API_KEY: 'new-key' }),
      headers: { 'Content-Type': 'application/json' },
    });
    expect(resp.status).toBe(401);
  });

  it('rejects requests with wrong token', async () => {
    const app = new Hono();
    registerEnvRoutes(app, createMockSupervisor(), 'test-token', defaultSuccessDeps());

    const resp = await app.request('/_kilo/env/patch', {
      method: 'POST',
      body: JSON.stringify({ KILOCODE_API_KEY: 'new-key' }),
      headers: authHeaders('wrong-token'),
    });
    expect(resp.status).toBe(401);
  });

  it('rejects invalid JSON body', async () => {
    const app = new Hono();
    registerEnvRoutes(app, createMockSupervisor(), 'test-token', defaultSuccessDeps());

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
    registerEnvRoutes(app, createMockSupervisor(), 'test-token', defaultSuccessDeps());

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
    registerEnvRoutes(app, createMockSupervisor(), 'test-token', defaultSuccessDeps());

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
    registerEnvRoutes(app, createMockSupervisor(), 'test-token', defaultSuccessDeps());

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
    registerEnvRoutes(app, createMockSupervisor(), 'test-token', defaultSuccessDeps());

    const resp = await app.request('/_kilo/env/patch', {
      method: 'POST',
      body: JSON.stringify({ KILOCODE_API_KEY: 123 }),
      headers: authHeaders(),
    });
    expect(resp.status).toBe(400);
    const body = (await resp.json()) as { error: string };
    expect(body.error).toContain("'KILOCODE_API_KEY' must be a string");
  });

  it('updates process.env, runs migration, and calls secrets reload when gateway is running', async () => {
    const app = new Hono();
    const supervisor = createMockSupervisor('running');
    const okResult: ReloadGatewaySecretsResult = { ok: true };
    const deps: EnvRoutesDeps = {
      migrate: vi.fn(() => ({ filesScanned: 1, filesModified: 1, profilesMigrated: 2 })),
      reload: vi.fn(() => okResult),
    };
    registerEnvRoutes(app, supervisor, 'test-token', deps);

    const resp = await app.request('/_kilo/env/patch', {
      method: 'POST',
      body: JSON.stringify({ KILOCODE_API_KEY: 'fresh-jwt-token' }),
      headers: authHeaders(),
    });

    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual({
      ok: true,
      reloaded: true,
      signaled: false,
      migratedProfiles: 2,
    });

    expect(process.env.KILOCODE_API_KEY).toBe('fresh-jwt-token');
    expect(deps.migrate).toHaveBeenCalledWith('/root/.openclaw');
    expect(deps.reload).toHaveBeenCalledWith('test-token');
    expect(supervisor.signal).not.toHaveBeenCalled();
  });

  it('falls back to SIGUSR1 when secrets reload fails', async () => {
    const app = new Hono();
    const supervisor = createMockSupervisor('running');
    const deps: EnvRoutesDeps = {
      migrate: vi.fn(() => ({ filesScanned: 0, filesModified: 0, profilesMigrated: 0 })),
      reload: vi.fn(() => ({ ok: false, error: 'connection refused' })),
    };
    registerEnvRoutes(app, supervisor, 'test-token', deps);

    const resp = await app.request('/_kilo/env/patch', {
      method: 'POST',
      body: JSON.stringify({ KILOCODE_API_KEY: 'fresh-jwt-token' }),
      headers: authHeaders(),
    });

    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual({
      ok: true,
      reloaded: false,
      signaled: true,
      migratedProfiles: 0,
    });

    expect(supervisor.signal).toHaveBeenCalledWith('SIGUSR1');
  });

  it('does not log the gateway token when secrets reload fails with a tokenized error', async () => {
    // Simulates a buggy or future caller whose `reloadResult.error` still
    // embeds the gateway token (e.g., Node's execFileSync rejects with
    // `Command failed: openclaw ... --token <TOKEN>`). The route must not
    // leak that token to controller logs.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const app = new Hono();
    const supervisor = createMockSupervisor('running');
    const deps: EnvRoutesDeps = {
      migrate: vi.fn(() => ({ filesScanned: 0, filesModified: 0, profilesMigrated: 0 })),
      reload: vi.fn(() => ({
        ok: false,
        error: 'Command failed: openclaw secrets reload --token test-token --json',
      })),
    };
    registerEnvRoutes(app, supervisor, 'test-token', deps);

    await app.request('/_kilo/env/patch', {
      method: 'POST',
      body: JSON.stringify({ KILOCODE_API_KEY: 'fresh-jwt-token' }),
      headers: authHeaders(),
    });

    for (const call of warnSpy.mock.calls) {
      for (const arg of call) {
        expect(String(arg)).not.toContain('test-token');
      }
    }

    warnSpy.mockRestore();
  });

  it('skips reload and signal when gateway is not running', async () => {
    const app = new Hono();
    const supervisor = createMockSupervisor('stopped');
    const deps = defaultSuccessDeps();
    registerEnvRoutes(app, supervisor, 'test-token', deps);

    const resp = await app.request('/_kilo/env/patch', {
      method: 'POST',
      body: JSON.stringify({ KILOCODE_API_KEY: 'fresh-jwt-token' }),
      headers: authHeaders(),
    });

    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual({
      ok: true,
      reloaded: false,
      signaled: false,
      migratedProfiles: 0,
    });

    expect(process.env.KILOCODE_API_KEY).toBe('fresh-jwt-token');
    expect(deps.migrate).toHaveBeenCalled();
    expect(deps.reload).not.toHaveBeenCalled();
    expect(supervisor.signal).not.toHaveBeenCalled();
  });

  it('does not leak through to catch-all proxy', async () => {
    const app = new Hono();
    registerEnvRoutes(app, createMockSupervisor(), 'test-token', defaultSuccessDeps());
    app.all('*', c => c.json({ proxied: true }));

    const resp = await app.request('/_kilo/env/patch', {
      method: 'POST',
    });
    expect(resp.status).toBe(401);
    expect(await resp.json()).toEqual({ error: 'Unauthorized' });
  });
});
