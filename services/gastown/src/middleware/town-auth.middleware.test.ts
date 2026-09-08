import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { GastownEnv } from '../gastown.worker';

const mocks = vi.hoisted(() => ({ getTownIdentityState: vi.fn(), authorizeTown: vi.fn() }));

vi.mock('../dos/Town.do', () => ({
  getTownDOStub: () => ({ getTownIdentityState: mocks.getTownIdentityState }),
}));
vi.mock('../util/town-authorization.util', () => ({
  authorizeTown: mocks.authorizeTown,
  TownAuthorizationUnavailableError: class extends Error {},
}));

import { townAuthMiddleware } from './town-auth.middleware';

describe('townAuthMiddleware', () => {
  it('uses fresh modern authorization instead of the cached admin claim', async () => {
    mocks.getTownIdentityState.mockResolvedValue({
      type: 'modern',
      identity: { ownerType: 'user', ownerUserId: 'owner', runtimeMode: 'modern' },
    });
    mocks.authorizeTown.mockResolvedValue(null);
    const app = new Hono<GastownEnv>();
    app.use('*', async (c, next) => {
      c.set('kiloUserId', 'stale-admin');
      c.set('kiloIsAdmin', true);
      c.set('kiloApiTokenPepper', 'pepper');
      await next();
    });
    app.use('/api/towns/:townId/*', townAuthMiddleware);
    app.get('/api/towns/:townId/config', c => c.text('allowed'));

    expect((await app.request('/api/towns/town-1/config', {}, {} as Env)).status).toBe(403);
  });

  it('preserves the cached admin bypass for legacy towns', async () => {
    mocks.getTownIdentityState.mockResolvedValue({
      type: 'legacy',
      identity: { ownerType: 'user', ownerUserId: 'owner', runtimeMode: 'legacy' },
    });
    const app = new Hono<GastownEnv>();
    app.use('*', async (c, next) => {
      c.set('kiloUserId', 'admin');
      c.set('kiloIsAdmin', true);
      await next();
    });
    app.use('/api/towns/:townId/*', townAuthMiddleware);
    app.get('/api/towns/:townId/config', c => c.text('allowed'));

    expect((await app.request('/api/towns/town-1/config', {}, {} as Env)).status).toBe(200);
  });

  it('fails closed for an invalid persisted authorization state', async () => {
    mocks.getTownIdentityState.mockResolvedValue({ type: 'invalid' });
    const app = new Hono<GastownEnv>();
    app.use('*', async (c, next) => {
      c.set('kiloUserId', 'user-1');
      c.set('kiloIsAdmin', true);
      await next();
    });
    app.use('/api/towns/:townId/*', townAuthMiddleware);
    app.get('/api/towns/:townId/config', c => c.text('allowed'));

    expect((await app.request('/api/towns/town-1/config', {}, {} as Env)).status).toBe(403);
  });
});
