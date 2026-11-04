import { randomBytes } from 'node:crypto';
import { beforeEach, describe, expect, test } from '@jest/globals';
import {
  getProvider,
  previewByokRouting,
  type ByokRoutePreviewStep,
  type GetProviderResult,
} from '@kilocode/web-shared/lib/ai-gateway/providers/get-provider';
import { getProviderInput } from '@kilocode/web-shared/tests/helpers/get-provider-input.helper';
import type { ProviderRoutingDecision } from '@kilocode/web-shared/lib/ai-gateway/providers/routing-decision';
import {
  findDirectByokCatalogModels,
  type DirectByokCatalogModel,
} from '@kilocode/web-shared/lib/ai-gateway/providers/direct-byok';
import { apiKeyUpstream } from '@kilocode/web-shared/lib/ai-gateway/providers/direct-byok/types';
import syntheticDefinition from '@kilocode/web-shared/lib/ai-gateway/providers/direct-byok/synthetic';
import {
  getByokCredentials,
  getModelGatewayUserByokProviders,
  getModelInferenceUserByokProviders,
  getStoredByokKeys,
  type ByokOwner,
} from '@kilocode/web-shared/lib/ai-gateway/byok';
import type * as byokModule from '@kilocode/web-shared/lib/ai-gateway/byok';
import type * as directByokModule from '@kilocode/web-shared/lib/ai-gateway/providers/direct-byok';
import type * as encryptionModule from '@kilocode/web-shared/lib/ai-gateway/byok/encryption';
import type * as chatGptRoutingModule from '@kilocode/web-shared/lib/ai-gateway/openai-chatgpt/routing';
import { getOpenAiChatGptCandidateModel } from '@kilocode/web-shared/lib/ai-gateway/openai-chatgpt/routing';
import type * as gatewayModelsCacheModule from '@kilocode/web-shared/lib/ai-gateway/providers/gateway-models-cache';
import { decryptApiKey, encryptApiKey } from '@kilocode/web-shared/lib/ai-gateway/byok/encryption';
import {
  canRouteToVercel,
  shouldRouteToVercel,
} from '@kilocode/web-shared/lib/ai-gateway/providers/vercel';
import { VERCEL_AI_GATEWAY } from '@kilocode/web-shared/lib/ai-gateway/providers/definitions/vercel';
import { OPENROUTER } from '@kilocode/web-shared/lib/ai-gateway/providers/definitions/openrouter';
import type { GatewayRequest } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/types';
import type { GatewayChatApiKind } from '@kilocode/web-shared/lib/ai-gateway/providers/types';
import {
  UserByokProviderIdSchema,
  type GatewayUserByokProviderId,
  type UserByokProviderId,
} from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/inference-provider-id';
import { BYOK_ENCRYPTION_KEY } from '@kilocode/web-shared/lib/config.server';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { byok_api_keys, type User } from '@kilocode/db/schema';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { createTestOrganization } from '@kilocode/web-shared/tests/helpers/organization.helper';

// Routing reads decrypted keys and the preview reads key metadata from the same rows. Only the
// model catalogs and gateway availability are faked, identically for both.
jest.mock('@kilocode/web-shared/lib/ai-gateway/providers/direct-byok', () => ({
  ...jest.requireActual<typeof directByokModule>(
    '@kilocode/web-shared/lib/ai-gateway/providers/direct-byok'
  ),
  findDirectByokCatalogModels: jest.fn(),
}));
jest.mock('@kilocode/web-shared/lib/ai-gateway/byok', () => {
  const actual = jest.requireActual<typeof byokModule>('@kilocode/web-shared/lib/ai-gateway/byok');
  return {
    ...actual,
    getModelInferenceUserByokProviders: jest.fn(),
    getModelGatewayUserByokProviders: jest.fn(),
    getByokCredentials: jest.fn(actual.getByokCredentials),
    getStoredByokKeys: jest.fn(actual.getStoredByokKeys),
  };
});
jest.mock('@kilocode/web-shared/lib/ai-gateway/byok/encryption', () => {
  const actual = jest.requireActual<typeof encryptionModule>(
    '@kilocode/web-shared/lib/ai-gateway/byok/encryption'
  );
  return { ...actual, decryptApiKey: jest.fn(actual.decryptApiKey) };
});
jest.mock('@kilocode/web-shared/lib/ai-gateway/providers/gateway-models-cache', () => ({
  ...jest.requireActual<typeof gatewayModelsCacheModule>(
    '@kilocode/web-shared/lib/ai-gateway/providers/gateway-models-cache'
  ),
  isValidOpenRouterModelId: jest.fn(async () => true),
}));
jest.mock('@kilocode/web-shared/lib/ai-gateway/openai-chatgpt/routing', () => {
  const actual = jest.requireActual<typeof chatGptRoutingModule>(
    '@kilocode/web-shared/lib/ai-gateway/openai-chatgpt/routing'
  );
  return {
    ...actual,
    getOpenAiChatGptCandidateModel: jest.fn(actual.getOpenAiChatGptCandidateModel),
  };
});
jest.mock('@kilocode/web-shared/lib/ai-gateway/providers/vercel', () => ({
  canRouteToVercel: jest.fn(),
  shouldRouteToVercel: jest.fn(),
}));

const MODEL = 'moonshotai/kimi-k2.6';

function catalogModel(
  id: 'synthetic' | 'zai-coding',
  supportedChatApis: GatewayChatApiKind[]
): DirectByokCatalogModel {
  return {
    provider: {
      id,
      models_dev_id: id,
      ...(id === 'zai-coding'
        ? { openrouter_inference_provider_id: 'z-ai' as const }
        : { provider_listing: syntheticDefinition.provider_listing }),
      ...apiKeyUpstream({
        apiUrl: `https://${id}.example/v1`,
        supportedChatApis,
        responseTransforms: null,
      }),
      transformRequest() {},
      models: async () => [],
    },
    model: { id: 'kimi-k2.6', name: 'Kimi K2.6', context_length: 1, max_completion_tokens: 1 },
  };
}

const CATALOG_MODELS = [
  catalogModel('synthetic', ['chat_completions']),
  catalogModel('zai-coding', ['chat_completions', 'responses']),
];

type KeyFixture = { providerId: UserByokProviderId; isEnabled: boolean; catalogMode: boolean };

function key(providerId: UserByokProviderId, state: 'catalog' | 'plain' | 'disabled'): KeyFixture {
  return { providerId, isEnabled: state !== 'disabled', catalogMode: state !== 'plain' };
}

function cartesian<T>(options: T[][]): T[][] {
  return options.reduce<T[][]>(
    (combinations, choices) =>
      combinations.flatMap(combination => choices.map(choice => [...combination, choice])),
    [[]]
  );
}

const KEY_SETS: KeyFixture[][] = cartesian<KeyFixture[]>([
  [[], [key('synthetic', 'catalog')], [key('synthetic', 'plain')], [key('synthetic', 'disabled')]],
  [[], [key('zai-coding', 'catalog')]],
  [[], [key('moonshotai', 'plain')], [key('moonshotai', 'disabled')]],
  [
    [],
    [key('vercel-ai-gateway', 'plain')],
    [key('openrouter', 'plain')],
    [key('vercel-ai-gateway', 'plain'), key('openrouter', 'plain')],
    [key('vercel-ai-gateway', 'disabled'), key('openrouter', 'plain')],
  ],
]).map(sets => sets.flat());

const SCENARIOS = cartesian<{
  apiKind?: GatewayChatApiKind;
  vercelServes?: boolean;
  gatewayProviders?: GatewayUserByokProviderId[];
}>([
  [{ apiKind: 'chat_completions' }, { apiKind: 'responses' }, { apiKind: 'messages' }],
  [{ vercelServes: true }, { vercelServes: false }],
  [{ gatewayProviders: ['vercel-ai-gateway', 'openrouter'] }, { gatewayProviders: ['openrouter'] }],
]).map(parts => Object.assign({}, ...parts) as Required<(typeof parts)[number]>);

function request(apiKind: GatewayChatApiKind): GatewayRequest {
  switch (apiKind) {
    case 'chat_completions':
      return { kind: apiKind, body: { model: MODEL, messages: [] } };
    case 'responses':
      return { kind: apiKind, body: { model: MODEL, input: 'hello' } };
    case 'messages':
      return { kind: apiKind, body: { model: MODEL, messages: [], max_tokens: 16 } };
  }
}

type RouteSignature =
  | { route: 'direct-byok' | 'unsupported-api-kind'; providerId: string }
  | { route: 'vercel-byok'; providerIds: string[] }
  | { route: 'gateway-byok'; providerId: string }
  | { route: 'kilo'; gateway: 'vercel' | 'openrouter' };

function routeOf(result: GetProviderResult, apiKind: GatewayChatApiKind): RouteSignature {
  if (result.kind !== 'provider') throw new Error(`unexpected ${result.kind} result`);
  const { provider, userByok } = result;
  if (provider.type === 'direct-byok') {
    const providerId = userByok?.[0]?.providerId ?? '';
    return provider.supportedChatApis.includes(apiKind)
      ? { route: 'direct-byok', providerId }
      : { route: 'unsupported-api-kind', providerId };
  }
  if (!userByok) {
    if (provider === VERCEL_AI_GATEWAY) return { route: 'kilo', gateway: 'vercel' };
    if (provider === OPENROUTER) return { route: 'kilo', gateway: 'openrouter' };
    throw new Error(`unexpected Kilo provider ${provider.type}`);
  }
  if (provider === VERCEL_AI_GATEWAY) {
    return { route: 'vercel-byok', providerIds: userByok.map(byok => byok.providerId) };
  }
  return { route: 'gateway-byok', providerId: userByok[0]?.providerId ?? '' };
}

function previewRouteOf(steps: ByokRoutePreviewStep[]): RouteSignature {
  const used = steps.filter(step => step.outcome === 'used');
  expect(used).toHaveLength(1);
  const [step] = used;
  switch (step.route) {
    case 'direct-byok':
    case 'unsupported-api-kind':
    case 'gateway-byok':
      return { route: step.route, providerId: step.providerId };
    case 'vercel-byok':
      return { route: step.route, providerIds: step.providerIds };
    case 'kilo':
      return { route: step.route, gateway: step.gateway };
    case 'chatgpt':
      throw new Error('a ChatGPT step is never used');
  }
}

type PreviewKeyStep = Extract<
  ByokRoutePreviewStep,
  { route: 'direct-byok' | 'vercel-byok' | 'gateway-byok' }
>;

function isPreviewKeyStep(step: ByokRoutePreviewStep): step is PreviewKeyStep {
  return (
    step.route === 'direct-byok' || step.route === 'vercel-byok' || step.route === 'gateway-byok'
  );
}

function previewProviderId(step: PreviewKeyStep): string {
  return step.route === 'vercel-byok' ? (step.providerIds[0] ?? '') : step.providerId;
}

type RoutedSteps = {
  candidates: { route: string; provider_id: string; outcome: string; reason?: string }[];
  steps: ProviderRoutingDecision['steps'];
};

/** The candidates and the steps after the model lookups that routing recorded. */
function routedSteps(decision: ProviderRoutingDecision | undefined): RoutedSteps {
  if (!decision) throw new Error('getProvider reported no decision');
  return {
    candidates: decision.byok_candidates.map(({ route, provider_id, outcome, reason }) => ({
      route,
      provider_id,
      outcome,
      ...(reason ? { reason } : {}),
    })),
    steps: decision.steps.filter(
      step => step.step !== 'custom-llm' && step.step !== 'direct-byok-model'
    ),
  };
}

/**
 * The decision `getProvider` must record when it follows the preview's steps without a usable
 * ChatGPT connection: every step above the used one is passed with the preview's reason, and none
 * below it is reached.
 */
function routedStepsOfPreview(steps: ByokRoutePreviewStep[]): RoutedSteps {
  const usedIndex = steps.findIndex(step => step.outcome === 'used');
  const used = steps[usedIndex];
  const keySteps = steps.filter(isPreviewKeyStep);
  const candidates = steps.flatMap<RoutedSteps['candidates'][number]>((step, index) => {
    if (!isPreviewKeyStep(step)) return [];
    const candidate = { route: step.route, provider_id: previewProviderId(step) };
    if (index > usedIndex) return [{ ...candidate, outcome: 'unreached' }];
    if (index === usedIndex) return [{ ...candidate, outcome: 'selected' }];
    const failsWithThisKey =
      used.route === 'unsupported-api-kind' &&
      step.route === 'direct-byok' &&
      used.providerId === step.providerId;
    return [
      { ...candidate, outcome: failsWithThisKey ? 'selected' : 'skipped', reason: step.reason },
    ];
  });

  const chatGptIndex = steps.findIndex(step => step.route === 'chatgpt');
  const catalogKeyServesAboveChatGpt = steps
    .slice(0, Math.max(chatGptIndex, 0))
    .some(step => step.route === 'direct-byok' && step.reason === 'serves');
  const routed: ProviderRoutingDecision['steps'] = catalogKeyServesAboveChatGpt
    ? [{ step: 'chatgpt', outcome: 'deferred', reason: 'catalog-key-serves' }]
    : steps
        .slice(0, usedIndex)
        .filter(step => step.route === 'chatgpt')
        .map(() => ({ step: 'chatgpt', outcome: 'skipped', reason: 'unavailable' }));
  const noKeyServed = {
    step: 'byok-key',
    outcome: 'skipped',
    reason: keySteps.length === 0 ? 'no-candidates' : 'none-served',
  } as const;
  switch (used.route) {
    case 'direct-byok':
    case 'vercel-byok':
    case 'gateway-byok':
      routed.push({
        step: 'byok-key',
        outcome: 'selected',
        route: used.route,
        provider_id: UserByokProviderIdSchema.parse(previewProviderId(used)),
      });
      break;
    case 'unsupported-api-kind':
      routed.push(noKeyServed, {
        step: 'unsupported-api-kind',
        outcome: 'selected',
        provider_id: used.providerId,
        supported_api_kinds: used.supportedApiKinds,
      });
      break;
    case 'kilo':
      routed.push(noKeyServed, {
        step: 'kilo',
        outcome: 'selected',
        gateway: used.gateway,
        bounded_spending: false,
        organization_disabled_vercel_ai_gateway: false,
        kilo_ignored_providers: [],
      });
      break;
    case 'chatgpt':
      throw new Error('a ChatGPT step is never used');
  }
  return { candidates, steps: routed };
}

async function createOwner(user: User, index: number): Promise<ByokOwner> {
  if (index % 2 === 0) return { type: 'user', id: user.id };
  const organization = await createTestOrganization(`Preview ${crypto.randomUUID()}`, user.id, 0);
  return { type: 'organization', id: organization.id };
}

beforeEach(() => {
  jest.mocked(findDirectByokCatalogModels).mockResolvedValue(CATALOG_MODELS);
  jest.mocked(getModelInferenceUserByokProviders).mockResolvedValue(['moonshotai']);
});

describe('previewByokRouting', () => {
  test.each(KEY_SETS.map((keys, index) => [index, keys] as const))(
    'uses the route getProvider takes for key set %i',
    async (index, keys) => {
      const user = await insertTestUser();
      const owner = await createOwner(user, index);
      if (keys.length > 0) {
        await db.insert(byok_api_keys).values(
          keys.map(({ providerId, isEnabled, catalogMode }) => ({
            ...(owner.type === 'user' ? { kilo_user_id: owner.id } : { organization_id: owner.id }),
            provider_id: providerId,
            encrypted_api_key: encryptApiKey(`${providerId}-secret`, BYOK_ENCRYPTION_KEY),
            created_by: user.id,
            is_enabled: isEnabled,
            settings: { serve_catalog_models: catalogMode },
          }))
        );
      }

      for (const { apiKind, vercelServes, gatewayProviders } of SCENARIOS) {
        jest.mocked(canRouteToVercel).mockResolvedValue(vercelServes);
        jest.mocked(shouldRouteToVercel).mockResolvedValue(vercelServes);
        jest.mocked(getModelGatewayUserByokProviders).mockResolvedValue(gatewayProviders);
        const scenario = { keys, apiKind, vercelServes, gatewayProviders };

        const decisions: ProviderRoutingDecision[] = [];
        const routed = await getProvider(
          getProviderInput({
            requestedModel: MODEL,
            request: request(apiKind),
            user,
            organizationId: owner.type === 'organization' ? owner.id : undefined,
            onDecision: decision => decisions.push(decision),
          })
        );
        expect(decisions.map(decision => decision.result)).toEqual([
          expect.objectContaining({ route: routeOf(routed, apiKind).route }),
        ]);

        jest.mocked(decryptApiKey).mockClear();
        jest.mocked(getByokCredentials).mockClear();
        jest.mocked(getStoredByokKeys).mockClear();
        const preview = await previewByokRouting({
          fromDb: db,
          owner,
          requestedModel: MODEL,
          apiKind,
        });
        expect(decryptApiKey).not.toHaveBeenCalled();
        expect(getByokCredentials).not.toHaveBeenCalled();
        expect(getStoredByokKeys).not.toHaveBeenCalled();

        if (preview.kind !== 'routes') throw new Error(`unexpected ${preview.kind} preview`);
        expect({ scenario, route: previewRouteOf(preview.steps) }).toEqual({
          scenario,
          route: routeOf(routed, apiKind),
        });
        expect({ scenario, decision: routedSteps(decisions[0]) }).toEqual({
          scenario,
          decision: routedStepsOfPreview(preview.steps),
        });
        const used = preview.steps.find(step => step.outcome === 'used');
        expect({ scenario, used }).not.toMatchObject({ used: { reason: 'disabled' } });
        if (!keys.some(({ isEnabled }) => isEnabled)) {
          expect({ scenario, used }).toMatchObject({ used: { route: 'kilo' } });
        }
        if (preview.steps.some(step => step.route === 'direct-byok' && step.reason === 'serves')) {
          expect(preview.steps.map(step => step.route)).not.toContain('unsupported-api-kind');
        }
      }
    }
  );

  test.each([
    { priorities: undefined, expected: 'synthetic' },
    { priorities: { synthetic: 1, 'zai-coding': 0 }, expected: 'zai-coding' },
    { priorities: { synthetic: 0, 'zai-coding': 1 }, expected: 'synthetic' },
  ])(
    'serves a catalog id with the first catalog-mode key in the owner order: $expected',
    async ({ priorities, expected }) => {
      const user = await insertTestUser();
      await db.insert(byok_api_keys).values(
        (['zai-coding', 'synthetic'] as const).map(providerId => ({
          kilo_user_id: user.id,
          provider_id: providerId,
          encrypted_api_key: encryptApiKey(`${providerId}-secret`, BYOK_ENCRYPTION_KEY),
          created_by: user.id,
          settings: { serve_catalog_models: true, priority: priorities?.[providerId] },
        }))
      );
      jest.mocked(shouldRouteToVercel).mockResolvedValue(false);
      jest.mocked(getModelGatewayUserByokProviders).mockResolvedValue([]);

      const routed = await getProvider(
        getProviderInput({
          requestedModel: MODEL,
          request: request('chat_completions'),
          user,
          organizationId: undefined,
        })
      );
      const preview = await previewByokRouting({
        fromDb: db,
        owner: { type: 'user', id: user.id },
        requestedModel: MODEL,
        apiKind: 'chat_completions',
      });

      if (preview.kind !== 'routes') throw new Error(`unexpected ${preview.kind} preview`);
      expect(routeOf(routed, 'chat_completions')).toEqual({
        route: 'direct-byok',
        providerId: expected,
      });
      expect(previewRouteOf(preview.steps)).toEqual({ route: 'direct-byok', providerId: expected });
    }
  );

  function permutations<T>(items: readonly T[]): T[][] {
    if (items.length <= 1) return [[...items]];
    return items.flatMap((item, index) =>
      permutations(items.toSpliced(index, 1)).map(rest => [item, ...rest])
    );
  }

  const PRIORITIZED_PROVIDERS = ['zai-coding', 'moonshotai', 'bedrock', 'openrouter'] as const;

  function expectedRoute(
    providerId: (typeof PRIORITIZED_PROVIDERS)[number],
    apiKind: GatewayChatApiKind,
    gatewayProviders: GatewayUserByokProviderId[]
  ): RouteSignature | null {
    switch (providerId) {
      case 'zai-coding':
        return apiKind === 'messages' ? null : { route: 'direct-byok', providerId };
      case 'moonshotai':
      case 'bedrock':
        return { route: 'vercel-byok', providerIds: [providerId] };
      case 'openrouter':
        return gatewayProviders.includes(providerId) ? { route: 'gateway-byok', providerId } : null;
    }
  }

  test.each(permutations(PRIORITIZED_PROVIDERS))(
    'uses the first key that serves in the owner order %s',
    async (...order) => {
      const user = await insertTestUser();
      await db.insert(byok_api_keys).values(
        order.map((providerId, priority) => ({
          kilo_user_id: user.id,
          provider_id: providerId,
          encrypted_api_key: encryptApiKey(`${providerId}-secret`, BYOK_ENCRYPTION_KEY),
          created_by: user.id,
          settings: { serve_catalog_models: providerId === 'zai-coding', priority },
        }))
      );
      jest.mocked(getModelInferenceUserByokProviders).mockResolvedValue(['moonshotai', 'bedrock']);
      jest.mocked(canRouteToVercel).mockResolvedValue(true);
      jest.mocked(shouldRouteToVercel).mockResolvedValue(true);

      for (const apiKind of ['chat_completions', 'messages'] as const) {
        for (const gatewayProviders of [
          ['openrouter'],
          [],
        ] satisfies GatewayUserByokProviderId[][]) {
          jest.mocked(getModelGatewayUserByokProviders).mockResolvedValue(gatewayProviders);
          const expected = order
            .map(providerId => expectedRoute(providerId, apiKind, gatewayProviders))
            .find(route => route !== null);

          const routed = await getProvider(
            getProviderInput({
              requestedModel: MODEL,
              request: request(apiKind),
              user,
              organizationId: undefined,
            })
          );
          const preview = await previewByokRouting({
            fromDb: db,
            owner: { type: 'user', id: user.id },
            requestedModel: MODEL,
            apiKind,
          });

          if (preview.kind !== 'routes') throw new Error(`unexpected ${preview.kind} preview`);
          const scenario = { apiKind, gatewayProviders };
          expect({ scenario, route: routeOf(routed, apiKind) }).toEqual({
            scenario,
            route: expected,
          });
          expect({ scenario, route: previewRouteOf(preview.steps) }).toEqual({
            scenario,
            route: expected,
          });
        }
      }
    }
  );

  test('marks the ChatGPT connection as not tried below a serving key', async () => {
    const user = await insertTestUser();
    await db.insert(byok_api_keys).values({
      kilo_user_id: user.id,
      provider_id: 'zai-coding',
      encrypted_api_key: encryptApiKey('zai-coding-secret', BYOK_ENCRYPTION_KEY),
      created_by: user.id,
      settings: { serve_catalog_models: true },
    });
    jest.mocked(getOpenAiChatGptCandidateModel).mockResolvedValueOnce('gpt-test');
    jest.mocked(shouldRouteToVercel).mockResolvedValue(false);

    const preview = await previewByokRouting({
      fromDb: db,
      owner: { type: 'user', id: user.id },
      requestedModel: MODEL,
      apiKind: 'responses',
    });

    if (preview.kind !== 'routes') throw new Error(`unexpected ${preview.kind} preview`);
    expect(preview.steps.map(({ route, outcome }) => ({ route, outcome }))).toEqual([
      { route: 'direct-byok', outcome: 'used' },
      { route: 'chatgpt', outcome: 'unreached' },
      { route: 'kilo', outcome: 'unreached' },
    ]);
  });

  test.each([
    { catalogPriority: 0, expected: 'serves' },
    { catalogPriority: 2, expected: 'fails closed' },
  ])(
    'decrypts only the key it uses: catalog key at priority $catalogPriority $expected',
    async ({ catalogPriority, expected }) => {
      const user = await insertTestUser();
      await db.insert(byok_api_keys).values([
        {
          kilo_user_id: user.id,
          provider_id: 'zai-coding',
          encrypted_api_key: encryptApiKey('zai-coding-secret', BYOK_ENCRYPTION_KEY),
          created_by: user.id,
          settings: { serve_catalog_models: true, priority: catalogPriority },
        },
        {
          kilo_user_id: user.id,
          provider_id: 'moonshotai',
          encrypted_api_key: encryptApiKey('moonshotai-secret', randomBytes(32).toString('base64')),
          created_by: user.id,
          settings: { priority: 1 },
        },
      ]);
      jest.mocked(shouldRouteToVercel).mockResolvedValue(true);
      jest.mocked(getModelGatewayUserByokProviders).mockResolvedValue([]);
      jest.mocked(decryptApiKey).mockClear();

      const routed = getProvider(
        getProviderInput({
          requestedModel: MODEL,
          request: request('chat_completions'),
          user,
          organizationId: undefined,
        })
      );

      if (expected === 'serves') {
        expect(routeOf(await routed, 'chat_completions')).toEqual({
          route: 'direct-byok',
          providerId: 'zai-coding',
        });
        expect(decryptApiKey).toHaveBeenCalledTimes(1);
      } else {
        await expect(routed).rejects.toThrow();
      }
    }
  );

  test('never decrypts a catalog key ranked below the gateway key that serves', async () => {
    const user = await insertTestUser();
    await db.insert(byok_api_keys).values([
      {
        kilo_user_id: user.id,
        provider_id: 'openrouter',
        encrypted_api_key: encryptApiKey('openrouter-secret', BYOK_ENCRYPTION_KEY),
        created_by: user.id,
        settings: { priority: 0 },
      },
      {
        kilo_user_id: user.id,
        provider_id: 'zai-coding',
        encrypted_api_key: encryptApiKey('zai-coding-secret', randomBytes(32).toString('base64')),
        created_by: user.id,
        settings: { serve_catalog_models: true, priority: 1 },
      },
    ]);
    jest.mocked(shouldRouteToVercel).mockResolvedValue(false);
    jest.mocked(getModelGatewayUserByokProviders).mockResolvedValue(['openrouter']);

    const routed = await getProvider(
      getProviderInput({
        requestedModel: MODEL,
        request: request('chat_completions'),
        user,
        organizationId: undefined,
      })
    );

    expect(routeOf(routed, 'chat_completions')).toEqual({
      route: 'gateway-byok',
      providerId: 'openrouter',
    });
  });

  test('ranks a key without a priority by its place in the whole key list, not among the eligible keys', async () => {
    const user = await insertTestUser();
    await db.insert(byok_api_keys).values([
      {
        kilo_user_id: user.id,
        provider_id: 'openrouter',
        encrypted_api_key: encryptApiKey('openrouter-secret', BYOK_ENCRYPTION_KEY),
        created_by: user.id,
        settings: { priority: 0 },
      },
      {
        kilo_user_id: user.id,
        provider_id: 'anthropic',
        encrypted_api_key: encryptApiKey('anthropic-secret', BYOK_ENCRYPTION_KEY),
        created_by: user.id,
        settings: { priority: 1 },
      },
      {
        kilo_user_id: user.id,
        provider_id: 'moonshotai',
        encrypted_api_key: encryptApiKey('moonshotai-secret', BYOK_ENCRYPTION_KEY),
        created_by: user.id,
      },
    ]);
    jest.mocked(findDirectByokCatalogModels).mockResolvedValue([]);
    jest.mocked(getModelInferenceUserByokProviders).mockResolvedValue(['moonshotai']);
    jest.mocked(getModelGatewayUserByokProviders).mockResolvedValue(['openrouter']);
    jest.mocked(shouldRouteToVercel).mockResolvedValue(false);

    const routed = await getProvider(
      getProviderInput({
        requestedModel: MODEL,
        request: request('chat_completions'),
        user,
        organizationId: undefined,
      })
    );
    const preview = await previewByokRouting({
      fromDb: db,
      owner: { type: 'user', id: user.id },
      requestedModel: MODEL,
      apiKind: 'chat_completions',
    });

    if (preview.kind !== 'routes') throw new Error(`unexpected ${preview.kind} preview`);
    const expected = { route: 'gateway-byok', providerId: 'openrouter' };
    expect(routeOf(routed, 'chat_completions')).toEqual(expected);
    expect(previewRouteOf(preview.steps)).toEqual(expected);
  });

  test('logs the selected key and why higher-ranked keys were skipped', async () => {
    const user = await insertTestUser();
    await db.insert(byok_api_keys).values(
      (['anthropic', 'bedrock'] as const).map((providerId, priority) => ({
        kilo_user_id: user.id,
        provider_id: providerId,
        encrypted_api_key: encryptApiKey(`${providerId}-secret`, BYOK_ENCRYPTION_KEY),
        created_by: user.id,
        settings: { priority },
      }))
    );
    jest.mocked(findDirectByokCatalogModels).mockResolvedValue([]);
    jest.mocked(getModelInferenceUserByokProviders).mockResolvedValue(['anthropic', 'bedrock']);
    jest.mocked(getModelGatewayUserByokProviders).mockResolvedValue([]);
    const debug = jest.spyOn(console, 'debug').mockImplementation(() => {});
    try {
      await getProvider(
        getProviderInput({
          requestedModel: MODEL,
          request: {
            kind: 'chat_completions',
            body: { model: MODEL, messages: [], provider: { ignore: ['anthropic'] } },
          },
          user,
          organizationId: undefined,
        })
      );

      expect(debug).toHaveBeenCalledWith('[getProvider] BYOK route selected', {
        requestedModel: MODEL,
        selected: 'bedrock',
        candidates: 2,
        skipped: [{ providerId: 'anthropic', reason: 'ignored-by-request' }],
      });
    } finally {
      debug.mockRestore();
    }
  });

  describe("the request's own provider.ignore", () => {
    async function routeWithIgnore(ignore: string[], providerIds: UserByokProviderId[]) {
      const user = await insertTestUser();
      await db.insert(byok_api_keys).values(
        providerIds.map((providerId, priority) => ({
          kilo_user_id: user.id,
          provider_id: providerId,
          encrypted_api_key: encryptApiKey(`${providerId}-secret`, BYOK_ENCRYPTION_KEY),
          created_by: user.id,
          settings: { priority },
        }))
      );
      jest.mocked(findDirectByokCatalogModels).mockResolvedValue([]);
      jest.mocked(getModelInferenceUserByokProviders).mockResolvedValue(['anthropic', 'bedrock']);
      jest.mocked(getModelGatewayUserByokProviders).mockResolvedValue(['openrouter']);
      jest.mocked(shouldRouteToVercel).mockResolvedValue(true);
      const routed = await getProvider(
        getProviderInput({
          requestedModel: MODEL,
          request: {
            kind: 'chat_completions',
            body: { model: MODEL, messages: [], provider: { ignore } },
          },
          user,
          organizationId: undefined,
        })
      );
      return routeOf(routed, 'chat_completions');
    }

    test('passes over an ignored provider key for the next key that serves', async () => {
      await expect(routeWithIgnore(['anthropic'], ['anthropic', 'bedrock'])).resolves.toEqual({
        route: 'vercel-byok',
        providerIds: ['bedrock'],
      });
      await expect(routeWithIgnore(['anthropic'], ['anthropic', 'openrouter'])).resolves.toEqual({
        route: 'gateway-byok',
        providerId: 'openrouter',
      });
    });

    test('still uses an ignored provider key when no other key serves', async () => {
      await expect(routeWithIgnore(['anthropic'], ['anthropic'])).resolves.toEqual({
        route: 'vercel-byok',
        providerIds: ['anthropic'],
      });
    });
  });

  test('puts the ChatGPT connection ahead of a gateway key the owner ranked above a catalog key', async () => {
    const user = await insertTestUser();
    await db.insert(byok_api_keys).values(
      (['openrouter', 'zai-coding'] as const).map((providerId, priority) => ({
        kilo_user_id: user.id,
        provider_id: providerId,
        encrypted_api_key: encryptApiKey(`${providerId}-secret`, BYOK_ENCRYPTION_KEY),
        created_by: user.id,
        settings: { serve_catalog_models: providerId === 'zai-coding', priority },
      }))
    );
    jest.mocked(getOpenAiChatGptCandidateModel).mockResolvedValueOnce('gpt-test');
    jest.mocked(getModelGatewayUserByokProviders).mockResolvedValue(['openrouter']);
    jest.mocked(shouldRouteToVercel).mockResolvedValue(false);

    const preview = await previewByokRouting({
      fromDb: db,
      owner: { type: 'user', id: user.id },
      requestedModel: MODEL,
      apiKind: 'responses',
    });

    if (preview.kind !== 'routes') throw new Error(`unexpected ${preview.kind} preview`);
    expect(preview.steps.map(({ route, outcome }) => ({ route, outcome }))).toEqual([
      { route: 'chatgpt', outcome: 'conditional' },
      { route: 'gateway-byok', outcome: 'used' },
      { route: 'direct-byok', outcome: 'unreached' },
      { route: 'kilo', outcome: 'unreached' },
    ]);
  });
});

describe('getProvider with an organization provider allow-list', () => {
  async function routeForOrganizationKeys(
    providerIds: UserByokProviderId[],
    allowedProviders: ReadonlySet<string> | undefined
  ) {
    const user = await insertTestUser();
    const organization = await createTestOrganization(`Allow ${crypto.randomUUID()}`, user.id, 0);
    await db.insert(byok_api_keys).values(
      providerIds.map((providerId, index) => ({
        organization_id: organization.id,
        provider_id: providerId,
        encrypted_api_key: encryptApiKey(`${providerId}-secret`, BYOK_ENCRYPTION_KEY),
        created_by: user.id,
        created_at: new Date(Date.UTC(2026, 0, index + 1)).toISOString(),
      }))
    );
    jest.mocked(findDirectByokCatalogModels).mockResolvedValue([]);
    jest.mocked(canRouteToVercel).mockResolvedValue(false);
    jest.mocked(shouldRouteToVercel).mockResolvedValue(false);
    jest.mocked(getModelGatewayUserByokProviders).mockResolvedValue(['openrouter']);
    const routed = await getProvider(
      getProviderInput({
        requestedModel: MODEL,
        request: request('chat_completions'),
        user,
        organizationId: organization.id,
        getAllowedProviders: async () => allowedProviders,
      })
    );
    return routeOf(routed, 'chat_completions');
  }

  test('uses a provider key the allow-list admits', async () => {
    await expect(
      routeForOrganizationKeys(['moonshotai'], new Set(['anthropic', 'moonshotai']))
    ).resolves.toEqual({ route: 'vercel-byok', providerIds: ['moonshotai'] });
  });

  test('uses provider keys when the policy does not restrict providers', async () => {
    await expect(routeForOrganizationKeys(['moonshotai'], undefined)).resolves.toEqual({
      route: 'vercel-byok',
      providerIds: ['moonshotai'],
    });
  });

  test('skips a provider key outside the allow-list for Kilo route', async () => {
    await expect(routeForOrganizationKeys(['moonshotai'], new Set(['anthropic']))).resolves.toEqual(
      { route: 'kilo', gateway: 'openrouter' }
    );
  });

  test('skips a provider key outside the allow-list for a gateway key', async () => {
    await expect(
      routeForOrganizationKeys(['moonshotai', 'openrouter'], new Set(['anthropic']))
    ).resolves.toEqual({ route: 'gateway-byok', providerId: 'openrouter' });
  });

  test('fails closed when the allowed key cannot be decrypted, even if a disallowed key can', async () => {
    const user = await insertTestUser();
    const organization = await createTestOrganization(`Allow ${crypto.randomUUID()}`, user.id, 0);
    const wrongKey = randomBytes(32).toString('base64');
    await db.insert(byok_api_keys).values([
      {
        organization_id: organization.id,
        provider_id: 'moonshotai',
        encrypted_api_key: encryptApiKey('moonshotai-secret', wrongKey),
        created_by: user.id,
      },
      {
        organization_id: organization.id,
        provider_id: 'anthropic',
        encrypted_api_key: encryptApiKey('anthropic-secret', BYOK_ENCRYPTION_KEY),
        created_by: user.id,
      },
    ]);
    jest.mocked(findDirectByokCatalogModels).mockResolvedValue([]);
    jest.mocked(getModelInferenceUserByokProviders).mockResolvedValue(['moonshotai', 'anthropic']);
    jest.mocked(shouldRouteToVercel).mockResolvedValue(false);

    await expect(
      getProvider(
        getProviderInput({
          requestedModel: MODEL,
          request: request('chat_completions'),
          user,
          organizationId: organization.id,
          getAllowedProviders: async () => new Set(['moonshotai']),
        })
      )
    ).rejects.toThrow();
  });

  test('uses the next key in order when the allow-list rejects the first one', async () => {
    jest.mocked(getModelInferenceUserByokProviders).mockResolvedValue(['moonshotai', 'anthropic']);

    await expect(routeForOrganizationKeys(['moonshotai', 'anthropic'], undefined)).resolves.toEqual(
      { route: 'vercel-byok', providerIds: ['moonshotai'] }
    );
    await expect(
      routeForOrganizationKeys(['moonshotai', 'anthropic'], new Set(['anthropic']))
    ).resolves.toEqual({ route: 'vercel-byok', providerIds: ['anthropic'] });
  });

  test('skips every provider key when no allowed provider serves the model', async () => {
    await expect(routeForOrganizationKeys(['moonshotai'], new Set())).resolves.toEqual({
      route: 'kilo',
      gateway: 'openrouter',
    });
  });
});
