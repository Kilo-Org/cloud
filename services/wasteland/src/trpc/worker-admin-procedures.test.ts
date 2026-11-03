import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createWorkerAdminAuthority,
  workerAdminBindingDigest,
  type WorkerAdminTarget,
} from '@kilocode/worker-utils/worker-admin-capability';

const getConfig = vi.fn();
const listAll = vi.fn();
const unregister = vi.fn();

vi.mock('../dos/Wasteland.do', () => ({
  getWastelandDOStub: () => ({ getConfig, updateConfig: vi.fn(), listMembers: vi.fn() }),
}));
vi.mock('../dos/WastelandRegistry.do', () => ({
  getWastelandRegistryStub: () => ({ listAll, unregister }),
}));

import { wastelandRouter } from './router';
import { router, type TRPCContext } from './init';

const wrapped = router({ wasteland: wastelandRouter });

const NOW = Math.floor(Date.now() / 1000);
const CALLER = 'caller-1';
const WASTELAND = '00000000-0000-4000-8000-000000000002';

async function authorityFor(actions: string[], target: WorkerAdminTarget) {
  const { privateKey, publicKey } = await generateKeyPair('ES256', { extractable: true });
  const publicJwk = { ...(await exportJWK(publicKey)), kid: 'kid-1', alg: 'ES256', use: 'sig' };
  const token = await new SignJWT({
    iss: 'kilo-web',
    sub: CALLER,
    aud: 'wasteland-admin',
    env: 'test',
    iat: NOW,
    nbf: NOW,
    exp: NOW + 300,
    jti: `jti-${actions.join('-')}`,
    cap: { v: 1, actions, targets: [target] },
    bnd: {
      pep: await workerAdminBindingDigest('pepper-1'),
      wsp: await workerAdminBindingDigest(''),
    },
  })
    .setProtectedHeader({ alg: 'ES256', typ: 'kilo-worker-cap+jwt', kid: 'kid-1' })
    .sign(privateKey);

  return createWorkerAdminAuthority({
    mode: 'reject',
    audience: 'wasteland-admin',
    identity: { kiloUserId: CALLER, apiTokenPepper: 'pepper-1', env: 'test' },
    legacyClaim: false,
    capabilityToken: token,
    jwks: { keys: [publicJwk] },
    introspect: async () => ({ active: true }),
    now: () => NOW * 1000,
  });
}

async function noCapabilityAuthority() {
  return createWorkerAdminAuthority({
    mode: 'reject',
    audience: 'wasteland-admin',
    identity: { kiloUserId: CALLER, apiTokenPepper: 'pepper-1', env: 'test' },
    legacyClaim: false,
    capabilityToken: null,
    jwks: null,
    introspect: async () => ({ active: true }),
    now: () => NOW * 1000,
  });
}

function caller(
  workerAdmin: Awaited<ReturnType<typeof authorityFor>>,
  overrides: Partial<TRPCContext> = {}
) {
  const ctx: TRPCContext = {
    env: {} as never,
    userId: CALLER,
    workerAdmin,
    procedurePath: '',
    legacyClaimLifetimeSeconds: null,
    apiTokenPepper: 'pepper-1',
    orgMemberships: [],
    ...overrides,
  };
  return wrapped.createCaller(ctx);
}

beforeEach(() => {
  getConfig.mockReset();
  listAll.mockReset();
  unregister.mockReset();
  getConfig.mockResolvedValue({
    wasteland_id: WASTELAND,
    name: 'Foreign wasteland',
    owner_type: 'org',
    owner_user_id: null,
    organization_id: 'org-2',
    dolthub_upstream: 'org/repo',
    visibility: 'public',
    status: 'active',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  });
});

describe('real wasteland procedures respect the capability action allowlist', () => {
  it('deleteWasteland is refused even when the capability names it', async () => {
    const authority = await authorityFor(['trpc:wasteland.deleteWasteland'], {
      kind: 'wasteland',
      id: WASTELAND,
    });
    await expect(
      caller(authority).wasteland.deleteWasteland({ wastelandId: WASTELAND })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(unregister).not.toHaveBeenCalled();
  });

  it('positive control: an allowlisted read succeeds for the same foreign wasteland', async () => {
    const authority = await authorityFor(['trpc:wasteland.getWasteland'], {
      kind: 'wasteland',
      id: WASTELAND,
    });
    await expect(
      caller(authority).wasteland.getWasteland({ wastelandId: WASTELAND })
    ).resolves.toMatchObject({ name: 'Foreign wasteland' });
  });

  it('requireOwnerAccess rejects a non-owner org member', async () => {
    await expect(
      caller(await noCapabilityAuthority(), {
        orgMemberships: [{ orgId: 'org-2', role: 'member' }],
      }).wasteland.addMember({ wastelandId: WASTELAND, userId: 'user-9' })
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: expect.stringContaining('Only wasteland owners'),
    });
    expect(unregister).not.toHaveBeenCalled();
  });

  it('adminListWastelands rejects a capability scoped to one wasteland', async () => {
    const authority = await authorityFor(['trpc:wasteland.adminListWastelands'], {
      kind: 'wasteland',
      id: WASTELAND,
    });
    await expect(caller(authority).wasteland.adminListWastelands()).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(listAll).not.toHaveBeenCalled();
  });

  it('adminListWastelands requires a service-scoped capability', async () => {
    const authority = await authorityFor(['trpc:wasteland.adminListWastelands'], {
      kind: 'service',
      id: 'wasteland',
    });
    listAll.mockResolvedValue([{ wasteland_id: WASTELAND }]);
    await expect(caller(authority).wasteland.adminListWastelands()).resolves.toEqual([
      expect.objectContaining({ name: 'Foreign wasteland' }),
    ]);
  });
});
