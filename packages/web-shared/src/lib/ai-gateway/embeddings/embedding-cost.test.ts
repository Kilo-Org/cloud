import { describe, it, expect, beforeEach } from '@jest/globals';
import type { StoredModel } from '@kilocode/db';
import {
  embeddingPromptPriceUsdPerToken,
  resolveEmbeddingCatalogCost_mUsd,
} from './embedding-cost';

const mockedGetOpenRouterModels = jest.fn(async (): Promise<Record<string, StoredModel>> => ({}));
const mockedGetVercelModels = jest.fn(async (): Promise<Record<string, StoredModel>> => ({}));
jest.mock('@kilocode/web-shared/lib/ai-gateway/providers/gateway-models-cache', () => ({
  getOpenRouterModelsMetadataFromDatabase: () => mockedGetOpenRouterModels(),
  getVercelModelsMetadataFromDatabase: () => mockedGetVercelModels(),
}));

function makeEmbeddingModel(
  promptPrices: string[],
  overrides: Partial<StoredModel> = {}
): StoredModel {
  return {
    id: 'openai/text-embedding-3-small',
    name: 'Text Embedding 3 Small',
    architecture: { output_modalities: ['embeddings'] },
    endpoints: promptPrices.map(prompt => ({ pricing: { prompt, completion: '0' } })),
    ...overrides,
  };
}

describe('embeddingPromptPriceUsdPerToken', () => {
  it('uses the highest prompt price across the catalogued endpoints', () => {
    const model = makeEmbeddingModel(['0.00000002', '0.00000005', '0.00000001']);

    expect(embeddingPromptPriceUsdPerToken(model)).toBe(0.00000005);
  });

  it('accepts a catalog entry typed as an embedding model', () => {
    const model = makeEmbeddingModel(['0.00000002'], {
      type: 'embedding',
      architecture: undefined,
    });

    expect(embeddingPromptPriceUsdPerToken(model)).toBe(0.00000002);
  });

  it('rejects a catalog entry that is not an embedding model', () => {
    const model = makeEmbeddingModel(['0.000003'], {
      architecture: { output_modalities: ['text'] },
    });

    expect(embeddingPromptPriceUsdPerToken(model)).toBeNull();
  });

  it('ignores endpoints without a usable prompt price', () => {
    const model: StoredModel = {
      id: 'openai/text-embedding-3-small',
      name: 'Text Embedding 3 Small',
      architecture: { output_modalities: ['embeddings'] },
      endpoints: [{}, { pricing: { prompt: 'not-a-number', completion: '0' } }],
    };

    expect(embeddingPromptPriceUsdPerToken(model)).toBeNull();
  });
});

describe('resolveEmbeddingCatalogCost_mUsd', () => {
  beforeEach(() => {
    mockedGetOpenRouterModels.mockClear();
    mockedGetVercelModels.mockClear();
    mockedGetOpenRouterModels.mockResolvedValue({
      'openai/text-embedding-3-small': makeEmbeddingModel(['0.00000002', '0.00000005']),
    });
    mockedGetVercelModels.mockResolvedValue({});
  });

  it('prices the reported prompt tokens at the catalog price ceiling', async () => {
    const cost_mUsd = await resolveEmbeddingCatalogCost_mUsd({
      provider: 'openrouter',
      modelIds: ['openai/text-embedding-3-small'],
      promptTokens: 1_000,
    });

    expect(cost_mUsd).toBe(50);
  });

  it('resolves a Kilo embedding alias to its catalog id', async () => {
    const cost_mUsd = await resolveEmbeddingCatalogCost_mUsd({
      provider: 'openrouter',
      modelIds: ['text-embedding-3-small'],
      promptTokens: 2_000,
    });

    expect(cost_mUsd).toBe(100);
  });

  it('prices from the serving gateway catalog first', async () => {
    mockedGetVercelModels.mockResolvedValue({
      'openai/text-embedding-3-small': makeEmbeddingModel(['0.0000001']),
    });

    const vercelCost = await resolveEmbeddingCatalogCost_mUsd({
      provider: 'vercel',
      modelIds: ['openai/text-embedding-3-small'],
      promptTokens: 1_000,
    });
    const openRouterCost = await resolveEmbeddingCatalogCost_mUsd({
      provider: 'openrouter',
      modelIds: ['openai/text-embedding-3-small'],
      promptTokens: 1_000,
    });

    expect(vercelCost).toBe(100);
    expect(openRouterCost).toBe(50);
  });

  it('falls back to the other catalog when the serving one omits the model', async () => {
    const cost_mUsd = await resolveEmbeddingCatalogCost_mUsd({
      provider: 'vercel',
      modelIds: ['openai/text-embedding-3-small'],
      promptTokens: 1_000,
    });

    expect(cost_mUsd).toBe(50);
  });

  it('tries each reported model id in order', async () => {
    mockedGetOpenRouterModels.mockResolvedValue({
      'mistralai/mistral-embed-2312': makeEmbeddingModel(['0.0000001'], {
        id: 'mistralai/mistral-embed-2312',
      }),
    });

    const cost_mUsd = await resolveEmbeddingCatalogCost_mUsd({
      provider: 'openrouter',
      modelIds: ['unknown/embedding', 'mistralai/mistral-embed-2312'],
      promptTokens: 1_000,
    });

    expect(cost_mUsd).toBe(100);
  });

  it('returns null when no catalogued embedding model matches', async () => {
    const cost_mUsd = await resolveEmbeddingCatalogCost_mUsd({
      provider: 'openrouter',
      modelIds: ['unknown/embedding'],
      promptTokens: 1_000,
    });

    expect(cost_mUsd).toBeNull();
  });

  it('does not look up a catalog for a request with no prompt tokens', async () => {
    const cost_mUsd = await resolveEmbeddingCatalogCost_mUsd({
      provider: 'openrouter',
      modelIds: ['openai/text-embedding-3-small'],
      promptTokens: 0,
    });

    expect(cost_mUsd).toBeNull();
    expect(mockedGetOpenRouterModels).not.toHaveBeenCalled();
  });

  it('does not look up a catalog for a provider without one', async () => {
    const cost_mUsd = await resolveEmbeddingCatalogCost_mUsd({
      provider: 'dev-tools',
      modelIds: ['openai/text-embedding-3-small'],
      promptTokens: 1_000,
    });

    expect(cost_mUsd).toBeNull();
    expect(mockedGetOpenRouterModels).not.toHaveBeenCalled();
  });
});
