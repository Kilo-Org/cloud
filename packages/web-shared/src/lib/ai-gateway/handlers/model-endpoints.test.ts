import { beforeAll, beforeEach, describe, expect, test } from '@jest/globals';
import { cleanupDbForTest, db } from '@kilocode/web-shared/lib/drizzle';
import { ai_gateway_config } from '@kilocode/db/schema';
import { NextRequest } from 'next/server';
import {
  getOpenRouterModelsMetadataFromDatabase,
  getVercelModelsMetadataFromDatabase,
} from '@kilocode/web-shared/lib/ai-gateway/providers/gateway-models-cache';
import { TEST_CUSTOM_PRICING_CONFIG } from '@kilocode/web-shared/tests/helpers/custom-pricing.helper';
import { handleModelEndpointsRequest } from './model-endpoints';

jest.mock('@kilocode/web-shared/lib/ai-gateway/providers/gateway-models-cache', () => ({
  getOpenRouterModelsMetadataFromDatabase: jest.fn(),
  getVercelModelsMetadataFromDatabase: jest.fn(),
  resolveOpenRouterModelAlias: jest.fn((modelId: string) => Promise.resolve(modelId)),
}));

const mockedGetOpenRouterModelsMetadataFromDatabase = jest.mocked(
  getOpenRouterModelsMetadataFromDatabase
);
const mockedGetVercelModelsMetadataFromDatabase = jest.mocked(getVercelModelsMetadataFromDatabase);

beforeEach(() => {
  mockedGetVercelModelsMetadataFromDatabase.mockResolvedValue({});
});

beforeAll(async () => {
  await cleanupDbForTest();
  await db.insert(ai_gateway_config).values({
    unavailable_models: { models: ['google/gemma-4-31b-it:free'] },
    custom_pricing: TEST_CUSTOM_PRICING_CONFIG,
  });
});

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

    const response = await handleModelEndpointsRequest(request(model.id), {
      params: Promise.resolve({ provider: 'deepseek', model: 'deepseek-v4-pro' }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe(
      'public, max-age=0, s-maxage=60, stale-while-revalidate=60'
    );
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

    const response = await handleModelEndpointsRequest(request('missing/model'), {
      params: Promise.resolve({ provider: 'missing', model: 'model' }),
    });

    expect(response.status).toBe(404);
    expect(response.headers.get('cache-control')).toBe(
      'public, max-age=0, s-maxage=60, stale-while-revalidate=60'
    );
    await expect(response.json()).resolves.toEqual({
      error: { message: 'Not Found', code: 404 },
    });
  });

  test.each(['google/gemma-4-26b-a4b-it:free', 'google/gemma-4-31b-it:free'])(
    'returns 404 for unavailable model %s without reading cached metadata',
    async modelId => {
      mockedGetOpenRouterModelsMetadataFromDatabase.mockClear();
      const [provider, model] = modelId.split('/');

      const response = await handleModelEndpointsRequest(request(modelId), {
        params: Promise.resolve({ provider, model }),
      });

      expect(response.status).toBe(404);
      expect(response.headers.get('cache-control')).toBe(
        'public, max-age=0, s-maxage=60, stale-while-revalidate=60'
      );
      await expect(response.json()).resolves.toEqual({
        error: { message: 'Not Found', code: 404 },
      });
      expect(mockedGetOpenRouterModelsMetadataFromDatabase).not.toHaveBeenCalled();
    }
  );

  test('ignores custom pricing for provider prices', async () => {
    const model = {
      id: 'google/gemini-3.8-flash',
      name: 'Google: Gemini 3.8 Flash',
      endpoints: [
        {
          provider_name: 'Google',
          pricing: { prompt: '0.000001', completion: '0.000002' },
        },
        { provider_name: 'Unpriced' },
      ],
    };
    mockedGetOpenRouterModelsMetadataFromDatabase.mockResolvedValue({ [model.id]: model });
    const [provider, modelName] = model.id.split('/');

    const response = await handleModelEndpointsRequest(request(model.id), {
      params: Promise.resolve({ provider, model: modelName }),
    });

    expect(response.status).toBe(200);
    expect((await response.json()).data.endpoints).toEqual(model.endpoints);
  });

  test('shows the higher of the OpenRouter and Vercel price of each provider', async () => {
    const model = {
      id: 'z-ai/glm-5',
      name: 'Z.ai: GLM 5',
      endpoints: [
        {
          tag: 'z-ai/fp8',
          provider_name: 'Z.AI',
          pricing: {
            prompt: '0.000001',
            completion: '0.000003',
            input_cache_read: '0.0000002',
            discount: 0.5,
          },
        },
        {
          tag: 'together',
          provider_name: 'Together',
          pricing: { prompt: '0.000002', completion: '0.000004' },
        },
        {
          tag: 'novita',
          provider_name: 'Novita',
          pricing: { prompt: '0.000003', completion: '0.000005' },
        },
      ],
    };
    mockedGetOpenRouterModelsMetadataFromDatabase.mockResolvedValue({ [model.id]: model });
    mockedGetVercelModelsMetadataFromDatabase.mockResolvedValue({
      'zai/glm-5': {
        id: 'zai/glm-5',
        name: 'GLM 5',
        endpoints: [
          {
            provider_name: 'zai',
            pricing: { prompt: '0.0000021', completion: '0.000005', input_cache_read: '0.0000003' },
          },
          {
            provider_name: 'togetherai',
            pricing: { prompt: '0.0000025', completion: '0.0000035' },
          },
          {
            provider_name: 'deepinfra',
            pricing: { prompt: '0.00001', completion: '0.00001' },
          },
        ],
      },
    });

    const response = await handleModelEndpointsRequest(request(model.id), {
      params: Promise.resolve({ provider: 'z-ai', model: 'glm-5' }),
    });

    expect(response.status).toBe(200);
    expect(
      (await response.json()).data.endpoints.map((e: { pricing?: unknown }) => e.pricing)
    ).toEqual([
      // OpenRouter's undiscounted price, raised where Vercel charges more
      { prompt: '0.0000021', completion: '0.000006000000', input_cache_read: '0.000000400000' },
      { prompt: '0.0000025', completion: '0.000004' },
      { prompt: '0.000003', completion: '0.000005' },
    ]);
  });

  test("compares both gateways' peak prices", async () => {
    const model = {
      id: 'deepseek/deepseek-v4.1-flash-1017',
      name: 'DeepSeek: DeepSeek V4.1 Flash',
      endpoints: [
        {
          tag: 'alibaba',
          provider_name: 'Alibaba',
          pricing: {
            prompt: '0.00000018',
            completion: '0.00000072',
            input_cache_read: '0.0000000036',
            overrides: [
              { utc_start: 0, utc_end: 1400, prompt: '0.00000018', completion: '0.00000072' },
              { utc_start: 1400, utc_end: 0, prompt: '0.00000009', completion: '0.00000036' },
            ],
          },
        },
      ],
    };
    mockedGetOpenRouterModelsMetadataFromDatabase.mockResolvedValue({ [model.id]: model });
    mockedGetVercelModelsMetadataFromDatabase.mockResolvedValue({
      [model.id]: {
        id: model.id,
        name: 'DeepSeek V4.1 Flash',
        endpoints: [
          {
            provider_name: 'alibaba',
            pricing: {
              prompt: '0.00000015',
              completion: '0.0000006',
              input_cache_read: '0.000000015',
              peak_pricing: { multiplier: 2 },
            },
          },
        ],
      },
    });

    const response = await handleModelEndpointsRequest(request(model.id), {
      params: Promise.resolve({ provider: 'deepseek', model: 'deepseek-v4.1-flash-1017' }),
    });

    expect(response.status).toBe(200);
    expect((await response.json()).data.endpoints).toEqual([
      {
        tag: 'alibaba',
        provider_name: 'Alibaba',
        pricing: {
          prompt: '0.000000300000',
          completion: '0.000001200000',
          input_cache_read: '0.000000030000',
        },
      },
    ]);
  });

  test('lists the endpoints and prices of the model a latest alias resolves to', async () => {
    const alias = {
      id: '~anthropic/claude-sonnet-latest',
      name: 'Anthropic: Claude Sonnet Latest',
      alias_target: { slug: 'anthropic/claude-sonnet-5' },
      endpoints: [{ tag: 'anthropic', pricing: { prompt: '0.000003', completion: '0.000015' } }],
    };
    const target = {
      id: 'anthropic/claude-sonnet-5',
      name: 'Anthropic: Claude Sonnet 5',
      endpoints: [
        { tag: 'anthropic', pricing: { prompt: '0.000004', completion: '0.00002' } },
        { tag: 'google-vertex', pricing: { prompt: '0.000004', completion: '0.00002' } },
      ],
    };
    mockedGetOpenRouterModelsMetadataFromDatabase.mockResolvedValue({
      [alias.id]: alias,
      [target.id]: target,
    });
    mockedGetVercelModelsMetadataFromDatabase.mockResolvedValue({
      [target.id]: {
        id: target.id,
        name: 'Claude Sonnet 5',
        endpoints: [
          {
            provider_name: 'vertexAnthropic',
            pricing: { prompt: '0.000005', completion: '0.00002' },
          },
        ],
      },
    });

    const response = await handleModelEndpointsRequest(request(alias.id), {
      params: Promise.resolve({ provider: '~anthropic', model: 'claude-sonnet-latest' }),
    });

    expect(response.status).toBe(200);
    const { data } = await response.json();
    expect(data.id).toBe(alias.id);
    expect(data.name).toBe(alias.name);
    expect(data.endpoints).toEqual([
      { tag: 'anthropic', pricing: { prompt: '0.000004', completion: '0.00002' } },
      { tag: 'google-vertex', pricing: { prompt: '0.000005', completion: '0.00002' } },
    ]);
  });
});
