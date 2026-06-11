import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { backendAuthMiddleware } from './backend-auth-middleware';

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
});
