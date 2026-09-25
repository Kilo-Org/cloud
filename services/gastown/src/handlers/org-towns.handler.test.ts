import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { GastownEnv } from '../gastown.worker';

const mocks = vi.hoisted(() => ({
  getTownAsync: vi.fn(),
  createRig: vi.fn(),
  getTownIdentityState: vi.fn(),
  authorizeOrganization: vi.fn(),
  configureRig: vi.fn(),
  addRig: vi.fn(),
}));

vi.mock('../dos/GastownOrg.do', () => ({
  getGastownOrgStub: () => ({ getTownAsync: mocks.getTownAsync, createRig: mocks.createRig }),
}));
vi.mock('../dos/Town.do', () => ({
  getTownDOStub: () => ({
    getTownIdentityState: mocks.getTownIdentityState,
    configureRig: mocks.configureRig,
    addRig: mocks.addRig,
  }),
}));
vi.mock('../util/town-authorization.util', () => ({
  authorizeOrganization: mocks.authorizeOrganization,
  TownAuthorizationUnavailableError: class extends Error {},
}));

import { handleCreateOrgRig, handleDeleteOrgTown } from './org-towns.handler';

describe('handleCreateOrgRig', () => {
  beforeEach(() => vi.resetAllMocks());

  function setup(
    kiloUsesModernToken: boolean,
    identity = { ownerType: 'org', organizationId: 'org-1', runtimeMode: 'modern' }
  ) {
    mocks.getTownAsync.mockResolvedValue({ id: 'town-1' });
    mocks.getTownIdentityState.mockResolvedValue({
      type: 'modern',
      identity: { ownerUserId: 'owner-1', ...identity },
    });
    mocks.createRig.mockResolvedValue({ id: 'rig-1' });
    const app = new Hono<GastownEnv>();
    app.post('/api/orgs/:orgId/rigs', c => {
      c.set('kiloUserId', 'user-1');
      c.set('kiloUsesModernToken', kiloUsesModernToken);
      c.set('kiloApiTokenPepper', 'current');
      c.set('orgRole', 'owner');
      return handleCreateOrgRig(c, c.req.param());
    });

    return app.request(
      '/api/orgs/org-1/rigs',
      {
        method: 'POST',
        body: JSON.stringify({
          town_id: 'town-1',
          name: 'rig',
          git_url: 'https://github.com/kilocode/example',
        }),
      },
      {} as Env
    );
  }

  it.each([
    ['a legacy bearer with a fresh membership', false],
    ['a modern bearer with a fresh membership', true],
    ['an admin with a fresh membership', true],
  ])('allows %s to mutate a modern town', async (_name, kiloUsesModernToken) => {
    mocks.authorizeOrganization.mockResolvedValue({ role: 'member' });
    const response = await setup(kiloUsesModernToken);

    expect(response.status).toBe(201);
    expect(mocks.createRig).toHaveBeenCalledOnce();
    expect(mocks.authorizeOrganization).toHaveBeenCalledWith(
      expect.anything(),
      'org-1',
      'user-1',
      'current'
    );
  });

  it('rejects a legacy bearer whose current membership was removed', async () => {
    mocks.authorizeOrganization.mockResolvedValue(null);
    const response = await setup(false);

    expect(response.status).toBe(403);
    expect(mocks.createRig).not.toHaveBeenCalled();
  });

  it('rejects a modern town belonging to another organization', async () => {
    const response = await setup(false, {
      ownerType: 'org',
      organizationId: 'org-2',
      runtimeMode: 'modern',
    });

    expect(response.status).toBe(403);
    expect(mocks.authorizeOrganization).not.toHaveBeenCalled();
  });

  it('uses the fresh target-town role for deletion', async () => {
    mocks.getTownAsync.mockResolvedValue({ id: 'town-1' });
    mocks.getTownIdentityState.mockResolvedValue({
      type: 'modern',
      identity: {
        ownerType: 'org',
        ownerUserId: 'owner-1',
        organizationId: 'org-1',
        runtimeMode: 'modern',
      },
    });
    mocks.authorizeOrganization.mockResolvedValue({ role: 'member' });
    const app = new Hono<GastownEnv>();
    app.delete('/api/orgs/:orgId/towns/:townId', c => {
      c.set('kiloUserId', 'user-1');
      c.set('kiloApiTokenPepper', 'current');
      c.set('orgRole', 'owner');
      return handleDeleteOrgTown(c, c.req.param());
    });

    const response = await app.request(
      '/api/orgs/org-1/towns/town-1',
      { method: 'DELETE' },
      {} as Env
    );

    expect(response.status).toBe(403);
    expect(mocks.createRig).not.toHaveBeenCalled();
  });
});
