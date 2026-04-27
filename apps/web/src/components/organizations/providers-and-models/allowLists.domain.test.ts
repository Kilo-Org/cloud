import { describe, expect, test } from '@jest/globals';
import {
  canonicalizeDenyList,
  canonicalizeModelAllowList,
  canonicalizeProviderAllowList,
  computeAllowedModelIds,
  computeEnabledProviderSlugs,
  deriveModelAllowListFromLegacyDenyList,
  deriveProviderAllowListFromLegacyDenyList,
  toggleModelAllowed,
  toggleProviderEnabled,
  uniqueStrings,
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

  test('model allow list excludes newly synced models', () => {
    const openRouterModels = [{ slug: 'openai/gpt-4.1' }, { slug: 'anthropic/claude-3-opus' }];

    const allowed = computeAllowedModelIds(['openai/gpt-4.1'], openRouterModels);
    expect([...allowed]).toEqual(['openai/gpt-4.1']);
  });

  test('empty model allow list means no models allowed', () => {
    const openRouterModels = [{ slug: 'openai/gpt-4.1' }];

    const allowed = computeAllowedModelIds([], openRouterModels);
    expect([...allowed]).toEqual([]);
  });

  test('canonicalize allow lists normalize and dedupe', () => {
    expect(canonicalizeModelAllowList(['openai/gpt-4.1:free', 'openai/gpt-4.1'])).toEqual([
      'openai/gpt-4.1',
    ]);
    expect(canonicalizeProviderAllowList(['openai', 'openai', 'anthropic'])).toEqual([
      'anthropic',
      'openai',
    ]);
  });

  test('uniqueStrings preserves source order for unrestricted snapshot migration', () => {
    expect(uniqueStrings(['openai', 'anthropic', 'openai'])).toEqual(['openai', 'anthropic']);
  });

  test('legacy model deny list can be inverted into an allow list snapshot', () => {
    const openRouterModels = [{ slug: 'openai/gpt-4.1' }, { slug: 'anthropic/claude-3-opus' }];

    const allowed = deriveModelAllowListFromLegacyDenyList(['openai/gpt-4.1'], openRouterModels);
    expect(allowed).toEqual(['anthropic/claude-3-opus']);
  });

  test('legacy provider deny list can be inverted into an allow list snapshot', () => {
    const allowed = deriveProviderAllowListFromLegacyDenyList(['openai'], ['anthropic', 'openai']);
    expect(allowed).toEqual(['anthropic']);
  });

  test('canonicalizeDenyList still supports legacy fallback normalization', () => {
    expect(canonicalizeDenyList(['openai/gpt-4.1:free', 'openai/gpt-4.1'])).toEqual([
      'openai/gpt-4.1',
    ]);
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

  test('toggleModelAllowed(disallow) removes model from allow list', () => {
    const next = toggleModelAllowed({
      modelId: 'openai/gpt-4.1',
      nextAllowed: false,
      draftModelAllowList: ['openai/gpt-4.1', 'anthropic/claude-3-opus'],
    });
    expect(next).toEqual(['anthropic/claude-3-opus']);
  });

  test('toggleModelAllowed(allow) adds model to allow list', () => {
    const next = toggleModelAllowed({
      modelId: 'openai/gpt-4.1',
      nextAllowed: true,
      draftModelAllowList: ['anthropic/claude-3-opus'],
    });
    expect(next).toEqual(['anthropic/claude-3-opus', 'openai/gpt-4.1']);
  });
});
