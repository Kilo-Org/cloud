import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SignJWT, jwtVerify } from 'jose';

const mocks = vi.hoisted(() => ({ userTown: vi.fn(), orgTown: vi.fn(), select: vi.fn() }));
vi.mock('cloudflare:workers', () => ({ DurableObject: class {}, WorkerEntrypoint: class {} }));
vi.mock('../TownContainer.do', () => ({
  getTownContainerStub: vi.fn(),
  getTownContainerDoId: vi.fn(),
}));
vi.mock('../GastownUser.do', () => ({
  getGastownUserStub: (_env: Env, id: string) => ({
    getTownAsync: (town: string) => mocks.userTown(id, town),
  }),
}));
vi.mock('../GastownOrg.do', () => ({
  getGastownOrgStub: (_env: Env, id: string) => ({
    getTownAsync: (town: string) => mocks.orgTown(id, town),
  }),
}));
vi.mock('@kilocode/db/client', () => ({ getWorkerDb: () => ({ select: mocks.select }) }));

import { TownDO } from '../Town.do';
import * as config from './config';
import {
  getTownIdentityState,
  initializePrivateTownIdentity,
  TOWN_IDENTITY_KEY,
  RUNTIME_AUTHORIZATION_KEY,
} from './runtime-authorization';

const secret = 'synthetic-test-secret';
const env = {
  NEXTAUTH_SECRET: secret,
  HYPERDRIVE: { connectionString: 'postgres://test' },
} as unknown as Env;
const identity = {
  ownerType: 'user' as const,
  ownerUserId: 'oauth/user-1',
  createdByUserId: 'oauth/user-1',
  runtimeMode: 'legacy' as const,
};
const registryRow = {
  id: 'town-1',
  name: 'Old town',
  owner_user_id: identity.ownerUserId,
  owner_org_id: 'org-1',
  created_by_user_id: identity.ownerUserId,
  created_at: '2025-01-01',
  updated_at: '2025-01-01',
};

function storage() {
  const values = new Map<string, unknown>();
  let queue = Promise.resolve();
  const store = {
    get: async (key: string) => structuredClone(values.get(key)),
    put: async (key: string, value: unknown) => {
      values.set(key, structuredClone(value));
    },
    transaction: <T>(fn: (txn: DurableObjectTransaction) => Promise<T>) => {
      const result = queue.then(() => fn(store as unknown as DurableObjectTransaction));
      queue = result.then(
        () => undefined,
        () => undefined
      );
      return result;
    },
  } as unknown as DurableObjectStorage;
  return store;
}

async function token(extra: Record<string, unknown> = {}, signingSecret = secret) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    version: 3,
    kiloUserId: identity.ownerUserId,
    apiTokenPepper: 'current',
    iat: now - 29 * 86400,
    exp: now + 86400,
    ...extra,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .sign(new TextEncoder().encode(signingSecret));
}

async function town(org = false, bearer?: string) {
  const store = storage();
  const oldToken = bearer ?? (await token());
  // Pre-PR state: town ID and mutable configuration, neither private key.
  await store.put('town:id', 'town-1');
  await store.put('town:config', {
    kilocode_token: oldToken,
    ...(org
      ? {
          owner_type: 'org',
          owner_id: 'org-1',
          organization_id: 'org-1',
          owner_user_id: identity.ownerUserId,
          created_by_user_id: identity.ownerUserId,
        }
      : { owner_user_id: identity.ownerUserId }),
  });
  const sync = vi.fn();
  // Invoke the actual method called by the unattended alarm, without creating
  // the unrelated scheduler SQL/container runtime or using a tRPC/UI refresh.
  const instance = Object.create(TownDO.prototype) as TownDO;
  Object.assign(instance, {
    ctx: { storage: store },
    env,
    _townId: 'town-1',
    lastKilocodeTokenCheckAt: 0,
    syncConfigToContainer: sync,
  });
  const renew = () => instance['refreshKilocodeTokenIfExpiring']();
  return { store, oldToken, sync, renew, instance };
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.userTown.mockResolvedValue(registryRow);
  mocks.orgTown.mockResolvedValue(registryRow);
  mocks.select.mockImplementation(() => ({
    from: () => ({
      where: () => ({
        limit: async () => [{ pepper: 'current', blockedAt: null, blockedReason: null }],
      }),
      innerJoin: () => ({ where: () => ({ limit: async () => [{ role: 'owner' }] }) }),
    }),
  }));
});

describe('unattended legacy town renewal entry', () => {
  it.each([false, true])(
    'adopts and renews a pre-PR town (org=%s) without UI refresh',
    async org => {
      const t = await town(org);
      await t.renew();
      expect(await getTownIdentityState(t.store, 'town-1')).toEqual({
        type: 'legacy',
        identity: org ? { ...identity, ownerType: 'org', organizationId: 'org-1' } : identity,
      });
      const renewed = (await config.getTownConfig(t.store)).kilocode_token;
      expect(renewed).not.toBe(t.oldToken);
      const { payload } = await jwtVerify(renewed!, new TextEncoder().encode(secret));
      expect(payload.kiloUserId).toBe(identity.ownerUserId);
      expect(payload.apiTokenPepper).toBe('current');
      expect(payload.exp! - payload.iat!).toBe(30 * 86400);
      expect(org ? mocks.orgTown : mocks.userTown).toHaveBeenCalledWith(
        org ? 'org-1' : identity.ownerUserId,
        'town-1'
      );
      expect(t.sync).toHaveBeenCalledOnce();
    }
  );

  it.each([false, true])('recovers an expired registry-bound legacy token (org=%s)', async org => {
    const t = await town(org, await token({ exp: Math.floor(Date.now() / 1000) - 86400 }));
    await t.renew();
    expect(t.sync).toHaveBeenCalledOnce();
  });

  it.each([
    null,
    { ...registryRow, id: 'another-town' },
    { ...registryRow, owner_user_id: 'another-user' },
  ])('rejects absent or mismatched personal registry ownership: %j', async row => {
    mocks.userTown.mockResolvedValue(row);
    const t = await town();
    await t.renew();
    expect(await t.store.get(TOWN_IDENTITY_KEY)).toBeUndefined();
    expect(t.sync).not.toHaveBeenCalled();
  });

  it.each([
    null,
    { ...registryRow, owner_org_id: 'another-org' },
    { ...registryRow, created_by_user_id: '' },
    { ...registryRow, created_by_user_id: 'another-member' },
  ])('rejects absent or mismatched org ownership: %j', async row => {
    mocks.orgTown.mockResolvedValue(row);
    const t = await town(true);
    await t.renew();
    expect(await t.store.get(TOWN_IDENTITY_KEY)).toBeUndefined();
    expect(t.sync).not.toHaveBeenCalled();
  });

  it.each([
    { env: 'development' },
    { env: 'production' },
    { aud: 'kilo-api' },
    { tokenPurpose: 'delegated-workload', credentialExchange: false },
    { credentialExchange: false },
    { botId: 'bot' },
    { organizationId: 'org-1' },
    { runtimeAuthorization: {} },
    { deviceSessionId: 'device' },
    { gastownAccess: true },
    { nbf: Math.floor(Date.now() / 1000) + 86400 },
    { iat: Math.floor(Date.now() / 1000) + 100 },
    { apiTokenPepper: null },
    { apiTokenPepper: 'rotated' },
  ])('does not launder token claims %j', async claims => {
    const t = await town(false, await token(claims));
    await t.renew();
    expect(await t.store.get(TOWN_IDENTITY_KEY)).toBeUndefined();
    expect(t.sync).not.toHaveBeenCalled();
  });

  it('rejects a forged expired token', async () => {
    const t = await town(false, await token({ exp: 1 }, 'wrong-secret'));
    await t.renew();
    expect(t.sync).not.toHaveBeenCalled();
    expect(mocks.userTown).not.toHaveBeenCalled();
  });

  it.each([
    { rows: [] },
    { rows: [{ pepper: 'new', blockedAt: null, blockedReason: null }] },
    { rows: [{ pepper: 'current', blockedAt: '2026-01-01', blockedReason: null }] },
    { rows: [{ pepper: 'current', blockedAt: null, blockedReason: 'abuse' }] },
  ])('rejects current account revocation %j', async ({ rows }) => {
    mocks.select.mockReturnValue({ from: () => ({ where: () => ({ limit: async () => rows }) }) });
    const t = await town();
    await t.renew();
    expect(await t.store.get(TOWN_IDENTITY_KEY)).toBeUndefined();
    expect(t.sync).not.toHaveBeenCalled();
  });

  it.each([{ rows: [] }, { rows: [{ role: 'billing_manager' }] }])(
    'rejects removed/deleted-org or ineligible membership %j',
    async ({ rows }) => {
      mocks.select.mockReturnValue({
        from: () => ({
          where: () => ({
            limit: async () => [{ pepper: 'current', blockedAt: null, blockedReason: null }],
          }),
          innerJoin: () => ({ where: () => ({ limit: async () => rows }) }),
        }),
      });
      const t = await town(true);
      await t.renew();
      expect(await t.store.get(TOWN_IDENTITY_KEY)).toBeUndefined();
      expect(t.sync).not.toHaveBeenCalled();
    }
  );

  it.each(['registry', 'database'])(
    'retries a transient %s failure on the next alarm',
    async authority => {
      if (authority === 'registry') mocks.userTown.mockRejectedValueOnce(new Error('unavailable'));
      else
        mocks.select.mockImplementationOnce(() => {
          throw new Error('unavailable');
        });
      const t = await town();
      await t.renew();
      expect(await t.store.get(TOWN_IDENTITY_KEY)).toBeUndefined();
      expect(t.sync).not.toHaveBeenCalled();
      await t.renew();
      expect(t.sync).toHaveBeenCalledOnce();
    }
  );

  it.each([
    null,
    false,
    {},
    { ...identity, runtimeMode: 'modern', ownerUserId: '' },
    { ...identity, runtimeMode: 'modern' },
  ])('never adopts over invalid or modern identity %j', async stored => {
    const t = await town();
    await t.store.put(TOWN_IDENTITY_KEY, stored);
    await t.renew();
    expect(await t.store.get(TOWN_IDENTITY_KEY)).toEqual(stored);
    expect(t.sync).not.toHaveBeenCalled();
  });

  it.each(['active', 'revoked'])('does not replace modern %s authorization', async state => {
    const t = await town();
    await t.store.put(TOWN_IDENTITY_KEY, { ...identity, runtimeMode: 'modern' });
    await t.store.put(RUNTIME_AUTHORIZATION_KEY, {
      version: 1,
      id: '00000000-0000-4000-8000-000000000001',
      resourceKind: 'gastown',
      resourceId: 'town-1',
      userId: identity.ownerUserId,
      authorizationUserId: identity.ownerUserId,
      issuedAt: '2026-01-01T00:00:00.000Z',
      delegationExpiresAt: '2026-01-31T00:00:00.000Z',
      state,
      bindings: { userPepperDigest: 'a'.repeat(64), authorizationPepperDigest: 'a'.repeat(64) },
      source: { admissionSource: 'user' },
    });
    expect((await getTownIdentityState(t.store, 'town-1')).type).toBe('modern');
    await t.renew();
    expect(t.sync).not.toHaveBeenCalled();
    expect(mocks.select).not.toHaveBeenCalled();
  });

  it('does not overwrite a concurrent modern adoption', async () => {
    const t = await town();
    mocks.userTown.mockImplementationOnce(async () => {
      await initializePrivateTownIdentity(t.store, { ...identity, runtimeMode: 'modern' });
      return registryRow;
    });
    await t.renew();
    expect((await getTownIdentityState(t.store, 'town-1')).type).toBe('modern');
    expect(t.sync).not.toHaveBeenCalled();
    expect((await config.getTownConfig(t.store)).kilocode_token).toBe(t.oldToken);
  });

  it('fences a concurrent token edit', async () => {
    const t = await town();
    mocks.userTown.mockImplementationOnce(async () => {
      await config.updateTownConfig(t.store, { kilocode_token: 'replacement' });
      return registryRow;
    });
    await t.renew();
    expect(t.sync).not.toHaveBeenCalled();
    expect(await t.store.get(TOWN_IDENTITY_KEY)).toBeUndefined();
  });

  it('does not overwrite a concurrent legacy adoption', async () => {
    const t = await town();
    const competingIdentity = {
      ...identity,
      ownerUserId: 'another-user',
      createdByUserId: 'another-user',
    };
    mocks.userTown.mockImplementationOnce(async () => {
      await initializePrivateTownIdentity(t.store, competingIdentity);
      return registryRow;
    });
    await t.renew();
    expect(await t.store.get(TOWN_IDENTITY_KEY)).toEqual(competingIdentity);
    expect(t.sync).not.toHaveBeenCalled();
    expect((await config.getTownConfig(t.store)).kilocode_token).toBe(t.oldToken);
  });

  it('retains the daily throttle after a completed check', async () => {
    const t = await town();
    await t.renew();
    await t.renew();
    expect(t.sync).toHaveBeenCalledOnce();
    expect(mocks.select).toHaveBeenCalledOnce();
  });

  it('rejects a stale owner token even after private identity adoption', async () => {
    const t = await town();
    await initializePrivateTownIdentity(t.store, identity);
    mocks.select.mockReturnValue({
      from: () => ({
        where: () => ({
          limit: async () => [{ pepper: 'rotated', blockedAt: null, blockedReason: null }],
        }),
      }),
    });
    await t.renew();
    expect(t.sync).not.toHaveBeenCalled();
    expect((await config.getTownConfig(t.store)).kilocode_token).toBe(t.oldToken);
  });

  it('coalesces concurrent unattended calls into one adoption and renewal', async () => {
    const t = await town();
    await Promise.all([t.renew(), t.renew()]);
    expect(t.sync).toHaveBeenCalledOnce();
    expect(mocks.userTown).toHaveBeenCalledOnce();
  });
});
