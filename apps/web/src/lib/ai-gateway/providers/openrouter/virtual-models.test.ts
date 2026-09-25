import { describe, expect, test } from '@jest/globals';
import {
  injectVirtualModels,
  VIRTUAL_PROVIDER,
} from '@/lib/ai-gateway/providers/openrouter/virtual-models';
import { buildModelIdToProviderSlugsIndex } from '@/lib/ai-gateway/providers/openrouter/models-by-provider-index.server';
import type {
  OpenRouterModel,
  OpenRouterProvider,
} from '@/lib/ai-gateway/providers/openrouter/openrouter-types';
import type { OpenRouterModel as CatalogModel } from '@/lib/organizations/organization-types';
import type { StoredModel } from '@kilocode/db/schema-types';

const SONNET = 'anthropic/claude-sonnet-5';
const SONNET_LATEST = '~anthropic/claude-sonnet-latest';

function provider(slug: string): OpenRouterProvider {
  return {
    name: slug,
    displayName: slug,
    slug,
    dataPolicy: { training: false, retainsPrompts: false, canPublish: false },
  };
}

function snapshotModel(
  slug: string,
  endpoint: Partial<NonNullable<OpenRouterModel['endpoint']>> = {}
): OpenRouterModel {
  return {
    slug,
    name: slug,
    author: slug.split('/')[0] ?? '',
    description: '',
    context_length: 1_000_000,
    input_modalities: ['text'],
    output_modalities: ['text'],
    group: 'Claude',
    updated_at: '2026-09-01T00:00:00.000Z',
    endpoint: {
      provider_display_name: 'Provider',
      is_free: false,
      pricing: { prompt: '0.000003', completion: '0.000015' },
      ...endpoint,
    },
  };
}

function catalogModel(
  id: string,
  name: string,
  pricing: CatalogModel['pricing'] = { prompt: '-1', completion: '-1' }
): CatalogModel {
  return {
    id,
    name,
    created: 1_790_000_000,
    description: `${name} description`,
    architecture: {
      input_modalities: ['text', 'image'],
      output_modalities: ['text'],
      tokenizer: 'Router',
    },
    top_provider: { is_moderated: false },
    pricing,
    context_length: 2_000_000,
  };
}

function storedModel(id: string, aliasTarget?: string): StoredModel {
  return {
    id,
    name: id,
    endpoints: [],
    ...(aliasTarget && { alias_target: { slug: aliasTarget } }),
  };
}

describe('injectVirtualModels', () => {
  test('lists a latest alias under every provider that serves its standard target', () => {
    const providerModelData = [
      { provider: provider('anthropic'), models: [snapshotModel(SONNET)] },
      {
        provider: provider('amazon-bedrock'),
        models: [
          snapshotModel(SONNET, { pricing: { prompt: '0.0000033', completion: '0.0000165' } }),
        ],
      },
      {
        provider: provider('free-host'),
        models: [snapshotModel(SONNET, { variant: 'free', is_free: true })],
      },
      { provider: provider('openai'), models: [snapshotModel('openai/gpt-6-sol')] },
    ];

    injectVirtualModels({
      providerModelData,
      catalogModels: [catalogModel(SONNET_LATEST, 'Anthropic: Claude Sonnet Latest')],
      storedModels: { [SONNET_LATEST]: storedModel(SONNET_LATEST, SONNET) },
    });

    const index = buildModelIdToProviderSlugsIndex({
      providers: providerModelData.map(({ provider, models }) => ({ ...provider, models })),
      total_providers: providerModelData.length,
      total_models: 0,
      generated_at: '',
    });
    expect([...(index.get(SONNET_LATEST) ?? [])]).toEqual(['anthropic', 'amazon-bedrock']);
    expect(providerModelData.some(({ provider }) => provider.slug === VIRTUAL_PROVIDER.slug)).toBe(
      false
    );
    const bedrockAlias = providerModelData[1]?.models.find(model => model.slug === SONNET_LATEST);
    expect(bedrockAlias).toMatchObject({
      name: 'Anthropic: Claude Sonnet Latest',
      description: 'Anthropic: Claude Sonnet Latest description',
      endpoint: { pricing: { prompt: '0.0000033', completion: '0.0000165' } },
    });
  });

  test('lists providerless routers under the virtual provider', () => {
    const providerModelData = [{ provider: provider('typesafe'), models: [snapshotModel(SONNET)] }];

    injectVirtualModels({
      providerModelData,
      catalogModels: [
        catalogModel('typesafe/jev-router', 'TypeSafe: Jev Router'),
        catalogModel('openrouter/free', 'Free Models Router', { prompt: '0', completion: '0' }),
      ],
      storedModels: {},
    });

    const virtual = providerModelData.find(
      ({ provider }) => provider.slug === VIRTUAL_PROVIDER.slug
    );
    expect(virtual?.models).toEqual([
      {
        slug: 'typesafe/jev-router',
        name: 'TypeSafe: Jev Router',
        author: 'typesafe',
        description: 'TypeSafe: Jev Router description',
        context_length: 2_000_000,
        input_modalities: ['text', 'image'],
        output_modalities: ['text'],
        group: 'Router',
        updated_at: new Date(1_790_000_000_000).toISOString(),
        endpoint: {
          provider_display_name: 'Virtual',
          is_free: false,
          pricing: { prompt: '-1', completion: '-1' },
        },
      },
      expect.objectContaining({
        slug: 'openrouter/free',
        endpoint: {
          provider_display_name: 'Virtual',
          is_free: true,
          pricing: { prompt: '0', completion: '0' },
          data_policy: { training: true, retainsPrompts: true },
        },
      }),
    ]);
  });

  test('falls back to the virtual provider when no provider serves the alias target', () => {
    const providerModelData = [
      { provider: provider('anthropic'), models: [snapshotModel('anthropic/claude-haiku-4.5')] },
    ];

    injectVirtualModels({
      providerModelData,
      catalogModels: [catalogModel(SONNET_LATEST, 'Anthropic: Claude Sonnet Latest')],
      storedModels: { [SONNET_LATEST]: storedModel(SONNET_LATEST, SONNET) },
    });

    expect(providerModelData.map(({ provider }) => provider.slug)).toEqual([
      'anthropic',
      VIRTUAL_PROVIDER.slug,
    ]);
    expect(providerModelData[1]?.models.map(model => model.slug)).toEqual([SONNET_LATEST]);
  });

  test('keeps models that providers already list and skips batch variants', () => {
    const providerModelData = [
      { provider: provider('anthropic'), models: [snapshotModel(SONNET)] },
    ];

    injectVirtualModels({
      providerModelData,
      catalogModels: [
        catalogModel(SONNET, 'Anthropic: Claude Sonnet 5'),
        catalogModel(`${SONNET}:free`, 'Anthropic: Claude Sonnet 5 (free)'),
        catalogModel('openai/gpt-6-sol:batch', 'OpenAI: GPT-6 Sol (batch)'),
      ],
      storedModels: {},
    });

    expect(providerModelData).toEqual([
      { provider: provider('anthropic'), models: [snapshotModel(SONNET)] },
    ]);
  });
});
