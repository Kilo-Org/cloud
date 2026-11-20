import { describe, test, expect, beforeEach } from '@jest/globals';
import * as z from 'zod';
import { redisClient } from '@kilocode/web-shared/lib/redis';
import { organizationAIAdoptionRedisKey } from '@kilocode/web-shared/lib/redis-keys';
import { readCachedAIAdoption, writeCachedAIAdoption } from './ai-adoption-cache';

jest.mock('@kilocode/web-shared/lib/redis', () => ({
  redisClient: { get: jest.fn(), set: jest.fn() },
}));

const schema = z.object({ value: z.number() });
const key = {
  organizationId: '11111111-1111-4111-8111-111111111111',
  startDate: '2026-10-21T10:00:00.000Z',
  endDate: '2026-11-20T11:00:00.000Z',
};

describe('AI adoption cache', () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  test('keys differ by organization and by range', () => {
    const base = organizationAIAdoptionRedisKey(key);
    expect(organizationAIAdoptionRedisKey({ ...key, organizationId: 'other' })).not.toBe(base);
    expect(
      organizationAIAdoptionRedisKey({ ...key, startDate: '2026-10-22T10:00:00.000Z' })
    ).not.toBe(base);
    expect(
      organizationAIAdoptionRedisKey({ ...key, endDate: '2026-11-20T12:00:00.000Z' })
    ).not.toBe(base);
  });

  test('writes JSON under the key with a one hour expiry', async () => {
    await writeCachedAIAdoption(key, { value: 1 });

    expect(redisClient.set).toHaveBeenCalledWith(
      organizationAIAdoptionRedisKey(key),
      JSON.stringify({ value: 1 }),
      { ex: 3600 }
    );
  });

  test('returns a valid cached value', async () => {
    jest.mocked(redisClient.get).mockResolvedValueOnce(JSON.stringify({ value: 2 }));

    await expect(readCachedAIAdoption(key, schema)).resolves.toEqual({ value: 2 });
  });

  test.each([null, 'not json', JSON.stringify({ value: 'x' })])(
    'misses on an absent or invalid entry: %s',
    async cached => {
      jest.mocked(redisClient.get).mockResolvedValueOnce(cached);

      await expect(readCachedAIAdoption(key, schema)).resolves.toBeNull();
    }
  );

  test('fails open when Redis errors', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    jest.mocked(redisClient.get).mockRejectedValueOnce(new Error('down'));
    jest.mocked(redisClient.set).mockRejectedValueOnce(new Error('down'));

    await expect(readCachedAIAdoption(key, schema)).resolves.toBeNull();
    await expect(writeCachedAIAdoption(key, { value: 1 })).resolves.toBeUndefined();
  });
});
