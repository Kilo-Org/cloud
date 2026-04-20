import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PROVIDER_ROLLOUT_CONFIG,
  PROVIDER_ROLLOUT_KV_KEY,
  providerRolloutTestUtils,
  readProviderRolloutConfig,
  selectProviderForProvision,
  writeProviderRolloutConfig,
} from './rollout';

function createKv(initial?: string) {
  const store = new Map<string, string>();
  if (initial) store.set(PROVIDER_ROLLOUT_KV_KEY, initial);

  return {
    async get(key: string, type?: 'text') {
      return type === 'text' ? (store.get(key) ?? null) : null;
    },
    async put(key: string, value: string) {
      store.set(key, value);
    },
  };
}

describe('provider rollout config', () => {
  it('defaults Northflank traffic to zero with no opted-in organizations', async () => {
    await expect(readProviderRolloutConfig(createKv())).resolves.toEqual({
      config: DEFAULT_PROVIDER_ROLLOUT_CONFIG,
      source: 'default',
    });
  });

  it('round-trips rollout config through KV', async () => {
    const kv = createKv();
    const config = {
      northflank: {
        personalTrafficPercent: 10,
        organizationTrafficPercent: 25,
        enabledOrganizationIds: ['550e8400-e29b-41d4-a716-446655440001'],
      },
    };

    await writeProviderRolloutConfig(kv, config);

    await expect(readProviderRolloutConfig(kv)).resolves.toEqual({
      config,
      source: 'kv',
    });
  });

  it('selects fly while Northflank rollout is unavailable', async () => {
    const kv = createKv(
      JSON.stringify({
        northflank: {
          personalTrafficPercent: 100,
          organizationTrafficPercent: 100,
          enabledOrganizationIds: ['550e8400-e29b-41d4-a716-446655440001'],
        },
      })
    );

    await expect(selectProviderForProvision({ kv, userId: 'user-1' })).resolves.toBe('fly');
    await expect(
      selectProviderForProvision({
        kv,
        userId: 'user-1',
        orgId: '550e8400-e29b-41d4-a716-446655440001',
      })
    ).resolves.toBe('fly');
  });

  it('selects the configured default provider in development', async () => {
    await expect(
      selectProviderForProvision({
        kv: createKv(),
        userId: 'user-1',
        workerEnv: 'development',
        defaultProvider: 'docker-local',
      })
    ).resolves.toBe('docker-local');
  });

  it('uses rollout rather than local defaults outside development', async () => {
    await expect(
      selectProviderForProvision({
        kv: createKv(),
        userId: 'user-1',
        workerEnv: 'production',
        defaultProvider: 'docker-local',
      })
    ).resolves.toBe('fly');
  });

  it('ignores invalid default provider values in development', async () => {
    await expect(
      selectProviderForProvision({
        kv: createKv(),
        userId: 'user-1',
        workerEnv: 'development',
        defaultProvider: 'bogus',
      })
    ).resolves.toBe('fly');
  });

  it('does not select Northflank for orgs that are not opted in', async () => {
    const kv = createKv(
      JSON.stringify({
        northflank: {
          personalTrafficPercent: 0,
          organizationTrafficPercent: 100,
          enabledOrganizationIds: ['550e8400-e29b-41d4-a716-446655440001'],
        },
      })
    );

    await expect(
      selectProviderForProvision({
        kv,
        userId: 'user-1',
        orgId: '550e8400-e29b-41d4-a716-446655440002',
      })
    ).resolves.toBe('fly');
  });

  it('uses explicit deterministic rollout keys', async () => {
    await expect(providerRolloutTestUtils.rolloutBucket('personal:user:user-1')).resolves.toBe(
      await providerRolloutTestUtils.rolloutBucket('personal:user:user-1')
    );
    await expect(
      providerRolloutTestUtils.rolloutBucket('org:550e8400-e29b-41d4-a716-446655440001:user:user-1')
    ).resolves.toBe(
      await providerRolloutTestUtils.rolloutBucket(
        'org:550e8400-e29b-41d4-a716-446655440001:user:user-1'
      )
    );
  });
});
