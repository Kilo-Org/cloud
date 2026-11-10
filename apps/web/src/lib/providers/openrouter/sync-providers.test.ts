import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { ai_gateway_metadata_cache } from '@kilocode/db/schema';
import { db, readDb, sql } from '@kilocode/web-shared/lib/drizzle';
import type { Provider } from '@kilocode/web-shared/lib/ai-gateway/providers/types';
import {
  gatewayModelEndpointsSource,
  gatewayModelsSource,
} from '@kilocode/web-shared/lib/ai-gateway/providers/gateway-model-metadata';
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

const modelsSource = gatewayModelsSource(gateway, '/models');

const listedModelIds = [
  ...Array.from({ length: 100 }, (_, index) => `test/model-${index}`),
  'test/model-0-batch',
];

function endpointsUrl(modelId: string) {
  return gatewayModelEndpointsSource(gateway, modelId).url;
}

function mockGateway(endpointsStatus: (modelId: string) => number | Promise<number>) {
  return jest.spyOn(global, 'fetch').mockImplementation(async input => {
    const url = String(input);
    if (url === `${gateway.apiUrl}/models`) {
      return Response.json({ data: listedModelIds.map(id => ({ id, name: id })) });
    }
    const modelId = url.slice(`${gateway.apiUrl}/models/`.length, -'/endpoints'.length);
    const status = await endpointsStatus(modelId);
    if (status !== 200) return new Response(null, { status });
    return Response.json({ data: { endpoints: [{ provider_name: 'test' }] } });
  });
}

function fetchedUrls(fetchSpy: jest.SpiedFunction<typeof fetch>) {
  return fetchSpy.mock.calls.map(([input]) => String(input));
}

function fetchedEndpointsUrls(fetchSpy: jest.SpiedFunction<typeof fetch>) {
  return fetchedUrls(fetchSpy).filter(url => url.endsWith('/endpoints'));
}

async function storeEndpointsRows(rows: ReadonlyArray<[modelId: string, data: unknown]>) {
  await db
    .insert(ai_gateway_metadata_cache)
    .values(rows.map(([modelId, data]) => ({ url: endpointsUrl(modelId), data })));
}

async function storeListRow(data: unknown) {
  await db.insert(ai_gateway_metadata_cache).values({ url: modelsSource.url, data });
}

function listBody(modelIds: readonly string[]) {
  return { data: modelIds.map(id => ({ id, name: `Stored ${id}` })) };
}

function storedEndpointsRows(modelIds: readonly string[]) {
  return modelIds.map((id): [string, unknown] => [
    id,
    id.endsWith('-batch') ? { status: 404 } : storedEndpoints,
  ]);
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

    const models = await fetchGatewayModels(gateway, modelsSource);

    expect(Object.keys(models)).toHaveLength(100);
    expect(models['test/model-0-batch']).toBeUndefined();
    expect(models['test/model-0']?.endpoints).toEqual([{ provider_name: 'test' }]);
  });

  it('fails on other live endpoint errors without starting the queued models', async () => {
    const selectSpy = jest.spyOn(readDb, 'select');
    const otherFetchesStarted = Promise.withResolvers<void>();
    const releaseOtherFetches = Promise.withResolvers<void>();
    let otherFetchCount = 0;
    const fetchSpy = mockGateway(async modelId => {
      if (modelId === 'test/model-7') return 500;
      otherFetchCount += 1;
      if (otherFetchCount === 7) otherFetchesStarted.resolve();
      await releaseOtherFetches.promise;
      return 200;
    });

    await expect(fetchGatewayModels(gateway, modelsSource)).rejects.toThrow(
      'Fetching https://gateway.test/v1/models/test/model-7/endpoints failed: 500'
    );
    await otherFetchesStarted.promise;
    releaseOtherFetches.resolve();

    // One read for the model list, then one per started model: the eight that fill the limiter.
    expect(selectSpy).toHaveBeenCalledTimes(9);
    expect(fetchedEndpointsUrls(fetchSpy).sort()).toEqual(
      listedModelIds
        .slice(0, 8)
        .map(id => endpointsUrl(id))
        .sort()
    );
  });

  it('uses stored endpoints, including a stored missing resource, without fetching them', async () => {
    const fetchSpy = mockGateway(() => 500);
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'debug').mockImplementation(() => {});
    await storeEndpointsRows(storedEndpointsRows(listedModelIds));

    const models = await fetchGatewayModels(gateway, modelsSource);

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
      ...storedEndpointsRows(
        listedModelIds.filter(id => id !== 'test/model-1' && id !== 'test/model-2')
      ),
      ['test/model-2', { data: { endpoints: 'not-a-list' } }],
    ]);

    const models = await fetchGatewayModels(gateway, modelsSource);

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

    await expect(fetchGatewayModels(gateway, modelsSource)).rejects.toThrow(
      'Suspicious: total number of vercel models is 98 < 100'
    );
  });

  it('uses the stored list and stored endpoints without fetching anything', async () => {
    const fetchSpy = mockGateway(() => 500);
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'debug').mockImplementation(() => {});
    await storeListRow(listBody(listedModelIds));
    await storeEndpointsRows(storedEndpointsRows(listedModelIds));

    const models = await fetchGatewayModels(gateway, modelsSource);

    expect(fetchedUrls(fetchSpy)).toEqual([]);
    expect(Object.keys(models)).toHaveLength(100);
    expect(models['test/model-0-batch']).toBeUndefined();
    expect(models['test/model-0']).toEqual({
      id: 'test/model-0',
      name: 'Stored test/model-0',
      endpoints: [{ provider_name: 'stored' }],
    });
  });

  it('fetches only the missing or unparseable endpoints of a stored list', async () => {
    const fetchSpy = mockGateway(() => 200);
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'debug').mockImplementation(() => {});
    await storeListRow(listBody(listedModelIds));
    await storeEndpointsRows([
      ...storedEndpointsRows(
        listedModelIds.filter(id => id !== 'test/model-1' && id !== 'test/model-2')
      ),
      ['test/model-2', { data: { endpoints: [{ provider_name: 'stored' }, 'not-an-endpoint'] } }],
    ]);

    const models = await fetchGatewayModels(gateway, modelsSource);

    expect(fetchedUrls(fetchSpy).sort()).toEqual(
      [endpointsUrl('test/model-1'), endpointsUrl('test/model-2')].sort()
    );
    expect(models['test/model-1']).toEqual({
      id: 'test/model-1',
      name: 'Stored test/model-1',
      endpoints: [{ provider_name: 'test' }],
    });
    expect(models['test/model-2']?.endpoints).toEqual([{ provider_name: 'test' }]);
    expect(models['test/model-3']?.endpoints).toEqual([{ provider_name: 'stored' }]);
  });

  it('fetches the list live when the stored list does not parse, still using stored endpoints', async () => {
    const fetchSpy = mockGateway(() => 500);
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'debug').mockImplementation(() => {});
    await storeListRow({ data: 'not-a-list' });
    await storeEndpointsRows(storedEndpointsRows(listedModelIds));

    const models = await fetchGatewayModels(gateway, modelsSource);

    expect(fetchedUrls(fetchSpy)).toEqual([modelsSource.url]);
    expect(warn).toHaveBeenCalledWith(
      '[fetchGatewayModels] stored vercel models are unusable',
      expect.anything()
    );
    expect(Object.keys(models)).toHaveLength(100);
    expect(models['test/model-0']).toEqual({
      id: 'test/model-0',
      name: 'test/model-0',
      endpoints: [{ provider_name: 'stored' }],
    });
  });

  it('fetches the list live when the stored list looks truncated', async () => {
    const fetchSpy = mockGateway(() => 500);
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'debug').mockImplementation(() => {});
    await storeListRow(listBody(listedModelIds.slice(0, 99)));
    await storeEndpointsRows(storedEndpointsRows(listedModelIds));

    const models = await fetchGatewayModels(gateway, modelsSource);

    expect(fetchedUrls(fetchSpy)).toEqual([modelsSource.url]);
    expect(warn).toHaveBeenCalledWith(
      '[fetchGatewayModels] stored vercel models are unusable',
      expect.objectContaining({
        message: `Suspicious: ${modelsSource.url} returned 99 entries, fewer than 100`,
      })
    );
    expect(Object.keys(models)).toHaveLength(100);
    expect(models['test/model-99']).toEqual({
      id: 'test/model-99',
      name: 'test/model-99',
      endpoints: [{ provider_name: 'stored' }],
    });
  });

  it('fails without fetching when too many stored models have no endpoints resource', async () => {
    const fetchSpy = mockGateway(() => 200);
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    await storeListRow(listBody(listedModelIds));
    await storeEndpointsRows([
      ...storedEndpointsRows(
        listedModelIds.filter(id => id !== 'test/model-1' && id !== 'test/model-2')
      ),
      ['test/model-1', { status: 404 }],
      ['test/model-2', { status: 404 }],
    ]);

    await expect(fetchGatewayModels(gateway, modelsSource)).rejects.toThrow(
      'Suspicious: total number of vercel models is 98 < 100'
    );
    expect(fetchedUrls(fetchSpy)).toEqual([]);
  });
});
