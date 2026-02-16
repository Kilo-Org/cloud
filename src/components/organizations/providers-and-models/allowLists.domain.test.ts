import { describe, expect, test } from '@jest/globals';
import {
  buildModelProvidersIndex,
  canonicalizeModelAllowList,
  computeAllowedModelIds,
  computeEnabledProviderSlugs,
  MODEL_ALLOW_NONE_SENTINEL,
  sanitizeModelAllowListForPersistence,
  setAllModelsAllowed,
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

  test('setAllModelsAllowed(true) returns [] when hadAllModelsInitially and targeting all', () => {
    const next = setAllModelsAllowed({
      nextAllowed: true,
      targetModelIds: ['openai/gpt-4.1', 'anthropic/claude-3.5-sonnet'],
      draftModelAllowList: ['openai/gpt-4.1'],
      allModelIds: ['openai/gpt-4.1', 'anthropic/claude-3.5-sonnet'],
      hadAllModelsInitially: true,
    });
    expect(next).toEqual([]);
  });

  test('setAllModelsAllowed(true) returns all model IDs when not hadAllModelsInitially', () => {
    const next = setAllModelsAllowed({
      nextAllowed: true,
      targetModelIds: ['anthropic/claude-3.5-sonnet', 'openai/gpt-4.1'],
      draftModelAllowList: ['openai/gpt-4.1'],
      allModelIds: ['anthropic/claude-3.5-sonnet', 'openai/gpt-4.1'],
      hadAllModelsInitially: false,
    });
    expect(next).toEqual(['anthropic/claude-3.5-sonnet', 'openai/gpt-4.1']);
  });

  test('setAllModelsAllowed(true) preserves wildcards when not hadAllModelsInitially', () => {
    const next = setAllModelsAllowed({
      nextAllowed: true,
      targetModelIds: ['openai/gpt-4.1'],
      draftModelAllowList: ['cerebras/*', 'openai/gpt-4.1'],
      allModelIds: ['openai/gpt-4.1'],
      hadAllModelsInitially: false,
    });
    expect(next).toEqual(['cerebras/*', 'openai/gpt-4.1']);
  });

  test('setAllModelsAllowed(false) returns sentinel list when deselecting all models', () => {
    const next = setAllModelsAllowed({
      nextAllowed: false,
      targetModelIds: ['openai/gpt-4.1'],
      draftModelAllowList: [],
      allModelIds: ['openai/gpt-4.1'],
      hadAllModelsInitially: true,
    });
    expect(next).toEqual([MODEL_ALLOW_NONE_SENTINEL]);
  });

  test('setAllModelsAllowed(true) on filtered subset merges into existing allow list', () => {
    const next = setAllModelsAllowed({
      nextAllowed: true,
      targetModelIds: ['anthropic/claude-3.5-sonnet'],
      draftModelAllowList: ['openai/gpt-4.1'],
      allModelIds: ['openai/gpt-4.1', 'anthropic/claude-3.5-sonnet', 'meta/llama-3'],
      hadAllModelsInitially: false,
    });
    expect(next).toEqual(['anthropic/claude-3.5-sonnet', 'openai/gpt-4.1']);
  });

  test('setAllModelsAllowed(false) on filtered subset removes only targets', () => {
    const next = setAllModelsAllowed({
      nextAllowed: false,
      targetModelIds: ['openai/gpt-4.1'],
      draftModelAllowList: ['anthropic/claude-3.5-sonnet', 'openai/gpt-4.1'],
      allModelIds: ['openai/gpt-4.1', 'anthropic/claude-3.5-sonnet'],
      hadAllModelsInitially: false,
    });
    expect(next).toEqual(['anthropic/claude-3.5-sonnet']);
  });

  test('setAllModelsAllowed(false) from empty list (all allowed) keeps non-targets', () => {
    const next = setAllModelsAllowed({
      nextAllowed: false,
      targetModelIds: ['openai/gpt-4.1'],
      draftModelAllowList: [],
      allModelIds: ['openai/gpt-4.1', 'anthropic/claude-3.5-sonnet'],
      hadAllModelsInitially: true,
    });
    expect(next).toEqual(['anthropic/claude-3.5-sonnet']);
  });

  test('computeAllowedModelIds returns empty set for sentinel list', () => {
    const openRouterModels = [{ slug: 'openai/gpt-4.1' }, { slug: 'anthropic/claude-3.5-sonnet' }];
    const openRouterProviders = [
      { slug: 'openai', models: [{ slug: 'openai/gpt-4.1', endpoint: {} }] },
      { slug: 'anthropic', models: [{ slug: 'anthropic/claude-3.5-sonnet', endpoint: {} }] },
    ];

    const allowed = computeAllowedModelIds(
      [MODEL_ALLOW_NONE_SENTINEL],
      openRouterModels,
      openRouterProviders
    );
    expect(allowed.size).toBe(0);
  });

  test('sanitizeModelAllowListForPersistence removes sentinel', () => {
    const sanitized = sanitizeModelAllowListForPersistence([MODEL_ALLOW_NONE_SENTINEL]);
    expect(sanitized).toEqual([]);
  });

  test('sanitizeModelAllowListForPersistence preserves valid entries', () => {
    const sanitized = sanitizeModelAllowListForPersistence([
      'openai/gpt-4.1',
      'anthropic/*',
      MODEL_ALLOW_NONE_SENTINEL,
    ]);
    expect(sanitized).toEqual(['openai/gpt-4.1', 'anthropic/*']);
  });

  test('sanitizeModelAllowListForPersistence returns empty array unchanged', () => {
    const sanitized = sanitizeModelAllowListForPersistence([]);
    expect(sanitized).toEqual([]);
  });
});
