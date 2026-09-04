import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Jose from 'jose';
import type * as RuntimeAuthorizationModule from '@kilocode/worker-utils/runtime-authorization';

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  renew: vi.fn(),
  getState: vi.fn(),
  updateConfig: vi.fn(),
}));

vi.mock('@kilocode/worker-utils/runtime-authorization', async importOriginal => {
  const actual = await importOriginal<typeof RuntimeAuthorizationModule>();
  return {
    ...actual,
    createRuntimeAuthorization: mocks.create,
    renewRuntimeAuthorization: mocks.renew,
  };
});
vi.mock('jose', async importOriginal => {
  const actual = await importOriginal<typeof Jose>();
  return { ...actual, decodeJwt: vi.fn(() => ({ tokenPurpose: 'human-api' })) };
});
vi.mock('../TownContainer.do', () => ({
  getTownContainerStub: () => ({ getState: mocks.getState }),
}));
vi.mock('./config', () => ({ updateTownConfig: mocks.updateConfig }));
vi.mock('../../util/secret.util', () => ({ resolveSecret: vi.fn(() => 'secret') }));

import {
  createRuntimeAuthorization,
  getPrivateTownIdentity,
  getRuntimeAuthorizationState,
  getTownIdentityState,
  initializePrivateTownIdentity,
  RUNTIME_AUTHORIZATION_KEY,
  reauthorizeRuntime,
  requiresRuntimeAuthorization,
  renewRuntimeAuthorization,
} from './runtime-authorization';
import { RuntimeAuthorizationRevokedError } from '@kilocode/worker-utils/runtime-authorization';
import { RuntimeAuthorizationExpiredError } from '@kilocode/worker-utils/runtime-authorization';

type TestStorage = DurableObjectStorage & { putMock: ReturnType<typeof vi.fn> };

function storage(): TestStorage {
  const values = new Map<string, unknown>();
  const put = vi.fn(async (key: string, value: unknown) => values.set(key, value));
  return {
    get: vi.fn(async <T>(key: string) => values.get(key) as T),
    put,
    putMock: put,
  } as unknown as TestStorage;
}

const identity = {
  ownerType: 'user' as const,
  ownerUserId: 'user-1',
  createdByUserId: 'user-1',
  runtimeMode: 'legacy' as const,
};

function authorization(state: 'active' | 'revoked' = 'active') {
  return {
    version: 1 as const,
    id: '00000000-0000-4000-8000-000000000001',
    resourceKind: 'gastown' as const,
    resourceId: 'town-1',
    userId: 'user-1',
    authorizationUserId: 'user-1',
    issuedAt: '2026-01-01T00:00:00.000Z',
    delegationExpiresAt: '2026-01-31T00:00:00.000Z',
    state,
    bindings: {
      userPepperDigest: 'a'.repeat(64),
      authorizationPepperDigest: 'a'.repeat(64),
    },
    source: { admissionSource: 'user' as const },
  };
}

function context(store: DurableObjectStorage) {
  return {
    storage: store,
    env: {
      NEXTAUTH_SECRET: 'secret',
      HYPERDRIVE: { connectionString: 'postgres://' },
    } as unknown as Env,
    townId: 'town-1',
    hasActiveWork: () => false,
    updateTownConfig: mocks.updateConfig,
  };
}

describe('runtime authorization persistence', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.updateConfig.mockResolvedValue({});
    mocks.getState.mockResolvedValue({ status: 'stopped' });
  });

  it('persists and reads the private town identity', async () => {
    const store = storage();
    await initializePrivateTownIdentity(store, identity);

    await expect(getPrivateTownIdentity(store, 'town-1')).resolves.toEqual(identity);
    expect(mocks.updateConfig).toHaveBeenCalledWith(
      store,
      expect.objectContaining({ owner_user_id: 'user-1' })
    );
  });

  it('requires runtime authorization when a persisted record lacks a valid identity', async () => {
    const store = storage();
    await store.put(RUNTIME_AUTHORIZATION_KEY, { malformed: true });

    await expect(requiresRuntimeAuthorization(store, 'town-1')).resolves.toBe(true);
  });

  it.each([
    ['a malformed identity', { malformed: true }, undefined],
    ['a runtime authorization without identity', undefined, authorization()],
    ['a legacy identity with a runtime authorization', identity, authorization()],
  ])('classifies %s as invalid rather than legacy', async (_name, privateIdentity, runtime) => {
    const store = storage();
    if (privateIdentity !== undefined) await store.put('town:private:identity', privateIdentity);
    if (runtime !== undefined) await store.put(RUNTIME_AUTHORIZATION_KEY, runtime);

    await expect(getTownIdentityState(store, 'town-1')).resolves.toEqual({ type: 'invalid' });
  });

  it('classifies a valid identity without runtime authorization as legacy', async () => {
    const store = storage();
    await initializePrivateTownIdentity(store, identity);

    await expect(getTownIdentityState(store, 'town-1')).resolves.toEqual({
      type: 'legacy',
      identity,
    });
  });

  it('requires runtime authorization for a modern identity without a stored record', async () => {
    const store = storage();
    await initializePrivateTownIdentity(store, { ...identity, runtimeMode: 'modern' });

    await expect(requiresRuntimeAuthorization(store, 'town-1')).resolves.toBe(true);
  });

  it.each([
    ['resource kind', { resourceKind: 'cloud-agent-next' }],
    ['resource ID', { resourceId: 'another-town' }],
    ['organization', { organizationId: 'org-2' }],
    ['runtime user', { userId: 'another-user' }],
    ['authorization user', { authorizationUserId: 'another-user' }],
  ])('rejects a modern authorization with the wrong %s binding', async (_name, update) => {
    const store = storage();
    await initializePrivateTownIdentity(store, { ...identity, runtimeMode: 'modern' });
    await store.put(RUNTIME_AUTHORIZATION_KEY, { ...authorization(), ...update });

    await expect(getTownIdentityState(store, 'town-1')).resolves.toEqual({ type: 'invalid' });
  });

  it('renews an active authorization and retains active state', async () => {
    const store = storage();
    await store.put(RUNTIME_AUTHORIZATION_KEY, authorization());
    mocks.renew.mockResolvedValue({ token: 'runtime-token' });

    await expect(renewRuntimeAuthorization(context(store))).resolves.toBe('runtime-token');
    await expect(getRuntimeAuthorizationState(store)).resolves.toBe('active');
    expect(mocks.updateConfig).toHaveBeenCalledWith({ kilocode_token: 'runtime-token' });
  });

  it('persists revoked state and does not return a replacement token', async () => {
    const store = storage();
    await store.put(RUNTIME_AUTHORIZATION_KEY, authorization());
    mocks.renew.mockRejectedValue(new RuntimeAuthorizationRevokedError());

    await expect(renewRuntimeAuthorization(context(store))).resolves.toBeUndefined();
    await expect(getRuntimeAuthorizationState(store)).resolves.toBe('revoked');
    expect(mocks.updateConfig).not.toHaveBeenCalled();
  });

  it('persists expiry as revoked without updating the town token', async () => {
    const store = storage();
    await store.put(RUNTIME_AUTHORIZATION_KEY, authorization());
    mocks.renew.mockRejectedValue(new RuntimeAuthorizationExpiredError());

    await expect(renewRuntimeAuthorization(context(store))).resolves.toBeUndefined();
    await expect(getRuntimeAuthorizationState(store)).resolves.toBe('revoked');
    expect(mocks.updateConfig).not.toHaveBeenCalled();
  });

  it('does not revoke a newer authorization when an in-flight renewal is rejected', async () => {
    const store = storage();
    const oldAuthorization = authorization();
    const replacementAuthorization = {
      ...authorization(),
      id: '00000000-0000-4000-8000-000000000002',
    };
    await store.put(RUNTIME_AUTHORIZATION_KEY, oldAuthorization);
    let rejectRenewal: (error: Error) => void = () => undefined;
    mocks.renew.mockImplementation(
      () => new Promise((_resolve, reject) => (rejectRenewal = reject))
    );

    const renewal = renewRuntimeAuthorization(context(store));
    await vi.waitFor(() => expect(mocks.renew).toHaveBeenCalledOnce());
    await store.put(RUNTIME_AUTHORIZATION_KEY, replacementAuthorization);
    rejectRenewal(new RuntimeAuthorizationRevokedError());

    await expect(renewal).resolves.toBeUndefined();
    await expect(getRuntimeAuthorizationState(store)).resolves.toBe('active');
    expect(store.putMock).not.toHaveBeenCalledWith(
      RUNTIME_AUTHORIZATION_KEY,
      expect.objectContaining({ id: oldAuthorization.id, state: 'revoked' })
    );
  });

  it('reauthorizes only a stopped town with a revoked authorization', async () => {
    const store = storage();
    await initializePrivateTownIdentity(store, { ...identity, runtimeMode: 'modern' });
    await store.put(RUNTIME_AUTHORIZATION_KEY, authorization('revoked'));
    mocks.create.mockResolvedValue({
      authorization: {
        ...authorization(),
        id: '00000000-0000-4000-8000-000000000002',
        issuedAt: '2026-02-01T00:00:00.000Z',
        delegationExpiresAt: '2026-03-03T00:00:00.000Z',
      },
      token: 'replacement-token',
    });

    await expect(reauthorizeRuntime(context(store), 'control-token', 'user-1')).resolves.toBe(true);
    await expect(getRuntimeAuthorizationState(store)).resolves.toBe('active');
    expect(await store.get<unknown>(RUNTIME_AUTHORIZATION_KEY)).toMatchObject({
      id: '00000000-0000-4000-8000-000000000002',
      delegationExpiresAt: '2026-03-03T00:00:00.000Z',
    });
  });

  it('reauthorizes an active authorization exactly at its delegation deadline', async () => {
    const store = storage();
    const expiredAuthorization = authorization();
    await initializePrivateTownIdentity(store, { ...identity, runtimeMode: 'modern' });
    await store.put(RUNTIME_AUTHORIZATION_KEY, expiredAuthorization);
    mocks.create.mockResolvedValue({
      authorization: { ...authorization(), id: '00000000-0000-4000-8000-000000000002' },
      token: 'replacement-token',
    });

    await expect(
      reauthorizeRuntime(
        { ...context(store), now: () => new Date(expiredAuthorization.delegationExpiresAt) },
        'control-token',
        'user-1'
      )
    ).resolves.toBe(true);
    expect(await store.get<unknown>(RUNTIME_AUTHORIZATION_KEY)).toMatchObject({
      id: '00000000-0000-4000-8000-000000000002',
      state: 'active',
    });
  });

  it('does not replace a nonexpired active authorization', async () => {
    const store = storage();
    await initializePrivateTownIdentity(store, { ...identity, runtimeMode: 'modern' });
    await store.put(RUNTIME_AUTHORIZATION_KEY, authorization());

    await expect(
      reauthorizeRuntime(
        { ...context(store), now: () => new Date('2026-01-30T23:59:59.999Z') },
        'control-token',
        'user-1'
      )
    ).resolves.toBe(false);
    expect(mocks.create).not.toHaveBeenCalled();
    await expect(getRuntimeAuthorizationState(store)).resolves.toBe('active');
  });

  it('does not revoke or replace a newer authorization during expiry reauthorization', async () => {
    const store = storage();
    const expiredAuthorization = authorization();
    const replacementAuthorization = {
      ...authorization(),
      id: '00000000-0000-4000-8000-000000000002',
    };
    await initializePrivateTownIdentity(store, { ...identity, runtimeMode: 'modern' });
    await store.put(RUNTIME_AUTHORIZATION_KEY, expiredAuthorization);
    let resolveState: (state: { status: string }) => void = () => undefined;
    mocks.getState.mockImplementation(() => new Promise(resolve => (resolveState = resolve)));

    const reauthorization = reauthorizeRuntime(
      { ...context(store), now: () => new Date(expiredAuthorization.delegationExpiresAt) },
      'control-token',
      'user-1'
    );
    await vi.waitFor(() => expect(mocks.getState).toHaveBeenCalledOnce());
    await store.put(RUNTIME_AUTHORIZATION_KEY, replacementAuthorization);
    resolveState({ status: 'stopped' });

    await expect(reauthorization).resolves.toBe(false);
    expect(mocks.create).not.toHaveBeenCalled();
    await expect(getRuntimeAuthorizationState(store)).resolves.toBe('active');
  });

  it('refuses reauthorization while the town has active work', async () => {
    const store = storage();
    await initializePrivateTownIdentity(store, identity);
    await store.put(RUNTIME_AUTHORIZATION_KEY, authorization('revoked'));

    await expect(
      reauthorizeRuntime(
        { ...context(store), hasActiveWork: () => true },
        'control-token',
        'user-1'
      )
    ).resolves.toBe(false);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('creates and stores a modern authorization for the private identity', async () => {
    const store = storage();
    await initializePrivateTownIdentity(store, identity);
    mocks.create.mockResolvedValue({ authorization: authorization(), token: 'runtime-token' });

    await expect(
      createRuntimeAuthorization(context(store), 'control-token', 'user-1')
    ).resolves.toBe('runtime-token');
    await expect(getRuntimeAuthorizationState(store)).resolves.toBe('active');
  });
});
