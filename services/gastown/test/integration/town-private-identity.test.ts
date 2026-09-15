import { env, runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as admission from '@kilocode/worker-utils/runtime-authorization';
import { getTownDOStub, type TownDO } from '../../src/dos/Town.do';
import {
  initializePrivateTownIdentity,
  createRuntimeAuthorization,
  renewRuntimeAuthorization,
  TOWN_IDENTITY_KEY,
  RUNTIME_AUTHORIZATION_KEY,
} from '../../src/dos/town/runtime-authorization';

const identity = {
  ownerType: 'user' as const,
  ownerUserId: 'oauth/legacy-owner',
  createdByUserId: 'oauth/legacy-owner',
  runtimeMode: 'legacy' as const,
};

function town() {
  return getTownDOStub(env, `identity-${crypto.randomUUID()}`);
}

describe('private town identity on real Durable Object storage', () => {
  it('initializes identity and owner configuration together', async () => {
    await runInDurableObject(town(), async (_instance, state) => {
      await state.storage.put('town:config', { kilocode_token: 'retained-token' });
      await initializePrivateTownIdentity(state.storage, identity);
      expect(await state.storage.get(TOWN_IDENTITY_KEY)).toEqual(identity);
      expect(await state.storage.get('town:config')).toMatchObject({
        kilocode_token: 'retained-token',
        owner_user_id: identity.ownerUserId,
        owner_type: 'user',
      });
    });
  });

  it('rolls back the identity write when persisted config validation fails', async () => {
    await runInDurableObject(town(), async (_instance, state) => {
      const malformedConfig = { kilocode_token: 123 };
      await state.storage.put('town:config', malformedConfig);
      await expect(initializePrivateTownIdentity(state.storage, identity)).rejects.toThrow();
      expect(await state.storage.get(TOWN_IDENTITY_KEY)).toBeUndefined();
      expect(await state.storage.get('town:config')).toEqual(malformedConfig);
    });
  });

  it.each([null, false, {}, { ...identity, runtimeMode: 'modern' }])(
    'does not overwrite existing invalid/modern identity %j',
    async existing => {
      await runInDurableObject(town(), async (_instance, state) => {
        await state.storage.put(TOWN_IDENTITY_KEY, existing);
        await expect(initializePrivateTownIdentity(state.storage, identity)).rejects.toThrow();
        expect(await state.storage.get(TOWN_IDENTITY_KEY)).toEqual(existing);
      });
    }
  );

  it('does not adopt a legacy identity over an orphaned authorization', async () => {
    await runInDurableObject(town(), async (_instance, state) => {
      await state.storage.put(RUNTIME_AUTHORIZATION_KEY, { state: 'revoked' });
      await expect(initializePrivateTownIdentity(state.storage, identity)).rejects.toThrow();
      expect(await state.storage.get(TOWN_IDENTITY_KEY)).toBeUndefined();
      expect(await state.storage.get(RUNTIME_AUTHORIZATION_KEY)).toEqual({ state: 'revoked' });
    });
  });

  it('allows only one concurrent identity initialization', async () => {
    await runInDurableObject(town(), async (_instance, state) => {
      await state.storage.put('town:config', {});
      const attempts = await Promise.allSettled([
        initializePrivateTownIdentity(state.storage, identity),
        initializePrivateTownIdentity(state.storage, { ...identity, ownerUserId: 'other-owner' }),
      ]);
      expect(attempts.filter(result => result.status === 'fulfilled')).toHaveLength(1);
      const stored = await state.storage.get<{ ownerUserId: string }>(TOWN_IDENTITY_KEY);
      expect(await state.storage.get('town:config')).toMatchObject({
        owner_user_id: stored?.ownerUserId,
      });
    });
  });
});

// Exercise production admission persistence with real transactional storage;
// only the external PostgreSQL/token admission is substituted.
describe('runtime sponsorship on real Durable Object storage', () => {
  afterEach(() => vi.restoreAllMocks());

  it.each([false, true])(
    'atomically persists sponsorship (invalid config: %s)',
    async invalidConfig => {
      await runInDurableObject(town(), async (instance, state) => {
        const organizationId = '00000000-0000-4000-8000-000000000003';
        const original = { ...identity, ownerType: 'org' as const, organizationId };
        await initializePrivateTownIdentity(state.storage, original);
        if (invalidConfig) await state.storage.put('town:config', { kilocode_token: 123 });
        const previousConfig = await state.storage.get('town:config');
        const authorization = admission.RuntimeAuthorizationSchema.parse({
          version: 1,
          id: '00000000-0000-4000-8000-000000000001',
          resourceKind: 'gastown',
          resourceId: instance['townId'],
          organizationId,
          userId: 'oauth/new-owner',
          authorizationUserId: 'oauth/new-owner',
          issuedAt: '2026-09-09T00:00:00.000Z',
          delegationExpiresAt: '2026-10-09T00:00:00.000Z',
          state: 'active',
          bindings: { userPepperDigest: 'a'.repeat(64), authorizationPepperDigest: 'a'.repeat(64) },
          source: { admissionSource: 'user' },
        });
        vi.spyOn(admission, 'createRuntimeAuthorization').mockResolvedValue({
          authorization,
          token: 'runtime-token',
          expiresAt: '2026-09-09T01:00:00.000Z',
        });
        const token = await createRuntimeAuthorization(
          {
            storage: state.storage,
            env: {
              ...env,
              NEXTAUTH_SECRET: 'synthetic-test-secret',
              HYPERDRIVE: { connectionString: 'postgres://test' },
            } as Env,
            townId: instance['townId'],
            hasActiveWork: () => false,
          },
          'control-token',
          'oauth/new-owner',
          organizationId
        );
        if (invalidConfig) {
          expect(token).toBeUndefined();
          expect(await state.storage.get(TOWN_IDENTITY_KEY)).toEqual(original);
          expect(await state.storage.get(RUNTIME_AUTHORIZATION_KEY)).toBeUndefined();
          expect(await state.storage.get('town:config')).toEqual(previousConfig);
        } else {
          expect(token).toBe('runtime-token');
          expect(await instance.getTownIdentityState()).toEqual({
            type: 'modern',
            identity: { ...original, ownerUserId: 'oauth/new-owner', runtimeMode: 'modern' },
          });
          expect(await state.storage.get(RUNTIME_AUTHORIZATION_KEY)).toEqual(authorization);
          expect(await instance.getTownConfig()).toMatchObject({
            owner_type: 'org',
            owner_id: organizationId,
            organization_id: organizationId,
            owner_user_id: 'oauth/new-owner',
            created_by_user_id: original.createdByUserId,
          });
        }
      });
    }
  );
});

describe('runtime renewal on real Durable Object storage', () => {
  afterEach(() => vi.restoreAllMocks());

  async function fixture(instance: TownDO, storage: DurableObjectStorage) {
    await initializePrivateTownIdentity(storage, { ...identity, runtimeMode: 'modern' });
    const authorization = admission.RuntimeAuthorizationSchema.parse({
      version: 1,
      id: '00000000-0000-4000-8000-000000000001',
      resourceKind: 'gastown',
      resourceId: instance['townId'],
      userId: identity.ownerUserId,
      authorizationUserId: identity.ownerUserId,
      issuedAt: '2026-09-14T00:00:00.000Z',
      delegationExpiresAt: '2026-10-14T00:00:00.000Z',
      state: 'active',
      bindings: { userPepperDigest: 'a'.repeat(64), authorizationPepperDigest: 'a'.repeat(64) },
      source: { admissionSource: 'user' },
    });
    await storage.put(RUNTIME_AUTHORIZATION_KEY, authorization);
    return {
      authorization,
      context: {
        storage,
        env: {
          ...env,
          NEXTAUTH_SECRET: 'synthetic-test-secret',
          HYPERDRIVE: { connectionString: 'postgres://unused' },
        } as Env,
        townId: instance['townId'],
        hasActiveWork: () => false,
      },
    };
  }

  it.each(['active', 'revoked'] as const)(
    'rejects plain admission over an existing %s grant during work',
    async grantState => {
      await runInDurableObject(town(), async (instance, state) => {
        const { context, authorization } = await fixture(instance, state.storage);
        const previous = { ...authorization, state: grantState };
        await state.storage.put(RUNTIME_AUTHORIZATION_KEY, previous);
        const oldConfig = await instance.getTownConfig();
        const oldIdentity = await state.storage.get(TOWN_IDENTITY_KEY);
        const create = vi.spyOn(admission, 'createRuntimeAuthorization').mockResolvedValue({
          authorization,
          token: 'replacement-token',
          expiresAt: '2026-09-14T01:00:00Z',
        });

        expect(
          await createRuntimeAuthorization(
            { ...context, hasActiveWork: () => true },
            'control-token',
            identity.ownerUserId
          )
        ).toBeUndefined();

        expect(create).not.toHaveBeenCalled();
        expect(await state.storage.get(RUNTIME_AUTHORIZATION_KEY)).toEqual(previous);
        expect(await state.storage.get(TOWN_IDENTITY_KEY)).toEqual(oldIdentity);
        expect(await instance.getTownConfig()).toEqual(oldConfig);
      });
    }
  );

  it('commits only the token and preserves configuration and private identity', async () => {
    await runInDurableObject(town(), async (instance, state) => {
      const { context, authorization } = await fixture(instance, state.storage);
      const oldConfig = await instance.getTownConfig();
      const oldIdentity = await state.storage.get(TOWN_IDENTITY_KEY);
      vi.spyOn(admission, 'renewRuntimeAuthorization').mockResolvedValue({
        token: 'renewed-token',
        expiresAt: '2026-09-14T01:00:00Z',
      });
      expect(await renewRuntimeAuthorization(context)).toBe('renewed-token');
      expect(await instance.getTownConfig()).toEqual({
        ...oldConfig,
        kilocode_token: 'renewed-token',
      });
      expect(await state.storage.get(TOWN_IDENTITY_KEY)).toEqual(oldIdentity);
      expect(await state.storage.get(RUNTIME_AUTHORIZATION_KEY)).toEqual(authorization);
    });
  });

  it.each(['authorization', 'identity'] as const)(
    'does not overwrite a concurrent %s change while renewal is in flight',
    async changed => {
      await runInDurableObject(town(), async (instance, state) => {
        const { context, authorization } = await fixture(instance, state.storage);
        vi.spyOn(admission, 'renewRuntimeAuthorization').mockImplementation(async () => {
          if (changed === 'authorization')
            await state.storage.put(RUNTIME_AUTHORIZATION_KEY, {
              ...authorization,
              state: 'revoked',
            });
          if (changed === 'identity')
            await state.storage.put(TOWN_IDENTITY_KEY, {
              ...identity,
              runtimeMode: 'modern',
              ownerUserId: 'different-owner',
            });
          return { token: 'stale-token', expiresAt: '2026-09-14T01:00:00Z' };
        });
        expect(await renewRuntimeAuthorization(context)).toBeUndefined();
        expect((await instance.getTownConfig()).kilocode_token).toBeUndefined();
        if (changed === 'authorization')
          expect(await state.storage.get(RUNTIME_AUTHORIZATION_KEY)).toEqual({
            ...authorization,
            state: 'revoked',
          });
        if (changed === 'identity')
          expect(await state.storage.get(TOWN_IDENTITY_KEY)).toMatchObject({
            ownerUserId: 'different-owner',
          });
      });
    }
  );

  it.each(['settings', 'token'] as const)(
    'merges renewal with a concurrent %s publication',
    async changed => {
      await runInDurableObject(town(), async (instance, state) => {
        const { context } = await fixture(instance, state.storage);
        vi.spyOn(admission, 'renewRuntimeAuthorization').mockImplementation(async () => {
          const current = await instance.getTownConfig();
          await state.storage.put('town:config', {
            ...current,
            ...(changed === 'settings'
              ? { env_vars: { NEW_SETTING: 'preserved' } }
              : { kilocode_token: 'other-valid-renewal' }),
          });
          return { token: 'renewed-token', expiresAt: '2026-09-14T01:00:00Z' };
        });
        expect(await renewRuntimeAuthorization(context)).toBe('renewed-token');
        expect((await instance.getTownConfig()).kilocode_token).toBe('renewed-token');
        if (changed === 'settings')
          expect((await instance.getTownConfig()).env_vars).toEqual({ NEW_SETTING: 'preserved' });
      });
    }
  );

  it('allows both concurrent renewals under the same unchanged authority', async () => {
    await runInDurableObject(town(), async (instance, state) => {
      const { context } = await fixture(instance, state.storage);
      vi.spyOn(admission, 'renewRuntimeAuthorization')
        .mockResolvedValueOnce({ token: 'first-token', expiresAt: '2026-09-14T01:00:00Z' })
        .mockResolvedValueOnce({ token: 'second-token', expiresAt: '2026-09-14T01:00:00Z' });
      const results = await Promise.all([
        renewRuntimeAuthorization(context),
        renewRuntimeAuthorization(context),
      ]);
      expect(results.sort()).toEqual(['first-token', 'second-token']);
      expect(results).toContain((await instance.getTownConfig()).kilocode_token);
    });
  });

  it('preserves replacement authorization when stale external renewal reports revocation', async () => {
    await runInDurableObject(town(), async (instance, state) => {
      const { context, authorization } = await fixture(instance, state.storage);
      const replacement = {
        ...authorization,
        source: { ...authorization.source, tokenSource: 'replacement' },
      };
      vi.spyOn(admission, 'renewRuntimeAuthorization').mockImplementation(async () => {
        await state.storage.put(RUNTIME_AUTHORIZATION_KEY, replacement);
        throw new admission.RuntimeAuthorizationRevokedError();
      });
      expect(await renewRuntimeAuthorization(context)).toBeUndefined();
      expect(await state.storage.get(RUNTIME_AUTHORIZATION_KEY)).toEqual(replacement);
    });
  });

  it('does not publish a token when persisted configuration is malformed', async () => {
    await runInDurableObject(town(), async (instance, state) => {
      const { context, authorization } = await fixture(instance, state.storage);
      await state.storage.put('town:config', { kilocode_token: 123 });
      vi.spyOn(admission, 'renewRuntimeAuthorization').mockResolvedValue({
        token: 'renewed-token',
        expiresAt: '2026-09-14T01:00:00Z',
      });
      expect(await renewRuntimeAuthorization(context)).toBeUndefined();
      expect(await state.storage.get('town:config')).toEqual({ kilocode_token: 123 });
      expect(await state.storage.get(RUNTIME_AUTHORIZATION_KEY)).toEqual(authorization);
    });
  });
});
