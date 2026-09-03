import { describe, expect, it, vi } from 'vitest';
import type { TRPCContext } from './init';

const mocks = vi.hoisted(() => ({
  getPrivateTownIdentity: vi.fn(),
  getTownAsync: vi.fn(),
  authorizeTown: vi.fn(),
}));

vi.mock('cloudflare:workers', () => ({}));
vi.mock('../dos/Town.do', () => ({
  getTownDOStub: () => ({ getPrivateTownIdentity: mocks.getPrivateTownIdentity }),
}));
vi.mock('../dos/TownContainer.do', () => ({ getTownContainerStub: vi.fn() }));
vi.mock('../dos/GastownUser.do', () => ({
  getGastownUserStub: () => ({ getTownAsync: mocks.getTownAsync }),
}));
vi.mock('../dos/GastownOrg.do', () => ({
  getGastownOrgStub: () => ({ getTownAsync: mocks.getTownAsync }),
}));
vi.mock('../util/town-authorization.util', () => ({
  authorizeTown: mocks.authorizeTown,
  TownAuthorizationUnavailableError: class extends Error {},
}));

import { resolveTownOwnership } from './router';

const ctx = {
  env: {},
  executionCtx: {},
  userId: 'cached-admin',
  isAdmin: true,
  apiTokenPepper: 'pepper',
  gastownAccess: true,
  orgMemberships: [{ orgId: 'org-1', role: 'owner' }],
  controlToken: 'token',
} as TRPCContext;

describe('resolveTownOwnership', () => {
  it('rejects a stale cached admin for another modern town', async () => {
    mocks.getPrivateTownIdentity.mockResolvedValue({
      ownerType: 'user',
      ownerUserId: 'owner',
      runtimeMode: 'modern',
    });
    mocks.authorizeTown.mockResolvedValue(null);

    await expect(resolveTownOwnership(ctx.env, ctx, 'town-1')).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('allows a fresh active admin for a modern town', async () => {
    mocks.getPrivateTownIdentity.mockResolvedValue({
      ownerType: 'user',
      ownerUserId: 'owner',
      runtimeMode: 'modern',
    });
    mocks.authorizeTown.mockResolvedValue({ type: 'admin' });

    await expect(resolveTownOwnership(ctx.env, ctx, 'town-1')).resolves.toEqual({ type: 'admin' });
  });

  it('rejects a removed org member despite cached membership', async () => {
    mocks.getPrivateTownIdentity.mockResolvedValue({
      ownerType: 'org',
      ownerUserId: 'owner',
      organizationId: 'org-1',
      runtimeMode: 'modern',
    });
    mocks.authorizeTown.mockResolvedValue(null);

    await expect(resolveTownOwnership(ctx.env, ctx, 'town-1')).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });
});
