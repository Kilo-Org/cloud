import { describe, expect, test } from '@jest/globals';
import {
  createAllowPredicateFromAllowList,
  createAllowPredicateFromRestrictions,
  type ProviderLookup,
} from '@/lib/model-allow.server';

function lookup(map: Record<string, string[]>): ProviderLookup {
  return async modelId => new Set(map[modelId] ?? []);
}

describe('model allow predicates', () => {
  test('undefined allow lists are unrestricted', async () => {
    const isAllowed = createAllowPredicateFromAllowList(undefined, undefined);

    await expect(isAllowed('openai/gpt-4o')).resolves.toBe(true);
  });

  test('empty model allow list denies all models', async () => {
    const isAllowed = createAllowPredicateFromAllowList([], undefined);

    await expect(isAllowed('openai/gpt-4o')).resolves.toBe(false);
  });

  test('model allow list normalizes model ids', async () => {
    const isAllowed = createAllowPredicateFromAllowList(['openai/gpt-4o'], undefined);

    await expect(isAllowed('openai/gpt-4o:free')).resolves.toBe(true);
  });

  test('provider allow list denies models offered only by unlisted providers', async () => {
    const isAllowed = createAllowPredicateFromAllowList(
      undefined,
      ['openai'],
      lookup({ 'baidu/ernie': ['baidu-qianfan'] })
    );

    await expect(isAllowed('baidu/ernie')).resolves.toBe(false);
  });

  test('provider allow list allows models with at least one listed provider', async () => {
    const isAllowed = createAllowPredicateFromAllowList(
      undefined,
      ['openai'],
      lookup({ 'openai/gpt-4o': ['baidu-qianfan', 'openai'] })
    );

    await expect(isAllowed('openai/gpt-4o')).resolves.toBe(true);
  });

  test('allow lists take precedence over legacy deny lists', async () => {
    const isAllowed = createAllowPredicateFromRestrictions({
      modelAllowList: ['openai/gpt-4o'],
      modelDenyList: ['openai/gpt-4o'],
      providerDenyList: [],
    });

    await expect(isAllowed('openai/gpt-4o')).resolves.toBe(true);
  });
});
