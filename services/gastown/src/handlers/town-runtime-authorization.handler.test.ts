import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { GastownEnv } from '../gastown.worker';

const mocks = vi.hoisted(() => ({
  select: vi.fn(),
  getTownIdentityState: vi.fn(),
  reauthorizeRuntime: vi.fn(),
}));
vi.mock('@kilocode/db/client', () => ({ getWorkerDb: () => ({ select: mocks.select }) }));
vi.mock('../dos/Town.do', () => ({ getTownDOStub: () => mocks }));
import { handleReauthorizeTownRuntime } from './town-runtime-authorization.handler';

function request(
  role: string | null,
  principal = {
    pepper: 'current',
    blockedAt: null as string | null,
    blockedReason: null,
    isAdmin: true,
  }
) {
  const rows = [[principal], role ? [{ role }] : []];
  mocks.select.mockImplementation(() => ({
    from: () => ({
      where: () => ({ limit: async () => rows.shift() }),
      innerJoin: () => ({ where: () => ({ limit: async () => rows.shift() }) }),
    }),
  }));
  const app = new Hono<GastownEnv>();
  app.post('/', c => {
    c.set('kiloUserId', 'admin');
    c.set('kiloIsAdmin', true);
    c.set('kiloApiTokenPepper', 'current');
    c.set('kiloControlToken', 'control');
    c.set('kiloOrgMemberships', [{ orgId: 'org', role: 'owner' }]);
    return handleReauthorizeTownRuntime(c, { townId: 'town' });
  });
  return app.request('/', { method: 'POST' }, {
    HYPERDRIVE: { connectionString: 'postgres://' },
  } as Env);
}

describe('modern org reauthorization uses current ownership even for admins', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.getTownIdentityState.mockResolvedValue({
      type: 'modern',
      identity: {
        ownerType: 'org',
        ownerUserId: 'creator',
        organizationId: 'org',
        runtimeMode: 'modern',
      },
    });
    mocks.reauthorizeRuntime.mockResolvedValue(true);
  });
  it('allows an admin who is currently an organization owner', async () => {
    expect((await request('owner')).status).toBe(200);
    expect(mocks.reauthorizeRuntime).toHaveBeenCalledWith('control', 'admin', 'org');
  });
  it.each([
    ['admin', 200],
    ['other-owner', 403],
  ])(
    'personal town owned by %s returns %i for admin reauthorization',
    async (ownerUserId, status) => {
      mocks.getTownIdentityState.mockResolvedValue({
        type: 'modern',
        identity: {
          ownerType: 'user',
          ownerUserId,
          runtimeMode: 'modern',
        },
      });
      expect((await request(null)).status).toBe(status);
      expect(mocks.reauthorizeRuntime).toHaveBeenCalledTimes(status === 200 ? 1 : 0);
    }
  );

  it.each(['member', 'billing_manager', null])(
    'denies admin with current role %j despite cached owner role',
    async role => {
      expect((await request(role)).status).toBe(403);
      expect(mocks.reauthorizeRuntime).not.toHaveBeenCalled();
    }
  );
  it.each([
    { pepper: 'rotated', blockedAt: null, blockedReason: null, isAdmin: true },
    { pepper: 'current', blockedAt: '2026-01-01', blockedReason: null, isAdmin: true },
  ])('rejects revoked or blocked admin owners', async principal => {
    expect((await request('owner', principal)).status).toBe(403);
    expect(mocks.reauthorizeRuntime).not.toHaveBeenCalled();
  });
});
