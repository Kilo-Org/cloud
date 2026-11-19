import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import { byok_api_keys, type User } from '@kilocode/db/schema';
import type {
  CustomLlmDefinition,
  CustomPricingTiers,
  ReasoningEffort,
} from '@kilocode/db/schema-types';
import {
  getProvider,
  type GetProviderProviderResult,
} from '@kilocode/web-shared/lib/ai-gateway/providers/get-provider';
import {
  KiloRoutingDecisionRecordSchema,
  type ProviderRoutingDecision,
} from '@kilocode/web-shared/lib/ai-gateway/providers/routing-decision';
import { findDirectByokCatalogModels } from '@kilocode/web-shared/lib/ai-gateway/providers/direct-byok';
import type * as directByokModule from '@kilocode/web-shared/lib/ai-gateway/providers/direct-byok';
import {
  getModelGatewayUserByokProviders,
  getModelInferenceUserByokProviders,
} from '@kilocode/web-shared/lib/ai-gateway/byok';
import type * as byokModule from '@kilocode/web-shared/lib/ai-gateway/byok';
import { encryptApiKey } from '@kilocode/web-shared/lib/ai-gateway/byok/encryption';
import { checkOpenAiChatGptByok } from '@kilocode/web-shared/lib/ai-gateway/openai-chatgpt/routing';
import type * as chatGptRoutingModule from '@kilocode/web-shared/lib/ai-gateway/openai-chatgpt/routing';
import {
  canRouteToVercel,
  shouldRouteToVercel,
} from '@kilocode/web-shared/lib/ai-gateway/providers/vercel';
import type {
  GatewayRequest,
  OpenRouterProviderConfig,
} from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/types';
import { BYOK_ENCRYPTION_KEY } from '@kilocode/web-shared/lib/config.server';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { getProviderInput } from '@kilocode/web-shared/tests/helpers/get-provider-input.helper';
import {
  expectProviderResult,
  onlyRoute,
} from '@kilocode/web-shared/tests/helpers/get-provider-result.helper';
import {
  testByokEnvelope,
  useFakeByokKms,
} from '@kilocode/web-shared/tests/helpers/byok-kms.helper';
import {
  deleteCustomLlmForTest,
  insertCustomLlmForTest,
  partnerCustomLlmDefinition,
} from '@kilocode/web-shared/tests/helpers/custom-llm.helper';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';

jest.mock('@kilocode/web-shared/lib/ai-gateway/providers/direct-byok', () => ({
  ...jest.requireActual<typeof directByokModule>(
    '@kilocode/web-shared/lib/ai-gateway/providers/direct-byok'
  ),
  findDirectByokCatalogModels: jest.fn(),
}));
jest.mock('@kilocode/web-shared/lib/ai-gateway/byok', () => ({
  ...jest.requireActual<typeof byokModule>('@kilocode/web-shared/lib/ai-gateway/byok'),
  getModelInferenceUserByokProviders: jest.fn(),
  getModelGatewayUserByokProviders: jest.fn(),
}));
jest.mock('@kilocode/web-shared/lib/ai-gateway/openai-chatgpt/routing', () => ({
  ...jest.requireActual<typeof chatGptRoutingModule>(
    '@kilocode/web-shared/lib/ai-gateway/openai-chatgpt/routing'
  ),
  checkOpenAiChatGptByok: jest.fn(),
  getOpenAiChatGptCandidateModel: jest.fn(async () => null),
}));
jest.mock('@kilocode/web-shared/lib/ai-gateway/providers/gateway-models-cache', () => ({
  ...jest.requireActual<object>(
    '@kilocode/web-shared/lib/ai-gateway/providers/gateway-models-cache'
  ),
  resolveOpenRouterModelAlias: jest.fn(async (model: string) =>
    model === '~moonshotai/kimi-latest' ? 'moonshotai/kimi-k2.6' : model
  ),
}));
jest.mock('@kilocode/web-shared/lib/ai-gateway/providers/vercel', () => ({
  canRouteToVercel: jest.fn(),
  shouldRouteToVercel: jest.fn(),
}));

const MODEL = 'moonshotai/kimi-k2.6';
const LATEST_ALIAS = '~moonshotai/kimi-latest';
const PARTNER_PROVIDER = 'acme-ai';
const PARTNER_URL = 'https://partner.example.com/v1';
const pricing: CustomPricingTiers = [
  {
    start_context_length: 0,
    pricing: {
      prompt_per_million: 0.5,
      completion_per_million: 1.5,
      input_cache_read_per_million: null,
      input_cache_write_per_million: null,
    },
  },
];
const apiKeyCredentials = JSON.stringify({ type: 'api_key', api_key: 'partner-upstream-key' });

useFakeByokKms();

let user: User;

function chatRequest(provider?: OpenRouterProviderConfig): GatewayRequest {
  return { kind: 'chat_completions', body: { model: MODEL, messages: [], provider } };
}

async function insertPartner(
  overrides: Partial<CustomLlmDefinition> = {},
  credentials: string | null = apiKeyCredentials
) {
  await insertCustomLlmForTest(
    MODEL,
    partnerCustomLlmDefinition(PARTNER_PROVIDER, {
      internal_id: 'partner-kimi',
      base_url: PARTNER_URL,
      pricing,
      ...overrides,
    }),
    credentials === null ? null : encryptApiKey(credentials, BYOK_ENCRYPTION_KEY)
  );
}

async function routeAndRecord(
  input: Partial<Parameters<typeof getProviderInput>[0]> = {}
): Promise<{ result: GetProviderProviderResult; decision: ProviderRoutingDecision }> {
  const decisions: ProviderRoutingDecision[] = [];
  const result = await getProvider(
    getProviderInput({
      requestedModel: MODEL,
      request: chatRequest(),
      user,
      organizationId: undefined,
      ...input,
      onDecision: decision => decisions.push(decision),
    })
  );
  expectProviderResult(result);
  expect(decisions).toHaveLength(1);
  const [decision] = decisions;
  const serialized = JSON.stringify(decision);
  expect(
    KiloRoutingDecisionRecordSchema.parse({
      schema_version: 1,
      usage_id: crypto.randomUUID(),
      created_at: new Date().toISOString(),
      ...JSON.parse(serialized),
    })
  ).toMatchObject(decision);
  expect(serialized).not.toMatch(/partner-upstream-key|partner\.example\.com/);
  return { result, decision };
}

const NO_CUSTOM_LLM = { step: 'custom-llm', outcome: 'skipped', reason: 'no-match' } as const;
const NO_DIRECT_BYOK_MODEL = {
  step: 'direct-byok-model',
  outcome: 'skipped',
  reason: 'no-match',
} as const;
const NO_BYOK_KEYS = { step: 'byok-key', outcome: 'skipped', reason: 'no-candidates' } as const;

function kiloStep(extra: { partner_inference_provider?: string } = {}) {
  return {
    step: 'kilo',
    outcome: 'selected',
    gateway: 'vercel',
    bounded_spending: false,
    kilo_ignored_providers: [],
    ...extra,
  } as const;
}

function skippedPartnerStep(reason: string) {
  return {
    step: 'partner',
    outcome: 'skipped',
    partner_inference_provider: PARTNER_PROVIDER,
    reason,
  } as const;
}

async function expectKiloRouteOnly(
  input: Partial<Parameters<typeof getProviderInput>[0]>,
  reason: string
) {
  const { result, decision } = await routeAndRecord(input);

  expect(result.routes).toHaveLength(1);
  expect(await onlyRoute(result)).toMatchObject({
    provider: { type: 'vercel' },
    userByok: null,
    isFree: false,
  });
  expect((await result.routes[0]()).customLlmPricing).toBeUndefined();
  expect(decision.steps.filter(step => step.step !== 'organization-policy')).toEqual([
    NO_CUSTOM_LLM,
    NO_DIRECT_BYOK_MODEL,
    NO_BYOK_KEYS,
    skippedPartnerStep(reason),
    kiloStep(),
  ]);
  expect(decision.result).toMatchObject({
    kind: 'provider',
    route: 'kilo',
    provider_type: 'vercel',
    payer: 'kilo',
  });
}

beforeEach(async () => {
  user = await insertTestUser();
  jest.mocked(findDirectByokCatalogModels).mockResolvedValue([]);
  jest.mocked(getModelInferenceUserByokProviders).mockResolvedValue(['moonshotai']);
  jest.mocked(getModelGatewayUserByokProviders).mockResolvedValue([]);
  jest.mocked(checkOpenAiChatGptByok).mockReset().mockResolvedValue(null);
  jest.mocked(canRouteToVercel).mockResolvedValue(true);
  jest.mocked(shouldRouteToVercel).mockResolvedValue(true);
  jest.spyOn(console, 'debug').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(async () => {
  for (const method of ['debug', 'error'] as const) {
    const logger = console[method];
    if (jest.isMockFunction(logger)) logger.mockRestore();
  }
  await deleteCustomLlmForTest(MODEL);
});

describe('getProvider without a partner', () => {
  test('serves the catalog model through Kilo alone', async () => {
    const { result, decision } = await routeAndRecord();

    expect(await onlyRoute(result)).toMatchObject({
      provider: { type: 'vercel' },
      userByok: null,
    });
    expect(decision.steps).toEqual([NO_CUSTOM_LLM, NO_DIRECT_BYOK_MODEL, NO_BYOK_KEYS, kiloStep()]);
    expect(decision.steps).not.toContainEqual(expect.objectContaining({ step: 'partner' }));
  });

  test('ignores a custom LLM that owns a different id', async () => {
    await insertCustomLlmForTest('acme/other-model', partnerCustomLlmDefinition('acme'));
    try {
      const { result } = await routeAndRecord();

      expect(result.routes).toHaveLength(1);
      expect((await result.routes[0]()).provider.type).toBe('vercel');
    } finally {
      await deleteCustomLlmForTest('acme/other-model');
    }
  });
});

describe('getProvider with a partner', () => {
  test('tries the partner first and keeps Kilo as the failover route', async () => {
    await insertPartner();

    const { result, decision } = await routeAndRecord();

    expect(result.routes).toHaveLength(2);
    const partnerRoute = await result.routes[0]();
    expect(partnerRoute).toMatchObject({
      provider: {
        type: 'partner',
        inferenceProviderId: PARTNER_PROVIDER,
        apiUrl: PARTNER_URL,
        apiKey: 'partner-upstream-key',
        supportedChatApis: ['chat_completions'],
        responseTransforms: null,
      },
      userByok: null,
      isFree: false,
      bypassAccessCheck: false,
      customLlmPricing: pricing,
    });
    expect(partnerRoute.skipBalanceCheck).toBeUndefined();
    const kiloRoute = await result.routes[1]();
    expect(kiloRoute).toMatchObject({
      provider: { type: 'vercel' },
      userByok: null,
      isFree: false,
      bypassAccessCheck: false,
    });
    expect(kiloRoute.customLlmPricing).toBeUndefined();
    expect(decision.steps).toEqual([
      NO_CUSTOM_LLM,
      NO_DIRECT_BYOK_MODEL,
      NO_BYOK_KEYS,
      kiloStep({ partner_inference_provider: PARTNER_PROVIDER }),
    ]);
    expect(decision.result).toEqual({
      kind: 'provider',
      route: 'kilo',
      provider_type: 'partner',
      byok_provider_ids: [],
      payer: 'kilo',
      is_free: false,
    });
  });

  test('fails over to OpenRouter when Kilo routes there', async () => {
    await insertPartner();
    jest.mocked(shouldRouteToVercel).mockResolvedValue(false);

    const { result, decision } = await routeAndRecord();

    expect((await result.routes[0]()).provider.type).toBe('partner');
    expect((await result.routes[1]()).provider.type).toBe('openrouter');
    expect(decision.steps.at(-1)).toMatchObject({
      step: 'kilo',
      gateway: 'openrouter',
      partner_inference_provider: PARTNER_PROVIDER,
    });
  });

  test('applies the partner reasoning transform and upstream settings to the provider', async () => {
    await insertPartner({ reasoning_details_transform: 'mistral-thinking' });

    const { result } = await routeAndRecord();

    expect((await result.routes[0]()).provider.responseTransforms).toBe('mistral-thinking');
  });

  test('looks the partner up regardless of the requested id case', async () => {
    await insertPartner();

    const { result } = await routeAndRecord({
      requestedModel: MODEL.toUpperCase(),
      request: {
        kind: 'chat_completions',
        body: { model: MODEL.toUpperCase(), messages: [] },
      },
    });

    expect(result.routes).toHaveLength(2);
  });

  test('serves the partner to an organization member as well', async () => {
    await insertPartner();

    const { result } = await routeAndRecord({
      organizationId: '00000000-0000-4000-8000-000000000001',
    });

    expect(result.routes).toHaveLength(2);
    expect((await result.routes[0]()).provider.type).toBe('partner');
  });

  test('serves a request the partner allows through provider settings', async () => {
    await insertPartner();

    const { result } = await routeAndRecord({
      request: chatRequest({
        only: [PARTNER_PROVIDER, 'other'],
        ignore: ['elsewhere'],
        order: [PARTNER_PROVIDER],
        allow_fallbacks: false,
      }),
      getAllowedProviders: async () => new Set([PARTNER_PROVIDER, 'other']),
      kiloIgnoredProviders: ['elsewhere'],
      countryCode: 'US',
    });

    expect(result.routes).toHaveLength(2);
  });

  test('keeps a user BYOK key ahead of the partner without a partner route', async () => {
    await insertPartner();
    await db.insert(byok_api_keys).values({
      kilo_user_id: user.id,
      provider_id: 'moonshotai',
      encrypted_api_key_envelope: testByokEnvelope('moonshotai-secret'),
      created_by: user.id,
      is_enabled: true,
      settings: { serve_catalog_models: false },
    });

    const { result, decision } = await routeAndRecord();

    expect(result.routes).toHaveLength(1);
    const route = await onlyRoute(result);
    expect(route.provider.type).toBe('vercel');
    expect(route.userByok?.map(byok => byok.providerId)).toEqual(['moonshotai']);
    expect(route.customLlmPricing).toBeUndefined();
    expect(decision.steps).toEqual(
      expect.not.arrayContaining([
        expect.objectContaining({ step: 'partner' }),
        expect.objectContaining({ step: 'kilo' }),
      ])
    );
    expect(decision.result).toMatchObject({
      route: 'vercel-byok',
      payer: 'owner-byok-key',
    });
  });
});

describe('getProvider skips the partner', () => {
  test('for an API kind the partner does not serve', async () => {
    await insertPartner();
    const model = MODEL;

    await expectKiloRouteOnly(
      {
        request: { kind: 'responses', body: { model, input: 'hello' } },
      },
      'unsupported-api-kind'
    );
  });

  test('serves a partner that declares the requested API kind', async () => {
    await insertPartner({ api_kinds: ['chat_completions', 'responses'] });

    const { result } = await routeAndRecord({
      request: { kind: 'responses', body: { model: MODEL, input: 'hello' } },
    });

    expect(result.routes).toHaveLength(2);
    expect((await result.routes[0]()).provider.type).toBe('partner');
  });

  test('for a request with a spend ceiling', async () => {
    await insertPartner();

    const { result, decision } = await routeAndRecord({ boundedSpending: true });

    expect(result.routes).toHaveLength(1);
    expect(decision.steps).toEqual([
      NO_CUSTOM_LLM,
      NO_DIRECT_BYOK_MODEL,
      NO_BYOK_KEYS,
      skippedPartnerStep('bounded-spending'),
      { ...kiloStep(), bounded_spending: true },
    ]);
  });

  test('for an organization that disables OpenRouter', async () => {
    await insertPartner();

    await expectKiloRouteOnly({ openRouterDisabled: true }, 'openrouter-disabled');
  });

  test.each<[string, OpenRouterProviderConfig]>([
    ['only excludes the partner', { only: ['other'] }],
    ['ignore lists the partner', { ignore: [PARTNER_PROVIDER] }],
    ['ignore lists the partner in another case', { ignore: [PARTNER_PROVIDER.toUpperCase()] }],
    ['order excludes the partner without fallbacks', { order: ['other'], allow_fallbacks: false }],
    ['a price ceiling is set', { max_price: { prompt: 1 } }],
    ['zero data retention is required', { zdr: true }],
    ['data collection is denied', { data_collection: 'deny' }],
  ])('when the request provider settings say %s', async (_name, provider) => {
    await insertPartner();

    await expectKiloRouteOnly({ request: chatRequest(provider) }, 'provider-settings');
  });

  test.each<[string, OpenRouterProviderConfig]>([
    ['zero data retention', { zdr: true }],
    ['denied data collection', { data_collection: 'deny' }],
  ])('when the partner may train on prompts despite %s', async (_name, provider) => {
    await insertPartner({ may_train_on_prompts: true });

    await expectKiloRouteOnly({ request: chatRequest(provider) }, 'provider-settings');
  });

  test('when the organization policy provider settings exclude it', async () => {
    await insertPartner();

    await expectKiloRouteOnly(
      {
        request: chatRequest(),
        getRoutingProviderConfig: async () => ({ ignore: [PARTNER_PROVIDER] }),
      },
      'provider-settings'
    );
  });

  test("when Kilo's own ignored providers include it", async () => {
    await insertPartner();

    const { result, decision } = await routeAndRecord({ kiloIgnoredProviders: [PARTNER_PROVIDER] });

    expect(result.routes).toHaveLength(1);
    expect(decision.steps).toContainEqual(skippedPartnerStep('provider-settings'));
    expect(decision.steps.at(-1)).toEqual({
      ...kiloStep(),
      kilo_ignored_providers: [PARTNER_PROVIDER],
    });
  });

  test('when the allowed providers do not include it', async () => {
    await insertPartner();

    await expectKiloRouteOnly(
      { getAllowedProviders: async () => new Set(['other']) },
      'provider-settings'
    );
  });

  describe('for a reasoning effort the definition does not declare', () => {
    const efforts = (...values: ReasoningEffort[]) => ({
      opencode_settings: { reasoning_options: [{ type: 'effort', values }] },
      api_kinds: ['chat_completions', 'messages', 'responses'],
    });
    const declared = efforts('none', 'low', 'high', 'xhigh', 'max') as Partial<CustomLlmDefinition>;

    function request(kind: 'chat_completions' | 'messages' | 'responses', body: object) {
      return { kind, body: { model: MODEL, ...body } } as GatewayRequest;
    }

    test.each<[string, GatewayRequest]>([
      [
        'chat reasoning.effort',
        request('chat_completions', { messages: [], reasoning: { effort: 'medium' } }),
      ],
      [
        'chat reasoning_effort',
        request('chat_completions', { messages: [], reasoning_effort: 'minimal' }),
      ],
      [
        'chat reasoning.effort over reasoning_effort',
        request('chat_completions', {
          messages: [],
          reasoning: { effort: 'medium' },
          reasoning_effort: 'high',
        }),
      ],
      [
        'responses reasoning.effort',
        request('responses', { input: 'hi', reasoning: { effort: 'medium' } }),
      ],
      [
        'messages output_config.effort',
        request('messages', { messages: [], max_tokens: 1, output_config: { effort: 'medium' } }),
      ],
    ])('skips for %s', async (_name, gatewayRequest) => {
      await insertPartner(declared);

      await expectKiloRouteOnly({ request: gatewayRequest }, 'unsupported-reasoning-effort');
    });

    test.each<[string, GatewayRequest, Partial<CustomLlmDefinition>]>([
      [
        'chat reasoning.enabled false',
        request('chat_completions', { messages: [], reasoning: { enabled: false } }),
        efforts('low', 'high') as Partial<CustomLlmDefinition>,
      ],
      [
        'chat enable_thinking false',
        request('chat_completions', { messages: [], enable_thinking: false }),
        efforts('low', 'high') as Partial<CustomLlmDefinition>,
      ],
      [
        'responses effort none',
        request('responses', { input: 'hi', reasoning: { effort: 'none' } }),
        efforts('low', 'high') as Partial<CustomLlmDefinition>,
      ],
      [
        'messages thinking disabled',
        request('messages', { messages: [], max_tokens: 1, thinking: { type: 'disabled' } }),
        efforts('low', 'high') as Partial<CustomLlmDefinition>,
      ],
      [
        'a toggle that offers no other effort',
        request('chat_completions', { messages: [], reasoning: { effort: 'low' } }),
        { opencode_settings: { reasoning_options: [{ type: 'toggle' }] } },
      ],
    ])('skips for %s ', async (_name, gatewayRequest, overrides) => {
      await insertPartner(overrides);

      await expectKiloRouteOnly({ request: gatewayRequest }, 'unsupported-reasoning-effort');
    });

    test.each(['reasoning-content', 'reasoning'] as const)(
      'does not read reasoning.enabled false as none under the %s transform',
      async transform => {
        await insertPartner({
          ...(efforts('low', 'high') as Partial<CustomLlmDefinition>),
          reasoning_details_transform: transform,
        });

        const { result } = await routeAndRecord({
          request: request('chat_completions', { messages: [], reasoning: { enabled: false } }),
        });

        expect((await result.routes[0]()).provider.type).toBe('partner');
      }
    );

    test.each([
      ['reasoning-content', 'medium', 'high', true],
      ['reasoning-content', 'high', 'medium', false],
      ['reasoning-content', 'none', 'high', true],
      ['reasoning', 'medium', 'high', true],
      ['reasoning', 'high', 'medium', false],
    ] as const)(
      'under the %s transform, forwards the reasoning_effort that wins over reasoning.effort (%s, %s)',
      async (transform, effort, reasoningEffort, served) => {
        await insertPartner({
          ...(efforts('low', 'high') as Partial<CustomLlmDefinition>),
          reasoning_details_transform: transform,
        });
        const gatewayRequest = request('chat_completions', {
          messages: [],
          reasoning: { effort },
          reasoning_effort: reasoningEffort,
        });

        if (!served) {
          await expectKiloRouteOnly({ request: gatewayRequest }, 'unsupported-reasoning-effort');
          return;
        }
        const { result } = await routeAndRecord({ request: gatewayRequest });
        expect((await result.routes[0]()).provider.type).toBe('partner');
      }
    );

    test('reads reasoning.enabled false as none under the mistral-thinking transform', async () => {
      await insertPartner({
        ...(efforts('low', 'high') as Partial<CustomLlmDefinition>),
        reasoning_details_transform: 'mistral-thinking',
      });

      await expectKiloRouteOnly(
        { request: request('chat_completions', { messages: [], reasoning: { enabled: false } }) },
        'unsupported-reasoning-effort'
      );
    });

    test.each<[string, GatewayRequest, Partial<CustomLlmDefinition>]>([
      [
        'a declared chat effort',
        request('chat_completions', { messages: [], reasoning: { effort: 'xhigh' } }),
        declared,
      ],
      [
        'a declared responses effort',
        request('responses', { input: 'hi', reasoning: { effort: 'max' } }),
        declared,
      ],
      [
        'a declared messages effort',
        request('messages', { messages: [], max_tokens: 1, output_config: { effort: 'low' } }),
        declared,
      ],
      [
        'a disable when none is declared',
        request('chat_completions', { messages: [], reasoning: { enabled: false } }),
        declared,
      ],
      [
        'a toggle on',
        request('chat_completions', { messages: [], reasoning: { effort: 'high' } }),
        { opencode_settings: { reasoning_options: [{ type: 'toggle' }] } },
      ],
      [
        'a toggle off',
        request('chat_completions', { messages: [], reasoning: { enabled: false } }),
        { opencode_settings: { reasoning_options: [{ type: 'toggle' }] } },
      ],
      [
        'a toggle alongside efforts',
        request('chat_completions', { messages: [], reasoning: { effort: 'none' } }),
        {
          opencode_settings: {
            reasoning_options: [{ type: 'toggle' }, { type: 'effort', values: ['low', 'high'] }],
          },
        },
      ],
      ['a request without an effort', request('chat_completions', { messages: [] }), declared],
      [
        'a request with an enabled reasoning object only',
        request('chat_completions', { messages: [], reasoning: { enabled: true } }),
        declared,
      ],
      [
        'a definition without reasoning options',
        request('chat_completions', { messages: [], reasoning: { effort: 'medium' } }),
        { opencode_settings: {} },
      ],
      [
        'a definition with empty reasoning options',
        request('chat_completions', { messages: [], reasoning: { effort: 'medium' } }),
        { opencode_settings: { reasoning_options: [] } },
      ],
      [
        'a definition without effort values',
        request('chat_completions', { messages: [], reasoning: { effort: 'medium' } }),
        {
          opencode_settings: { reasoning_options: [{ type: 'effort', values: [null, 'default'] }] },
        },
      ],
    ])('serves %s through the partner', async (_name, gatewayRequest, overrides) => {
      await insertPartner({
        api_kinds: ['chat_completions', 'messages', 'responses'],
        ...overrides,
      });

      const { result } = await routeAndRecord({ request: gatewayRequest });

      expect(result.routes).toHaveLength(2);
      expect((await result.routes[0]()).provider.type).toBe('partner');
    });
  });

  test('for a latest alias that points at the partner model', async () => {
    await insertPartner();

    const { result, decision } = await routeAndRecord({ requestedModel: LATEST_ALIAS });

    expect(result.routes).toHaveLength(2);
    const partnerRoute = await result.routes[0]();
    expect(partnerRoute.provider.type).toBe('partner');
    expect(partnerRoute.customLlmPricing).toEqual(pricing);
    expect(decision.steps.at(-1)).toMatchObject({
      step: 'kilo',
      partner_inference_provider: PARTNER_PROVIDER,
    });
  });

  test.each<[string, Record<string, unknown>]>([
    ['a paid plugin', { plugins: [{ id: 'web' }] }],
    ['a server tool', { tools: [{ type: 'openrouter:web_search' }] }],
  ])('when the request asks for %s', async (_name, extra) => {
    await insertPartner();

    await expectKiloRouteOnly(
      { request: { kind: 'chat_completions', body: { ...chatRequest().body, ...extra } } as never },
      'server-features'
    );
  });

  test('not for a free plugin or a function tool', async () => {
    await insertPartner();

    const { result } = await routeAndRecord({
      request: {
        kind: 'chat_completions',
        body: {
          ...chatRequest().body,
          plugins: [{ id: 'response-healing' }],
          tools: [{ type: 'function', function: { name: 'f', parameters: {} } }],
        },
      } as never,
    });

    expect((await result.routes[0]()).provider.type).toBe('partner');
  });

  test('not when only lists the partner in another case', async () => {
    await insertPartner();

    const { result } = await routeAndRecord({
      request: chatRequest({ only: [PARTNER_PROVIDER.toUpperCase()] }),
    });

    expect((await result.routes[0]()).provider.type).toBe('partner');
  });

  test('not for denied data collection when the partner does not train on prompts', async () => {
    await insertPartner({ may_train_on_prompts: false });

    const { result } = await routeAndRecord({
      request: chatRequest({ data_collection: 'deny' }),
    });

    expect(result.routes).toHaveLength(2);
    expect((await result.routes[0]()).provider.type).toBe('partner');
  });

  test('for zero data retention even when the partner does not train on prompts', async () => {
    await insertPartner({ may_train_on_prompts: false });

    await expectKiloRouteOnly({ request: chatRequest({ zdr: true }) }, 'provider-settings');
  });

  test('when the partner has no usable credentials', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    await insertPartner({}, null);

    await expectKiloRouteOnly({}, 'invalid-credentials');
    expect(console.error).toHaveBeenCalledWith(
      'Partner custom LLM credentials are unusable',
      MODEL,
      { errorType: 'Error' }
    );
  });

  test('when the partner credentials are not valid JSON', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    await insertPartner({}, 'not json');

    await expectKiloRouteOnly({}, 'invalid-credentials');
  });

  test('when the partner credentials cannot be decrypted', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    await insertCustomLlmForTest(
      MODEL,
      partnerCustomLlmDefinition(PARTNER_PROVIDER, { base_url: PARTNER_URL, pricing }),
      { iv: 'AAAAAAAAAAAAAAAA', data: 'AAAA', authTag: 'AAAAAAAAAAAAAAAAAAAAAA==' }
    );

    await expectKiloRouteOnly({}, 'invalid-credentials');
  });
});
