import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { getTownDOStub } from '../../src/dos/Town.do';
import {
  initializePrivateTownIdentity,
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
