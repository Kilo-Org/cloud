import { afterAll, afterEach, beforeAll, describe, expect, test } from '@jest/globals';
import { getProvider } from '@kilocode/web-shared/lib/ai-gateway/providers/get-provider';
import { getProviderInput } from '@kilocode/web-shared/tests/helpers/get-provider-input.helper';
import { applyProviderSpecificLogic } from '@kilocode/web-shared/lib/ai-gateway/providers/apply-provider-specific-logic';
import { EmptyFraudDetectionHeaders } from '@kilocode/web-shared/lib/fraud-detection-headers';
import { encryptApiKey } from '@kilocode/web-shared/lib/ai-gateway/byok/encryption';
import { BYOK_ENCRYPTION_KEY } from '@kilocode/web-shared/lib/config.server';
import { createAnonymousContext } from '@kilocode/web-shared/lib/anonymous';
import { resetCustomLlmCacheForTest } from '@kilocode/web-shared/lib/ai-gateway/custom-llm/custom-llm-catalog';
import type { GatewayRequest } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/types';
import type { User } from '@kilocode/db/schema';
import type { CustomPricingTiers } from '@kilocode/db/schema-types';
import {
  customLlmDefinition,
  deleteCustomLlmForTest,
  insertCustomLlmForTest,
  publicCustomLlmDefinition,
} from '@kilocode/web-shared/tests/helpers/custom-llm.helper';

const ORG_ID = '00000000-0000-4000-8000-000000000001';
const OTHER_ORG_ID = '00000000-0000-4000-8000-000000000002';
const user = { id: 'user-id' } as User;
const pricing: CustomPricingTiers = [
  {
    start_context_length: 0,
    pricing: {
      prompt_per_million: 1,
      completion_per_million: 2,
      input_cache_read_per_million: null,
      input_cache_write_per_million: null,
    },
  },
];
const encryptedApiKey = encryptApiKey(
  JSON.stringify({ type: 'api_key', api_key: 'sk-upstream' }),
  BYOK_ENCRYPTION_KEY
);

function providerInput(
  requestedModel: string,
  caller: User | ReturnType<typeof createAnonymousContext>,
  organizationId: string | undefined
) {
  return {
    requestedModel,
    request: {
      kind: 'chat_completions',
      body: { model: requestedModel, messages: [] },
    } satisfies GatewayRequest,
    user: caller,
    organizationId,
  };
}

describe('getProvider with public custom LLMs', () => {
  beforeAll(async () => {
    await insertCustomLlmForTest(
      'acme/public-model-free',
      publicCustomLlmDefinition(['acme']),
      encryptedApiKey
    );
    await insertCustomLlmForTest(
      'acme/public-web-model-free',
      publicCustomLlmDefinition(['acme'], { extra_body: { plugins: [{ id: 'web' }] } }),
      encryptedApiKey
    );
    await insertCustomLlmForTest(
      'acme/multi-api-model',
      publicCustomLlmDefinition(['acme'], { api_kinds: ['chat_completions', 'responses'] }),
      encryptedApiKey
    );
    await insertCustomLlmForTest(
      'acme/private-model-free',
      customLlmDefinition({ organization_ids: [ORG_ID] }),
      encryptedApiKey
    );
    await insertCustomLlmForTest(
      'acme/unpriced-public-model',
      publicCustomLlmDefinition(['acme']),
      encryptedApiKey
    );
    await insertCustomLlmForTest(
      'acme/unpriced-private-model',
      customLlmDefinition({ organization_ids: [ORG_ID] }),
      encryptedApiKey
    );
    await insertCustomLlmForTest(
      'acme/priced-public-model',
      publicCustomLlmDefinition(['acme'], { pricing }),
      encryptedApiKey
    );
    await insertCustomLlmForTest(
      'acme/priced-private-model',
      customLlmDefinition({ organization_ids: [ORG_ID], pricing }),
      encryptedApiKey
    );
    await insertCustomLlmForTest(
      'acme/country-denied-public-model-free',
      publicCustomLlmDefinition(['acme'], { country_deny_list: ['CU', 'KP'] }),
      encryptedApiKey
    );
    await insertCustomLlmForTest(
      'acme/country-denied-private-model',
      customLlmDefinition({ organization_ids: [ORG_ID], country_deny_list: ['CU'] }),
      encryptedApiKey
    );
  });

  afterAll(async () => {
    await deleteCustomLlmForTest('acme/public-model-free');
    await deleteCustomLlmForTest('acme/public-web-model-free');
    await deleteCustomLlmForTest('acme/private-model-free');
    await deleteCustomLlmForTest('acme/multi-api-model');
    await deleteCustomLlmForTest('acme/unpriced-public-model');
    await deleteCustomLlmForTest('acme/unpriced-private-model');
    await deleteCustomLlmForTest('acme/priced-public-model');
    await deleteCustomLlmForTest('acme/priced-private-model');
    await deleteCustomLlmForTest('acme/country-denied-public-model-free');
    await deleteCustomLlmForTest('acme/country-denied-private-model');
  });

  test.each([
    ['acme/country-denied-public-model-free', createAnonymousContext('127.0.0.1'), undefined],
    ['acme/country-denied-private-model', user, ORG_ID],
  ])('refuses %s for a caller from a denied country', async (model, caller, organizationId) => {
    await expect(
      getProvider(
        getProviderInput({ ...providerInput(model, caller, organizationId), countryCode: 'CU' })
      )
    ).resolves.toEqual({ kind: 'custom-llm-unavailable' });
  });

  test.each([
    ['another country', 'US'],
    ['an unknown country', null],
  ])('serves a country-restricted custom LLM to %s', async (_name, countryCode) => {
    for (const [model, caller, organizationId, providerId] of [
      [
        'acme/country-denied-public-model-free',
        createAnonymousContext('127.0.0.1'),
        undefined,
        'custom-public',
      ],
      ['acme/country-denied-private-model', user, ORG_ID, 'custom'],
    ] as const) {
      await expect(
        getProvider(
          getProviderInput({ ...providerInput(model, caller, organizationId), countryCode })
        )
      ).resolves.toMatchObject({ kind: 'provider', provider: { type: providerId } });
    }
  });

  afterEach(() => {
    jest.restoreAllMocks();
    resetCustomLlmCacheForTest();
  });

  test('routes a public custom LLM for an anonymous caller through policy checks', async () => {
    const result = await getProvider(
      getProviderInput(
        providerInput('acme/public-model-free', createAnonymousContext('127.0.0.1'), undefined)
      )
    );

    expect(result).toMatchObject({
      kind: 'provider',
      provider: {
        type: 'custom-public',
        apiUrl: 'https://upstream.example.com/v1',
        apiKey: 'sk-upstream',
      },
      bypassAccessCheck: false,
    });
  });

  test('serves the APIs a custom LLM lists, or the one its AI SDK provider implies', async () => {
    const multi = await getProvider(
      getProviderInput(providerInput('acme/multi-api-model', user, undefined))
    );
    const single = await getProvider(
      getProviderInput(providerInput('acme/public-model-free', user, undefined))
    );

    expect(multi).toMatchObject({
      provider: { supportedChatApis: ['chat_completions', 'responses'] },
    });
    expect(single).toMatchObject({ provider: { supportedChatApis: ['chat_completions'] } });
  });

  test('keeps a private custom LLM to its grantees, exempt from policy checks', async () => {
    await expect(
      getProvider(getProviderInput(providerInput('acme/private-model-free', user, ORG_ID)))
    ).resolves.toMatchObject({
      kind: 'provider',
      provider: { type: 'custom' },
      bypassAccessCheck: true,
    });
    await expect(
      getProvider(getProviderInput(providerInput('acme/private-model-free', user, OTHER_ORG_ID)))
    ).resolves.toEqual({ kind: 'custom-llm-unavailable' });
  });

  test.each([
    [
      'public',
      'an anonymous caller',
      'acme/public-model-free',
      createAnonymousContext('127.0.0.1'),
      undefined,
    ],
    ['public', 'a signed-in user', 'acme/public-model-free', user, undefined],
    ['private', 'a grantee', 'acme/private-model-free', user, ORG_ID],
  ])(
    'serves a %s custom LLM with a free id for free to %s',
    async (_visibility, _caller, model, caller, organizationId) => {
      await expect(
        getProvider(getProviderInput(providerInput(model, caller, organizationId)))
      ).resolves.toMatchObject({ kind: 'provider', isFree: true });
    }
  );

  test.each([
    ['public', 'a signed-in user', 'acme/unpriced-public-model', undefined],
    ['private', 'a grantee', 'acme/unpriced-private-model', ORG_ID],
  ])(
    'does not serve an unpriced %s custom LLM without a free id for free to %s',
    async (_visibility, _caller, model, organizationId) => {
      await expect(
        getProvider(getProviderInput(providerInput(model, user, organizationId)))
      ).resolves.toMatchObject({
        kind: 'provider',
        isFree: false,
      });
    }
  );

  test('refuses an unpriced public custom LLM without a free id to an anonymous caller', async () => {
    await expect(
      getProvider(
        getProviderInput(
          providerInput(
            'acme/unpriced-public-model',
            createAnonymousContext('127.0.0.1'),
            undefined
          )
        )
      )
    ).resolves.toEqual({ kind: 'custom-llm-unavailable' });
  });

  test('charges for a private custom LLM with pricing, still exempt from policy checks', async () => {
    await expect(
      getProvider(getProviderInput(providerInput('acme/priced-private-model', user, ORG_ID)))
    ).resolves.toMatchObject({
      kind: 'provider',
      provider: { type: 'custom' },
      isFree: false,
      bypassAccessCheck: true,
    });
  });

  test('charges a signed-in user for a public custom LLM with pricing', async () => {
    await expect(
      getProvider(getProviderInput(providerInput('acme/priced-public-model', user, undefined)))
    ).resolves.toMatchObject({
      kind: 'provider',
      provider: { type: 'custom-public' },
      isFree: false,
      bypassAccessCheck: false,
    });
  });

  test('refuses a public custom LLM with pricing to an anonymous caller', async () => {
    await expect(
      getProvider(
        getProviderInput(
          providerInput('acme/priced-public-model', createAnonymousContext('127.0.0.1'), undefined)
        )
      )
    ).resolves.toEqual({ kind: 'custom-llm-unavailable' });
  });

  async function upstreamBody(
    requestedModel: string,
    caller: User | ReturnType<typeof createAnonymousContext>,
    organizationId: string | undefined
  ) {
    const input = providerInput(requestedModel, caller, organizationId);
    const request: GatewayRequest = { kind: 'chat_completions', body: { ...input.request.body } };
    // Server tool types are not part of the declared request types.
    Object.assign(request.body, {
      plugins: [{ id: 'web' }],
      tools: [
        { type: 'openrouter:web_search' },
        { type: 'function', function: { name: 'read_file', parameters: {} } },
      ],
    });
    const result = await getProvider(getProviderInput({ ...input, request }));
    if (result.kind !== 'provider') throw new Error(`Expected a provider, got ${result.kind}`);
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    await applyProviderSpecificLogic(
      result.provider,
      requestedModel,
      request,
      {},
      result.userByok,
      EmptyFraudDetectionHeaders,
      caller.id,
      organizationId ?? null,
      null,
      null,
      false,
      null
    );
    return request.body;
  }

  test('strips paid server features from a public custom LLM request', async () => {
    const body = await upstreamBody(
      'acme/public-model-free',
      createAnonymousContext('127.0.0.1'),
      undefined
    );

    expect(body).not.toHaveProperty('plugins');
    expect(body.tools).toEqual([
      { type: 'function', function: { name: 'read_file', parameters: {} } },
    ]);
  });

  test('keeps plugins that a public custom LLM definition adds itself', async () => {
    const body = await upstreamBody(
      'acme/public-web-model-free',
      createAnonymousContext('127.0.0.1'),
      undefined
    );

    expect(body.plugins).toEqual([{ id: 'web' }]);
  });

  test('strips paid server features from a free private custom LLM request', async () => {
    const body = await upstreamBody('acme/private-model-free', user, ORG_ID);

    expect(body).not.toHaveProperty('plugins');
    expect(body.tools).toEqual([
      { type: 'function', function: { name: 'read_file', parameters: {} } },
    ]);
  });

  test('keeps paid server features in a private custom LLM request without a free id', async () => {
    const body = await upstreamBody('acme/unpriced-private-model', user, ORG_ID);

    expect(body.plugins).toEqual([{ id: 'web' }]);
    expect(body.tools).toHaveLength(2);
  });
});
