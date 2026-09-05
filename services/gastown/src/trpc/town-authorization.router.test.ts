import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TRPCContext } from './init';

const mocks = vi.hoisted(() => ({
  getTownIdentityState: vi.fn(),
  getTownAsync: vi.fn(),
  authorizeOrganization: vi.fn(),
  listTowns: vi.fn(),
  authorizeTown: vi.fn(),
  refreshRuntimeAuthorizationForManualRefresh: vi.fn(),
  forceRefreshContainerToken: vi.fn(),
  updateTownConfig: vi.fn(),
  syncConfigToContainer: vi.fn(),
}));

vi.mock('cloudflare:workers', () => ({}));
vi.mock('../dos/Town.do', () => ({
  getTownDOStub: () => ({
    getTownIdentityState: mocks.getTownIdentityState,
    requiresRuntimeAuthorization: vi.fn(),
    refreshRuntimeAuthorizationForManualRefresh: mocks.refreshRuntimeAuthorizationForManualRefresh,
    forceRefreshContainerToken: mocks.forceRefreshContainerToken,
    updateTownConfig: mocks.updateTownConfig,
    syncConfigToContainer: mocks.syncConfigToContainer,
  }),
}));
vi.mock('../dos/TownContainer.do', () => ({ getTownContainerStub: vi.fn() }));
vi.mock('../dos/GastownUser.do', () => ({
  getGastownUserStub: () => ({ getTownAsync: mocks.getTownAsync }),
}));
vi.mock('../dos/GastownOrg.do', () => ({
  getGastownOrgStub: () => ({ getTownAsync: mocks.getTownAsync, listTowns: mocks.listTowns }),
}));
vi.mock('../util/town-authorization.util', () => ({
  authorizeTown: mocks.authorizeTown,
  authorizeOrganization: mocks.authorizeOrganization,
  TownAuthorizationUnavailableError: class extends Error {},
}));

import { gastownRouter, resolveTownOwnership } from './router';

const ctx = {
  env: {},
  executionCtx: {},
  userId: 'cached-admin',
  isAdmin: true,
  apiTokenPepper: 'pepper',
  gastownAccess: true,
  orgMemberships: [{ orgId: 'org-1', role: 'owner' }],
  controlToken: 'token',
  usesModernToken: true,
} as TRPCContext;

describe('resolveTownOwnership', () => {
  beforeEach(() => vi.resetAllMocks());

  it('rejects a stale cached admin for another modern town', async () => {
    mocks.getTownIdentityState.mockResolvedValue({
      type: 'modern',
      identity: { ownerType: 'user', ownerUserId: 'owner', runtimeMode: 'modern' },
    });
    mocks.authorizeTown.mockResolvedValue(null);

    await expect(resolveTownOwnership(ctx.env, ctx, 'town-1')).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('allows a fresh active admin for a modern town', async () => {
    mocks.getTownIdentityState.mockResolvedValue({
      type: 'modern',
      identity: { ownerType: 'user', ownerUserId: 'owner', runtimeMode: 'modern' },
    });
    mocks.authorizeTown.mockResolvedValue({ type: 'admin' });

    await expect(resolveTownOwnership(ctx.env, ctx, 'town-1')).resolves.toEqual({ type: 'admin' });
  });

  it('rejects a removed org member despite cached membership', async () => {
    mocks.getTownIdentityState.mockResolvedValue({
      type: 'modern',
      identity: {
        ownerType: 'org',
        ownerUserId: 'owner',
        organizationId: 'org-1',
        runtimeMode: 'modern',
      },
    });
    mocks.authorizeTown.mockResolvedValue(null);

    await expect(resolveTownOwnership(ctx.env, ctx, 'town-1')).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('fails closed when persisted town authorization metadata is invalid', async () => {
    mocks.getTownIdentityState.mockResolvedValue({ type: 'invalid' });

    await expect(resolveTownOwnership(ctx.env, ctx, 'town-1')).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('uses current organization authorization for a legacy bearer collection read', async () => {
    mocks.authorizeOrganization.mockResolvedValue(null);
    const legacyCtx = { ...ctx, usesModernToken: false };

    await expect(
      gastownRouter.createCaller(legacyCtx).listOrgTowns({
        organizationId: '00000000-0000-4000-8000-000000000001',
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.authorizeOrganization).toHaveBeenCalledOnce();
    expect(mocks.listTowns).not.toHaveBeenCalled();
  });

  it('renews a modern runtime without legacy reminting', async () => {
    mocks.getTownIdentityState.mockResolvedValue({
      type: 'modern',
      identity: { ownerType: 'user', ownerUserId: 'cached-admin', runtimeMode: 'modern' },
    });
    mocks.authorizeTown.mockResolvedValue({ type: 'user' });
    mocks.getTownAsync.mockResolvedValue({ id: 'town-1', owner_user_id: 'cached-admin' });
    mocks.refreshRuntimeAuthorizationForManualRefresh.mockResolvedValue('renewed');

    await expect(
      gastownRouter.createCaller(ctx).refreshContainerToken({
        townId: '00000000-0000-4000-8000-000000000001',
      })
    ).resolves.toBeUndefined();
    expect(mocks.forceRefreshContainerToken).toHaveBeenCalledOnce();
    expect(mocks.updateTownConfig).not.toHaveBeenCalled();
    expect(mocks.syncConfigToContainer).not.toHaveBeenCalled();
  });

  it('rejects a revoked modern runtime before refreshing the container token', async () => {
    mocks.getTownIdentityState.mockResolvedValue({
      type: 'modern',
      identity: { ownerType: 'user', ownerUserId: 'cached-admin', runtimeMode: 'modern' },
    });
    mocks.authorizeTown.mockResolvedValue({ type: 'user' });
    mocks.getTownAsync.mockResolvedValue({ id: 'town-1', owner_user_id: 'cached-admin' });
    mocks.refreshRuntimeAuthorizationForManualRefresh.mockResolvedValue('revoked');

    await expect(
      gastownRouter.createCaller(ctx).refreshContainerToken({
        townId: '00000000-0000-4000-8000-000000000001',
      })
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(mocks.forceRefreshContainerToken).not.toHaveBeenCalled();
    expect(mocks.updateTownConfig).not.toHaveBeenCalled();
    expect(mocks.syncConfigToContainer).not.toHaveBeenCalled();
  });
});
