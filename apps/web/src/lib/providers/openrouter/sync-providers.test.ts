import { afterEach, describe, expect, it, jest } from '@jest/globals';
import type { Provider } from '@kilocode/web-shared/lib/ai-gateway/providers/types';
import { fetchGatewayModels } from './sync-providers';

const gateway = {
  id: 'vercel',
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

function mockGateway(endpointsStatus: (modelId: string) => number) {
  return jest.spyOn(global, 'fetch').mockImplementation(async input => {
    const url = String(input);
    if (url === `${gateway.apiUrl}/models`) {
      return Response.json({ data: listedModelIds.map(id => ({ id, name: id })) });
    }
    const modelId = url.slice(`${gateway.apiUrl}/models/`.length, -'/endpoints'.length);
    const status = endpointsStatus(modelId);
    if (status !== 200) return new Response(null, { status });
    return Response.json({ data: { endpoints: [{ provider_name: 'test' }] } });
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

  it('fails on other endpoint errors', async () => {
    mockGateway(modelId => (modelId === 'test/model-7' ? 500 : 200));

    await expect(fetchGatewayModels(gateway, '/models')).rejects.toThrow(
      'Fetching model endpoints for vercel/test/model-7 failed: 500'
    );
  });
});
