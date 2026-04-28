import { describe, expect, test } from '@jest/globals';
import { getProviderAllowListFromDenyList } from '@/scripts/db/backfill-provider-allow-lists';

describe('getProviderAllowListFromDenyList', () => {
  test('creates provider allow list from current providers minus denied providers', () => {
    const result = getProviderAllowListFromDenyList({
      providerSlugs: ['openai', 'anthropic', 'fake-new-provider'],
      providerDenyList: ['anthropic'],
    });

    expect(result).toEqual(['openai', 'fake-new-provider']);
  });

  test('keeps all current providers when deny list is empty', () => {
    const result = getProviderAllowListFromDenyList({
      providerSlugs: ['openai', 'anthropic'],
      providerDenyList: [],
    });

    expect(result).toEqual(['openai', 'anthropic']);
  });

  test('does not include denied providers that are no longer in the current catalog', () => {
    const result = getProviderAllowListFromDenyList({
      providerSlugs: ['openai'],
      providerDenyList: ['anthropic', 'removed-provider'],
    });

    expect(result).toEqual(['openai']);
  });
});
