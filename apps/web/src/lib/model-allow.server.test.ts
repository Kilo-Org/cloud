import { describe, expect, test } from '@jest/globals';
import {
  createAllowPredicateFromProviderAllowList,
  createAllowPredicateFromRestrictions,
  type ProviderLookup,
} from '@/lib/model-allow.server';
import { CLAUDE_SONNET_LATEST_MODEL_ALIAS } from '@/lib/ai-gateway/latest-model-aliases';

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

  test('latest aliases honor deny lists and use snapshot routes when present', async () => {
    const denied = createAllowPredicateFromRestrictions(
      {
        requireModelInCurrentSnapshot: true,
        providerAllowList: ['anthropic'],
        modelDenyList: [CLAUDE_SONNET_LATEST_MODEL_ALIAS],
      },
      lookup({ [CLAUDE_SONNET_LATEST_MODEL_ALIAS]: ['anthropic'] })
    );
    const allowed = createAllowPredicateFromRestrictions(
      {
        requireModelInCurrentSnapshot: true,
        providerAllowList: ['anthropic'],
        modelDenyList: [],
      },
      lookup({ [CLAUDE_SONNET_LATEST_MODEL_ALIAS]: ['anthropic'] })
    );
    const unsynced = createAllowPredicateFromRestrictions(
      {
        requireModelInCurrentSnapshot: true,
        providerAllowList: ['anthropic'],
        modelDenyList: [],
      },
      lookup({})
    );

    await expect(denied(CLAUDE_SONNET_LATEST_MODEL_ALIAS)).resolves.toBe(false);
    await expect(allowed(CLAUDE_SONNET_LATEST_MODEL_ALIAS)).resolves.toBe(true);
    await expect(unsynced(CLAUDE_SONNET_LATEST_MODEL_ALIAS)).resolves.toBe(true);
  });

  test('OpenRouter-native models require snapshot membership and ignore fake provider slugs', async () => {
    const missing = createAllowPredicateFromRestrictions(
      {
        requireModelInCurrentSnapshot: true,
        providerAllowList: ['anthropic'],
        modelDenyList: [],
      },
      lookup({})
    );
    const present = createAllowPredicateFromRestrictions(
      {
        requireModelInCurrentSnapshot: true,
        providerAllowList: ['anthropic'],
        modelDenyList: [],
      },
      lookup({ 'openrouter/free': ['openrouter'] })
    );

    await expect(missing('openrouter/free')).resolves.toBe(false);
    await expect(present('openrouter/free')).resolves.toBe(true);
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

  test('provider allow list hides restricted exclusive models when every restricted provider is disabled', async () => {
    const isAllowed = createAllowPredicateFromProviderAllowList(
      undefined,
      ['openai', 'fireworks'],
      lookup({ 'deepseek/deepseek-v4-pro': ['fireworks', 'deepseek'] })
    );

    await expect(isAllowed('deepseek/deepseek-v4-pro:discounted')).resolves.toBe(false);
    await expect(isAllowed('deepseek/deepseek-v4-pro')).resolves.toBe(true);
  });

  test('provider allow list keeps restricted exclusive models when a restricted provider remains enabled', async () => {
    const isAllowed = createAllowPredicateFromProviderAllowList(
      undefined,
      ['openai', 'deepseek'],
      lookup({ 'deepseek/deepseek-v4-pro': ['fireworks'] })
    );

    await expect(isAllowed('deepseek/deepseek-v4-pro:discounted')).resolves.toBe(true);
  });

  test('provider allow list still evaluates restricted exclusive models missing from the snapshot', async () => {
    const isAllowed = createAllowPredicateFromProviderAllowList(
      undefined,
      ['deepseek'],
      lookup({})
    );

    await expect(isAllowed('deepseek/deepseek-v4-pro:discounted')).resolves.toBe(true);
    await expect(isAllowed('stealth/gpt-5.6-sol')).resolves.toBe(false);
  });
});
