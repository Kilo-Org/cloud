import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { ai_gateway_metadata_cache } from '@kilocode/db/schema';
import { db, sql } from '@kilocode/web-shared/lib/drizzle';
import type { Provider } from '@kilocode/web-shared/lib/ai-gateway/providers/types';
import {
  fetchGatewayModels,
  gatewayModelEndpointsSource,
  gatewayModelsSource,
} from './sync-providers';

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

function endpointsUrl(modelId: string) {
  return gatewayModelEndpointsSource(gateway, modelId).url;
}

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

function fetchedEndpointsUrls(fetchSpy: jest.SpiedFunction<typeof fetch>) {
  return fetchSpy.mock.calls
    .map(([input]) => String(input))
    .filter(url => url.endsWith('/endpoints'));
}

async function storeEndpointsRows(rows: ReadonlyArray<[modelId: string, data: unknown]>) {
  await db
    .insert(ai_gateway_metadata_cache)
    .values(rows.map(([modelId, data]) => ({ url: endpointsUrl(modelId), data })));
}

const storedEndpoints = { data: { endpoints: [{ provider_name: 'stored' }] } };

beforeEach(async () => {
  await db.delete(ai_gateway_metadata_cache).where(sql`true`);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('fetchGatewayModels', () => {
  it('skips listed models whose endpoints resource does not exist', async () => {
    mockGateway(modelId => (modelId.endsWith('-batch') ? 404 : 200));
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'debug').mockImplementation(() => {});

    const models = await fetchGatewayModels(gateway, gatewayModelsSource(gateway, '/models'));

    expect(Object.keys(models)).toHaveLength(100);
    expect(models['test/model-0-batch']).toBeUndefined();
    expect(models['test/model-0']?.endpoints).toEqual([{ provider_name: 'test' }]);
  });

  it('fails on other live endpoint errors without fetching the queued models', async () => {
    const fetchSpy = mockGateway(modelId => (modelId === 'test/model-7' ? 500 : 200));

    await expect(
      fetchGatewayModels(gateway, gatewayModelsSource(gateway, '/models'))
    ).rejects.toThrow('Fetching https://gateway.test/v1/models/test/model-7/endpoints failed: 500');
    await new Promise(resolve => setTimeout(resolve, 200));
    expect(fetchedEndpointsUrls(fetchSpy).length).toBeLessThan(20);
  });

  it('uses stored endpoints, including a stored missing resource, without fetching them', async () => {
    const fetchSpy = mockGateway(() => 500);
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'debug').mockImplementation(() => {});
    await storeEndpointsRows(
      listedModelIds.map(id => [id, id.endsWith('-batch') ? { status: 404 } : storedEndpoints])
    );

    const models = await fetchGatewayModels(gateway, gatewayModelsSource(gateway, '/models'));

    expect(fetchedEndpointsUrls(fetchSpy)).toEqual([]);
    expect(Object.keys(models)).toHaveLength(100);
    expect(models['test/model-0-batch']).toBeUndefined();
    expect(models['test/model-0']?.endpoints).toEqual([{ provider_name: 'stored' }]);
  });

  it('fetches endpoints live only for models whose row is missing or does not parse', async () => {
    const fetchSpy = mockGateway(() => 200);
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'debug').mockImplementation(() => {});
    await storeEndpointsRows([
      ...listedModelIds
        .filter(id => id !== 'test/model-1' && id !== 'test/model-2')
        .map((id): [string, unknown] => [
          id,
          id.endsWith('-batch') ? { status: 404 } : storedEndpoints,
        ]),
      ['test/model-2', { data: { endpoints: 'not-a-list' } }],
    ]);

    const models = await fetchGatewayModels(gateway, gatewayModelsSource(gateway, '/models'));

    expect(fetchedEndpointsUrls(fetchSpy).sort()).toEqual(
      [endpointsUrl('test/model-1'), endpointsUrl('test/model-2')].sort()
    );
    expect(models['test/model-1']?.endpoints).toEqual([{ provider_name: 'test' }]);
    expect(models['test/model-2']?.endpoints).toEqual([{ provider_name: 'test' }]);
    expect(models['test/model-3']?.endpoints).toEqual([{ provider_name: 'stored' }]);
  });

  it('fails when too many listed models have no endpoints resource', async () => {
    mockGateway(modelId =>
      modelId.endsWith('-batch') || modelId === 'test/model-1' || modelId === 'test/model-2'
        ? 404
        : 200
    );
    jest.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(
      fetchGatewayModels(gateway, gatewayModelsSource(gateway, '/models'))
    ).rejects.toThrow('Suspicious: total number of vercel models is 98 < 100');
  });
});
