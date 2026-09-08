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
  getTownConfig: vi.fn(),
  initializePrivateTownIdentity: vi.fn(),
  resolveLegacyTownTokenOwner: vi.fn(),
  generateKiloApiToken: vi.fn(),
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
    getTownConfig: mocks.getTownConfig,
    initializePrivateTownIdentity: mocks.initializePrivateTownIdentity,
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
vi.mock('../dos/town/legacy-token-renewal', () => ({
  LegacyTownTokenRenewalUnavailableError: class extends Error {},
  resolveLegacyTownTokenOwner: mocks.resolveLegacyTownTokenOwner,
}));
vi.mock('../util/kilo-token.util', () => ({ generateKiloApiToken: mocks.generateKiloApiToken }));
vi.mock('../util/secret.util', () => ({ resolveSecret: vi.fn(() => 'secret') }));

import { gastownRouter, resolveTownOwnership } from './router';
import { LegacyTownTokenRenewalUnavailableError } from '../dos/town/legacy-token-renewal';

const env = {} as Env;
env.NEXTAUTH_SECRET = {} as Env['NEXTAUTH_SECRET'];

const ctx = {
  env,
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

  it('does not mint or sync a legacy token when current authorization is revoked', async () => {
    mocks.getTownIdentityState.mockResolvedValue({
      type: 'legacy',
      identity: {
        ownerType: 'org',
        ownerUserId: 'owner-1',
        organizationId: 'org-1',
        runtimeMode: 'legacy',
      },
    });
    mocks.getTownAsync.mockResolvedValue(null);
    mocks.getTownConfig.mockResolvedValue({ owner_type: 'org', organization_id: 'org-1' });
    mocks.refreshRuntimeAuthorizationForManualRefresh.mockResolvedValue('legacy');
    mocks.resolveLegacyTownTokenOwner.mockResolvedValue(null);

    await expect(
      gastownRouter.createCaller(ctx).refreshContainerToken({
        townId: '00000000-0000-4000-8000-000000000001',
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.forceRefreshContainerToken).not.toHaveBeenCalled();
    expect(mocks.generateKiloApiToken).not.toHaveBeenCalled();
    expect(mocks.updateTownConfig).not.toHaveBeenCalled();
    expect(mocks.syncConfigToContainer).not.toHaveBeenCalled();
  });

  it('does not mint or sync a legacy token when authorization is unavailable', async () => {
    mocks.getTownIdentityState.mockResolvedValue({
      type: 'legacy',
      identity: {
        ownerType: 'org',
        ownerUserId: 'owner-1',
        organizationId: 'org-1',
        runtimeMode: 'legacy',
      },
    });
    mocks.getTownAsync.mockResolvedValue(null);
    mocks.getTownConfig.mockResolvedValue({ owner_type: 'org', organization_id: 'org-1' });
    mocks.refreshRuntimeAuthorizationForManualRefresh.mockResolvedValue('legacy');
    mocks.resolveLegacyTownTokenOwner.mockRejectedValue(
      new LegacyTownTokenRenewalUnavailableError()
    );

    await expect(
      gastownRouter.createCaller(ctx).refreshContainerToken({
        townId: '00000000-0000-4000-8000-000000000001',
      })
    ).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
    expect(mocks.forceRefreshContainerToken).not.toHaveBeenCalled();
    expect(mocks.generateKiloApiToken).not.toHaveBeenCalled();
    expect(mocks.updateTownConfig).not.toHaveBeenCalled();
    expect(mocks.syncConfigToContainer).not.toHaveBeenCalled();
  });

  it('mints a legacy org town token with the current owner pepper', async () => {
    mocks.getTownIdentityState.mockResolvedValue({
      type: 'legacy',
      identity: {
        ownerType: 'org',
        ownerUserId: 'owner-1',
        organizationId: 'org-1',
        runtimeMode: 'legacy',
      },
    });
    mocks.getTownAsync.mockResolvedValue(null);
    mocks.getTownConfig.mockResolvedValue({ owner_type: 'org', organization_id: 'org-1' });
    mocks.refreshRuntimeAuthorizationForManualRefresh.mockResolvedValue('legacy');
    mocks.resolveLegacyTownTokenOwner.mockResolvedValue({
      id: 'owner-1',
      api_token_pepper: 'owner-current',
    });
    mocks.generateKiloApiToken.mockResolvedValue('new-token');

    await expect(
      gastownRouter.createCaller(ctx).refreshContainerToken({
        townId: '00000000-0000-4000-8000-000000000001',
      })
    ).resolves.toBeUndefined();
    expect(mocks.forceRefreshContainerToken).toHaveBeenCalledOnce();
    expect(mocks.generateKiloApiToken).toHaveBeenCalledWith(
      { id: 'owner-1', api_token_pepper: 'owner-current' },
      'secret'
    );
    expect(mocks.updateTownConfig).toHaveBeenCalledWith({ kilocode_token: 'new-token' });
    expect(mocks.syncConfigToContainer).toHaveBeenCalledOnce();
  });

  it('migrates a personal legacy town before minting with its current owner pepper', async () => {
    const identity = {
      ownerType: 'user' as const,
      ownerUserId: 'cached-admin',
      createdByUserId: 'cached-admin',
      runtimeMode: 'legacy' as const,
    };
    mocks.getTownIdentityState
      .mockResolvedValueOnce({ type: 'legacy', identity: null })
      .mockResolvedValueOnce({ type: 'legacy', identity: null })
      .mockResolvedValueOnce({ type: 'legacy', identity });
    mocks.getTownAsync.mockResolvedValue({ id: 'town-1', owner_user_id: 'cached-admin' });
    mocks.refreshRuntimeAuthorizationForManualRefresh.mockResolvedValue('legacy');
    mocks.resolveLegacyTownTokenOwner.mockResolvedValue({
      id: 'cached-admin',
      api_token_pepper: 'owner-current',
    });
    mocks.generateKiloApiToken.mockResolvedValue('new-token');

    await expect(
      gastownRouter.createCaller(ctx).refreshContainerToken({
        townId: '00000000-0000-4000-8000-000000000001',
      })
    ).resolves.toBeUndefined();
    expect(mocks.initializePrivateTownIdentity).toHaveBeenCalledWith(identity);
    expect(mocks.resolveLegacyTownTokenOwner).toHaveBeenCalledWith(env, identity, {
      id: 'cached-admin',
      apiTokenPepper: 'pepper',
    });
    expect(mocks.generateKiloApiToken).toHaveBeenCalledWith(
      { id: 'cached-admin', api_token_pepper: 'owner-current' },
      'secret'
    );
  });

  it('migrates an org legacy town from its owner registry record', async () => {
    const identity = {
      ownerType: 'org' as const,
      ownerUserId: 'creator-1',
      organizationId: 'org-1',
      createdByUserId: 'creator-1',
      runtimeMode: 'legacy' as const,
    };
    mocks.getTownIdentityState
      .mockResolvedValueOnce({ type: 'legacy', identity: null })
      .mockResolvedValueOnce({ type: 'legacy', identity: null })
      .mockResolvedValueOnce({ type: 'legacy', identity });
    mocks.getTownAsync.mockResolvedValueOnce(null).mockResolvedValueOnce({
      id: 'town-1',
      owner_org_id: 'org-1',
      created_by_user_id: 'creator-1',
    });
    mocks.getTownConfig.mockResolvedValue({ owner_type: 'org', organization_id: 'org-1' });
    mocks.refreshRuntimeAuthorizationForManualRefresh.mockResolvedValue('legacy');
    mocks.resolveLegacyTownTokenOwner.mockResolvedValue({
      id: 'creator-1',
      api_token_pepper: 'owner-current',
    });
    mocks.generateKiloApiToken.mockResolvedValue('new-token');

    await expect(
      gastownRouter.createCaller(ctx).refreshContainerToken({
        townId: '00000000-0000-4000-8000-000000000001',
      })
    ).resolves.toBeUndefined();
    expect(mocks.initializePrivateTownIdentity).toHaveBeenCalledWith(identity);
    expect(mocks.generateKiloApiToken).toHaveBeenCalledWith(
      { id: 'creator-1', api_token_pepper: 'owner-current' },
      'secret'
    );
  });

  it.each([
    ['missing', null],
    ['mismatched', { id: 'town-1', owner_org_id: 'other-org', created_by_user_id: 'creator-1' }],
  ])('rejects a %s org owner registry record without minting', async (_kind, registryTown) => {
    mocks.getTownIdentityState
      .mockResolvedValueOnce({ type: 'legacy', identity: null })
      .mockResolvedValueOnce({ type: 'legacy', identity: null });
    mocks.getTownAsync.mockResolvedValueOnce(null).mockResolvedValueOnce(registryTown);
    mocks.getTownConfig.mockResolvedValue({ owner_type: 'org', organization_id: 'org-1' });
    mocks.refreshRuntimeAuthorizationForManualRefresh.mockResolvedValue('legacy');

    await expect(
      gastownRouter.createCaller(ctx).refreshContainerToken({
        townId: '00000000-0000-4000-8000-000000000001',
      })
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(mocks.initializePrivateTownIdentity).not.toHaveBeenCalled();
    expect(mocks.forceRefreshContainerToken).not.toHaveBeenCalled();
    expect(mocks.generateKiloApiToken).not.toHaveBeenCalled();
    expect(mocks.updateTownConfig).not.toHaveBeenCalled();
    expect(mocks.syncConfigToContainer).not.toHaveBeenCalled();
  });

  it('accepts an exact identity initialized concurrently', async () => {
    const identity = {
      ownerType: 'user' as const,
      ownerUserId: 'cached-admin',
      createdByUserId: 'cached-admin',
      runtimeMode: 'legacy' as const,
    };
    mocks.getTownIdentityState
      .mockResolvedValueOnce({ type: 'legacy', identity: null })
      .mockResolvedValueOnce({ type: 'legacy', identity: null })
      .mockResolvedValueOnce({ type: 'legacy', identity });
    mocks.getTownAsync.mockResolvedValue({ id: 'town-1', owner_user_id: 'cached-admin' });
    mocks.refreshRuntimeAuthorizationForManualRefresh.mockResolvedValue('legacy');
    mocks.initializePrivateTownIdentity.mockRejectedValue(new Error('already initialized'));
    mocks.resolveLegacyTownTokenOwner.mockResolvedValue({
      id: 'cached-admin',
      api_token_pepper: 'owner-current',
    });
    mocks.generateKiloApiToken.mockResolvedValue('new-token');

    await expect(
      gastownRouter.createCaller(ctx).refreshContainerToken({
        townId: '00000000-0000-4000-8000-000000000001',
      })
    ).resolves.toBeUndefined();
    expect(mocks.generateKiloApiToken).toHaveBeenCalledOnce();
  });

  it('rejects a concurrent mismatched identity without minting', async () => {
    mocks.getTownIdentityState
      .mockResolvedValueOnce({ type: 'legacy', identity: null })
      .mockResolvedValueOnce({ type: 'legacy', identity: null })
      .mockResolvedValueOnce({
        type: 'legacy',
        identity: {
          ownerType: 'user',
          ownerUserId: 'other-user',
          createdByUserId: 'other-user',
          runtimeMode: 'legacy',
        },
      });
    mocks.getTownAsync.mockResolvedValue({ id: 'town-1', owner_user_id: 'cached-admin' });
    mocks.refreshRuntimeAuthorizationForManualRefresh.mockResolvedValue('legacy');
    mocks.initializePrivateTownIdentity.mockRejectedValue(new Error('already initialized'));

    await expect(
      gastownRouter.createCaller(ctx).refreshContainerToken({
        townId: '00000000-0000-4000-8000-000000000001',
      })
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(mocks.resolveLegacyTownTokenOwner).not.toHaveBeenCalled();
    expect(mocks.forceRefreshContainerToken).not.toHaveBeenCalled();
    expect(mocks.generateKiloApiToken).not.toHaveBeenCalled();
    expect(mocks.updateTownConfig).not.toHaveBeenCalled();
    expect(mocks.syncConfigToContainer).not.toHaveBeenCalled();
  });
});
