import { getAssignedCodingPlanApiKey } from '@/lib/coding-plans';
import { getMiniMaxUsage } from '@/lib/coding-plans/minimax-usage';
import {
  canQueryCodingPlanUsage,
  CodingPlanUsageUnavailableError,
  getCodingPlanUsageResponse,
} from '@/lib/coding-plans/usage';
import { CodingPlanUsageError, type CodingPlanUsageSnapshot } from './usage-contract';
import { redisClient } from '@/lib/redis';

jest.mock('@/lib/coding-plans', () => ({
  getAssignedCodingPlanApiKey: jest.fn(),
}));
jest.mock('@/lib/coding-plans/minimax-usage', () => ({
  getMiniMaxUsage: jest.fn(),
}));
jest.mock('@/lib/redis', () => ({
  redisClient: {
    get: jest.fn(),
    set: jest.fn(),
    del: jest.fn(),
  },
}));
jest.mock('@/lib/utils.server', () => ({
  sentryLogger: jest.fn(() => jest.fn()),
}));

const subscription = {
  id: 'subscription-id',
  planId: 'minimax-token-plan-plus',
  providerId: 'minimax',
  status: 'active',
  keyInventoryId: 'inventory-id',
};
const snapshot: CodingPlanUsageSnapshot = {
  fetchedAt: '2026-08-05T12:00:00.000Z',
  windows: [
    {
      id: 'short_term',
      remainingPercent: 75,
      resetsAt: '2026-08-05T17:00:00.000Z',
      period: { unit: 'hour', value: 5 },
    },
  ],
};

const mockedGetAssignedCodingPlanApiKey = jest.mocked(getAssignedCodingPlanApiKey);
const mockedGetMiniMaxUsage = jest.mocked(getMiniMaxUsage);
const mockedRedisGet = jest.mocked(redisClient.get);
const mockedRedisSet = jest.mocked(redisClient.set);
const mockedRedisDel = jest.mocked(redisClient.del);

beforeEach(() => {
  mockedGetAssignedCodingPlanApiKey.mockResolvedValue('managed-api-key');
  mockedGetMiniMaxUsage.mockResolvedValue(snapshot);
  mockedRedisGet.mockResolvedValue(null);
  mockedRedisSet.mockResolvedValue('OK');
  mockedRedisDel.mockResolvedValue(1);
});

afterEach(() => {
  jest.clearAllMocks();
});

describe('Coding Plan usage cache', () => {
  it('caches a successful normalized provider response for 60 seconds', async () => {
    await expect(getCodingPlanUsageResponse('user-id', subscription)).resolves.toMatchObject({
      fetchedAt: snapshot.fetchedAt,
      subscription: { id: subscription.id, windows: snapshot.windows },
    });

    expect(mockedRedisSet).toHaveBeenCalledWith(
      'coding-plan-usage:v1:user-id:subscription-id:minimax-token-plan-plus:minimax:inventory-id',
      JSON.stringify(snapshot),
      { ex: 60 }
    );
  });

  it('validates the assigned credential before serving a cache hit', async () => {
    mockedRedisGet.mockResolvedValue(JSON.stringify(snapshot));

    await expect(getCodingPlanUsageResponse('user-id', subscription)).resolves.toMatchObject({
      fetchedAt: snapshot.fetchedAt,
    });
    expect(mockedGetAssignedCodingPlanApiKey).toHaveBeenCalledTimes(1);
    expect(mockedGetMiniMaxUsage).not.toHaveBeenCalled();

    mockedGetAssignedCodingPlanApiKey.mockResolvedValueOnce(null);
    await expect(getCodingPlanUsageResponse('user-id', subscription)).rejects.toBeInstanceOf(
      CodingPlanUsageUnavailableError
    );
    expect(mockedRedisGet).toHaveBeenCalledTimes(1);
  });

  it('treats malformed and unavailable Redis entries as cache misses', async () => {
    mockedRedisGet
      .mockResolvedValueOnce('{}')
      .mockRejectedValueOnce(new Error('redis unavailable'));

    await getCodingPlanUsageResponse('user-id', subscription);
    await getCodingPlanUsageResponse('other-user-id', subscription);

    expect(mockedRedisDel).toHaveBeenCalledTimes(1);
    expect(mockedGetMiniMaxUsage).toHaveBeenCalledTimes(2);
  });

  it('fails open when a successful provider response cannot be cached', async () => {
    mockedRedisSet.mockRejectedValue(new Error('redis unavailable'));

    await expect(getCodingPlanUsageResponse('user-id', subscription)).resolves.toMatchObject({
      fetchedAt: snapshot.fetchedAt,
    });
  });

  it('does not cache provider errors', async () => {
    mockedGetMiniMaxUsage.mockRejectedValue(new CodingPlanUsageError('http'));

    await expect(getCodingPlanUsageResponse('user-id', subscription)).rejects.toMatchObject({
      code: 'http',
    });
    expect(mockedRedisSet).not.toHaveBeenCalled();

    mockedGetMiniMaxUsage.mockResolvedValue(snapshot);
    await expect(getCodingPlanUsageResponse('user-id', subscription)).resolves.toMatchObject({
      fetchedAt: snapshot.fetchedAt,
    });
    expect(mockedGetMiniMaxUsage).toHaveBeenCalledTimes(2);
    expect(mockedRedisSet).toHaveBeenCalledTimes(1);
  });

  it('coalesces concurrent requests for the same cache key', async () => {
    const [first, second] = await Promise.all([
      getCodingPlanUsageResponse('user-id', subscription),
      getCodingPlanUsageResponse('user-id', subscription),
    ]);

    expect(first).toEqual(second);
    expect(mockedRedisGet).toHaveBeenCalledTimes(1);
    expect(mockedGetMiniMaxUsage).toHaveBeenCalledTimes(1);
    expect(mockedRedisSet).toHaveBeenCalledTimes(1);
  });

  it('does not coalesce requests across inventory assignments', async () => {
    await Promise.all([
      getCodingPlanUsageResponse('user-id', subscription),
      getCodingPlanUsageResponse('user-id', { ...subscription, keyInventoryId: 'other-inventory' }),
    ]);

    expect(mockedRedisGet).toHaveBeenCalledTimes(2);
    expect(mockedGetMiniMaxUsage).toHaveBeenCalledTimes(2);
    expect(mockedRedisSet.mock.calls.map(([key]) => key)).toEqual([
      'coding-plan-usage:v1:user-id:subscription-id:minimax-token-plan-plus:minimax:inventory-id',
      'coding-plan-usage:v1:user-id:subscription-id:minimax-token-plan-plus:minimax:other-inventory',
    ]);
  });
});

describe('Coding Plan usage capability', () => {
  it('requires a live subscription, retained assignment, and registered adapter', () => {
    expect(canQueryCodingPlanUsage(subscription)).toBe(true);
    expect(canQueryCodingPlanUsage({ ...subscription, status: 'canceled' })).toBe(false);
    expect(canQueryCodingPlanUsage({ ...subscription, keyInventoryId: null })).toBe(false);
    expect(
      canQueryCodingPlanUsage({
        ...subscription,
        planId: 'byteplus-coding-plan-team-lite',
        providerId: 'byteplus-coding',
      })
    ).toBe(false);
  });
});
