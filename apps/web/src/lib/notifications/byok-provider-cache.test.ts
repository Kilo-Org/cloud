import { redisClient } from '@/lib/redis';
import {
  getByokProvidersForUser,
  groupProvidersByUser,
  syncByokProviderNotificationsToRedis,
  type ByokProviderRow,
} from './byok-provider-cache';

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

const mockedRedisGet = jest.mocked(redisClient.get);

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
