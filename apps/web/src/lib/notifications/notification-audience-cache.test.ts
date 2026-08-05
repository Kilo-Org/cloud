import { redisClient } from '@/lib/redis';
import { executeSnowflakeStatement, resolveSnowflakeConfig } from '@/lib/snowflake';
import {
  getByokProvidersForUser,
  getDeprecatedAutoModelsForUser,
  groupDeprecatedAutoModelsByUser,
  groupProvidersByUser,
  parseDeprecatedAutoModelRows,
  syncByokProviderNotificationsToRedis,
  syncDeprecatedAutoModelNotificationsToRedis,
  type ByokProviderRow,
  type DeprecatedAutoModelRow,
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

describe('deprecated auto model audience', () => {
  it('parses, groups, and de-duplicates Snowflake rows', () => {
    const rows = parseDeprecatedAutoModelRows([
      ['user_a', 'kilo-auto/frontier'],
      ['user_a', 'kilo-auto/balanced'],
      ['user_a', 'kilo-auto/frontier'],
      ['user_b', 'kilo-auto/balanced'],
    ]);

    const grouped = groupDeprecatedAutoModelsByUser(rows);

    expect(grouped.get('user_a')).toEqual(['kilo-auto/frontier', 'kilo-auto/balanced']);
    expect(grouped.get('user_b')).toEqual(['kilo-auto/balanced']);
  });

  it('rejects unexpected Snowflake model ids', () => {
    expect(() => parseDeprecatedAutoModelRows([['user_a', 'kilo-auto/efficient']])).toThrow(
      'Failed to parse deprecated auto model rows'
    );
  });

  it('writes one entry per user with the model array and a 7-day TTL', async () => {
    const rows: DeprecatedAutoModelRow[] = [
      { userId: 'user_a', modelId: 'kilo-auto/frontier' },
      { userId: 'user_a', modelId: 'kilo-auto/balanced' },
      { userId: 'user_b', modelId: 'kilo-auto/balanced' },
    ];

    const result = await syncDeprecatedAutoModelNotificationsToRedis(async () => rows);

    expect(result).toEqual({ rowCount: 3, userCount: 2 });
    expect(mockPipelineSets).toEqual([
      {
        key: 'notification:deprecated-auto-models:user_a',
        value: JSON.stringify(['kilo-auto/frontier', 'kilo-auto/balanced']),
        opts: { ex: SEVEN_DAYS_SECONDS },
      },
      {
        key: 'notification:deprecated-auto-models:user_b',
        value: JSON.stringify(['kilo-auto/balanced']),
        opts: { ex: SEVEN_DAYS_SECONDS },
      },
    ]);
  });

  it('queries recent successful usage from Snowflake with the deprecated model bindings', async () => {
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
      ['user_a', 'kilo-auto/frontier'],
      ['user_b', 'kilo-auto/balanced'],
    ]);

    await expect(syncDeprecatedAutoModelNotificationsToRedis()).resolves.toEqual({
      rowCount: 2,
      userCount: 2,
    });
    expect(mockedExecuteSnowflakeStatement).toHaveBeenCalledWith({
      config,
      statement: expect.stringMatching(
        /from microdollar_usage_daily[\s\S]*usage_date >= dateadd\(week, -1, current_date\(\)\)[\s\S]*auto_model in \(\?, \?\)[\s\S]*total_output_tokens > 0/
      ),
      bindings: [
        { type: 'TEXT', value: 'kilo-auto/frontier' },
        { type: 'TEXT', value: 'kilo-auto/balanced' },
      ],
      timeoutSeconds: 60,
    });
  });

  it('fails when Snowflake is not configured', async () => {
    mockedResolveSnowflakeConfig.mockReturnValueOnce(null);

    await expect(syncDeprecatedAutoModelNotificationsToRedis()).rejects.toThrow(
      'Snowflake is not configured'
    );
    expect(mockedExecuteSnowflakeStatement).not.toHaveBeenCalled();
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

describe('getDeprecatedAutoModelsForUser', () => {
  it('returns the parsed model array for the user', async () => {
    mockedRedisGet.mockResolvedValueOnce(
      JSON.stringify(['kilo-auto/frontier', 'kilo-auto/balanced'])
    );

    await expect(getDeprecatedAutoModelsForUser('user_a')).resolves.toEqual([
      'kilo-auto/frontier',
      'kilo-auto/balanced',
    ]);
    expect(mockedRedisGet).toHaveBeenCalledWith('notification:deprecated-auto-models:user_a');
  });

  it('returns an empty array when there is no cached entry', async () => {
    mockedRedisGet.mockResolvedValueOnce(null);

    await expect(getDeprecatedAutoModelsForUser('user_a')).resolves.toEqual([]);
  });

  it('fails open to an empty array when the cached value is malformed', async () => {
    mockedRedisGet.mockResolvedValueOnce(JSON.stringify(['kilo-auto/efficient']));

    await expect(getDeprecatedAutoModelsForUser('user_a')).resolves.toEqual([]);
  });
});
