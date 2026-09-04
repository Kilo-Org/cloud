import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { fetchModelsForProvider } from './fetch-provider-models';
import { getModelDisplayPricing } from './display-pricing';
import type { OpenRouterModel, OpenRouterProvider } from './openrouter-types';

const provider = {
  name: 'OpenAI',
  displayName: 'OpenAI',
  slug: 'openai',
  dataPolicy: { training: false, retainsPrompts: true, canPublish: false },
} satisfies OpenRouterProvider;

const standardModel = {
  slug: 'openai/gpt-5.6-sol',
  name: 'OpenAI: GPT-5.6 Sol',
  author: 'openai',
  description: 'GPT-5.6 Sol',
  context_length: 1050000,
  input_modalities: ['text', 'image', 'file'],
  output_modalities: ['text'],
  group: 'GPT',
  updated_at: '2026-09-04T00:00:00Z',
  endpoint: {
    variant: 'standard',
    model_variant_slug: 'openai/gpt-5.6-sol',
    provider_display_name: 'OpenAI',
    is_free: false,
    pricing: { prompt: '0.000002', completion: '0.00001', discount: 0.5 },
  },
} satisfies OpenRouterModel;

const batchModel = {
  ...standardModel,
  endpoint: {
    ...standardModel.endpoint,
    variant: 'batch',
    model_variant_slug: 'openai/gpt-5.6-sol:batch',
    pricing: { prompt: '0.000001', completion: '0.000005', discount: 0.5 },
  },
} satisfies OpenRouterModel;

function mockModels(models: OpenRouterModel[]) {
  jest.spyOn(global, 'fetch').mockResolvedValue(Response.json({ data: { models } }));
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe('fetchModelsForProvider', () => {
  it.each([
    ['standard first', [standardModel, batchModel]],
    ['batch first', [batchModel, standardModel]],
  ])('keeps standard pricing when duplicate cards arrive %s', async (_order, cards) => {
    mockModels(cards);

    const models = await fetchModelsForProvider(provider);

    expect(models).toEqual([standardModel]);
    expect(getModelDisplayPricing(models[0].endpoint?.pricing)).toEqual({
      prompt: '0.000004000000',
      completion: '0.000020000000',
    });
  });

  it.each([
    ['variant', { ...batchModel, endpoint: { ...batchModel.endpoint, model_variant_slug: null } }],
    ['endpoint slug', { ...batchModel, endpoint: { ...batchModel.endpoint, variant: null } }],
    [
      'model slug',
      {
        ...batchModel,
        slug: 'openai/gpt-5.6-sol:batch',
        endpoint: { ...batchModel.endpoint, variant: undefined, model_variant_slug: undefined },
      },
    ],
  ])('excludes batch-only models identified by %s', async (_field, model) => {
    mockModels([model]);

    expect(await fetchModelsForProvider(provider)).toEqual([]);
  });

  it.each(['vendor/model', 'vendor/model:free'])(
    'preserves a free variant with model slug %s',
    async slug => {
      const freeModel = {
        ...standardModel,
        slug,
        endpoint: {
          ...standardModel.endpoint,
          variant: 'free',
          model_variant_slug: 'vendor/model:free',
          is_free: true,
          pricing: { prompt: '0', completion: '0' },
        },
      };
      mockModels([freeModel]);

      expect(await fetchModelsForProvider(provider)).toEqual([freeModel]);
    }
  );

  it.each([undefined, null])('preserves models with %s variant metadata', async metadata => {
    const model = {
      ...standardModel,
      endpoint: {
        ...standardModel.endpoint,
        variant: metadata,
        model_variant_slug: metadata,
      },
    };
    mockModels([model]);

    expect(await fetchModelsForProvider(provider)).toEqual([model]);
  });

  it('preserves models without an endpoint', async () => {
    const model = { ...standardModel, endpoint: null };
    mockModels([model]);

    expect(await fetchModelsForProvider(provider)).toEqual([model]);
  });

  it('rejects failed upstream requests', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(new Response(null, { status: 503 }));

    await expect(fetchModelsForProvider(provider)).rejects.toThrow(
      'Failed to fetch models for provider OpenAI: 503'
    );
  });
});
