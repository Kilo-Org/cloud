import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import {
  consumeFreeModelRateLimit,
  consumeFreeModelRateLimitByUser,
  consumePromotionLimit,
  fillFreeModelRateLimit,
  getFreeModelRateLimitUsage,
} from './free-model-rate-limiter';

type MockRedisEval = (script: string, keys: string[], args: unknown[]) => Promise<unknown>;

const mockRedisEval = jest.fn<MockRedisEval>();

jest.mock('@/lib/redis', () => ({
  redisClient: {
    eval: mockRedisEval,
  },
}));

describe('free model rate limiter', () => {
  beforeEach(() => {
    mockRedisEval.mockReset();
  });

  it('atomically consumes an IP request from the rolling window', async () => {
    mockRedisEval.mockResolvedValueOnce([1, 1]);

    await expect(consumeFreeModelRateLimit('192.0.2.1')).resolves.toEqual({
      allowed: true,
      requestCount: 1,
    });
    expect(mockRedisEval).toHaveBeenCalledWith(
      expect.stringContaining("redis.call('ZADD'"),
      ['ai-gateway.free-model-rate-limit:ip:192.0.2.1'],
      [3_600_000, 200, 3_600, expect.any(String)]
    );
  });

  it('returns the current count when a user has reached the limit', async () => {
    mockRedisEval.mockResolvedValueOnce([0, 200]);

    await expect(consumeFreeModelRateLimitByUser('user-123')).resolves.toEqual({
      allowed: false,
      requestCount: 200,
    });
    expect(mockRedisEval).toHaveBeenCalledWith(
      expect.any(String),
      ['ai-gateway.free-model-rate-limit:user:user-123'],
      [3_600_000, 200, 3_600, expect.any(String)]
    );
  });

  it('uses a separate 24-hour window for anonymous promotion requests', async () => {
    mockRedisEval.mockResolvedValueOnce([1, 42]);

    await expect(consumePromotionLimit('192.0.2.1')).resolves.toEqual({
      allowed: true,
      requestCount: 42,
    });
    expect(mockRedisEval).toHaveBeenCalledWith(
      expect.any(String),
      ['ai-gateway.promotion-rate-limit:ip:192.0.2.1'],
      [86_400_000, 10_000, 86_400, expect.any(String)]
    );
  });

  it('fails open when Redis is unavailable', async () => {
    mockRedisEval.mockRejectedValueOnce(new Error('Redis unavailable'));

    await expect(consumeFreeModelRateLimit('192.0.2.1')).resolves.toEqual({
      allowed: true,
      requestCount: 0,
    });
  });

  it('reads and fills the same IP limit for the admin controls', async () => {
    mockRedisEval.mockResolvedValueOnce(12).mockResolvedValueOnce([188, 200]);

    await expect(getFreeModelRateLimitUsage('192.0.2.1')).resolves.toBe(12);
    await expect(fillFreeModelRateLimit('192.0.2.1')).resolves.toEqual({
      requestsAdded: 188,
      requestCount: 200,
    });

    expect(mockRedisEval.mock.calls[0]?.[1]).toEqual([
      'ai-gateway.free-model-rate-limit:ip:192.0.2.1',
    ]);
    expect(mockRedisEval.mock.calls[1]?.[1]).toEqual([
      'ai-gateway.free-model-rate-limit:ip:192.0.2.1',
    ]);
  });
});
