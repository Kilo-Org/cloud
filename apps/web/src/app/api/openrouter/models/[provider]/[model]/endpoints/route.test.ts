import { describe, expect, test } from '@jest/globals';
import { NextRequest } from 'next/server';
import { getOpenRouterModelsMetadataFromDatabase } from '@/lib/ai-gateway/providers/gateway-models-cache';
import { GET } from './route';

jest.mock('@/lib/ai-gateway/providers/gateway-models-cache', () => ({
  getOpenRouterModelsMetadataFromDatabase: jest.fn(),
}));

const mockedGetOpenRouterModelsMetadataFromDatabase = jest.mocked(
  getOpenRouterModelsMetadataFromDatabase
);

function request(modelId: string) {
  return new NextRequest(`http://localhost:3000/api/openrouter/models/${modelId}/endpoints`);
}

describe('GET /api/openrouter/models/[provider]/[model]/endpoints', () => {
  test('returns the cached model without adding missing fields', async () => {
    const model = {
      id: 'deepseek/deepseek-v4-pro',
      name: 'DeepSeek: DeepSeek V4 Pro',
      endpoints: [
        {
          provider_name: 'DeepSeek',
          context_length: 1_048_576,
          pricing: { prompt: '0.000000435', completion: '0.00000087' },
        },
      ],
    };
    mockedGetOpenRouterModelsMetadataFromDatabase.mockResolvedValue({ [model.id]: model });

    const response = await GET(request(model.id), {
      params: Promise.resolve({ provider: 'deepseek', model: 'deepseek-v4-pro' }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ data: model });
  });

  test('returns 404 when the model is absent from the cache', async () => {
    mockedGetOpenRouterModelsMetadataFromDatabase.mockResolvedValue({});

    const response = await GET(request('missing/model'), {
      params: Promise.resolve({ provider: 'missing', model: 'model' }),
    });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: { message: 'Not Found', code: 404 },
    });
  });
});
