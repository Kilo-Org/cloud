import { beforeAll, beforeEach, describe, expect, test } from '@jest/globals';
import { cleanupDbForTest, db } from '@kilocode/web-shared/lib/drizzle';
import { ai_gateway_config } from '@kilocode/db/schema';
import {
  familyHasUnavailableFreeModel,
  getUnavailableModelIds,
  isUnavailableModel,
  readUnavailableModelIds,
} from '@kilocode/web-shared/lib/ai-gateway/unavailable-models';

jest.mock('@kilocode/web-shared/lib/redis', () => ({
  redisClient: { get: jest.fn(async () => null), set: jest.fn(async () => 'OK') },
}));

beforeAll(async () => {
  await cleanupDbForTest();
  await db.insert(ai_gateway_config).values({
    unavailable_models: {
      models: [
        'apodex/apodex-1.1-mini:free',
        'google/gemma-4-31b-it:free',
        'qwen/qwen3.8-27b:free',
        'example/region-restricted',
      ],
    },
  });
});

describe('unavailable models', () => {
  test('combines the stored list with the hardcoded gemma free model', async () => {
    expect([...(await getUnavailableModelIds())]).toEqual([
      'google/gemma-4-26b-a4b-it:free',
      'apodex/apodex-1.1-mini:free',
      'google/gemma-4-31b-it:free',
      'qwen/qwen3.8-27b:free',
      'example/region-restricted',
    ]);
  });

  test('keeps exact matching for request rejection', async () => {
    expect(await isUnavailableModel('apodex/apodex-1.1-mini:free')).toBe(true);
    expect(await isUnavailableModel('apodex/apodex-1.1-mini')).toBe(false);
    expect(await isUnavailableModel('google/gemma-4-26b-a4b-it:free')).toBe(true);
    expect(await isUnavailableModel('google/gemma-4-26b-a4b-it')).toBe(false);
    expect(await isUnavailableModel('google/gemma-4-31b-it:free')).toBe(true);
    expect(await isUnavailableModel('google/gemma-4-31b-it')).toBe(false);
    expect(await isUnavailableModel('qwen/qwen3.8-27b:free')).toBe(true);
    expect(await isUnavailableModel('qwen/qwen3.8-27b')).toBe(false);
    expect(await isUnavailableModel('example/region-restricted')).toBe(true);
    expect(await isUnavailableModel('openai/gpt-oss-20b:free')).toBe(false);
  });
});

describe('familyHasUnavailableFreeModel', () => {
  const unavailableModelIds = new Set([
    'apodex/apodex-1.1-mini:free',
    'google/gemma-4-31b-it:free',
    'qwen/qwen3.8-27b:free',
    'example/region-restricted',
  ]);

  test.each([
    'apodex/apodex-1.1-mini:free',
    'apodex/apodex-1.1-mini',
    'google/gemma-4-31b-it:free',
    'google/gemma-4-31b-it',
    'qwen/qwen3.8-27b:free',
    'qwen/qwen3.8-27b',
  ])('matches the normalized family of %s', modelId => {
    expect(familyHasUnavailableFreeModel(unavailableModelIds, modelId)).toBe(true);
  });

  test.each(['example/region-restricted', 'cohere/north-mini-code'])(
    'does not match %s, which has no unavailable free model',
    modelId => {
      expect(familyHasUnavailableFreeModel(unavailableModelIds, modelId)).toBe(false);
    }
  );
});

describe('readUnavailableModelIds', () => {
  beforeEach(async () => {
    await cleanupDbForTest();
  });

  test('returns an empty list when no config row exists', async () => {
    expect(await readUnavailableModelIds()).toEqual([]);
  });

  test('reads only the unavailable_models column, without the hardcoded model', async () => {
    await db.insert(ai_gateway_config).values({
      preferred_models: { models: ['provider/b'] },
      unavailable_models: { models: ['provider/c:free'] },
    });
    expect(await readUnavailableModelIds()).toEqual(['provider/c:free']);
  });

  test('throws on an invalid stored list', async () => {
    await db
      .insert(ai_gateway_config)
      .values({ unavailable_models: { models: ['Provider/Model'] } });
    await expect(readUnavailableModelIds()).rejects.toThrow();
  });
});
