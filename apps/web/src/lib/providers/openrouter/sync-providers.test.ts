import { afterEach, describe, expect, it, jest } from '@jest/globals';
import type { CustomLlm } from '@kilocode/web-shared/lib/ai-gateway/custom-llm/custom-llm-catalog';
import type {
  NormalizedProvider,
  OpenRouterModel,
  OpenRouterProvider,
} from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/openrouter-types';
import type { Provider } from '@kilocode/web-shared/lib/ai-gateway/providers/types';
import { fetchGatewayModels, syncProviders } from './sync-providers';

jest.mock('@kilocode/web-shared/lib/ai-gateway/unavailable-models', () => ({
  ...(jest.requireActual('@kilocode/web-shared/lib/ai-gateway/unavailable-models') as Record<
    string,
    unknown
  >),
  getUnavailableModelIds: jest.fn(async () => new Set<string>()),
}));

jest.mock('./inject-direct-byok-providers', () => ({
  injectDirectByokProviders: jest.fn(async (providers: readonly NormalizedProvider[]) => [
    ...providers,
  ]),
}));

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

describe('syncProviders', () => {
  it.each([
    { providerTrains: true, includeOptIn: true, hasUpstreamModels: true },
    { providerTrains: true, includeOptIn: false, hasUpstreamModels: true },
    { providerTrains: false, includeOptIn: true, hasUpstreamModels: true },
    { providerTrains: false, includeOptIn: false, hasUpstreamModels: true },
    { providerTrains: true, includeOptIn: true, hasUpstreamModels: false },
  ])('preserves custom endpoint policies with %j', async params => {
    const { providerTrains, includeOptIn, hasUpstreamModels } = params;
    const provider: OpenRouterProvider = {
      name: 'Acme',
      displayName: 'Acme Inference',
      slug: 'acme',
      dataPolicy: { training: providerTrains, retainsPrompts: false, canPublish: false },
    };
    const upstreamModel: OpenRouterModel = {
      slug: 'acme/upstream',
      name: 'Upstream model',
      author: 'Acme',
      description: '',
      context_length: 64_000,
      input_modalities: ['text'],
      output_modalities: ['text'],
      group: 'other',
      updated_at: '2026-11-03T00:00:00.000Z',
      endpoint: {
        provider_display_name: 'Acme Inference',
        is_free: false,
        pricing: { prompt: '0.000001', completion: '0.000002' },
        data_policy: { training: false, retainsPrompts: false },
      },
    };
    const upstreamModels: OpenRouterModel[] = hasUpstreamModels
      ? [
          upstreamModel,
          {
            ...upstreamModel,
            slug: 'custom/default',
            endpoint: {
              ...upstreamModel.endpoint,
              provider_display_name: 'Acme Inference',
              is_free: true,
              pricing: { prompt: '0', completion: '0' },
            },
          },
        ]
      : [];
    const customLlms: CustomLlm[] = [
      { id: 'custom/default', training: undefined },
      { id: 'custom/false', training: false },
      ...(includeOptIn ? [{ id: 'custom/true', training: true }] : []),
    ].map(({ id, training }) => ({
      public_id: id,
      encrypted_api_key: null,
      definition: {
        display_name: id,
        context_length: 64_000,
        max_completion_tokens: 8_000,
        base_url: 'https://custom.example.com/v1',
        may_train_on_prompts: training,
        public: { inference_providers: ['acme', 'custom-only'], description: 'Custom model' },
        pricing: [
          {
            start_context_length: 0,
            pricing: {
              prompt_per_million: 2,
              completion_per_million: 8,
              input_cache_read_per_million: null,
              input_cache_write_per_million: null,
            },
          },
        ],
      },
    }));
    jest.spyOn(global, 'fetch').mockImplementation(async input => {
      const url = new URL(String(input));
      expect(url.pathname).toBe('/api/frontend/v1/models/find');
      expect(url.searchParams.get('providers')).toBe('Acme');
      return Response.json({ data: { models: upstreamModels } });
    });
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});

    const snapshot = await syncProviders({
      providers: [provider],
      openRouterModels: {},
      openRouterCatalogModels: [],
      vercelModels: {},
      vercelModelIdOverrides: new Map(),
      customLlms,
    });

    expect(snapshot.total_providers).toBe(2);
    expect(snapshot.total_models).toBe(customLlms.length * 2 + Number(hasUpstreamModels));
    for (const normalizedProvider of snapshot.providers) {
      expect(normalizedProvider.dataPolicy).toMatchObject({
        training: (normalizedProvider.slug === 'acme' && providerTrains) || includeOptIn,
        retainsPrompts: true,
      });
      for (const customLlm of customLlms) {
        expect(
          normalizedProvider.models.find(model => model.slug === customLlm.public_id)?.endpoint
        ).toMatchObject({
          provider_display_name: 'Other',
          is_free: false,
          data_policy: {
            training: customLlm.definition.may_train_on_prompts ?? false,
            retainsPrompts: true,
          },
        });
      }
      if (normalizedProvider.slug === 'acme') {
        expect(normalizedProvider.displayName).toBe('Acme Inference');
        if (hasUpstreamModels) {
          expect(
            normalizedProvider.models.find(model => model.slug === upstreamModel.slug)?.endpoint
              ?.data_policy
          ).toEqual({ training: providerTrains, retainsPrompts: false });
        }
      }
    }
  });
});
