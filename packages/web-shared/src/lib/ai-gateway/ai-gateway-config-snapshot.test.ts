import { beforeEach, describe, expect, it } from '@jest/globals';
import { ai_gateway_config } from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';
import { cleanupDbForTest, db, readDb } from '@kilocode/web-shared/lib/drizzle';
import { redisClient } from '@kilocode/web-shared/lib/redis';
import { AI_GATEWAY_CONFIG_REDIS_KEY } from '@kilocode/web-shared/lib/redis-keys';
import {
  createAiGatewayConfigSelector,
  getAiGatewayConfigSnapshot,
  publishAiGatewayConfigSnapshot,
  type AiGatewayConfigSnapshot,
} from './ai-gateway-config-snapshot';

jest.mock('@kilocode/web-shared/lib/redis', () => ({
  redisClient: { get: jest.fn(), set: jest.fn(), del: jest.fn() },
}));

const mockedRedisGet = jest.mocked(redisClient.get);
const mockedRedisSet = jest.mocked(redisClient.set);
const mockedRedisDel = jest.mocked(redisClient.del);

const storedSnapshot: AiGatewayConfigSnapshot = {
  config: { vercel_routing_enabled: false },
  auto_free: { models: [{ model: 'provider/model:free', weight: 1, reasoning: {} }] },
  unavailable_models: { models: ['provider/unavailable:free'] },
  preferred_models: { models: ['provider/preferred'] },
};

const redisSnapshot: AiGatewayConfigSnapshot = {
  config: { vercel_routing_enabled: true },
  auto_free: null,
  unavailable_models: { models: ['provider/from-redis'] },
  preferred_models: null,
};

let redisValues: Map<string, string>;
let now = Date.now();

function advancePastMemoryTtl() {
  now += 10 * 60_000;
}

async function flushBackgroundWrites() {
  await new Promise(resolve => setImmediate(resolve));
}

beforeEach(async () => {
  jest.restoreAllMocks();
  advancePastMemoryTtl();
  jest.spyOn(Date, 'now').mockImplementation(() => now);

  await cleanupDbForTest();
  await db.insert(ai_gateway_config).values({
    config: { vercel_routing_enabled: false },
    auto_free: { models: [{ model: 'provider/model:free', weight: 1, reasoning: {} }] },
    unavailable_models: { models: ['provider/unavailable:free'] },
    preferred_models: { models: ['provider/preferred'] },
  });

  redisValues = new Map();
  mockedRedisGet.mockReset();
  mockedRedisGet.mockImplementation((async (key: string) => redisValues.get(key) ?? null) as never);
  mockedRedisSet.mockReset();
  mockedRedisSet.mockImplementation((async (
    key: string,
    value: string,
    options?: { nx?: boolean }
  ) => {
    if (options?.nx && redisValues.has(key)) return null;
    redisValues.set(key, value);
    return 'OK';
  }) as never);
  mockedRedisDel.mockReset();
  mockedRedisDel.mockImplementation((async (key: string) =>
    Number(redisValues.delete(key))) as never);
});

describe('getAiGatewayConfigSnapshot', () => {
  it('reads all four columns with one replica query on a Redis miss and populates Redis with NX', async () => {
    const select = jest.spyOn(readDb, 'select');

    expect(await getAiGatewayConfigSnapshot()).toEqual(storedSnapshot);
    await flushBackgroundWrites();

    expect(select).toHaveBeenCalledTimes(1);
    expect(mockedRedisGet).toHaveBeenCalledWith(AI_GATEWAY_CONFIG_REDIS_KEY);
    expect(mockedRedisSet).toHaveBeenCalledWith(
      AI_GATEWAY_CONFIG_REDIS_KEY,
      JSON.stringify(storedSnapshot),
      { nx: true, ex: 300 }
    );
  });

  it('does not overwrite a value already in Redis when populating', async () => {
    mockedRedisGet.mockResolvedValueOnce(null);
    redisValues.set(AI_GATEWAY_CONFIG_REDIS_KEY, JSON.stringify(redisSnapshot));

    expect(await getAiGatewayConfigSnapshot()).toEqual(storedSnapshot);
    await flushBackgroundWrites();

    expect(redisValues.get(AI_GATEWAY_CONFIG_REDIS_KEY)).toBe(JSON.stringify(redisSnapshot));
  });

  it('serves a Redis hit without querying the database', async () => {
    redisValues.set(AI_GATEWAY_CONFIG_REDIS_KEY, JSON.stringify(redisSnapshot));
    const select = jest.spyOn(readDb, 'select');

    expect(await getAiGatewayConfigSnapshot()).toEqual(redisSnapshot);
    expect(select).not.toHaveBeenCalled();
    expect(mockedRedisSet).not.toHaveBeenCalled();
  });

  it('serves the in-memory value within the TTL without reading Redis again', async () => {
    expect(await getAiGatewayConfigSnapshot()).toEqual(storedSnapshot);
    now += 59_000;
    expect(await getAiGatewayConfigSnapshot()).toEqual(storedSnapshot);

    expect(mockedRedisGet).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['Redis throws', () => mockedRedisGet.mockRejectedValueOnce(new Error('timeout'))],
    ['Redis holds invalid JSON', () => redisValues.set(AI_GATEWAY_CONFIG_REDIS_KEY, '{not json')],
    [
      'Redis holds an invalid snapshot',
      () => redisValues.set(AI_GATEWAY_CONFIG_REDIS_KEY, JSON.stringify({ config: {} })),
    ],
  ])('falls back to the database when %s', async (_case, arrange) => {
    arrange();
    const select = jest.spyOn(readDb, 'select');

    expect(await getAiGatewayConfigSnapshot()).toEqual(storedSnapshot);
    expect(select).toHaveBeenCalledTimes(1);
  });

  it('still serves the database value when populating Redis fails', async () => {
    mockedRedisSet.mockRejectedValueOnce(new Error('timeout'));

    expect(await getAiGatewayConfigSnapshot()).toEqual(storedSnapshot);
    await flushBackgroundWrites();
  });

  it('shares one Redis read and one database query between concurrent callers', async () => {
    let releaseRedis: (value: null) => void = () => {};
    mockedRedisGet.mockImplementationOnce(
      (() =>
        new Promise<null>(resolve => {
          releaseRedis = resolve;
        })) as never
    );
    const select = jest.spyOn(readDb, 'select');

    const results = Promise.all(Array.from({ length: 5 }, () => getAiGatewayConfigSnapshot()));
    releaseRedis(null);

    expect(await results).toEqual(Array.from({ length: 5 }, () => storedSnapshot));
    expect(mockedRedisGet).toHaveBeenCalledTimes(1);
    expect(select).toHaveBeenCalledTimes(1);
  });

  it('keeps the last-known-good snapshot when the database fails', async () => {
    const first = await getAiGatewayConfigSnapshot();
    advancePastMemoryTtl();
    redisValues.clear();
    jest.spyOn(readDb, 'select').mockImplementation(() => {
      throw new Error('database unavailable');
    });

    expect(await getAiGatewayConfigSnapshot()).toBe(first);
  });

  it('returns null when no row exists and does not populate Redis', async () => {
    await cleanupDbForTest();

    expect(await getAiGatewayConfigSnapshot()).toBeNull();
    await flushBackgroundWrites();
    expect(mockedRedisSet).not.toHaveBeenCalled();
  });
});

describe('createAiGatewayConfigSelector', () => {
  it('derives a value once per snapshot', async () => {
    const select = jest.fn((snapshot: AiGatewayConfigSnapshot) => snapshot.preferred_models);
    const get = createAiGatewayConfigSelector(select, null);

    expect(await get()).toEqual({ models: ['provider/preferred'] });
    expect(await get()).toEqual({ models: ['provider/preferred'] });
    expect(select).toHaveBeenCalledTimes(1);
  });

  it('keeps the last valid value when the stored value becomes invalid', async () => {
    const get = createAiGatewayConfigSelector(snapshot => {
      if (snapshot.preferred_models === null) throw new Error('invalid');
      return snapshot.preferred_models;
    }, 'default');

    expect(await get()).toEqual({ models: ['provider/preferred'] });

    advancePastMemoryTtl();
    redisValues.set(
      AI_GATEWAY_CONFIG_REDIS_KEY,
      JSON.stringify({ ...storedSnapshot, preferred_models: null })
    );
    expect(await get()).toEqual({ models: ['provider/preferred'] });
  });

  it('returns the default when the first stored value is invalid', async () => {
    const get = createAiGatewayConfigSelector(() => {
      throw new Error('invalid');
    }, 'default');

    expect(await get()).toBe('default');
  });

  it('returns the default when no row exists', async () => {
    await cleanupDbForTest();
    const get = createAiGatewayConfigSelector(snapshot => snapshot.config, 'default');

    expect(await get()).toBe('default');
  });
});

describe('publishAiGatewayConfigSnapshot', () => {
  it('overwrites Redis with the row read from the primary', async () => {
    redisValues.set(AI_GATEWAY_CONFIG_REDIS_KEY, JSON.stringify(redisSnapshot));
    await db
      .update(ai_gateway_config)
      .set({ preferred_models: { models: ['provider/updated'] } })
      .where(eq(ai_gateway_config.id, 1));

    await publishAiGatewayConfigSnapshot();

    const expected = { ...storedSnapshot, preferred_models: { models: ['provider/updated'] } };
    expect(mockedRedisSet).toHaveBeenCalledWith(
      AI_GATEWAY_CONFIG_REDIS_KEY,
      JSON.stringify(expected),
      { ex: 300 }
    );
    expect(redisValues.get(AI_GATEWAY_CONFIG_REDIS_KEY)).toBe(JSON.stringify(expected));
  });

  it('deletes the cached snapshot when the write fails', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    redisValues.set(AI_GATEWAY_CONFIG_REDIS_KEY, JSON.stringify(redisSnapshot));
    mockedRedisSet.mockRejectedValueOnce(new Error('timeout'));

    await publishAiGatewayConfigSnapshot();

    expect(mockedRedisDel).toHaveBeenCalledWith(AI_GATEWAY_CONFIG_REDIS_KEY);
    expect(redisValues.has(AI_GATEWAY_CONFIG_REDIS_KEY)).toBe(false);
  });

  it('does not throw when both the write and the delete fail', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    mockedRedisSet.mockRejectedValueOnce(new Error('timeout'));
    mockedRedisDel.mockRejectedValueOnce(new Error('timeout'));

    await expect(publishAiGatewayConfigSnapshot()).resolves.toBeUndefined();
  });
});
