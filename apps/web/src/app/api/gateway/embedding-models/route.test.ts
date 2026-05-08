import { describe, expect, test, beforeEach } from '@jest/globals';
import { GET } from './route';
import { getOpenRouterEmbeddingModels } from '@/lib/ai-gateway/providers/openrouter';
import type {
  OpenRouterModel,
  OpenRouterModelsResponse,
} from '@/lib/organizations/organization-types';

jest.mock('@/lib/ai-gateway/providers/openrouter');

const mockedGetOpenRouterEmbeddingModels = jest.mocked(getOpenRouterEmbeddingModels);

function makeEmbeddingModel(id: string): OpenRouterModel {
  return {
    id,
    name: id,
    created: 0,
    description: '',
    architecture: {
      input_modalities: ['text'],
      output_modalities: ['embeddings'],
      tokenizer: 'Other',
    },
    top_provider: {
      is_moderated: false,
      context_length: 8192,
      max_completion_tokens: null,
    },
    pricing: {
      prompt: '0.0000001',
      completion: '0',
    },
    context_length: 8192,
  };
}

describe('GET /api/gateway/embedding-models', () => {
  beforeEach(() => {
    mockedGetOpenRouterEmbeddingModels.mockReset();
  });

  test('returns the embedding models from OpenRouter', async () => {
    const response: OpenRouterModelsResponse = {
      data: [
        makeEmbeddingModel('mistralai/mistral-embed-2312'),
        makeEmbeddingModel('openai/text-embedding-3-small'),
      ],
    };
    mockedGetOpenRouterEmbeddingModels.mockResolvedValue(response);

    const result = await GET();

    expect(result.status).toBe(200);
    await expect(result.json()).resolves.toEqual(response);
  });

  test('returns 500 when OpenRouter fetch fails', async () => {
    mockedGetOpenRouterEmbeddingModels.mockRejectedValue(new Error('boom'));

    const result = await GET();

    expect(result.status).toBe(500);
    await expect(result.json()).resolves.toEqual({
      error: 'Failed to fetch embedding models',
      message: 'Error from OpenRouter API',
    });
  });
});
