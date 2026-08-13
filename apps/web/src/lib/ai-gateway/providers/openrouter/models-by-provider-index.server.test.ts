import { describe, expect, test } from '@jest/globals';
import type { StoredModel } from '@kilocode/db/schema-types';
import type { NormalizedOpenRouterResponse } from '@/lib/ai-gateway/providers/openrouter/openrouter-types';
import { buildModelIdToProviderSlugsIndex } from '@/lib/ai-gateway/providers/openrouter/models-by-provider-index.server';

function providerModel(providerSlug: string, isFree: boolean) {
  return {
    name: providerSlug,
    displayName: providerSlug,
    slug: providerSlug,
    dataPolicy: { training: false, retainsPrompts: false, canPublish: false },
    models: [
      {
        slug: 'nvidia/nemotron-3.5-lightning',
        name: 'NVIDIA: Nemotron 3.5 Lightning',
        author: 'NVIDIA',
        description: '',
        context_length: 1_000_000,
        input_modalities: ['text'],
        output_modalities: ['text'],
        group: 'nemotron',
        updated_at: '2026-08-13',
        endpoint: {
          provider_display_name: providerSlug,
          is_free: isFree,
          pricing: { prompt: isFree ? '0' : '0.0000001', completion: '0.0000002' },
        },
      },
    ],
  };
}

describe('model provider index', () => {
  test('keeps suffixed endpoint providers separate from unsuffixed providers', () => {
    const snapshot = {
      providers: [providerModel('coreweave', false), providerModel('nvidia', true)],
      total_providers: 2,
      total_models: 2,
      generated_at: '2026-08-13T00:00:00.000Z',
    } satisfies NormalizedOpenRouterResponse;
    const openRouterModels = {
      'nvidia/nemotron-3.5-lightning:free': {
        id: 'nvidia/nemotron-3.5-lightning:free',
        name: 'NVIDIA: Nemotron 3.5 Lightning (free)',
        type: 'language',
        endpoints: [{ tag: 'nvidia/nvfp4', provider_name: 'Nvidia' }],
      },
    } satisfies Record<string, StoredModel>;

    const index = buildModelIdToProviderSlugsIndex(snapshot, openRouterModels);

    expect(index.get('nvidia/nemotron-3.5-lightning')).toEqual(new Set(['coreweave', 'nvidia']));
    expect(index.get('nvidia/nemotron-3.5-lightning:free')).toEqual(new Set(['nvidia']));
  });

  test('uses exact endpoint metadata for non-free suffixes', () => {
    const snapshot = {
      providers: [
        {
          ...providerModel('alibaba', false),
          models: [
            {
              ...providerModel('alibaba', false).models[0],
              slug: 'qwen/qwen-plus-2025-07-28',
            },
          ],
        },
      ],
      total_providers: 1,
      total_models: 1,
      generated_at: '2026-08-13T00:00:00.000Z',
    } satisfies NormalizedOpenRouterResponse;
    const openRouterModels = {
      'qwen/qwen-plus-2025-07-28:thinking': {
        id: 'qwen/qwen-plus-2025-07-28:thinking',
        name: 'Qwen: Qwen Plus 0728 (thinking)',
        endpoints: [{ provider_name: 'alibaba' }],
      },
    } satisfies Record<string, StoredModel>;

    const index = buildModelIdToProviderSlugsIndex(snapshot, openRouterModels);

    expect(index.get('qwen/qwen-plus-2025-07-28:thinking')).toEqual(new Set(['alibaba']));
  });
});
