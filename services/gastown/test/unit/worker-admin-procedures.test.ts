import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createWorkerAdminAuthority,
  workerAdminBindingDigest,
  type WorkerAdminTarget,
} from '@kilocode/worker-utils/worker-admin-capability';

const getTownConfig = vi.fn();
const getTownAsync = vi.fn();
const getPersonalRig = vi.fn();
const getOrgRig = vi.fn();

vi.mock('../../src/dos/Town.do', () => ({
  getTownDOStub: () => ({
    getTownConfig,
    listAgents: async () => [],
    listBeads: async () => [],
    getRigAsync: async () => null,
  }),
}));
vi.mock('../../src/dos/TownContainer.do', () => ({
  getTownContainerStub: () => ({ fetch: vi.fn() }),
}));
vi.mock('../../src/dos/GastownUser.do', () => ({
  getGastownUserStub: () => ({ getTownAsync, getRigAsync: getPersonalRig }),
}));
vi.mock('../../src/dos/GastownOrg.do', () => ({
  getGastownOrgStub: () => ({ getRigAsync: getOrgRig }),
}));
vi.mock('../../src/middleware/worker-admin.middleware', async importOriginal => {
  const actual =
    await importOriginal<typeof import('../../src/middleware/worker-admin.middleware')>();
  return { ...actual, emitWorkerAdminDecision: vi.fn() };
});

import { gastownRouter } from '../../src/trpc/router';
import { router, type TRPCContext } from '../../src/trpc/init';

const wrapped = router({ gastown: gastownRouter });

const NOW = Math.floor(Date.now() / 1000);
const CALLER = 'caller-1';
const TOWN = '00000000-0000-4000-8000-000000000001';

async function authorityFor(
  actions: string[],
  target: WorkerAdminTarget = { kind: 'town', id: TOWN }
) {
  const { privateKey, publicKey } = await generateKeyPair('ES256', { extractable: true });
  const publicJwk = { ...(await exportJWK(publicKey)), kid: 'kid-1', alg: 'ES256', use: 'sig' };
  const token = await new SignJWT({
    iss: 'kilo-web',
    sub: CALLER,
    aud: 'gastown-admin',
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
    audience: 'gastown-admin',
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
    audience: 'gastown-admin',
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
  return wrapped.createCaller({
    env: {} as never,
    executionCtx: {} as never,
    userId: CALLER,
    workerAdmin,
    procedurePath: '',
    apiTokenPepper: 'pepper-1',
    gastownAccess: true,
    orgMemberships: [],
    ...overrides,
  } as TRPCContext);
}

beforeEach(() => {
  getTownConfig.mockReset();
  getTownAsync.mockReset();
  getPersonalRig.mockReset();
  getOrgRig.mockReset();
  getTownAsync.mockResolvedValue(null);
  getPersonalRig.mockResolvedValue(null);
  getOrgRig.mockResolvedValue(null);
  getTownConfig.mockResolvedValue({
    owner_type: 'org',
    organization_id: 'org-2',
    owner_user_id: null,
    name: 'Foreign town',
  });
});

describe('real gastown procedures respect the capability action allowlist', () => {
  it.each([
    [
      'sendMessage',
      (c: ReturnType<typeof caller>) => c.gastown.sendMessage({ townId: TOWN, message: 'hi' }),
    ],
    [
      'createPtySession',
      (c: ReturnType<typeof caller>) => c.gastown.createPtySession({ townId: TOWN, agentId: TOWN }),
    ],
  ])('%s is refused even when the capability names it', async (_name, invoke) => {
    const authority = await authorityFor([`trpc:gastown.${_name}`]);
    await expect(invoke(caller(authority))).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('rejects a rig from another town of a user-owned foreign town', async () => {
    const rigId = '00000000-0000-4000-8000-000000000010';
    getTownConfig.mockResolvedValue({
      owner_type: 'user',
      owner_user_id: 'owner-2',
      organization_id: null,
      name: 'Foreign town',
    });
    getPersonalRig
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: rigId, town_id: '00000000-0000-4000-8000-000000000011' });
    const authority = await authorityFor(['trpc:gastown.getRig'], {
      kind: 'town',
      id: TOWN,
    });
    await expect(caller(authority).gastown.getRig({ rigId, townId: TOWN })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('rejects a rig from another town of an org-owned foreign town', async () => {
    const rigId = '00000000-0000-4000-8000-000000000012';
    getOrgRig.mockResolvedValue({
      id: rigId,
      town_id: '00000000-0000-4000-8000-000000000013',
    });
    const authority = await authorityFor(['trpc:gastown.getRig'], {
      kind: 'town',
      id: TOWN,
    });
    await expect(caller(authority).gastown.getRig({ rigId, townId: TOWN })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('positive control: an allowlisted rig in the named town is returned', async () => {
    const rigId = '00000000-0000-4000-8000-000000000014';
    getTownConfig.mockResolvedValue({
      owner_type: 'org',
      organization_id: 'org-2',
      owner_user_id: null,
      name: 'Foreign town',
    });
    getOrgRig.mockResolvedValue({
      id: rigId,
      town_id: TOWN,
      name: 'rig',
      git_url: 'https://example.test/r.git',
      default_branch: 'main',
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    });
    const authority = await authorityFor(['trpc:gastown.getRig']);
    await expect(caller(authority).gastown.getRig({ rigId, townId: TOWN })).resolves.toMatchObject({
      id: rigId,
      town_id: TOWN,
    });
  });

  it('keeps an owner working in reject mode without a capability', async () => {
    getTownAsync.mockResolvedValue({
      id: TOWN,
      name: 'Own town',
      owner_user_id: CALLER,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    });
    await expect(
      caller(await noCapabilityAuthority()).gastown.checkAdminAccess({ townId: TOWN })
    ).resolves.toEqual({ isAdminViewing: false, ownerUserId: null, ownerOrgId: null });
  });

  it('keeps an org member working in reject mode without a capability', async () => {
    await expect(
      caller(await noCapabilityAuthority(), {
        orgMemberships: [{ orgId: 'org-2', role: 'member', name: 'org' }],
      }).gastown.checkAdminAccess({ townId: TOWN })
    ).resolves.toEqual({ isAdminViewing: false, ownerUserId: null, ownerOrgId: null });
  });

  it('positive control: an allowlisted read succeeds for the same foreign town', async () => {
    const authority = await authorityFor(['trpc:gastown.checkAdminAccess']);
    await expect(caller(authority).gastown.checkAdminAccess({ townId: TOWN })).resolves.toEqual({
      isAdminViewing: true,
      ownerUserId: null,
      ownerOrgId: 'org-2',
    });
  });
});
