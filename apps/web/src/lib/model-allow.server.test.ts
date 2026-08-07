import { describe, expect, test } from '@jest/globals';
import {
  createAllowPredicateFromProviderAllowList,
  createAllowPredicateFromRestrictions,
  type ProviderLookup,
} from '@/lib/model-allow.server';
import { CLAUDE_SONNET_LATEST_MODEL_ALIAS } from '@/lib/ai-gateway/latest-model-aliases';
import { CLAUDE_SONNET_CURRENT_MODEL_ID } from '@/lib/ai-gateway/providers/anthropic.constants';

function lookup(map: Record<string, string[]>): ProviderLookup {
  return async modelId => new Set(map[modelId] ?? []);
}

describe('model access predicates', () => {
  test('undefined provider allow list only applies model deny list', async () => {
    const isAllowed = createAllowPredicateFromProviderAllowList(
      ['openai/gpt-4o'],
      undefined,
      lookup({ 'anthropic/claude-3-opus': ['anthropic'] })
    );

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

  test('provider allow list denies models missing from the current snapshot', async () => {
    const isAllowed = createAllowPredicateFromProviderAllowList(undefined, ['openai'], lookup({}));

    await expect(isAllowed('grok-4.5')).resolves.toBe(false);
  });

  test('enterprise deny lists require models to exist in the current snapshot', async () => {
    const isAllowed = createAllowPredicateFromRestrictions(
      {
        requireModelInCurrentSnapshot: true,
        modelDenyList: ['x-ai/grok-4.5'],
      },
      lookup({ 'x-ai/grok-4.6': ['x-ai'] })
    );

    await expect(isAllowed('grok-4.5')).resolves.toBe(false);
    await expect(isAllowed('x-ai/grok-4.6')).resolves.toBe(true);
  });

  test('Enterprise requires snapshot membership without configured restrictions', async () => {
    const isAllowed = createAllowPredicateFromRestrictions(
      {
        requireModelInCurrentSnapshot: true,
        modelDenyList: [],
      },
      lookup({ 'x-ai/grok-4.6': ['x-ai'] })
    );

    await expect(isAllowed('grok-4.5')).resolves.toBe(false);
    await expect(isAllowed('x-ai/grok-4.6')).resolves.toBe(true);
  });

  test('latest aliases bypass model restrictions but retain provider availability', async () => {
    const withProviders = createAllowPredicateFromRestrictions(
      {
        requireModelInCurrentSnapshot: true,
        providerAllowList: ['anthropic'],
        modelDenyList: [CLAUDE_SONNET_LATEST_MODEL_ALIAS],
      },
      lookup({ [CLAUDE_SONNET_CURRENT_MODEL_ID]: ['anthropic'] })
    );
    const withIncompatibleProviders = createAllowPredicateFromRestrictions(
      {
        requireModelInCurrentSnapshot: true,
        providerAllowList: ['openai'],
        modelDenyList: [CLAUDE_SONNET_LATEST_MODEL_ALIAS],
      },
      lookup({ [CLAUDE_SONNET_CURRENT_MODEL_ID]: ['anthropic'] })
    );
    const withoutProviders = createAllowPredicateFromRestrictions(
      {
        requireModelInCurrentSnapshot: true,
        providerAllowList: [],
        modelDenyList: [CLAUDE_SONNET_LATEST_MODEL_ALIAS],
      },
      lookup({})
    );

    await expect(withProviders(CLAUDE_SONNET_LATEST_MODEL_ALIAS)).resolves.toBe(true);
    await expect(withIncompatibleProviders(CLAUDE_SONNET_LATEST_MODEL_ALIAS)).resolves.toBe(false);
    await expect(withoutProviders(CLAUDE_SONNET_LATEST_MODEL_ALIAS)).resolves.toBe(false);
  });

  test.each(['kilo-auto/balanced', 'kilo-internal/private-model', 'kimi-coding/kimi-for-coding'])(
    'keeps %s exempt from Enterprise model restrictions',
    async modelId => {
      const isAllowed = createAllowPredicateFromRestrictions(
        {
          requireModelInCurrentSnapshot: true,
          providerAllowList: [],
          modelDenyList: [modelId],
        },
        lookup({})
      );

      await expect(isAllowed(modelId)).resolves.toBe(true);
    }
  );

  test('provider allow list still applies model deny list', async () => {
    const isAllowed = createAllowPredicateFromProviderAllowList(
      ['openai/gpt-4o'],
      ['openai'],
      lookup({ 'openai/gpt-4o': ['openai'] })
    );

    await expect(isAllowed('openai/gpt-4o')).resolves.toBe(false);
  });

  test('createAllowPredicateFromRestrictions uses provider allow and model deny lists', async () => {
    const isAllowed = createAllowPredicateFromRestrictions(
      {
        requireModelInCurrentSnapshot: true,
        providerAllowList: ['openai'],
        modelDenyList: ['openai/gpt-4o'],
      },
      lookup({ 'openai/gpt-4o': ['openai'], 'openai/gpt-4.1': ['openai'] })
    );

    await expect(isAllowed('openai/gpt-4o')).resolves.toBe(false);
    await expect(isAllowed('openai/gpt-4.1')).resolves.toBe(true);
  });
});
