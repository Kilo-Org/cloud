import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { StoredModel } from '@kilocode/db/schema-types';
import type { Provider } from '@kilocode/web-shared/lib/ai-gateway/providers/types';
import type {
  NormalizedProvider,
  OpenRouterModel,
  OpenRouterProvider,
} from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/openrouter-types';
import {
  fetchGatewayModels,
  fetchProviderModels,
  getRefreshedThrough,
  mergeRefreshFailures,
} from './sync-providers';

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
  ...Array.from({ length: 110 }, (_, index) => `test/model-${index}`),
  'test/model-0-batch',
];

function timeoutError() {
  return new DOMException('The operation was aborted due to timeout', 'TimeoutError');
}

function mockGateway(endpointsResponse: (modelId: string) => number | 'timeout') {
  return jest.spyOn(global, 'fetch').mockImplementation(async input => {
    const url = String(input);
    if (url === `${gateway.apiUrl}/models`) {
      return Response.json({ data: listedModelIds.map(id => ({ id, name: id })) });
    }
    const modelId = url.slice(`${gateway.apiUrl}/models/`.length, -'/endpoints'.length);
    const response = endpointsResponse(modelId);
    if (response === 'timeout') throw timeoutError();
    if (response !== 200) return new Response(null, { status: response });
    return Response.json({ data: { endpoints: [{ provider_name: 'fresh' }] } });
  });
}

function storedModel(id: string): StoredModel {
  return { id, name: id, endpoints: [{ provider_name: 'previous' }] };
}

const noPreviousModels = async () => {
  throw new Error('previous snapshot should not be loaded');
};

beforeEach(() => {
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'debug').mockImplementation(() => {});
  jest.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('fetchGatewayModels', () => {
  it('skips listed models whose endpoints resource does not exist', async () => {
    mockGateway(modelId => (modelId.endsWith('-batch') ? 404 : 200));

    const { models, failures } = await fetchGatewayModels(gateway, '/models', noPreviousModels);

    expect(Object.keys(models)).toHaveLength(110);
    expect(models['test/model-0-batch']).toBeUndefined();
    expect(models['test/model-0']?.endpoints).toEqual([{ provider_name: 'fresh' }]);
    expect(failures).toEqual([]);
  });

  it('keeps previous data for models whose endpoints fail and reports each failure', async () => {
    mockGateway(modelId => {
      if (modelId === 'test/model-7') return 408;
      if (modelId === 'test/model-8') return 'timeout';
      if (modelId === 'test/model-9') return 500;
      return 200;
    });
    const getPreviousModels = jest.fn(async () => ({
      'test/model-7': storedModel('test/model-7'),
      'test/model-8': storedModel('test/model-8'),
    }));

    const { models, failures } = await fetchGatewayModels(gateway, '/models', getPreviousModels);

    expect(getPreviousModels).toHaveBeenCalledTimes(1);
    expect(models['test/model-7']?.endpoints).toEqual([{ provider_name: 'previous' }]);
    expect(models['test/model-8']?.endpoints).toEqual([{ provider_name: 'previous' }]);
    expect(models['test/model-9']).toBeUndefined();
    expect(models['test/model-10']?.endpoints).toEqual([{ provider_name: 'fresh' }]);
    expect(failures).toEqual(
      expect.arrayContaining([
        { entry: 'vercel endpoints for test/model-7', error: '408' },
        { entry: 'vercel endpoints for test/model-8', error: 'timed out after 20s' },
        { entry: 'vercel endpoints for test/model-9', error: '500' },
      ])
    );
    expect(failures).toHaveLength(3);
  });

  it('fails the run when too many endpoint requests fail', async () => {
    mockGateway(modelId => {
      if (modelId.endsWith('-batch')) return 404;
      return Number(modelId.split('-')[1]) < 12 ? 408 : 200;
    });

    await expect(fetchGatewayModels(gateway, '/models', noPreviousModels)).rejects.toThrow(
      /^12 of 111 vercel model endpoint requests failed to refresh; first: vercel endpoints for test\/model-\d+: 408$/
    );
  });

  it('fails the run when the model list cannot be fetched', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(new Response(null, { status: 502 }));

    await expect(fetchGatewayModels(gateway, '/models', noPreviousModels)).rejects.toThrow(
      'Fetching models from vercel failed: 502'
    );
  });
});

function providerOf(name: string): OpenRouterProvider {
  return {
    name,
    displayName: name,
    slug: name.toLowerCase(),
    dataPolicy: { training: false, retainsPrompts: false, canPublish: false },
  };
}

function modelOf(slug: string, providerName: string): OpenRouterModel {
  return {
    slug,
    name: slug,
    author: 'test',
    description: '',
    context_length: 1000,
    input_modalities: ['text'],
    output_modalities: ['text'],
    group: 'test',
    updated_at: '2026-10-01T00:00:00.000Z',
    endpoint: {
      provider_display_name: providerName,
      is_free: false,
      pricing: { prompt: '0.000001', completion: '0.000002' },
    },
  };
}

function previousProviderOf(name: string, models: OpenRouterModel[]): NormalizedProvider {
  return { ...providerOf(name), headquarters: 'US', datacenters: ['US'], models };
}

function mockProviderModels(response: (providerName: string) => number | 'timeout') {
  jest.spyOn(global, 'fetch').mockImplementation(async input => {
    const providerName = new URL(String(input)).searchParams.get('providers') ?? '';
    const result = response(providerName);
    if (result === 'timeout') throw timeoutError();
    if (result !== 200) return new Response(null, { status: result });
    return Response.json({ data: { models: [modelOf(`fresh/${providerName}`, providerName)] } });
  });
}

describe('fetchProviderModels', () => {
  const providers = Array.from({ length: 20 }, (_, index) => providerOf(`Provider${index}`));

  it('keeps the previous models of a provider whose request fails', async () => {
    mockProviderModels(name => (name === 'Provider3' ? 'timeout' : 200));
    const previousModel = modelOf('previous/model', 'Provider3');

    const { providerModelData, failures } = await fetchProviderModels(providers, async () => [
      previousProviderOf('Provider3', [previousModel]),
    ]);

    expect(providerModelData.find(data => data.provider.name === 'Provider3')?.models).toEqual([
      previousModel,
    ]);
    expect(providerModelData.find(data => data.provider.name === 'Provider4')?.models).toEqual([
      modelOf('fresh/Provider4', 'Provider4'),
    ]);
    expect(failures).toEqual([
      { entry: 'models for provider Provider3', error: 'timed out after 20s' },
    ]);
  });

  it('leaves a failed provider without previous data empty', async () => {
    mockProviderModels(name => (name === 'Provider3' ? 503 : 200));

    const { providerModelData } = await fetchProviderModels(providers, async () => []);

    expect(providerModelData.find(data => data.provider.name === 'Provider3')?.models).toEqual([]);
  });

  it('fails the run when too many provider requests fail', async () => {
    mockProviderModels(name =>
      ['Provider1', 'Provider2', 'Provider3'].includes(name) ? 503 : 200
    );

    await expect(fetchProviderModels(providers, async () => [])).rejects.toThrow(
      /^3 of 20 provider model requests failed to refresh/
    );
  });
});

describe('mergeRefreshFailures', () => {
  const now = new Date('2026-10-14T12:00:00.000Z');

  it('keeps the first failure time of entries that are still failing', () => {
    expect(
      mergeRefreshFailures(
        {
          'still failing': { since: '2026-10-14T11:00:00.000Z', error: '408' },
          recovered: { since: '2026-10-14T10:00:00.000Z', error: '408' },
        },
        [
          { entry: 'still failing', error: '524' },
          { entry: 'new failure', error: 'timed out after 20s' },
        ],
        now
      )
    ).toEqual({
      'still failing': { since: '2026-10-14T11:00:00.000Z', error: '524' },
      'new failure': { since: now.toISOString(), error: 'timed out after 20s' },
    });
  });

  it('truncates long error messages', () => {
    const merged = mergeRefreshFailures({}, [{ entry: 'entry', error: 'x'.repeat(1000) }], now);

    expect(merged.entry?.error).toHaveLength(300);
  });
});

describe('getRefreshedThrough', () => {
  const now = new Date('2026-10-14T12:00:00.000Z');

  it('is now when every entry refreshed', () => {
    expect(getRefreshedThrough({}, now)).toBe(now.toISOString());
  });

  it('is the oldest first failure time among entries using previous data', () => {
    expect(
      getRefreshedThrough(
        {
          a: { since: '2026-10-14T11:30:00.000Z', error: '408' },
          b: { since: '2026-10-14T10:45:00.000Z', error: '408' },
        },
        now
      )
    ).toBe('2026-10-14T10:45:00.000Z');
  });
});
