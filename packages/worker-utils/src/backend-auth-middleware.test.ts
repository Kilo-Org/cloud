import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { backendAuthMiddleware } from './backend-auth-middleware';
import { resetInternalAuthObservation } from './internal-auth-observation';

afterEach(() => {
  vi.restoreAllMocks();
  resetInternalAuthObservation();
});

describe('backendAuthMiddleware', () => {
  it('authenticates with an async bearer token getter', async () => {
    const app = new Hono();
    app.use(
      '*',
      backendAuthMiddleware(async () => 'shared-secret')
    );
    app.get('/health', c => c.json({ ok: true }));

    const response = await app.request('/health', {
      headers: { authorization: 'Bearer shared-secret' },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
  });

  it('rejects requests when the async bearer token does not match', async () => {
    const app = new Hono();
    app.use(
      '*',
      backendAuthMiddleware(async () => 'shared-secret')
    );
    app.get('/health', c => c.json({ ok: true }));

    const response = await app.request('/health', {
      headers: { authorization: 'Bearer wrong-secret' },
    });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: 'Unauthorized' });
  });

  it('reports an accepted request only when observation is configured', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const observed = new Hono();
    observed.use(
      '*',
      backendAuthMiddleware(async () => 'shared-secret', {
        receiver: 'auto-routing',
        route: c => (c.req.path.startsWith('/admin/') ? 'admin' : 'decide'),
      })
    );
    observed.get('/admin/mode', c => c.json({ ok: true }));
    const silent = new Hono();
    silent.use(
      '*',
      backendAuthMiddleware(async () => 'shared-secret')
    );
    silent.get('/health', c => c.json({ ok: true }));

    const accepted = await observed.request('/admin/mode', {
      headers: { authorization: 'Bearer shared-secret', 'x-kilo-caller': 'ai-gateway' },
    });
    const refused = await observed.request('/admin/mode', {
      headers: { authorization: 'Bearer wrong-secret' },
    });
    await silent.request('/health', { headers: { authorization: 'Bearer shared-secret' } });

    expect(accepted.status).toBe(200);
    expect(refused.status).toBe(401);
    expect(
      log.mock.calls.map(([line]) => JSON.parse(String(line)) as Record<string, unknown>)
    ).toEqual([
      expect.objectContaining({
        event: 'kilo_internal_auth',
        receiver: 'auto-routing',
        route: 'admin',
        auth: 'legacy_shared_secret',
        caller: 'ai-gateway',
        count: 1,
      }),
    ]);
  });
});
