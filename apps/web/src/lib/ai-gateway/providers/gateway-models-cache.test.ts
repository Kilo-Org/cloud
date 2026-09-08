import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockLimit = jest.fn<() => Promise<Array<{ models: unknown }>>>();

jest.mock('@/lib/drizzle', () => ({
  readDb: {
    select: jest.fn(() => ({
      from: jest.fn(() => ({
        orderBy: jest.fn(() => ({ limit: mockLimit })),
      })),
    })),
  },
}));

import {
  extractVercelInferenceProviderIdsFromModel,
  getLanguageModelIds,
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
    const { isValidOpenRouterModelId, getCachedVercelInferenceProviderIdsForModel } =
      await import('@/lib/ai-gateway/providers/gateway-models-cache');
    return {
      isValidOpenRouterModelId,
      getCachedVercelInferenceProviderIdsForModel,
    };
  }

  beforeEach(() => {
    mockLimit.mockReset();
  });

  it('accepts ids present in the database catalog', async () => {
    const { isValidOpenRouterModelId } = await loadValidator();
    mockLimit.mockResolvedValue([
      { models: { 'openai/gpt-4o': storedModel({ id: 'openai/gpt-4o' }) } },
    ]);

    await expect(isValidOpenRouterModelId('openai/gpt-4o')).resolves.toBe(true);
  });

  it('rejects ids missing from a non-empty database catalog', async () => {
    const { isValidOpenRouterModelId } = await loadValidator();
    mockLimit.mockResolvedValue([
      { models: { 'openai/gpt-4o': storedModel({ id: 'openai/gpt-4o' }) } },
    ]);

    await expect(isValidOpenRouterModelId('not-a-real-model')).resolves.toBe(false);
  });

  it('fails open when the database has no model ids', async () => {
    const { isValidOpenRouterModelId } = await loadValidator();
    mockLimit.mockResolvedValue([]);

    await expect(isValidOpenRouterModelId('not-a-real-model')).resolves.toBe(true);
  });

  it('reads Vercel inference providers from the database catalog', async () => {
    const { getCachedVercelInferenceProviderIdsForModel } = await loadValidator();
    mockLimit.mockResolvedValue([
      {
        models: {
          'anthropic/claude-sonnet-4.5': storedModel({
            id: 'anthropic/claude-sonnet-4.5',
            endpoints: [
              { provider_name: 'anthropic' },
              { provider_name: 'bedrock' },
              { provider_name: 'anthropic' },
            ],
          }),
        },
      },
    ]);

    await expect(
      getCachedVercelInferenceProviderIdsForModel('anthropic/claude-sonnet-4.5')
    ).resolves.toEqual(['anthropic', 'bedrock']);
  });
});
