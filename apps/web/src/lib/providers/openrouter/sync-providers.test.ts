import { afterEach, describe, expect, it, jest } from '@jest/globals';
import type { Provider } from '@kilocode/web-shared/lib/ai-gateway/providers/types';
import { fetchGatewayModels } from './sync-providers';

const gateway = {
  type: 'vercel',
  apiUrl: 'https://gateway.test/v1',
  apiUrlOverrides: {},
  disableUrlSuffix: false,
  apiKey: 'test-key',
  apiKeyHeader: null,
  supportedChatApis: ['chat_completions'],
  responseTransforms: null,
  async transformRequest() {},
} satisfies Provider;

const listedModelIds = [
  ...Array.from({ length: 100 }, (_, index) => `test/model-${index}`),
  'test/model-0-batch',
];

function mockGateway(
  endpointsStatus: (modelId: string) => number,
  listedModel: (id: string) => Record<string, unknown> = id => ({ id, name: id }),
  endpointsModel: Record<string, unknown> = {}
) {
  return jest.spyOn(global, 'fetch').mockImplementation(async input => {
    const url = String(input);
    if (url === `${gateway.apiUrl}/models`) {
      return Response.json({ data: listedModelIds.map(listedModel) });
    }
    const modelId = url.slice(`${gateway.apiUrl}/models/`.length, -'/endpoints'.length);
    const status = endpointsStatus(modelId);
    if (status !== 200) return new Response(null, { status });
    return Response.json({ data: { ...endpointsModel, endpoints: [{ provider_name: 'test' }] } });
  });
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe('fetchGatewayModels', () => {
  it('skips listed models whose endpoints resource does not exist', async () => {
    mockGateway(modelId => (modelId.endsWith('-batch') ? 404 : 200));
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'debug').mockImplementation(() => {});

    const models = await fetchGatewayModels(gateway, '/models');

    expect(Object.keys(models)).toHaveLength(100);
    expect(models['test/model-0-batch']).toBeUndefined();
    expect(models['test/model-0']?.endpoints).toEqual([{ provider_name: 'test' }]);
  });

  it('fills model fields the model list lacks from the endpoints response', async () => {
    mockGateway(
      () => 200,
      id => ({
        id,
        name: id,
        type: 'language',
        owned_by: 'test',
        description: 'Listed description',
        created: 1_755_815_280,
      }),
      {
        description: 'Endpoints description',
        released: 1_790_000_000,
        architecture: { input_modalities: ['text', 'file'], output_modalities: ['text'] },
        reasoning: { supported_efforts: ['low', 'high'] },
      }
    );
    jest.spyOn(console, 'debug').mockImplementation(() => {});

    const models = await fetchGatewayModels(gateway, '/models');

    expect(models['test/model-0']).toEqual({
      id: 'test/model-0',
      name: 'test/model-0',
      type: 'language',
      description: 'Listed description',
      created: 1_755_815_280,
      released: 1_790_000_000,
      architecture: { input_modalities: ['text', 'file'], output_modalities: ['text'] },
      reasoning: { mandatory: false, supported_efforts: ['low', 'high'] },
      endpoints: [{ provider_name: 'test' }],
    });
  });

  it('fails on other endpoint errors', async () => {
    mockGateway(modelId => (modelId === 'test/model-7' ? 500 : 200));

    await expect(fetchGatewayModels(gateway, '/models')).rejects.toThrow(
      'Fetching model endpoints for vercel/test/model-7 failed: 500'
    );
  });
});
