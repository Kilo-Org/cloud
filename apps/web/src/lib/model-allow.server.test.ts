import { describe, expect, test } from '@jest/globals';
import {
  createAllowPredicateFromDenyList,
  createAllowPredicateFromProviderAllowList,
  createAllowPredicateFromRestrictions,
  type ProviderLookup,
} from '@/lib/model-allow.server';

function lookup(map: Record<string, string[]>): ProviderLookup {
  return async modelId => new Set(map[modelId] ?? []);
}

describe('model access predicates', () => {
  test('undefined provider allow list only applies model deny list', async () => {
    const isAllowed = createAllowPredicateFromProviderAllowList(['openai/gpt-4o'], undefined);

    await expect(isAllowed('openai/gpt-4o')).resolves.toBe(false);
    await expect(isAllowed('anthropic/claude-3-opus')).resolves.toBe(true);
  });

  test('empty model deny list allows all known models from allowed providers', async () => {
    const isAllowed = createAllowPredicateFromProviderAllowList(
      [],
      ['openai'],
      lookup({ 'openai/gpt-4o': ['openai'] })
    );

    await expect(isAllowed('openai/gpt-4o')).resolves.toBe(true);
  });

  test('model deny list normalizes model ids', async () => {
    const isAllowed = createAllowPredicateFromProviderAllowList(['openai/gpt-4o'], undefined);

    await expect(isAllowed('openai/gpt-4o:free')).resolves.toBe(false);
  });

  test('provider allow list denies models offered only by unlisted providers', async () => {
    const isAllowed = createAllowPredicateFromProviderAllowList(
      undefined,
      ['openai'],
      lookup({ 'baidu/ernie': ['baidu-qianfan'] })
    );

    await expect(isAllowed('baidu/ernie')).resolves.toBe(false);
  });

  test('provider allow list allows models with at least one listed provider', async () => {
    const isAllowed = createAllowPredicateFromProviderAllowList(
      undefined,
      ['openai'],
      lookup({ 'openai/gpt-4o': ['baidu-qianfan', 'openai'] })
    );

    await expect(isAllowed('openai/gpt-4o')).resolves.toBe(true);
  });

  test('provider allow list permits models without OpenRouter provider metadata', async () => {
    const isAllowed = createAllowPredicateFromProviderAllowList(undefined, ['openai'], lookup({}));

    await expect(isAllowed('custom-llm-id')).resolves.toBe(true);
  });

  test('provider allow list still applies model deny list', async () => {
    const isAllowed = createAllowPredicateFromProviderAllowList(
      ['openai/gpt-4o'],
      ['openai'],
      lookup({ 'openai/gpt-4o': ['openai'] })
    );

    await expect(isAllowed('openai/gpt-4o')).resolves.toBe(false);
  });

  test('legacy deny lists are used when no provider allow list exists', async () => {
    const isAllowed = createAllowPredicateFromRestrictions({
      modelDenyList: ['openai/gpt-4o'],
      providerDenyList: [],
    });

    await expect(isAllowed('openai/gpt-4o')).resolves.toBe(false);
  });

  test('legacy provider deny list is used when no provider allow list exists', async () => {
    const isAllowed = createAllowPredicateFromRestrictions(
      {
        modelDenyList: [],
        providerDenyList: ['openai'],
      },
      lookup({ 'openai/gpt-4o': ['openai'] })
    );

    await expect(isAllowed('openai/gpt-4o')).resolves.toBe(false);
  });

  test('provider allow list policy ignores legacy provider deny list', async () => {
    const isAllowed = createAllowPredicateFromRestrictions(
      {
        providerAllowList: ['openai'],
        modelDenyList: [],
        providerDenyList: ['openai'],
      },
      lookup({ 'openai/gpt-4o': ['openai'] })
    );

    await expect(isAllowed('openai/gpt-4o')).resolves.toBe(true);
  });

  test('legacy provider deny list still blocks all-denied providers', async () => {
    const isAllowed = createAllowPredicateFromDenyList(
      [],
      ['openai'],
      lookup({ 'openai/gpt-4o': ['openai'] })
    );

    await expect(isAllowed('openai/gpt-4o')).resolves.toBe(false);
  });
});
