import { describe, expect, test } from '@jest/globals';
import {
  injectExtraProviderModels,
  injectVercelOnlyProviders,
} from '@/lib/providers/openrouter/inject-extra-provider-models';
import {
  modelRetainsPrompts,
  modelTrains,
} from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/model-data-policy';
import type {
  OpenRouterModel,
  OpenRouterProvider,
} from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/openrouter-types';
import type { StoredModel } from '@kilocode/db/schema-types';

const MODEL_SLUG = 'nvidia/nemotron-3-super-120b-a12b';

function provider(
  slug: string,
  displayName: string,
  dataPolicy: OpenRouterProvider['dataPolicy']
): OpenRouterProvider {
  return {
    name: displayName,
    displayName,
    slug,
    dataPolicy,
  };
}

function nvidiaModel(): OpenRouterModel {
  return {
    slug: MODEL_SLUG,
    name: 'NVIDIA: Nemotron 3 Super',
    author: 'nvidia',
    description: '',
    context_length: 256_000,
    input_modalities: ['text'],
    output_modalities: ['text'],
    group: 'Nemotron',
    updated_at: '2026-08-09T00:00:00.000Z',
    endpoint: {
      provider_display_name: 'NVIDIA',
      is_free: true,
      pricing: { prompt: '0', completion: '0' },
      data_policy: { training: true, retainsPrompts: true },
    },
  };
}

describe('injectExtraProviderModels', () => {
  test('does not copy the source provider data policy onto injected offerings', () => {
    const nvidia = nvidiaModel();
    const providerModelData = [
      {
        provider: provider('nvidia', 'NVIDIA', {
          training: true,
          retainsPrompts: true,
          canPublish: false,
        }),
        models: [nvidia],
      },
      {
        provider: provider('amazon-bedrock', 'Amazon Bedrock', {
          training: false,
          retainsPrompts: false,
          canPublish: false,
        }),
        models: [] as OpenRouterModel[],
      },
    ];
    const vercelModels: Record<string, StoredModel> = {
      [MODEL_SLUG]: {
        id: MODEL_SLUG,
        name: 'NVIDIA Nemotron 3 Super',
        endpoints: [
          {
            provider_name: 'nvidia',
            pricing: { prompt: '0', completion: '0' },
          },
          {
            provider_name: 'bedrock',
            context_length: 256_000,
            pricing: { prompt: '0.15', completion: '0.65' },
          },
        ],
      },
    };

    injectExtraProviderModels(vercelModels, providerModelData);

    const injected = providerModelData[1]?.models[0];
    expect(injected?.slug).toBe(MODEL_SLUG);
    expect(injected?.endpoint).toEqual({
      provider_display_name: 'Amazon Bedrock',
      is_free: false,
      pricing: { prompt: '0.15', completion: '0.65' },
    });
    expect(injected && modelTrains(injected, false)).toBe(false);
    expect(injected && modelRetainsPrompts(injected, false)).toBe(false);
    expect(nvidia.endpoint?.data_policy).toEqual({ training: true, retainsPrompts: true });
    expect(modelTrains(nvidia, true)).toBe(true);
    expect(modelRetainsPrompts(nvidia, true)).toBe(true);
  });

  test('injects offerings for providers outside the known provider registry', () => {
    const model = nvidiaModel();
    const providerModelData = [
      {
        provider: provider('nvidia', 'NVIDIA', {
          training: true,
          retainsPrompts: true,
          canPublish: false,
        }),
        models: [model],
      },
      {
        provider: provider('future-provider', 'Future Provider', {
          training: false,
          retainsPrompts: false,
          canPublish: false,
        }),
        models: [] as OpenRouterModel[],
      },
    ];
    const vercelModels: Record<string, StoredModel> = {
      [MODEL_SLUG]: {
        id: MODEL_SLUG,
        name: model.name,
        endpoints: [
          { provider_name: 'nvidia' },
          { provider_name: 'future-provider', context_length: 128_000 },
        ],
      },
    };

    injectExtraProviderModels(vercelModels, providerModelData);

    expect(providerModelData[1]?.models[0]?.slug).toBe(MODEL_SLUG);
    expect(providerModelData[1]?.models[0]?.context_length).toBe(128_000);
  });
});

describe('injectVercelOnlyProviders', () => {
  function nvidiaProviderModelData() {
    return [
      {
        provider: provider('nvidia', 'NVIDIA', {
          training: true,
          retainsPrompts: true,
          canPublish: false,
        }),
        models: [nvidiaModel()],
      },
      {
        provider: provider('amazon-bedrock', 'Amazon Bedrock', {
          training: false,
          retainsPrompts: false,
          canPublish: false,
        }),
        models: [] as OpenRouterModel[],
      },
    ];
  }

  test('adds providers that only serve snapshot models through Vercel', () => {
    const providerModelData = nvidiaProviderModelData();
    const vercelModels: Record<string, StoredModel> = {
      [MODEL_SLUG]: {
        id: MODEL_SLUG,
        name: 'NVIDIA Nemotron 3 Super',
        endpoints: [
          { provider_name: 'nvidia', has_zdr: false, has_no_training: false },
          { provider_name: 'bedrock', has_zdr: true, has_no_training: true },
          {
            provider_name: 'runinfra',
            context_length: 128_000,
            pricing: { prompt: '0.0000001', completion: '0.0000004' },
            has_zdr: true,
            has_no_training: true,
          },
        ],
      },
    };

    injectVercelOnlyProviders(vercelModels, providerModelData);

    expect(providerModelData.map(({ provider }) => provider.slug)).toEqual([
      'nvidia',
      'amazon-bedrock',
      'runinfra',
    ]);
    const runinfra = providerModelData[2];
    expect(runinfra?.provider).toEqual({
      name: 'Runinfra',
      displayName: 'Runinfra',
      slug: 'runinfra',
      dataPolicy: { training: false, retainsPrompts: false, canPublish: false },
      icon: { url: 'https://placehold.co/100?text=RU&font=roboto', className: 'rounded-sm' },
    });
    expect(runinfra?.models).toHaveLength(1);
    expect(runinfra?.models[0]?.slug).toBe(MODEL_SLUG);
    expect(runinfra?.models[0]?.context_length).toBe(128_000);
    expect(runinfra?.models[0]?.endpoint).toEqual({
      provider_display_name: 'Runinfra',
      is_free: false,
      pricing: { prompt: '0.0000001', completion: '0.0000004' },
      data_policy: { training: false, retainsPrompts: false },
    });
  });

  test('treats missing Vercel data policy guarantees as training and retaining prompts', () => {
    const providerModelData = nvidiaProviderModelData();
    const vercelModels: Record<string, StoredModel> = {
      [MODEL_SLUG]: {
        id: MODEL_SLUG,
        name: 'NVIDIA Nemotron 3 Super',
        endpoints: [
          { provider_name: 'nvidia' },
          { provider_name: 'boundless', has_zdr: true, has_no_training: false },
        ],
      },
    };

    injectVercelOnlyProviders(vercelModels, providerModelData);

    const boundless = providerModelData.find(({ provider }) => provider.slug === 'boundless');
    expect(boundless?.provider.dataPolicy).toEqual({
      training: true,
      retainsPrompts: false,
      canPublish: false,
    });
    expect(boundless?.models[0]?.endpoint?.data_policy).toEqual({
      training: true,
      retainsPrompts: false,
    });
  });

  test('does not add providers already known under an OpenRouter slug', () => {
    const providerModelData = nvidiaProviderModelData();
    const vercelModels: Record<string, StoredModel> = {
      [MODEL_SLUG]: {
        id: MODEL_SLUG,
        name: 'NVIDIA Nemotron 3 Super',
        endpoints: [{ provider_name: 'nvidia' }, { provider_name: 'bedrock' }],
      },
    };

    injectVercelOnlyProviders(vercelModels, providerModelData);

    expect(providerModelData.map(({ provider }) => provider.slug)).toEqual([
      'nvidia',
      'amazon-bedrock',
    ]);
  });

  test('ignores Vercel models that are not in the snapshot', () => {
    const providerModelData = nvidiaProviderModelData();
    const vercelModels: Record<string, StoredModel> = {
      'vendor/vercel-only-model': {
        id: 'vendor/vercel-only-model',
        name: 'Vercel Only Model',
        endpoints: [{ provider_name: 'boundless' }],
      },
    };

    injectVercelOnlyProviders(vercelModels, providerModelData);

    expect(providerModelData).toHaveLength(2);
  });

  test('skips provider ids that routing would lowercase', () => {
    const providerModelData = nvidiaProviderModelData();
    const vercelModels: Record<string, StoredModel> = {
      [MODEL_SLUG]: {
        id: MODEL_SLUG,
        name: 'NVIDIA Nemotron 3 Super',
        endpoints: [{ provider_name: 'nvidia' }, { provider_name: 'futureProvider' }],
      },
    };

    injectVercelOnlyProviders(vercelModels, providerModelData);

    expect(providerModelData).toHaveLength(2);
  });
});
