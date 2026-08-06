import { redisClient } from '@/lib/redis';
import { executeSnowflakeStatement, resolveSnowflakeConfig } from '@/lib/snowflake';
import {
  getAutoModelsForUser,
  getByokProvidersForUser,
  groupAutoModelsByUser,
  groupProvidersByUser,
  parseAutoModelRows,
  syncAutoModelNotificationsToRedis,
  syncByokProviderNotificationsToRedis,
  syncNotificationAudiencesToRedis,
  type AutoModelRow,
  type ByokProviderRow,
} from './notification-audience-cache';

type PipelineSet = { key: string; value: string; opts?: { ex?: number } };

const mockPipelineSets: PipelineSet[] = [];

jest.mock('@/lib/redis', () => ({
  redisClient: {
    pipeline: () => ({
      set: (key: string, value: string, opts?: { ex?: number }) => {
        mockPipelineSets.push({ key, value, opts });
      },
      exec: async () => [],
    }),
    get: jest.fn(),
  },
}));

jest.mock('@/lib/snowflake', () => ({
  executeSnowflakeStatement: jest.fn(),
  resolveSnowflakeConfig: jest.fn(),
}));

const mockedRedisGet = jest.mocked(redisClient.get);
const mockedExecuteSnowflakeStatement = jest.mocked(executeSnowflakeStatement);
const mockedResolveSnowflakeConfig = jest.mocked(resolveSnowflakeConfig);

const SEVEN_DAYS_SECONDS = 60 * 60 * 24 * 7;

beforeEach(() => {
  mockPipelineSets.length = 0;
  jest.clearAllMocks();
});

describe('groupProvidersByUser', () => {
  it('groups providers per user and de-duplicates', () => {
    const rows: ByokProviderRow[] = [
      { userId: 'user_a', provider: 'anthropic' },
      { userId: 'user_a', provider: 'google' },
      { userId: 'user_a', provider: 'anthropic' },
      { userId: 'user_b', provider: 'deepseek' },
    ];

    const grouped = groupProvidersByUser(rows);

    expect(grouped.get('user_a')).toEqual(['anthropic', 'google']);
    expect(grouped.get('user_b')).toEqual(['deepseek']);
    expect(grouped.size).toBe(2);
  });

  it('omits providers that are not relevant for the notification', () => {
    const rows: ByokProviderRow[] = [
      { userId: 'user_a', provider: 'anthropic' },
      { userId: 'user_a', provider: 'unsupported-provider' },
      { userId: 'user_b', provider: 'openrouter' },
    ];

    const grouped = groupProvidersByUser(rows);

    expect(grouped.get('user_a')).toEqual(['anthropic']);
    expect(grouped.has('user_b')).toBe(false);
    expect(grouped.size).toBe(1);
  });
});

describe('syncByokProviderNotificationsToRedis', () => {
  it('writes one entry per user with the provider array and a 7-day TTL', async () => {
    const rows: ByokProviderRow[] = [
      { userId: 'user_a', provider: 'anthropic' },
      { userId: 'user_a', provider: 'google' },
      { userId: 'user_b', provider: 'deepseek' },
    ];

    const result = await syncByokProviderNotificationsToRedis(async () => rows);

    expect(result).toEqual({ rowCount: 3, userCount: 2 });
    expect(mockPipelineSets).toEqual([
      {
        key: 'notification:byok-providers:user_a',
        value: JSON.stringify(['anthropic', 'google']),
        opts: { ex: SEVEN_DAYS_SECONDS },
      },
      {
        key: 'notification:byok-providers:user_b',
        value: JSON.stringify(['deepseek']),
        opts: { ex: SEVEN_DAYS_SECONDS },
      },
    ]);
  });

  it('writes nothing when there are no rows', async () => {
    const result = await syncByokProviderNotificationsToRedis(async () => []);

    expect(result).toEqual({ rowCount: 0, userCount: 0 });
    expect(mockPipelineSets).toHaveLength(0);
  });

  it('does not store empty provider lists after irrelevant providers are filtered', async () => {
    const rows: ByokProviderRow[] = [
      { userId: 'user_a', provider: 'unsupported-provider' },
      { userId: 'user_b', provider: 'openrouter' },
    ];

    const result = await syncByokProviderNotificationsToRedis(async () => rows);

    expect(result).toEqual({ rowCount: 2, userCount: 0 });
    expect(mockPipelineSets).toHaveLength(0);
  });
});

describe('Auto model audience', () => {
  it('parses, groups, and de-duplicates Snowflake rows', () => {
    const rows = parseAutoModelRows([
      ['user_a', '["kilo-auto/balanced","kilo-auto/frontier"]'],
      ['user_a', '["kilo-auto/frontier"]'],
      ['user_b', '["kilo-auto/efficient"]'],
    ]);

    const grouped = groupAutoModelsByUser(rows);

    expect(grouped.get('user_a')).toEqual(['kilo-auto/balanced', 'kilo-auto/frontier']);
    expect(grouped.get('user_b')).toEqual(['kilo-auto/efficient']);
  });

  it('rejects malformed or empty Snowflake model arrays', () => {
    expect(() => parseAutoModelRows([['user_a', 'not-json']])).toThrow(
      'Failed to parse Auto model rows'
    );
    expect(() => parseAutoModelRows([['user_a', '[]']])).toThrow('Failed to parse Auto model rows');
  });

  it('writes one entry per user with the model array and a 7-day TTL', async () => {
    const rows: AutoModelRow[] = [
      { userId: 'user_a', modelIds: ['kilo-auto/balanced', 'kilo-auto/frontier'] },
      { userId: 'user_b', modelIds: ['kilo-auto/efficient'] },
    ];

    const result = await syncAutoModelNotificationsToRedis(async () => rows);

    expect(result).toEqual({ rowCount: 2, userCount: 2 });
    expect(mockPipelineSets).toEqual([
      {
        key: 'notification:auto-models:user_a',
        value: JSON.stringify(['kilo-auto/balanced', 'kilo-auto/frontier']),
        opts: { ex: SEVEN_DAYS_SECONDS },
      },
      {
        key: 'notification:auto-models:user_b',
        value: JSON.stringify(['kilo-auto/efficient']),
        opts: { ex: SEVEN_DAYS_SECONDS },
      },
    ]);
  });

  it('queries all recent successful Auto model usage from Snowflake', async () => {
    const config = {
      accountHost: 'account.snowflakecomputing.com',
      jwtAccountIdentifier: 'account',
      username: 'user',
      role: 'role',
      warehouse: 'warehouse',
      database: 'database',
      schema: 'schema',
      privateKeyPem: 'private-key',
      publicKeyFingerprint: 'SHA256:fingerprint',
    };
    mockedResolveSnowflakeConfig.mockReturnValueOnce(config);
    mockedExecuteSnowflakeStatement.mockResolvedValueOnce([
      ['user_a', '["kilo-auto/balanced","kilo-auto/frontier"]'],
      ['user_b', '["kilo-auto/efficient"]'],
    ]);

    await expect(syncAutoModelNotificationsToRedis()).resolves.toEqual({
      rowCount: 2,
      userCount: 2,
    });
    expect(mockedExecuteSnowflakeStatement).toHaveBeenCalledWith({
      config,
      statement: expect.stringMatching(
        /array_agg\(distinct auto_model\)[\s\S]*from microdollar_usage_daily[\s\S]*auto_model is not null[\s\S]*group by kilo_user_id/
      ),
      timeoutSeconds: 60,
    });
  });

  it('fails when Snowflake is not configured', async () => {
    mockedResolveSnowflakeConfig.mockReturnValueOnce(null);

    await expect(syncAutoModelNotificationsToRedis()).rejects.toThrow(
      'Snowflake is not configured'
    );
    expect(mockedExecuteSnowflakeStatement).not.toHaveBeenCalled();
  });
});

describe('syncNotificationAudiencesToRedis', () => {
  it('returns both audience results after both syncs complete', async () => {
    await expect(
      syncNotificationAudiencesToRedis({
        byokProviders: async () => ({ rowCount: 3, userCount: 2 }),
        autoModels: async () => ({ rowCount: 4, userCount: 3 }),
      })
    ).resolves.toEqual({
      byokProviders: { rowCount: 3, userCount: 2 },
      autoModels: { rowCount: 4, userCount: 3 },
    });
  });

  it('waits for the other audience before reporting an aggregated failure', async () => {
    let finishByokSync: ((result: { rowCount: number; userCount: number }) => void) | undefined;
    let reportAutoFailure: (() => void) | undefined;
    const byokSync = new Promise<{ rowCount: number; userCount: number }>(resolve => {
      finishByokSync = resolve;
    });
    const autoFailureReported = new Promise<void>(resolve => {
      reportAutoFailure = resolve;
    });
    const syncPromise = syncNotificationAudiencesToRedis({
      byokProviders: () => byokSync,
      autoModels: async () => {
        reportAutoFailure?.();
        throw new Error('Snowflake unavailable');
      },
    });
    let rejected = false;
    void syncPromise.catch(() => {
      rejected = true;
    });

    await autoFailureReported;
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(rejected).toBe(false);

    finishByokSync?.({ rowCount: 3, userCount: 2 });
    await expect(syncPromise).rejects.toMatchObject({
      name: 'AggregateError',
      message: 'Failed to sync notification audiences: autoModels',
    });
  });

  it('aggregates all failed audience names and reasons', async () => {
    const byokError = new Error('PostHog unavailable');
    const autoModelsError = new Error('Snowflake unavailable');

    await expect(
      syncNotificationAudiencesToRedis({
        byokProviders: async () => {
          throw byokError;
        },
        autoModels: async () => {
          throw autoModelsError;
        },
      })
    ).rejects.toMatchObject({
      name: 'AggregateError',
      message: 'Failed to sync notification audiences: byokProviders, autoModels',
      errors: [byokError, autoModelsError],
    });
  });
});

describe('getByokProvidersForUser', () => {
  it('returns the parsed provider array for the user', async () => {
    mockedRedisGet.mockResolvedValueOnce(JSON.stringify(['anthropic', 'google']));

    await expect(getByokProvidersForUser('user_a')).resolves.toEqual(['anthropic', 'google']);
    expect(mockedRedisGet).toHaveBeenCalledWith('notification:byok-providers:user_a');
  });

  it('returns an empty array when there is no cached entry', async () => {
    mockedRedisGet.mockResolvedValueOnce(null);

    await expect(getByokProvidersForUser('user_a')).resolves.toEqual([]);
  });

  it('fails open to an empty array when the cached value is malformed', async () => {
    mockedRedisGet.mockResolvedValueOnce('not-json');

    await expect(getByokProvidersForUser('user_a')).resolves.toEqual([]);
  });
});

describe('getAutoModelsForUser', () => {
  it('returns the parsed model array for the user', async () => {
    mockedRedisGet.mockResolvedValueOnce(
      JSON.stringify(['kilo-auto/balanced', 'kilo-auto/frontier', 'kilo-auto/efficient'])
    );

    await expect(getAutoModelsForUser('user_a')).resolves.toEqual([
      'kilo-auto/balanced',
      'kilo-auto/frontier',
      'kilo-auto/efficient',
    ]);
    expect(mockedRedisGet).toHaveBeenCalledWith('notification:auto-models:user_a');
  });

  it('returns an empty array when there is no cached entry', async () => {
    mockedRedisGet.mockResolvedValueOnce(null);

    await expect(getAutoModelsForUser('user_a')).resolves.toEqual([]);
  });

  it('fails open to an empty array when the cached value is malformed', async () => {
    mockedRedisGet.mockResolvedValueOnce(JSON.stringify(['kilo-auto/frontier', 42]));

    await expect(getAutoModelsForUser('user_a')).resolves.toEqual([]);
  });
});
