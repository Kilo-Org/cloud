import { describe, expect, test } from '@jest/globals';
import {
  injectOpenRouterCatalogOnlyModels,
  OPENROUTER_NATIVE_PROVIDER_SLUG,
  type OpenRouterPublicModel,
} from '@/lib/ai-gateway/providers/openrouter/inject-openrouter-catalog-only-models';
import type {
  OpenRouterModel,
  OpenRouterProvider,
} from '@/lib/ai-gateway/providers/openrouter/openrouter-types';

function provider(slug: string, displayName: string): OpenRouterProvider {
  return {
    name: displayName,
    displayName,
    slug,
    dataPolicy: { training: false, retainsPrompts: false, canPublish: false },
  };
}

function catalogModel(slug: string, name: string): OpenRouterModel {
  return {
    slug,
    name,
    author: 'anthropic',
    description: 'target',
    context_length: 200_000,
    input_modalities: ['text'],
    output_modalities: ['text'],
    group: 'Claude',
    updated_at: '2026-01-01T00:00:00.000Z',
    endpoint: {
      provider_display_name: 'Anthropic',
      is_free: false,
      pricing: { prompt: '0.000003', completion: '0.000015' },
    },
  };
}

function publicModel(
  overrides: Partial<OpenRouterPublicModel> & Pick<OpenRouterPublicModel, 'id' | 'name'>
): OpenRouterPublicModel {
  return {
    description: '',
    context_length: 100_000,
    architecture: { input_modalities: ['text'], output_modalities: ['text'] },
    pricing: { prompt: '0.000002', completion: '0.00001' },
    ...overrides,
  };
}

describe('injectOpenRouterCatalogOnlyModels', () => {
  test('clones latest aliases onto every provider that offers the alias target', () => {
    const providerModelData = [
      {
        provider: provider('anthropic', 'Anthropic'),
        models: [catalogModel('anthropic/claude-sonnet-5', 'Claude Sonnet 5')],
      },
      {
        provider: provider('amazon-bedrock', 'Amazon Bedrock'),
        models: [catalogModel('anthropic/claude-sonnet-5', 'Claude Sonnet 5')],
      },
    ];

    injectOpenRouterCatalogOnlyModels(providerModelData, [
      publicModel({
        id: '~anthropic/claude-sonnet-latest',
        name: 'Anthropic Claude Sonnet Latest',
        alias_target: { slug: 'anthropic/claude-sonnet-5' },
      }),
    ]);

    expect(providerModelData[0]?.models.map(model => model.slug)).toEqual([
      '~anthropic/claude-sonnet-latest',
      'anthropic/claude-sonnet-5',
    ]);
    expect(providerModelData[1]?.models.map(model => model.slug)).toEqual([
      '~anthropic/claude-sonnet-latest',
      'anthropic/claude-sonnet-5',
    ]);
    expect(providerModelData[0]?.models[0]?.endpoint?.pricing).toEqual({
      prompt: '0.000003',
      completion: '0.000015',
    });
  });

  test('adds OpenRouter-native models to a synthetic OpenRouter provider', () => {
    const providerModelData = [
      {
        provider: provider('anthropic', 'Anthropic'),
        models: [catalogModel('anthropic/claude-sonnet-5', 'Claude Sonnet 5')],
      },
    ];

    injectOpenRouterCatalogOnlyModels(providerModelData, [
      publicModel({
        id: 'openrouter/free',
        name: 'Free Models Router',
        pricing: { prompt: '0', completion: '0' },
      }),
      publicModel({
        id: 'openrouter/auto',
        name: 'Auto Router',
        pricing: { prompt: '-1', completion: '-1' },
      }),
    ]);

    const openRouter = providerModelData.find(
      entry => entry.provider.slug === OPENROUTER_NATIVE_PROVIDER_SLUG
    );
    expect(openRouter?.models.map(model => model.slug)).toEqual([
      'openrouter/auto',
      'openrouter/free',
    ]);
    expect(openRouter?.models.find(model => model.slug === 'openrouter/free')?.endpoint).toEqual({
      provider_display_name: 'OpenRouter',
      is_free: true,
      pricing: { prompt: '0', completion: '0' },
      data_policy: { training: true, retainsPrompts: true },
    });
    expect(openRouter?.models.find(model => model.slug === 'openrouter/auto')?.endpoint).toBeNull();
  });
});
