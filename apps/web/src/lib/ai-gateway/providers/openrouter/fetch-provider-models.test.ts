import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { fetchModelsForProvider } from '@/lib/ai-gateway/providers/openrouter/fetch-provider-models';
import { getModelDisplayPricing } from '@/lib/ai-gateway/providers/openrouter/display-pricing';
import type {
  OpenRouterModel,
  OpenRouterProvider,
} from '@/lib/ai-gateway/providers/openrouter/openrouter-types';

const provider: OpenRouterProvider = {
  name: 'OpenAI',
  displayName: 'OpenAI',
  slug: 'openai',
  dataPolicy: { training: false, retainsPrompts: true, canPublish: false },
};

function model(variant: string | null | undefined): OpenRouterModel {
  return {
    slug: 'openai/gpt-5.6-sol',
    name: 'OpenAI: GPT-5.6 Sol',
    author: 'openai',
    description: '',
    context_length: 1_050_000,
    input_modalities: ['text', 'image', 'file'],
    output_modalities: ['text'],
    group: 'GPT',
    updated_at: '2026-09-04T00:00:00.000Z',
    endpoint: {
      provider_display_name: 'OpenAI',
      variant,
      is_free: false,
      pricing:
        variant === 'batch'
          ? { prompt: '0.000001', completion: '0.000005', discount: 0.5 }
          : { prompt: '0.000002', completion: '0.00001', discount: 0.5 },
      data_policy: { training: false, retainsPrompts: true },
    },
  };
}

function mockModels(models: OpenRouterModel[]) {
  return jest.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ data: { models } }));
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe('fetchModelsForProvider', () => {
  it.each([false, true])(
    'keeps standard pricing for duplicate slugs regardless of order (batch first: %s)',
    async batchFirst => {
      const standard = model('standard');
      const batch = model('batch');
      mockModels(batchFirst ? [batch, standard] : [standard, batch]);

      const models = await fetchModelsForProvider(provider);

      expect(models).toEqual([standard]);
      expect(getModelDisplayPricing(models[0]?.endpoint?.pricing)).toEqual({
        prompt: '0.000004000000',
        completion: '0.000020000000',
      });
    }
  );

  it('excludes batch-only models rather than advertising unsupported pricing', async () => {
    mockModels([model('batch')]);

    expect(await fetchModelsForProvider(provider)).toEqual([]);
  });

  it.each([undefined, null, 'free', 'extended'])('preserves variant %s', async variant => {
    const entry = model(variant);
    mockModels([entry]);

    expect(await fetchModelsForProvider(provider)).toEqual([entry]);
  });

  it('preserves models without endpoints', async () => {
    const entry = { ...model(undefined), endpoint: null };
    mockModels([entry]);

    expect(await fetchModelsForProvider(provider)).toEqual([entry]);
  });

  it('uses the requested provider and attribution headers', async () => {
    const mockFetch = mockModels([]);

    await fetchModelsForProvider({ ...provider, name: 'Amazon Bedrock' });

    expect(mockFetch).toHaveBeenCalledWith(
      'https://openrouter.ai/api/frontend/v1/models/find?providers=Amazon+Bedrock&fmt=cards',
      {
        method: 'GET',
        headers: { 'HTTP-Referer': 'https://kilocode.ai', 'X-Title': 'Kilo Code' },
      }
    );
  });

  it('rejects upstream errors instead of returning an empty model list', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(null, {
        status: 503,
        statusText: 'Service Unavailable',
      })
    );

    await expect(fetchModelsForProvider(provider)).rejects.toThrow(
      'Failed to fetch models for provider OpenAI: 503 Service Unavailable'
    );
  });

  it('rejects malformed model data', async () => {
    jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(Response.json({ data: { models: [{ slug: 'openai/gpt-5.6-sol' }] } }));

    await expect(fetchModelsForProvider(provider)).rejects.toThrow();
  });
});
