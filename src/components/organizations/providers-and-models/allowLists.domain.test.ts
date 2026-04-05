import { describe, expect, test } from '@jest/globals';
import {
  canonicalizeDenyList,
  computeAllowedModelIds,
  computeEnabledProviderSlugs,
  toggleModelAllowed,
  toggleProviderEnabled,
} from '@/components/organizations/providers-and-models/allowLists.domain';

describe('allowLists.domain', () => {
  test('empty provider_deny_list means all providers enabled', () => {
    const enabled = computeEnabledProviderSlugs([], ['a', 'b']);
    expect([...enabled].sort()).toEqual(['a', 'b']);
  });

  test('non-empty provider_deny_list excludes denied providers', () => {
    const enabled = computeEnabledProviderSlugs(['a'], ['a', 'b']);
    expect([...enabled].sort()).toEqual(['b']);
  });

  test('empty model_deny_list means all models allowed (normalized)', () => {
    const openRouterModels = [{ slug: 'openai/gpt-4.1:free' }, { slug: 'openai/gpt-4.1' }];

    const allowed = computeAllowedModelIds([], openRouterModels);
    expect([...allowed].sort()).toEqual(['openai/gpt-4.1']);
  });

  test('non-empty model_deny_list excludes denied models', () => {
    const openRouterModels = [{ slug: 'openai/gpt-4.1' }, { slug: 'anthropic/claude-3-opus' }];

    const allowed = computeAllowedModelIds(['anthropic/claude-3-opus'], openRouterModels);
    expect([...allowed]).toEqual(['openai/gpt-4.1']);
  });

  test('canonicalizeDenyList normalizes :free and dedupes', () => {
    expect(canonicalizeDenyList(['openai/gpt-4.1:free', 'openai/gpt-4.1'])).toEqual([
      'openai/gpt-4.1',
    ]);
  });

  test('toggleProviderEnabled(disable) adds provider to deny list', () => {
    const next = toggleProviderEnabled({
      providerSlug: 'openai',
      nextEnabled: false,
      draftProviderDenyList: [],
    });
    expect(next).toEqual(['openai']);
  });

  test('toggleProviderEnabled(enable) removes provider from deny list', () => {
    const next = toggleProviderEnabled({
      providerSlug: 'openai',
      nextEnabled: true,
      draftProviderDenyList: ['openai', 'anthropic'],
    });
    expect(next).toEqual(['anthropic']);
  });

  test('toggleModelAllowed(disallow) adds model to deny list', () => {
    const next = toggleModelAllowed({
      modelId: 'openai/gpt-4.1',
      nextAllowed: false,
      draftModelDenyList: [],
    });
    expect(next).toEqual(['openai/gpt-4.1']);
  });

  test('toggleModelAllowed(allow) removes model from deny list', () => {
    const next = toggleModelAllowed({
      modelId: 'openai/gpt-4.1',
      nextAllowed: true,
      draftModelDenyList: ['openai/gpt-4.1', 'anthropic/claude-3-opus'],
    });
    expect(next).toEqual(['anthropic/claude-3-opus']);
  });
});
