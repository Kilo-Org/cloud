import { beforeEach, describe, expect, test } from '@jest/globals';
import {
  getProvider,
  previewByokRouting,
} from '@kilocode/web-shared/lib/ai-gateway/providers/get-provider';
import { getProviderInput } from '@kilocode/web-shared/tests/helpers/get-provider-input.helper';
import {
  expectProviderResult,
  firstRoute,
  onlyRoute,
} from '@kilocode/web-shared/tests/helpers/get-provider-result.helper';
import type { ProviderRoutingDecision } from '@kilocode/web-shared/lib/ai-gateway/providers/routing-decision';
import { findDirectByokCatalogModels } from '@kilocode/web-shared/lib/ai-gateway/providers/direct-byok';
import type * as directByokModule from '@kilocode/web-shared/lib/ai-gateway/providers/direct-byok';
import {
  getModelGatewayUserByokProviders,
  getModelInferenceUserByokProviders,
} from '@kilocode/web-shared/lib/ai-gateway/byok';
import type * as byokModule from '@kilocode/web-shared/lib/ai-gateway/byok';
import type * as gatewayModelsCacheModule from '@kilocode/web-shared/lib/ai-gateway/providers/gateway-models-cache';
import { isValidOpenRouterModelId } from '@kilocode/web-shared/lib/ai-gateway/providers/gateway-models-cache';
import { shouldRouteToVercel } from '@kilocode/web-shared/lib/ai-gateway/providers/vercel';
import type { GatewayRequest } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/types';
import type { GatewayChatApiKind } from '@kilocode/web-shared/lib/ai-gateway/providers/types';
import { EmptyFraudDetectionHeaders } from '@kilocode/web-shared/lib/fraud-detection-headers';
import type { ByokPrivateProviderDefinition } from '@kilocode/db/schema-types';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { byok_api_keys, type User } from '@kilocode/db/schema';
import {
  testByokEnvelope,
  useFakeByokKms,
} from '@kilocode/web-shared/tests/helpers/byok-kms.helper';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { createTestOrganization } from '@kilocode/web-shared/tests/helpers/organization.helper';

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
jest.mock('@kilocode/web-shared/lib/ai-gateway/providers/gateway-models-cache', () => ({
  ...jest.requireActual<typeof gatewayModelsCacheModule>(
    '@kilocode/web-shared/lib/ai-gateway/providers/gateway-models-cache'
  ),
  isValidOpenRouterModelId: jest.fn(),
  resolveOpenRouterModelAlias: jest.fn(async (modelId: string) =>
    modelId === LATEST_ALIAS ? 'moonshotai/kimi-k2.6' : modelId
  ),
}));
jest.mock('@kilocode/web-shared/lib/ai-gateway/providers/vercel', () => ({
  canRouteToVercel: jest.fn(async () => false),
  shouldRouteToVercel: jest.fn(async () => false),
  isValidVercelModelId: jest.fn(async () => false),
}));

const actualDirectByok = jest.requireActual<typeof directByokModule>(
  '@kilocode/web-shared/lib/ai-gateway/providers/direct-byok'
);

const CATALOG_MODEL = 'moonshotai/kimi-k2.6';
const LATEST_ALIAS = '~moonshotai/kimi-latest';
const PRIVATE_PROVIDER_ID = 'private-a1b2c3d4e5';
const OTHER_PRIVATE_PROVIDER_ID = 'private-f6g7h8i9j0';
const CREDENTIALS = JSON.stringify({ type: 'api_key', api_key: 'private-provider-secret' });

function privateProvider(
  overrides: Partial<ByokPrivateProviderDefinition> = {}
): ByokPrivateProviderDefinition {
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
      { id: CATALOG_MODEL, internal_id: 'kimi', context_length: 1000, max_completion_tokens: 10 },
    ],
    ...overrides,
  };
}

function request(model: string, apiKind: GatewayChatApiKind = 'chat_completions'): GatewayRequest {
  switch (apiKind) {
    case 'chat_completions':
      return { kind: apiKind, body: { model, messages: [] } };
    case 'responses':
      return { kind: apiKind, body: { model, input: 'hello' } };
    case 'messages':
      return { kind: apiKind, body: { model, messages: [], max_tokens: 16 } };
  }
}

type KeyRow = {
  providerId: string;
  privateProvider?: ByokPrivateProviderDefinition;
  catalogMode?: boolean;
  isEnabled?: boolean;
  priority?: number;
  secret?: string;
};

async function organizationWithKeys(user: User, keys: KeyRow[]): Promise<string> {
  const organization = await createTestOrganization(
    `Private provider ${crypto.randomUUID()}`,
    user.id,
    0
  );
  await db.insert(byok_api_keys).values(
    keys.map(key => ({
      organization_id: organization.id,
      provider_id: key.providerId,
      encrypted_api_key_envelope: testByokEnvelope(key.secret ?? CREDENTIALS),
      created_by: user.id,
      is_enabled: key.isEnabled ?? true,
      settings: {
        serve_catalog_models: key.catalogMode ?? false,
        priority: key.priority,
        private_provider: key.privateProvider,
      },
    }))
  );
  return organization.id;
}

async function route(
  user: User,
  organizationId: string | undefined,
  model: string,
  options: { apiKind?: GatewayChatApiKind; privateModelAllowed?: boolean } = {}
) {
  let decision: ProviderRoutingDecision | undefined;
  const result = await getProvider(
    getProviderInput({
      requestedModel: model,
      request: request(model, options.apiKind),
      user,
      organizationId,
      isDirectByokProviderAllowed: async target =>
        target.kind !== 'private-provider' || (options.privateModelAllowed ?? true),
      onDecision: recorded => {
        decision = recorded;
      },
    })
  );
  if (!decision) throw new Error('getProvider reported no decision');
  return { result, decision };
}

function privateProviderSteps(decision: ProviderRoutingDecision) {
  return decision.steps.filter(step => step.step === 'direct-byok-model');
}

useFakeByokKms();

beforeEach(() => {
  // No provider of `DIRECT_BYOK_PROVIDERS` serves the catalog id; the owner's private providers may.
  jest
    .mocked(findDirectByokCatalogModels)
    .mockImplementation(async (catalogModelId, providers) =>
      providers ? actualDirectByok.findDirectByokCatalogModels(catalogModelId, providers) : []
    );
  jest.mocked(getModelInferenceUserByokProviders).mockResolvedValue([]);
  jest.mocked(getModelGatewayUserByokProviders).mockResolvedValue(['openrouter']);
  jest.mocked(isValidOpenRouterModelId).mockImplementation(async id => id === CATALOG_MODEL);
  jest.mocked(shouldRouteToVercel).mockResolvedValue(false);
});

describe('getProvider for a private provider model id', () => {
  test('serves the model with the private provider, exempt from the organization policy', async () => {
    const user = await insertTestUser();
    const organizationId = await organizationWithKeys(user, [
      { providerId: PRIVATE_PROVIDER_ID, privateProvider: privateProvider() },
    ]);

    const { result, decision } = await route(
      user,
      organizationId,
      `${PRIVATE_PROVIDER_ID}/acme/coder`
    );

    const served = await onlyRoute(result);
    expect(served).toMatchObject({
      provider: {
        type: 'direct-byok',
        apiUrl: 'https://llm.acme.example/v1',
        apiKey: 'private-provider-secret',
        inferenceProviderId: PRIVATE_PROVIDER_ID,
      },
      userByok: [{ decryptedAPIKey: CREDENTIALS, providerId: PRIVATE_PROVIDER_ID }],
      isFree: false,
      bypassAccessCheck: true,
    });
    expect(privateProviderSteps(decision)).toEqual([
      { step: 'direct-byok-model', outcome: 'selected', provider_id: PRIVATE_PROVIDER_ID },
    ]);
    expect(decision.result).toMatchObject({
      kind: 'provider',
      route: 'direct-byok-model',
      provider_type: 'direct-byok',
      payer: 'owner-byok-key',
    });
  });

  test('never reports a request the private provider pays for as free, whatever the model id', async () => {
    const user = await insertTestUser();
    const base = privateProvider();
    const organizationId = await organizationWithKeys(user, [
      {
        providerId: PRIVATE_PROVIDER_ID,
        privateProvider: privateProvider({
          models: [{ ...base.models[0], id: 'acme/coder-free' }],
        }),
      },
    ]);

    const { result, decision } = await route(
      user,
      organizationId,
      `${PRIVATE_PROVIDER_ID}/acme/coder-free`
    );

    expect(await onlyRoute(result)).toMatchObject({ isFree: false });
    expect(decision.result).toMatchObject({ is_free: false });
  });

  test.each([
    {
      name: 'a personal request',
      keys: [{ providerId: PRIVATE_PROVIDER_ID, privateProvider: privateProvider() }],
      personal: true,
      model: `${PRIVATE_PROVIDER_ID}/acme/coder`,
      reason: 'no-organization',
    },
    {
      name: 'a private provider the organization does not have',
      keys: [{ providerId: OTHER_PRIVATE_PROVIDER_ID, privateProvider: privateProvider() }],
      model: `${PRIVATE_PROVIDER_ID}/acme/coder`,
      reason: 'no-key',
    },
    {
      name: 'a disabled private provider',
      keys: [
        { providerId: PRIVATE_PROVIDER_ID, privateProvider: privateProvider(), isEnabled: false },
      ],
      model: `${PRIVATE_PROVIDER_ID}/acme/coder`,
      reason: 'disabled',
    },
    {
      name: 'a model the private provider does not list',
      keys: [{ providerId: PRIVATE_PROVIDER_ID, privateProvider: privateProvider() }],
      model: `${PRIVATE_PROVIDER_ID}/acme/other`,
      reason: 'unknown-model',
    },
    {
      name: 'credentials that do not parse',
      keys: [
        { providerId: PRIVATE_PROVIDER_ID, privateProvider: privateProvider(), secret: 'not json' },
      ],
      model: `${PRIVATE_PROVIDER_ID}/acme/coder`,
      reason: 'invalid-credentials',
    },
    {
      name: 'a stored definition that no longer parses',
      keys: [
        {
          providerId: PRIVATE_PROVIDER_ID,
          privateProvider: { name: 'Broken' } as unknown as ByokPrivateProviderDefinition,
        },
      ],
      model: `${PRIVATE_PROVIDER_ID}/acme/coder`,
      reason: 'no-key',
    },
  ])('answers $name like an unknown model, never with another route', async testCase => {
    const user = await insertTestUser();
    const organizationId = await organizationWithKeys(user, [
      ...testCase.keys,
      { providerId: 'openrouter' },
    ]);
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});

    const { result, decision } = await route(
      user,
      testCase.personal ? undefined : organizationId,
      testCase.model
    );

    error.mockRestore();
    expect(result).toEqual({ kind: 'byok-private-provider-unavailable' });
    expect(privateProviderSteps(decision)).toEqual([
      {
        step: 'direct-byok-model',
        outcome: 'rejected',
        provider_id: PRIVATE_PROVIDER_ID,
        reason: testCase.reason,
      },
    ]);
    expect(decision.result).toEqual({ kind: 'byok-private-provider-unavailable' });
  });

  test('refuses a bespoke id of a catalog-mode private provider, naming the catalog id', async () => {
    const user = await insertTestUser();
    const organizationId = await organizationWithKeys(user, [
      { providerId: PRIVATE_PROVIDER_ID, privateProvider: privateProvider(), catalogMode: true },
    ]);

    const catalog = await route(user, organizationId, `${PRIVATE_PROVIDER_ID}/${CATALOG_MODEL}`);
    const bespoke = await route(user, organizationId, `${PRIVATE_PROVIDER_ID}/acme/coder`);

    expect(catalog.result).toEqual({
      kind: 'direct-byok-catalog-only',
      keyLabel: 'Acme private provider',
      catalogModelId: CATALOG_MODEL,
    });
    expect(bespoke.result).toEqual({
      kind: 'direct-byok-catalog-only',
      keyLabel: 'Acme private provider',
      catalogModelId: null,
    });
    expect(privateProviderSteps(catalog.decision)).toEqual([
      {
        step: 'direct-byok-model',
        outcome: 'rejected',
        provider_id: PRIVATE_PROVIDER_ID,
        reason: 'catalog-only',
        catalog_model_id: CATALOG_MODEL,
      },
    ]);
  });
});

describe('getProvider for a catalog id a private provider serves in catalog mode', () => {
  test('serves it with the private provider ahead of other keys by default, failing over to them', async () => {
    const user = await insertTestUser();
    const organizationId = await organizationWithKeys(user, [
      { providerId: 'openrouter' },
      { providerId: PRIVATE_PROVIDER_ID, privateProvider: privateProvider(), catalogMode: true },
    ]);

    const { result, decision } = await route(user, organizationId, CATALOG_MODEL);

    expectProviderResult(result);
    expect(result.routes).toHaveLength(2);
    expect(await result.routes[0]()).toMatchObject({
      provider: { type: 'direct-byok', inferenceProviderId: PRIVATE_PROVIDER_ID },
      userByok: [{ providerId: PRIVATE_PROVIDER_ID }],
      bypassAccessCheck: false,
    });
    expect(await result.routes[1]?.()).toMatchObject({ userByok: [{ providerId: 'openrouter' }] });
    expect(decision.byok_candidates).toEqual([
      expect.objectContaining({
        route: 'direct-byok',
        provider_id: PRIVATE_PROVIDER_ID,
        default_rank: -1,
        outcome: 'selected',
      }),
      expect.objectContaining({ route: 'gateway-byok', provider_id: 'openrouter' }),
    ]);
  });

  test('follows the owner priority over the default rank', async () => {
    const user = await insertTestUser();
    const organizationId = await organizationWithKeys(user, [
      { providerId: 'openrouter', priority: 0 },
      {
        providerId: PRIVATE_PROVIDER_ID,
        privateProvider: privateProvider(),
        catalogMode: true,
        priority: 1,
      },
    ]);

    const { result } = await route(user, organizationId, CATALOG_MODEL);

    expect(await firstRoute(result)).toMatchObject({ userByok: [{ providerId: 'openrouter' }] });
  });

  test('skips the private provider when the organization model policy does not admit the model', async () => {
    const user = await insertTestUser();
    const organizationId = await organizationWithKeys(user, [
      { providerId: 'openrouter' },
      { providerId: PRIVATE_PROVIDER_ID, privateProvider: privateProvider(), catalogMode: true },
    ]);

    const { result, decision } = await route(user, organizationId, CATALOG_MODEL, {
      privateModelAllowed: false,
    });

    expect(await onlyRoute(result)).toMatchObject({ userByok: [{ providerId: 'openrouter' }] });
    expect(decision.steps).toContainEqual({
      step: 'organization-policy',
      excluded_provider_ids: [PRIVATE_PROVIDER_ID],
    });
  });

  test('ignores private providers outside catalog mode and models they do not list', async () => {
    const user = await insertTestUser();
    const organizationId = await organizationWithKeys(user, [
      { providerId: PRIVATE_PROVIDER_ID, privateProvider: privateProvider() },
      {
        providerId: OTHER_PRIVATE_PROVIDER_ID,
        privateProvider: privateProvider({ models: [privateProvider().models[0]] }),
        catalogMode: true,
      },
    ]);
    jest.mocked(getModelGatewayUserByokProviders).mockResolvedValue([]);

    const { result } = await route(user, organizationId, CATALOG_MODEL);

    expect(await onlyRoute(result)).toMatchObject({ userByok: null });
  });

  test('fails with the private provider over another API kind instead of falling back to Kilo', async () => {
    const user = await insertTestUser();
    const organizationId = await organizationWithKeys(user, [
      { providerId: PRIVATE_PROVIDER_ID, privateProvider: privateProvider(), catalogMode: true },
    ]);
    jest.mocked(getModelGatewayUserByokProviders).mockResolvedValue([]);

    const { result, decision } = await route(user, organizationId, CATALOG_MODEL, {
      apiKind: 'messages',
    });

    expect(await onlyRoute(result)).toMatchObject({
      provider: { type: 'direct-byok', supportedChatApis: ['chat_completions'] },
      userByok: [{ providerId: PRIVATE_PROVIDER_ID }],
    });
    expect(decision.steps).toContainEqual({
      step: 'unsupported-api-kind',
      outcome: 'selected',
      provider_id: PRIVATE_PROVIDER_ID,
      supported_api_kinds: ['chat_completions'],
    });
  });

  test("serves a latest alias with the private provider model of the alias's target", async () => {
    const user = await insertTestUser();
    const organizationId = await organizationWithKeys(user, [
      { providerId: PRIVATE_PROVIDER_ID, privateProvider: privateProvider(), catalogMode: true },
    ]);
    jest.mocked(getModelGatewayUserByokProviders).mockResolvedValue([]);
    jest
      .mocked(isValidOpenRouterModelId)
      .mockImplementation(async id => id === CATALOG_MODEL || id === LATEST_ALIAS);

    const { result } = await route(user, organizationId, LATEST_ALIAS);

    const served = await onlyRoute(result);
    expect(served).toMatchObject({ userByok: [{ providerId: PRIVATE_PROVIDER_ID }] });
    const body = { model: LATEST_ALIAS, messages: [] };
    await served.provider.transformRequest({
      provider: served.provider,
      model: LATEST_ALIAS,
      request: { kind: 'chat_completions', body },
      originalHeaders: EmptyFraudDetectionHeaders,
      extraHeaders: {},
      userByok: served.userByok,
      kilo_user_id: user.id,
      organization_id: organizationId,
      session_id: null,
    });
    expect(body.model).toBe('kimi');
  });

  test('never applies to a personal request', async () => {
    const user = await insertTestUser();
    await organizationWithKeys(user, [
      { providerId: PRIVATE_PROVIDER_ID, privateProvider: privateProvider(), catalogMode: true },
    ]);
    jest.mocked(getModelGatewayUserByokProviders).mockResolvedValue([]);

    const { result } = await route(user, undefined, CATALOG_MODEL);

    expect(await onlyRoute(result)).toMatchObject({ userByok: null });
  });
});

describe('previewByokRouting with private providers', () => {
  test.each([
    { apiKind: 'chat_completions' as const, outcome: 'used', reason: 'serves' },
    { apiKind: 'messages' as const, outcome: 'skipped', reason: 'unsupported-api-kind' },
  ])('shows a catalog-mode private provider for $apiKind', async ({ apiKind, outcome, reason }) => {
    const user = await insertTestUser();
    const organizationId = await organizationWithKeys(user, [
      { providerId: 'openrouter' },
      { providerId: PRIVATE_PROVIDER_ID, privateProvider: privateProvider(), catalogMode: true },
    ]);

    const preview = await previewByokRouting({
      fromDb: db,
      owner: { type: 'organization', id: organizationId },
      requestedModel: CATALOG_MODEL,
      apiKind,
    });

    expect(preview).toMatchObject({ kind: 'routes' });
    if (preview.kind !== 'routes') throw new Error('expected routes');
    expect(preview.steps[0]).toEqual({
      route: 'direct-byok',
      outcome,
      providerId: PRIVATE_PROVIDER_ID,
      reason,
      supportedApiKinds: ['chat_completions'],
    });
  });

  test('explains a private provider outside catalog mode that lists the catalog id', async () => {
    const user = await insertTestUser();
    const organizationId = await organizationWithKeys(user, [
      { providerId: PRIVATE_PROVIDER_ID, privateProvider: privateProvider() },
    ]);

    const preview = await previewByokRouting({
      fromDb: db,
      owner: { type: 'organization', id: organizationId },
      requestedModel: CATALOG_MODEL,
      apiKind: 'chat_completions',
    });

    if (preview.kind !== 'routes') throw new Error('expected routes');
    expect(preview.steps[0]).toEqual({
      route: 'direct-byok',
      outcome: 'skipped',
      providerId: PRIVATE_PROVIDER_ID,
      reason: 'not-catalog-mode',
      supportedApiKinds: ['chat_completions'],
    });
  });

  test('treats a private provider model id as outside the catalog', async () => {
    const user = await insertTestUser();
    const organizationId = await organizationWithKeys(user, [
      { providerId: PRIVATE_PROVIDER_ID, privateProvider: privateProvider() },
    ]);

    const preview = await previewByokRouting({
      fromDb: db,
      owner: { type: 'organization', id: organizationId },
      requestedModel: `${PRIVATE_PROVIDER_ID}/acme/coder`,
      apiKind: 'chat_completions',
    });

    expect(preview).toEqual({ kind: 'not-catalog-model' });
  });
});
