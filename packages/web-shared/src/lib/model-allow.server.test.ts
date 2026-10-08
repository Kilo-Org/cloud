import { afterAll, beforeAll, describe, expect, test } from '@jest/globals';
import {
  createAllowPredicateFromProviderAllowList,
  createAllowPredicateFromRestrictions,
  type ProviderLookup,
} from '@kilocode/web-shared/lib/model-allow.server';
import { CLAUDE_SONNET_LATEST_MODEL_ALIAS } from '@kilocode/web-shared/lib/ai-gateway/latest-model-aliases';
import {
  deleteCustomLlmForTest,
  insertCustomLlmForTest,
  privateCustomLlmDefinition,
  publicCustomLlmDefinition,
} from '@kilocode/web-shared/tests/helpers/custom-llm.helper';

function lookup(map: Record<string, string[]>): ProviderLookup {
  return async modelId => new Set(map[modelId] ?? []);
}

describe('model access predicates', () => {
  beforeAll(async () => {
    await insertCustomLlmForTest('acme/private-model', privateCustomLlmDefinition());
    await insertCustomLlmForTest('acme/public-model', publicCustomLlmDefinition(['acme']));
  });

  afterAll(async () => {
    await deleteCustomLlmForTest('acme/private-model');
    await deleteCustomLlmForTest('acme/public-model');
  });

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

  test('latest aliases remain subject to model restrictions', async () => {
    const deniedByModelPolicy = createAllowPredicateFromRestrictions(
      {
        requireModelInCurrentSnapshot: true,
        providerAllowList: ['anthropic'],
        modelDenyList: [CLAUDE_SONNET_LATEST_MODEL_ALIAS],
      },
      lookup({})
    );
    const missingFromSnapshot = createAllowPredicateFromRestrictions(
      {
        requireModelInCurrentSnapshot: true,
        providerAllowList: ['anthropic'],
        modelDenyList: [],
      },
      lookup({})
    );

    await expect(deniedByModelPolicy(CLAUDE_SONNET_LATEST_MODEL_ALIAS)).resolves.toBe(false);
    await expect(missingFromSnapshot(CLAUDE_SONNET_LATEST_MODEL_ALIAS)).resolves.toBe(false);
  });

  test.each(['kilo-auto/balanced', 'acme/private-model', 'kimi-coding/kimi-for-coding'])(
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

  test('does not exempt a kilo-internal/ id without a custom LLM', async () => {
    const isAllowed = createAllowPredicateFromRestrictions(
      { requireModelInCurrentSnapshot: true, providerAllowList: [], modelDenyList: [] },
      lookup({})
    );

    await expect(isAllowed('kilo-internal/missing-model')).resolves.toBe(false);
  });

  test('applies provider allow lists to the providers of a public custom LLM', async () => {
    const restrictions = { requireModelInCurrentSnapshot: true, modelDenyList: [] };
    const allowsAcme = createAllowPredicateFromRestrictions(
      { ...restrictions, providerAllowList: ['acme'] },
      lookup({})
    );
    const allowsOpenAi = createAllowPredicateFromRestrictions(
      { ...restrictions, providerAllowList: ['openai'] },
      lookup({ 'acme/public-model': ['openai'] })
    );
    const deniesModel = createAllowPredicateFromRestrictions(
      { ...restrictions, providerAllowList: ['acme'], modelDenyList: ['acme/public-model'] },
      lookup({})
    );

    await expect(allowsAcme('acme/public-model')).resolves.toBe(true);
    await expect(allowsOpenAi('acme/public-model')).resolves.toBe(false);
    await expect(deniesModel('acme/public-model')).resolves.toBe(false);
  });

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
      ['deepseek', 'fireworks'],
      lookup({ 'stepfun/step-3.7-flash': ['fireworks', 'stepfun'] })
    );

    await expect(isAllowed('stepfun/step-3.7-flash:free')).resolves.toBe(false);
    await expect(isAllowed('stepfun/step-3.7-flash')).resolves.toBe(true);
  });

  test('provider allow list keeps restricted exclusive models when a restricted provider remains enabled', async () => {
    const isAllowed = createAllowPredicateFromProviderAllowList(
      undefined,
      ['stepfun', 'fireworks'],
      lookup({ 'stepfun/step-3.7-flash': ['fireworks'] })
    );

    await expect(isAllowed('stepfun/step-3.7-flash:free')).resolves.toBe(true);
  });

  test('provider allow list still evaluates restricted exclusive models missing from the snapshot', async () => {
    const isAllowed = createAllowPredicateFromProviderAllowList(undefined, ['stepfun'], lookup({}));

    await expect(isAllowed('stepfun/step-3.7-flash:free')).resolves.toBe(true);
    await expect(isAllowed('unknown/model')).resolves.toBe(false);
  });
});
