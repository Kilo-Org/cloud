import { describe, expect, test } from '@jest/globals';
import {
  buildModelProvidersIndex,
  canonicalizeModelAllowList,
  computeAllowedModelIds,
  computeEnabledProviderSlugs,
  computeModelsOnlyFromProvider,
  toggleAllowFutureModelsForProvider,
  toggleModelAllowed,
  toggleProviderEnabled,
} from '@/components/organizations/providers-and-models/allowLists.domain';

describe('allowLists.domain', () => {
  test('`[]` provider_allow_list means all providers enabled', () => {
    const enabled = computeEnabledProviderSlugs([], ['a', 'b']);
    expect([...enabled].sort()).toEqual(['a', 'b']);
  });

  test('`[]` model_allow_list means all models allowed (normalized)', () => {
    const openRouterModels = [{ slug: 'openai/gpt-4.1:free' }, { slug: 'openai/gpt-4.1' }];
    const openRouterProviders = [
      {
        slug: 'openai',
        models: [{ slug: 'openai/gpt-4.1', endpoint: {} }],
      },
    ];

    const allowed = computeAllowedModelIds([], openRouterModels, openRouterProviders);
    expect([...allowed].sort()).toEqual(['openai/gpt-4.1']);
  });

  test('canonicalizeModelAllowList normalizes :free and dedupes', () => {
    expect(canonicalizeModelAllowList(['openai/gpt-4.1:free', 'openai/gpt-4.1'])).toEqual([
      'openai/gpt-4.1',
    ]);
  });

  test('toggleProviderEnabled(disable) removes provider wildcard from model allow list', () => {
    const { nextModelAllowList, nextProviderAllowList } = toggleProviderEnabled({
      providerSlug: 'cerebras',
      nextEnabled: false,
      draftProviderAllowList: [],
      draftModelAllowList: ['cerebras/*', 'openai/gpt-4.1'],
      allProviderSlugsWithEndpoints: ['cerebras', 'openai'],
      hadAllProvidersInitially: true,
    });

    expect(nextModelAllowList).toEqual(['openai/gpt-4.1']);
    expect(nextProviderAllowList.sort()).toEqual(['openai']);
  });

  test('toggleAllowFutureModelsForProvider enables provider and adds provider wildcard', () => {
    const { nextModelAllowList, nextProviderAllowList } = toggleAllowFutureModelsForProvider({
      providerSlug: 'cerebras',
      nextAllowed: true,
      draftModelAllowList: ['openai/gpt-4.1'],
      draftProviderAllowList: ['openai'],
      allProviderSlugsWithEndpoints: ['cerebras', 'openai'],
      hadAllProvidersInitially: false,
    });

    expect(nextModelAllowList.sort()).toEqual(['cerebras/*', 'openai/gpt-4.1']);
    expect(nextProviderAllowList.sort()).toEqual(['cerebras', 'openai']);
  });

  test('toggleModelAllowed(disable) removes provider wildcards for providers offering the model', () => {
    const providerIndex = buildModelProvidersIndex([
      {
        slug: 'cerebras',
        models: [{ slug: 'z-ai/glm4.6', endpoint: {} }],
      },
    ]);

    const next = toggleModelAllowed({
      modelId: 'z-ai/glm4.6',
      nextAllowed: false,
      draftModelAllowList: ['cerebras/*', 'z-ai/glm4.6'],
      allModelIds: ['z-ai/glm4.6'],
      providerSlugsForModelId: [...(providerIndex.get('z-ai/glm4.6') ?? [])],
      hadAllModelsInitially: false,
    });

    expect(next).toEqual([]);
  });

  test('computeModelsOnlyFromProvider returns models that would have zero enabled providers', () => {
    const modelProvidersIndex = buildModelProvidersIndex([
      {
        slug: 'cerebras',
        models: [
          { slug: 'cerebras/llama-70b', endpoint: {} },
          { slug: 'shared/model-1', endpoint: {} },
        ],
      },
      {
        slug: 'openai',
        models: [{ slug: 'shared/model-1', endpoint: {} }],
      },
    ]);

    const orphaned = computeModelsOnlyFromProvider({
      providerSlug: 'cerebras',
      draftModelAllowList: ['cerebras/llama-70b', 'shared/model-1'],
      draftProviderAllowList: ['cerebras', 'openai'],
      allProviderSlugsWithEndpoints: ['cerebras', 'openai'],
      modelProvidersIndex,
    });

    // cerebras/llama-70b is only from cerebras, so it's orphaned
    // shared/model-1 is also from openai, so it's NOT orphaned
    expect(orphaned).toEqual(['cerebras/llama-70b']);
  });

  test('computeModelsOnlyFromProvider returns empty when no models would be orphaned', () => {
    const modelProvidersIndex = buildModelProvidersIndex([
      {
        slug: 'cerebras',
        models: [{ slug: 'shared/model-1', endpoint: {} }],
      },
      {
        slug: 'openai',
        models: [{ slug: 'shared/model-1', endpoint: {} }],
      },
    ]);

    const orphaned = computeModelsOnlyFromProvider({
      providerSlug: 'cerebras',
      draftModelAllowList: ['shared/model-1'],
      draftProviderAllowList: ['cerebras', 'openai'],
      allProviderSlugsWithEndpoints: ['cerebras', 'openai'],
      modelProvidersIndex,
    });

    expect(orphaned).toEqual([]);
  });

  test('toggleProviderEnabled(disable) removes orphaned models when modelProvidersIndex is provided', () => {
    const modelProvidersIndex = buildModelProvidersIndex([
      {
        slug: 'cerebras',
        models: [
          { slug: 'cerebras/llama-70b', endpoint: {} },
          { slug: 'shared/model-1', endpoint: {} },
        ],
      },
      {
        slug: 'openai',
        models: [
          { slug: 'openai/gpt-4.1', endpoint: {} },
          { slug: 'shared/model-1', endpoint: {} },
        ],
      },
    ]);

    const { nextModelAllowList, nextProviderAllowList } = toggleProviderEnabled({
      providerSlug: 'cerebras',
      nextEnabled: false,
      draftProviderAllowList: ['cerebras', 'openai'],
      draftModelAllowList: ['cerebras/llama-70b', 'openai/gpt-4.1', 'shared/model-1'],
      allProviderSlugsWithEndpoints: ['cerebras', 'openai'],
      hadAllProvidersInitially: false,
      modelProvidersIndex,
    });

    // cerebras/llama-70b should be removed (only from cerebras)
    // shared/model-1 should remain (also from openai)
    // openai/gpt-4.1 should remain (from openai)
    expect(nextModelAllowList.sort()).toEqual(['openai/gpt-4.1', 'shared/model-1']);
    expect(nextProviderAllowList).toEqual(['openai']);
  });

  test('computeAllowedModelIds filters out models when their providers are disabled', () => {
    const openRouterModels = [
      { slug: 'cerebras/llama-70b' },
      { slug: 'openai/gpt-4.1' },
      { slug: 'shared/model-1' },
    ];
    const openRouterProviders = [
      {
        slug: 'cerebras',
        models: [
          { slug: 'cerebras/llama-70b', endpoint: {} },
          { slug: 'shared/model-1', endpoint: {} },
        ],
      },
      {
        slug: 'openai',
        models: [
          { slug: 'openai/gpt-4.1', endpoint: {} },
          { slug: 'shared/model-1', endpoint: {} },
        ],
      },
    ];

    // All models are in the allow list
    const modelAllowList = ['cerebras/llama-70b', 'openai/gpt-4.1', 'shared/model-1'];

    // But only openai provider is enabled
    const enabledProviderSlugs = new Set(['openai']);

    const allowed = computeAllowedModelIds(
      modelAllowList,
      openRouterModels,
      openRouterProviders,
      enabledProviderSlugs
    );

    // cerebras/llama-70b should be filtered out (only from cerebras, which is disabled)
    // openai/gpt-4.1 should be included (from openai, which is enabled)
    // shared/model-1 should be included (available from openai, which is enabled)
    expect([...allowed].sort()).toEqual(['openai/gpt-4.1', 'shared/model-1']);
  });

  test('computeAllowedModelIds includes all models when enabledProviderSlugs is not provided', () => {
    const openRouterModels = [{ slug: 'cerebras/llama-70b' }, { slug: 'openai/gpt-4.1' }];
    const openRouterProviders = [
      {
        slug: 'cerebras',
        models: [{ slug: 'cerebras/llama-70b', endpoint: {} }],
      },
      {
        slug: 'openai',
        models: [{ slug: 'openai/gpt-4.1', endpoint: {} }],
      },
    ];

    const modelAllowList = ['cerebras/llama-70b', 'openai/gpt-4.1'];

    // Not passing enabledProviderSlugs - should include all models in allow list
    const allowed = computeAllowedModelIds(modelAllowList, openRouterModels, openRouterProviders);

    expect([...allowed].sort()).toEqual(['cerebras/llama-70b', 'openai/gpt-4.1']);
  });

  test('computeModelsOnlyFromProvider expands wildcards to detect orphaned models', () => {
    const modelProvidersIndex = buildModelProvidersIndex([
      {
        slug: 'cerebras',
        models: [
          { slug: 'cerebras/llama-70b', endpoint: {} },
          { slug: 'shared/model-1', endpoint: {} },
        ],
      },
      {
        slug: 'openai',
        models: [{ slug: 'shared/model-1', endpoint: {} }],
      },
    ]);

    const orphaned = computeModelsOnlyFromProvider({
      providerSlug: 'cerebras',
      draftModelAllowList: ['cerebras/*'],
      draftProviderAllowList: ['cerebras', 'openai'],
      allProviderSlugsWithEndpoints: ['cerebras', 'openai'],
      modelProvidersIndex,
    });

    // cerebras/* expands to cerebras/llama-70b and shared/model-1
    // cerebras/llama-70b is only from cerebras, so it's orphaned
    // shared/model-1 is also from openai, so it's NOT orphaned
    expect(orphaned).toEqual(['cerebras/llama-70b']);
  });
});
