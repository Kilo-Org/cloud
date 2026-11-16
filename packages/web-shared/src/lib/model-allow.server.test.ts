import { afterAll, beforeAll, describe, expect, test } from '@jest/globals';
import {
  customLlmDefinition,
  deleteCustomLlmForTest,
  insertCustomLlmForTest,
  publicCustomLlmDefinition,
} from '@kilocode/web-shared/tests/helpers/custom-llm.helper';
import {
  createAllowPredicateFromProviderAllowList,
  createAllowPredicateFromRestrictions,
  type CustomLlmGrantee,
  type ProviderLookup,
} from '@kilocode/web-shared/lib/model-allow.server';
import type { ByokEndpointDefinition } from '@kilocode/db/schema-types';
import { byok_api_keys } from '@kilocode/db/schema';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { testByokEnvelope } from '@kilocode/web-shared/tests/helpers/byok-kms.helper';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { createTestOrganization } from '@kilocode/web-shared/tests/helpers/organization.helper';
import { CLAUDE_SONNET_LATEST_MODEL_ALIAS } from '@kilocode/web-shared/lib/ai-gateway/latest-model-aliases';

const RESTRICTED_PUBLIC_MODEL = 'test/restricted-public';

function lookup(map: Record<string, string[]>): ProviderLookup {
  return async modelId => new Set(map[modelId] ?? []);
}

describe('model access predicates', () => {
  beforeAll(async () => {
    await insertCustomLlmForTest('acme/public-model', publicCustomLlmDefinition(['acme']));
    await insertCustomLlmForTest(RESTRICTED_PUBLIC_MODEL, publicCustomLlmDefinition(['stepfun']));
  });

  afterAll(async () => {
    await deleteCustomLlmForTest('acme/public-model');
    await deleteCustomLlmForTest(RESTRICTED_PUBLIC_MODEL);
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

  describe('endpoint models', () => {
    const ENDPOINT_ID = 'endpoint-a1b2c3d4e5';
    const CATALOG_ENDPOINT_ID = 'endpoint-b1c2d3e4f5';
    const DISABLED_ENDPOINT_ID = 'endpoint-c1d2e3f4g5';
    let organizationId: string;
    let otherOrganizationId: string;

    function endpointDefinition(): ByokEndpointDefinition {
      return {
        name: 'Acme',
        base_url: 'https://llm.acme.example/v1',
        api_kinds: ['chat_completions'],
        client_provider: 'openrouter',
        reasoning_format: 'reasoning-details',
        models: [
          {
            id: 'acme/coder',
            internal_id: 'coder-v2',
            context_length: 1000,
            max_completion_tokens: 10,
          },
        ],
      };
    }

    beforeAll(async () => {
      const user = await insertTestUser();
      organizationId = (await createTestOrganization(`Endpoint ${crypto.randomUUID()}`, user.id, 0))
        .id;
      otherOrganizationId = (
        await createTestOrganization(`Endpoint ${crypto.randomUUID()}`, user.id, 0)
      ).id;
      await db.insert(byok_api_keys).values(
        [
          { providerId: ENDPOINT_ID, catalogMode: false, isEnabled: true },
          { providerId: CATALOG_ENDPOINT_ID, catalogMode: true, isEnabled: true },
          { providerId: DISABLED_ENDPOINT_ID, catalogMode: false, isEnabled: false },
        ].map(key => ({
          organization_id: organizationId,
          provider_id: key.providerId,
          encrypted_api_key_envelope: testByokEnvelope('{"type":"api_key","api_key":"secret"}'),
          created_by: user.id,
          is_enabled: key.isEnabled,
          settings: { serve_catalog_models: key.catalogMode, endpoint: endpointDefinition() },
        }))
      );
    });

    function isAllowed(modelId: string, grantee: CustomLlmGrantee | undefined) {
      return createAllowPredicateFromRestrictions(
        {
          requireModelInCurrentSnapshot: true,
          providerAllowList: [],
          modelDenyList: [modelId],
          customLlmGrantee: grantee,
        },
        lookup({})
      )(modelId);
    }

    test('exempts a model the grantee organization endpoint lists', async () => {
      await expect(
        isAllowed(`${ENDPOINT_ID}/acme/coder`, { organizationId, groupIds: [] })
      ).resolves.toBe(true);
    });

    test.each([
      ['an unlisted model', `${ENDPOINT_ID}/acme/other`, () => organizationId],
      ['a catalog-mode endpoint', `${CATALOG_ENDPOINT_ID}/acme/coder`, () => organizationId],
      ['a disabled endpoint', `${DISABLED_ENDPOINT_ID}/acme/coder`, () => organizationId],
      ['an unknown endpoint', 'endpoint-zzzzzzzzzz/acme/coder', () => organizationId],
      ['another organization', `${ENDPOINT_ID}/acme/coder`, () => otherOrganizationId],
    ])('does not exempt %s', async (_case, modelId, grantee) => {
      await expect(isAllowed(modelId, { organizationId: grantee(), groupIds: [] })).resolves.toBe(
        false
      );
    });

    test('does not exempt an endpoint model without a grantee', async () => {
      await expect(isAllowed(`${ENDPOINT_ID}/acme/coder`, undefined)).resolves.toBe(false);
      await expect(isAllowed('endpoint-short/acme/coder', undefined)).resolves.toBe(false);
    });
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

  test.each(['kilo-auto/balanced', 'kimi-coding/kimi-for-coding'])(
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
      {
        ...restrictions,
        providerAllowList: ['acme'],
        modelDenyList: ['acme/public-model'],
        customLlmGrantee: { organizationId: '00000000-0000-4000-8000-0000000000a1', groupIds: [] },
      },
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

  test('provider allow list hides restricted public custom LLMs when every restricted provider is disabled', async () => {
    const isAllowed = createAllowPredicateFromProviderAllowList(
      undefined,
      ['deepseek', 'fireworks'],
      lookup({ 'stepfun/step-5-preview': ['fireworks', 'stepfun'] })
    );

    await expect(isAllowed(RESTRICTED_PUBLIC_MODEL)).resolves.toBe(false);
    await expect(isAllowed('stepfun/step-5-preview')).resolves.toBe(true);
  });

  test('provider allow list keeps restricted public custom LLMs when a restricted provider remains enabled', async () => {
    const isAllowed = createAllowPredicateFromProviderAllowList(
      undefined,
      ['stepfun', 'fireworks'],
      lookup({ 'stepfun/step-5-preview': ['fireworks'] })
    );

    await expect(isAllowed(RESTRICTED_PUBLIC_MODEL)).resolves.toBe(true);
  });

  test('provider allow list still evaluates restricted public custom LLMs missing from the snapshot', async () => {
    const isAllowed = createAllowPredicateFromProviderAllowList(undefined, ['stepfun'], lookup({}));

    await expect(isAllowed(RESTRICTED_PUBLIC_MODEL)).resolves.toBe(true);
    await expect(isAllowed('unknown/model')).resolves.toBe(false);
  });
});
