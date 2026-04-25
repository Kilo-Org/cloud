import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import { registerEnvRoutes, type EnvRoutesDeps } from './env';
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

function makeMigrateDeps(
  profilesMigrated = 0,
  filesModified = profilesMigrated > 0 ? 1 : 0
): EnvRoutesDeps {
  return {
    migrate: vi.fn(() => ({ filesScanned: 1, filesModified, profilesMigrated })),
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
    registerEnvRoutes(app, createMockSupervisor(), 'test-token', makeMigrateDeps());

    const resp = await app.request('/_kilo/env/patch', {
      method: 'POST',
      body: JSON.stringify({ KILOCODE_API_KEY: 'new-key' }),
      headers: { 'Content-Type': 'application/json' },
    });
    expect(resp.status).toBe(401);
  });

  it('rejects requests with wrong token', async () => {
    const app = new Hono();
    registerEnvRoutes(app, createMockSupervisor(), 'test-token', makeMigrateDeps());

    const resp = await app.request('/_kilo/env/patch', {
      method: 'POST',
      body: JSON.stringify({ KILOCODE_API_KEY: 'new-key' }),
      headers: authHeaders('wrong-token'),
    });
    expect(resp.status).toBe(401);
  });

  it('rejects invalid JSON body', async () => {
    const app = new Hono();
    registerEnvRoutes(app, createMockSupervisor(), 'test-token', makeMigrateDeps());

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
    registerEnvRoutes(app, createMockSupervisor(), 'test-token', makeMigrateDeps());

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
    registerEnvRoutes(app, createMockSupervisor(), 'test-token', makeMigrateDeps());

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
    registerEnvRoutes(app, createMockSupervisor(), 'test-token', makeMigrateDeps());

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
    registerEnvRoutes(app, createMockSupervisor(), 'test-token', makeMigrateDeps());

    const resp = await app.request('/_kilo/env/patch', {
      method: 'POST',
      body: JSON.stringify({ KILOCODE_API_KEY: 123 }),
      headers: authHeaders(),
    });
    expect(resp.status).toBe(400);
    const body = (await resp.json()) as { error: string };
    expect(body.error).toContain("'KILOCODE_API_KEY' must be a string");
  });

  it('updates process.env, runs migration, and restarts the gateway when running', async () => {
    const app = new Hono();
    const supervisor = createMockSupervisor('running');
    const deps = makeMigrateDeps(2);
    registerEnvRoutes(app, supervisor, 'test-token', deps);

    const resp = await app.request('/_kilo/env/patch', {
      method: 'POST',
      body: JSON.stringify({ KILOCODE_API_KEY: 'fresh-jwt-token' }),
      headers: authHeaders(),
    });

    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual({
      ok: true,
      signaled: true,
      migratedProfiles: 2,
    });

    expect(process.env.KILOCODE_API_KEY).toBe('fresh-jwt-token');
    expect(deps.migrate).toHaveBeenCalledWith('/root/.openclaw');
    expect(supervisor.restart).toHaveBeenCalledTimes(1);
    expect(supervisor.signal).not.toHaveBeenCalled();
  });

  it('runs migration BEFORE restarting so the respawned gateway reads the migrated file', async () => {
    const app = new Hono();
    const supervisor = createMockSupervisor('running');
    const order: string[] = [];
    const deps: EnvRoutesDeps = {
      migrate: vi.fn(() => {
        order.push('migrate');
        return { filesScanned: 1, filesModified: 1, profilesMigrated: 1 };
      }),
    };
    (supervisor.restart as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      order.push('restart');
      return true;
    });
    registerEnvRoutes(app, supervisor, 'test-token', deps);

    const resp = await app.request('/_kilo/env/patch', {
      method: 'POST',
      body: JSON.stringify({ KILOCODE_API_KEY: 'new' }),
      headers: authHeaders(),
    });

    expect(resp.status).toBe(200);
    // migrate always runs first; restart fires-and-forgets but is scheduled
    // synchronously before the handler returns, so the first 'restart' tick
    // lands after migrate.
    await new Promise(resolve => setImmediate(resolve));
    expect(order).toEqual(['migrate', 'restart']);
  });

  it('skips restart when gateway is not running', async () => {
    const app = new Hono();
    const supervisor = createMockSupervisor('stopped');
    const deps = makeMigrateDeps(0);
    registerEnvRoutes(app, supervisor, 'test-token', deps);

    const resp = await app.request('/_kilo/env/patch', {
      method: 'POST',
      body: JSON.stringify({ KILOCODE_API_KEY: 'fresh-jwt-token' }),
      headers: authHeaders(),
    });

    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual({
      ok: true,
      signaled: false,
      migratedProfiles: 0,
    });

    expect(process.env.KILOCODE_API_KEY).toBe('fresh-jwt-token');
    expect(deps.migrate).toHaveBeenCalled();
    expect(supervisor.restart).not.toHaveBeenCalled();
  });

  it('response shape satisfies the worker EnvPatchResponseSchema wire contract', async () => {
    // The worker parses /_kilo/env/patch responses with EnvPatchResponseSchema
    // = z.object({ ok: boolean, signaled: boolean }). If the field name or
    // type drifts, `patchEnvOnMachine` throws, `reconcile.ts` treats the
    // push as failed, and — if the parallel fly.updateMachine path also
    // fails — the new key expiry is never persisted and the refresh retries
    // indefinitely. Guard against that here so a rename is caught locally.
    const app = new Hono();
    registerEnvRoutes(app, createMockSupervisor('running'), 'test-token', makeMigrateDeps(0));

    const resp = await app.request('/_kilo/env/patch', {
      method: 'POST',
      body: JSON.stringify({ KILOCODE_API_KEY: 'new' }),
      headers: authHeaders(),
    });
    const body = (await resp.json()) as Record<string, unknown>;
    expect(typeof body.ok).toBe('boolean');
    expect(typeof body.signaled).toBe('boolean');
  });

  it('logs but does not throw when the background restart rejects', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const app = new Hono();
    const supervisor = createMockSupervisor('running');
    (supervisor.restart as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('spawn failed'));
    registerEnvRoutes(app, supervisor, 'test-token', makeMigrateDeps());

    const resp = await app.request('/_kilo/env/patch', {
      method: 'POST',
      body: JSON.stringify({ KILOCODE_API_KEY: 'new' }),
      headers: authHeaders(),
    });
    expect(resp.status).toBe(200);

    // Wait for the fire-and-forget restart promise to settle.
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));

    const logged = errorSpy.mock.calls.some(call =>
      call.some(arg => String(arg).includes('gateway restart failed'))
    );
    expect(logged).toBe(true);

    errorSpy.mockRestore();
  });

  it('does not leak through to catch-all proxy', async () => {
    const app = new Hono();
    registerEnvRoutes(app, createMockSupervisor(), 'test-token', makeMigrateDeps());
    app.all('*', c => c.json({ proxied: true }));

    const resp = await app.request('/_kilo/env/patch', {
      method: 'POST',
    });
    expect(resp.status).toBe(401);
    expect(await resp.json()).toEqual({ error: 'Unauthorized' });
  });
});
