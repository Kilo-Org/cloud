import { afterAll, beforeAll, describe, expect, test } from '@jest/globals';
import {
  customLlmDefinition,
  deleteCustomLlmForTest,
  insertCustomLlmForTest,
} from '@kilocode/web-shared/tests/helpers/custom-llm.helper';
import {
  createAllowPredicateFromProviderAllowList,
  createAllowPredicateFromRestrictions,
  type ProviderLookup,
} from '@kilocode/web-shared/lib/model-allow.server';
import { CLAUDE_SONNET_LATEST_MODEL_ALIAS } from '@kilocode/web-shared/lib/ai-gateway/latest-model-aliases';
import type * as ExclusiveModels from '@kilocode/web-shared/lib/ai-gateway/kilo-exclusive-models';

// The live catalog's restricted Kilo-exclusive models come and go, so the restriction
// cases use a synthetic alias restricted to StepFun and keep the real lookup otherwise.
jest.mock('@kilocode/web-shared/lib/ai-gateway/kilo-exclusive-models', () => {
  const actual = jest.requireActual<typeof ExclusiveModels>(
    '@kilocode/web-shared/lib/ai-gateway/kilo-exclusive-models'
  );
  return {
    ...actual,
    getKiloExclusiveInferenceProviders: (modelId: string) =>
      modelId === 'test/restricted-exclusive'
        ? new Set(['stepfun'])
        : actual.getKiloExclusiveInferenceProviders(modelId),
  };
});

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

  describe('custom LLMs', () => {
    const ORG_ID = '00000000-0000-4000-8000-0000000000a1';
    const GROUP_ID = '00000000-0000-4000-8000-0000000000b1';
    const restrictions = {
      requireModelInCurrentSnapshot: true,
      providerAllowList: [],
      modelDenyList: ['acme/org-model', 'acme/group-model'],
    };

    beforeAll(async () => {
      await insertCustomLlmForTest(
        'acme/org-model',
        customLlmDefinition({ organization_ids: [ORG_ID] })
      );
      await insertCustomLlmForTest(
        'acme/group-model',
        customLlmDefinition({ organization_ids: [], group_ids: [GROUP_ID] })
      );
    });

    afterAll(async () => {
      await deleteCustomLlmForTest('acme/org-model');
      await deleteCustomLlmForTest('acme/group-model');
    });

    test.each([
      ['an allowlisted organization', 'acme/org-model', { organizationId: ORG_ID, groupIds: [] }],
      [
        'an allowlisted group',
        'acme/group-model',
        { organizationId: '00000000-0000-4000-8000-0000000000a2', groupIds: [GROUP_ID] },
      ],
    ])('exempts a custom LLM granted to %s', async (_grant, modelId, customLlmGrantee) => {
      const isAllowed = createAllowPredicateFromRestrictions(
        { ...restrictions, customLlmGrantee },
        lookup({})
      );

      await expect(isAllowed(modelId)).resolves.toBe(true);
    });

    test.each([
      [
        'another organization',
        { organizationId: '00000000-0000-4000-8000-0000000000a2', groupIds: [] },
      ],
      ['no grantee', undefined],
    ])('applies restrictions to a custom LLM for %s', async (_grant, customLlmGrantee) => {
      const isAllowed = createAllowPredicateFromRestrictions(
        { ...restrictions, customLlmGrantee },
        lookup({})
      );

      await expect(isAllowed('acme/org-model')).resolves.toBe(false);
    });

    test('does not exempt a kilo-internal/ id without a custom LLM', async () => {
      const isAllowed = createAllowPredicateFromRestrictions(
        { requireModelInCurrentSnapshot: true, providerAllowList: [], modelDenyList: [] },
        lookup({})
      );

      await expect(isAllowed('kilo-internal/missing-model')).resolves.toBe(false);
    });
  });

  test('keeps kilo-auto/balanced exempt from Enterprise model restrictions', async () => {
    const isAllowed = createAllowPredicateFromRestrictions(
      {
        requireModelInCurrentSnapshot: true,
        providerAllowList: [],
        modelDenyList: ['kilo-auto/balanced'],
      },
      lookup({})
    );

    await expect(isAllowed('kilo-auto/balanced')).resolves.toBe(true);
  });

  test('applies the model deny list to an organization provider model', async () => {
    const modelId = 'kimi-coding/kimi-for-coding';
    const isAllowed = createAllowPredicateFromRestrictions(
      {
        requireModelInCurrentSnapshot: true,
        providerAllowList: [],
        modelDenyList: [modelId],
      },
      lookup({})
    );

    await expect(isAllowed(modelId)).resolves.toBe(false);
  });

  test('allows an organization provider model the organization configured', async () => {
    const modelId = 'kimi-coding/kimi-for-coding';
    const isAllowed = createAllowPredicateFromRestrictions(
      {
        requireModelInCurrentSnapshot: true,
        providerAllowList: ['openai'],
        modelDenyList: [],
      },
      lookup({})
    );

    await expect(isAllowed(modelId)).resolves.toBe(true);
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
      lookup({ 'stepfun/step-5-preview': ['fireworks', 'stepfun'] })
    );

    await expect(isAllowed('test/restricted-exclusive')).resolves.toBe(false);
    await expect(isAllowed('stepfun/step-5-preview')).resolves.toBe(true);
  });

  test('provider allow list keeps restricted exclusive models when a restricted provider remains enabled', async () => {
    const isAllowed = createAllowPredicateFromProviderAllowList(
      undefined,
      ['stepfun', 'fireworks'],
      lookup({ 'stepfun/step-5-preview': ['fireworks'] })
    );

    await expect(isAllowed('test/restricted-exclusive')).resolves.toBe(true);
  });

  test('provider allow list still evaluates restricted exclusive models missing from the snapshot', async () => {
    const isAllowed = createAllowPredicateFromProviderAllowList(undefined, ['stepfun'], lookup({}));

    await expect(isAllowed('test/restricted-exclusive')).resolves.toBe(true);
    await expect(isAllowed('unknown/model')).resolves.toBe(false);
  });
});
