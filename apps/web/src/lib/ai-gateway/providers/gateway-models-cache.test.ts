import { describe, expect, it, jest } from '@jest/globals';

jest.mock('@/lib/redis', () => ({
  redisClient: { get: jest.fn() },
}));

import {
  extractVercelInferenceProviderIdsFromModel,
  getLanguageModelIds,
  getLanguageModelIdsWithoutEndpoints,
} from '@/lib/ai-gateway/providers/gateway-models-cache';
import type { StoredModel } from '@kilocode/db';

function storedModel(partial: Partial<StoredModel> & Pick<StoredModel, 'id'>): StoredModel {
  return {
    name: partial.id,
    endpoints: [{ provider_name: 'test' }],
    ...partial,
  };
}

describe('getLanguageModelIds', () => {
  it('includes language models even when they have no endpoints', () => {
    expect(
      getLanguageModelIds({
        'vendor/with-endpoints': storedModel({ id: 'vendor/with-endpoints' }),
        'vendor/no-endpoints': storedModel({ id: 'vendor/no-endpoints', endpoints: [] }),
        'vendor/untyped': storedModel({ id: 'vendor/untyped', type: undefined, endpoints: [] }),
        'vendor/embedding': storedModel({
          id: 'vendor/embedding',
          type: 'embedding',
          endpoints: [],
        }),
        'vendor/image': storedModel({ id: 'vendor/image', type: 'image' }),
      })
    ).toEqual(['vendor/with-endpoints', 'vendor/no-endpoints', 'vendor/untyped']);
  });
});

describe('getLanguageModelIdsWithoutEndpoints', () => {
  it('returns only language models with no endpoints', () => {
    expect(
      getLanguageModelIdsWithoutEndpoints({
        'vendor/with-endpoints': storedModel({ id: 'vendor/with-endpoints' }),
        'vendor/no-endpoints': storedModel({ id: 'vendor/no-endpoints', endpoints: [] }),
        'vendor/untyped': storedModel({ id: 'vendor/untyped', type: undefined, endpoints: [] }),
        'vendor/embedding': storedModel({
          id: 'vendor/embedding',
          type: 'embedding',
          endpoints: [],
        }),
      })
    ).toEqual(['vendor/no-endpoints', 'vendor/untyped']);
  });
});

describe('extractVercelInferenceProviderIdsFromModel', () => {
  it('builds a deduplicated plain provider list for a model', () => {
    const model: StoredModel = {
      id: 'anthropic/claude-sonnet-4.5',
      name: 'Claude Sonnet 4.5',
      endpoints: [
        { provider_name: 'anthropic' },
        { provider_name: 'bedrock' },
        { provider_name: 'anthropic' },
        { tag: 'fallback-without-provider-name' },
      ],
    };

    expect(extractVercelInferenceProviderIdsFromModel(model)).toEqual(['anthropic', 'bedrock']);
  });
});

describe('isValidOpenRouterModelId', () => {
  async function loadValidator() {
    jest.resetModules();
    const { isValidOpenRouterModelId } =
      await import('@/lib/ai-gateway/providers/gateway-models-cache');
    const { redisClient: freshRedisClient } = await import('@/lib/redis');
    return {
      isValidOpenRouterModelId,
      redisGet: jest.mocked(freshRedisClient.get),
    };
  }

  it('accepts known legacy aliases without consulting Redis', async () => {
    const { isValidOpenRouterModelId, redisGet } = await loadValidator();

    await expect(isValidOpenRouterModelId('gpt-4o')).resolves.toBe(true);
    expect(redisGet).not.toHaveBeenCalled();
  });

  it('accepts ids present in the Redis catalog', async () => {
    const { isValidOpenRouterModelId, redisGet } = await loadValidator();
    redisGet.mockResolvedValue(JSON.stringify(['openai/gpt-4o']));

    await expect(isValidOpenRouterModelId('openai/gpt-4o')).resolves.toBe(true);
  });

  it('rejects ids missing from a non-empty Redis catalog', async () => {
    const { isValidOpenRouterModelId, redisGet } = await loadValidator();
    redisGet.mockResolvedValue(JSON.stringify(['openai/gpt-4o']));

    await expect(isValidOpenRouterModelId('not-a-real-model')).resolves.toBe(false);
  });

  it('fails open when Redis has no model ids', async () => {
    const { isValidOpenRouterModelId, redisGet } = await loadValidator();
    redisGet.mockResolvedValue(null);

    await expect(isValidOpenRouterModelId('not-a-real-model')).resolves.toBe(true);
  });
});
