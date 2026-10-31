import { randomBytes } from 'node:crypto';
import { beforeEach, describe, expect, test } from '@jest/globals';
import {
  getProvider,
  previewByokRouting,
  type ByokRoutePreviewStep,
  type GetProviderResult,
} from '@kilocode/web-shared/lib/ai-gateway/providers/get-provider';
import {
  findDirectByokCatalogModels,
  type DirectByokCatalogModel,
} from '@kilocode/web-shared/lib/ai-gateway/providers/direct-byok';
import { apiKeyUpstream } from '@kilocode/web-shared/lib/ai-gateway/providers/direct-byok/types';
import syntheticDefinition from '@kilocode/web-shared/lib/ai-gateway/providers/direct-byok/synthetic';
import {
  getByokCredentials,
  getCatalogModeByokCredentials,
  getModelGatewayUserByokProviders,
  getModelInferenceUserByokProviders,
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
import type {
  GatewayUserByokProviderId,
  UserByokProviderId,
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
    getCatalogModeByokCredentials: jest.fn(actual.getCatalogModeByokCredentials),
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
  if (provider.id === 'direct-byok') {
    const providerId = userByok?.[0]?.providerId ?? '';
    return provider.supportedChatApis.includes(apiKind)
      ? { route: 'direct-byok', providerId }
      : { route: 'unsupported-api-kind', providerId };
  }
  if (!userByok) {
    if (provider === VERCEL_AI_GATEWAY) return { route: 'kilo', gateway: 'vercel' };
    if (provider === OPENROUTER) return { route: 'kilo', gateway: 'openrouter' };
    throw new Error(`unexpected Kilo provider ${provider.id}`);
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

        const routed = await getProvider({
          requestedModel: MODEL,
          request: request(apiKind),
          user,
          organizationId: owner.type === 'organization' ? owner.id : undefined,
        });

        jest.mocked(decryptApiKey).mockClear();
        jest.mocked(getByokCredentials).mockClear();
        jest.mocked(getCatalogModeByokCredentials).mockClear();
        const preview = await previewByokRouting({
          fromDb: db,
          owner,
          requestedModel: MODEL,
          apiKind,
        });
        expect(decryptApiKey).not.toHaveBeenCalled();
        expect(getByokCredentials).not.toHaveBeenCalled();
        expect(getCatalogModeByokCredentials).not.toHaveBeenCalled();

        if (preview.kind !== 'routes') throw new Error(`unexpected ${preview.kind} preview`);
        expect({ scenario, route: previewRouteOf(preview.steps) }).toEqual({
          scenario,
          route: routeOf(routed, apiKind),
        });
        const directKeyServes = preview.steps.some(
          step => step.route === 'direct-byok' && step.reason === 'serves'
        );
        if (directKeyServes) {
          expect(preview.steps.map(step => step.route)).not.toContain('unsupported-api-kind');
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
});

describe('getProvider with an organization provider allow-list', () => {
  async function routeForOrganizationKeys(
    providerIds: UserByokProviderId[],
    allowedProviders: ReadonlySet<string> | undefined
  ) {
    const user = await insertTestUser();
    const organization = await createTestOrganization(`Allow ${crypto.randomUUID()}`, user.id, 0);
    await db.insert(byok_api_keys).values(
      providerIds.map(providerId => ({
        organization_id: organization.id,
        provider_id: providerId,
        encrypted_api_key: encryptApiKey(`${providerId}-secret`, BYOK_ENCRYPTION_KEY),
        created_by: user.id,
      }))
    );
    jest.mocked(findDirectByokCatalogModels).mockResolvedValue([]);
    jest.mocked(canRouteToVercel).mockResolvedValue(false);
    jest.mocked(shouldRouteToVercel).mockResolvedValue(false);
    jest.mocked(getModelGatewayUserByokProviders).mockResolvedValue(['openrouter']);
    const routed = await getProvider({
      requestedModel: MODEL,
      request: request('chat_completions'),
      user,
      organizationId: organization.id,
      getAllowedProviders: async () => allowedProviders,
    });
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
      getProvider({
        requestedModel: MODEL,
        request: request('chat_completions'),
        user,
        organizationId: organization.id,
        getAllowedProviders: async () => new Set(['moonshotai']),
      })
    ).rejects.toThrow();
  });

  test('skips every provider key when no allowed provider serves the model', async () => {
    await expect(routeForOrganizationKeys(['moonshotai'], new Set())).resolves.toEqual({
      route: 'kilo',
      gateway: 'openrouter',
    });
  });
});
