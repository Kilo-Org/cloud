import { describe, expect, test } from '@jest/globals';
import {
  buildModelProvidersIndex,
  canonicalizeDenyList,
  canonicalizeProviderAllowList,
  collectUniqueCatalogModels,
  computeAllProviderSlugs,
  computeAllowedModelIds,
  computeEnabledProviderSlugs,
  deriveProviderAllowListFromLegacyDenyList,
  toggleModelAllowed,
  toggleProviderEnabled,
} from '@/components/organizations/providers-and-models/allowLists.domain';

describe('allowLists.domain', () => {
  test('provider allow list excludes newly synced providers', () => {
    const enabled = computeEnabledProviderSlugs(['a'], ['a', 'b']);
    expect([...enabled].sort()).toEqual(['a']);
  });

  test('empty provider allow list means no providers enabled', () => {
    const enabled = computeEnabledProviderSlugs([], ['a', 'b']);
    expect([...enabled]).toEqual([]);
  });

  test('model deny list does not exclude newly synced models', () => {
    const openRouterModels = [{ slug: 'openai/gpt-4.1' }, { slug: 'anthropic/claude-3-opus' }];

    const allowed = computeAllowedModelIds(['openai/gpt-4.1'], openRouterModels);
    expect([...allowed].sort()).toEqual(['anthropic/claude-3-opus']);
  });

  test('empty model deny list means all models allowed', () => {
    const openRouterModels = [{ slug: 'openai/gpt-4.1' }];

    const allowed = computeAllowedModelIds([], openRouterModels);
    expect([...allowed]).toEqual(['openai/gpt-4.1']);
  });

  test('canonicalize deny list normalizes and dedupes model ids', () => {
    expect(canonicalizeDenyList(['openai/gpt-4.1:free', 'openai/gpt-4.1'])).toEqual([
      'openai/gpt-4.1',
    ]);
  });

  test('canonicalize provider allow list dedupes and sorts providers', () => {
    expect(canonicalizeProviderAllowList(['openai', 'openai', 'anthropic'])).toEqual([
      'anthropic',
      'openai',
    ]);
  });

  test('legacy provider deny list can be inverted into an allow list snapshot', () => {
    const allowed = deriveProviderAllowListFromLegacyDenyList(['openai'], ['anthropic', 'openai']);
    expect(allowed).toEqual(['anthropic']);
  });

  test('toggleProviderEnabled(disable) removes provider from allow list', () => {
    const next = toggleProviderEnabled({
      providerSlug: 'openai',
      nextEnabled: false,
      draftProviderAllowList: ['openai', 'anthropic'],
    });
    expect(next).toEqual(['anthropic']);
  });

  test('toggleProviderEnabled(enable) adds provider to allow list', () => {
    const next = toggleProviderEnabled({
      providerSlug: 'openai',
      nextEnabled: true,
      draftProviderAllowList: ['anthropic'],
    });
    expect(next).toEqual(['anthropic', 'openai']);
  });

  test('toggleModelAllowed(disallow) adds model to deny list', () => {
    const next = toggleModelAllowed({
      modelId: 'openai/gpt-4.1',
      nextAllowed: false,
      draftModelDenyList: ['anthropic/claude-3-opus'],
    });
    expect(next).toEqual(['anthropic/claude-3-opus', 'openai/gpt-4.1']);
  });

  test('collectUniqueCatalogModels includes models without endpoints', () => {
    const models = collectUniqueCatalogModels([
      {
        models: [
          { slug: 'anthropic/claude-3-opus', endpoint: { pricing: {} }, name: 'Opus' },
          { slug: 'anthropic/unrouted', name: 'Unrouted' },
        ],
      },
    ]);

    expect(models.map(model => model.slug)).toEqual([
      'anthropic/claude-3-opus',
      'anthropic/unrouted',
    ]);
  });

  test('collectUniqueCatalogModels prefers a live endpoint when deduping', () => {
    const models = collectUniqueCatalogModels([
      { models: [{ slug: 'openai/gpt-4', name: 'without-endpoint' }] },
      { models: [{ slug: 'openai/gpt-4', endpoint: { pricing: {} }, name: 'with-endpoint' }] },
    ]);

    expect(models).toEqual([
      { slug: 'openai/gpt-4', endpoint: { pricing: {} }, name: 'with-endpoint' },
    ]);
  });

  test('buildModelProvidersIndex includes providers for models without endpoints', () => {
    const index = buildModelProvidersIndex([
      {
        slug: 'anthropic',
        models: [{ slug: 'anthropic/unrouted' }],
      },
      {
        slug: 'amazon-bedrock',
        models: [{ slug: 'anthropic/unrouted', endpoint: { pricing: {} } }],
      },
    ]);

    expect([...(index.get('anthropic/unrouted') ?? [])].sort()).toEqual([
      'amazon-bedrock',
      'anthropic',
    ]);
  });

  test('computeAllProviderSlugs includes providers that only offer unrouted models', () => {
    const slugs = computeAllProviderSlugs([
      { slug: 'empty', models: [] },
      { slug: 'unrouted-only', models: [{ slug: 'vendor/unrouted' }] },
      { slug: 'live', models: [{ slug: 'vendor/live', endpoint: { pricing: {} } }] },
    ]);

    expect(slugs).toEqual(['live', 'unrouted-only']);
  });

  test('toggleModelAllowed(allow) removes model from deny list', () => {
    const next = toggleModelAllowed({
      modelId: 'openai/gpt-4.1',
      nextAllowed: true,
      draftModelDenyList: ['anthropic/claude-3-opus', 'openai/gpt-4.1'],
    });
    expect(next).toEqual(['anthropic/claude-3-opus']);
  });
});
