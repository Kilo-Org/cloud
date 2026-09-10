import { env, runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as admission from '@kilocode/worker-utils/runtime-authorization';
import { getTownDOStub } from '../../src/dos/Town.do';
import {
  initializePrivateTownIdentity,
  createRuntimeAuthorization,
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
            updateTownConfig: update => instance.updateTownConfig(update),
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
