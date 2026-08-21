import { describe, expect, test } from '@jest/globals';
import { injectExtraProviderModels } from '@/lib/ai-gateway/providers/openrouter/inject-extra-provider-models';
import {
  modelRetainsPrompts,
  modelTrains,
} from '@/lib/ai-gateway/providers/openrouter/model-data-policy';
import type {
  OpenRouterModel,
  OpenRouterProvider,
} from '@/lib/ai-gateway/providers/openrouter/openrouter-types';
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
