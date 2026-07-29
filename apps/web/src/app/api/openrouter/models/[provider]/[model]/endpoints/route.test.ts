import { describe, expect, test } from '@jest/globals';
import { NextRequest } from 'next/server';
import { getOpenRouterModelsMetadataFromDatabase } from '@/lib/ai-gateway/providers/gateway-models-cache';
import { QWEN37_MAX_MODEL_ID } from '@/lib/ai-gateway/custom-pricing';
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
  test('undoes discounts for every priced endpoint without adding missing fields', async () => {
    const model = {
      id: 'deepseek/deepseek-v4-pro',
      name: 'DeepSeek: DeepSeek V4 Pro',
      endpoints: [
        {
          provider_name: 'DeepSeek',
          context_length: 1_048_576,
          pricing: { prompt: '0.000000435', completion: '0.00000087', discount: 0.5 },
        },
        {
          provider_name: 'Baidu',
          pricing: { prompt: '0.0000006253', completion: '0.0000012506', discount: 0.63 },
        },
        { provider_name: 'Unpriced' },
      ],
    };
    mockedGetOpenRouterModelsMetadataFromDatabase.mockResolvedValue({ [model.id]: model });

    const response = await GET(request(model.id), {
      params: Promise.resolve({ provider: 'deepseek', model: 'deepseek-v4-pro' }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      data: {
        id: model.id,
        name: model.name,
        endpoints: [
          {
            provider_name: 'DeepSeek',
            context_length: 1_048_576,
            pricing: { prompt: '0.000000870000', completion: '0.000001740000' },
          },
          {
            provider_name: 'Baidu',
            pricing: { prompt: '0.000001690000', completion: '0.000003380000' },
          },
          { provider_name: 'Unpriced' },
        ],
      },
    });
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

  test('applies custom pricing to every priced endpoint', async () => {
    const model = {
      id: QWEN37_MAX_MODEL_ID,
      name: 'Qwen: Qwen3.7 Max',
      endpoints: [
        {
          provider_name: 'Alibaba',
          pricing: { prompt: '0.000001', completion: '0.000002' },
        },
        {
          provider_name: 'Another provider',
          pricing: { prompt: '0.000003', completion: '0.000004' },
        },
        { provider_name: 'Unpriced' },
      ],
    };
    mockedGetOpenRouterModelsMetadataFromDatabase.mockResolvedValue({ [model.id]: model });
    const [provider, modelName] = model.id.split('/');

    const response = await GET(request(model.id), {
      params: Promise.resolve({ provider, model: modelName }),
    });

    expect(response.status).toBe(200);
    const data = (await response.json()).data;
    expect(data.endpoints).toEqual([
      {
        provider_name: 'Alibaba',
        pricing: {
          prompt: '0.000001250000',
          completion: '0.000003750000',
          input_cache_read: '0.000000125000',
          input_cache_write: '0.000001562500',
        },
      },
      {
        provider_name: 'Another provider',
        pricing: {
          prompt: '0.000001250000',
          completion: '0.000003750000',
          input_cache_read: '0.000000125000',
          input_cache_write: '0.000001562500',
        },
      },
      { provider_name: 'Unpriced' },
    ]);
  });
});
