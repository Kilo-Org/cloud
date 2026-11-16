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
import type { ByokEndpointDefinition } from '@kilocode/db/schema-types';
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
}));
jest.mock('@kilocode/web-shared/lib/ai-gateway/providers/vercel', () => ({
  canRouteToVercel: jest.fn(async () => false),
  shouldRouteToVercel: jest.fn(async () => false),
}));

const CATALOG_MODEL = 'moonshotai/kimi-k2.6';
const ENDPOINT_ID = 'endpoint-a1b2c3d4e5';
const OTHER_ENDPOINT_ID = 'endpoint-f6g7h8i9j0';
const CREDENTIALS = JSON.stringify({ type: 'api_key', api_key: 'endpoint-secret' });

function endpoint(overrides: Partial<ByokEndpointDefinition> = {}): ByokEndpointDefinition {
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
  endpoint?: ByokEndpointDefinition;
  catalogMode?: boolean;
  isEnabled?: boolean;
  priority?: number;
  secret?: string;
};

async function organizationWithKeys(user: User, keys: KeyRow[]): Promise<string> {
  const organization = await createTestOrganization(`Endpoint ${crypto.randomUUID()}`, user.id, 0);
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
        endpoint: key.endpoint,
      },
    }))
  );
  return organization.id;
}

async function route(
  user: User,
  organizationId: string | undefined,
  model: string,
  options: { apiKind?: GatewayChatApiKind; isByokEndpointModelAllowed?: boolean } = {}
) {
  let decision: ProviderRoutingDecision | undefined;
  const result = await getProvider(
    getProviderInput({
      requestedModel: model,
      request: request(model, options.apiKind),
      user,
      organizationId,
      isByokEndpointModelAllowed: async () => options.isByokEndpointModelAllowed ?? true,
      onDecision: recorded => {
        decision = recorded;
      },
    })
  );
  if (!decision) throw new Error('getProvider reported no decision');
  return { result, decision };
}

function endpointSteps(decision: ProviderRoutingDecision) {
  return decision.steps.filter(step => step.step === 'byok-endpoint-model');
}

useFakeByokKms();

beforeEach(() => {
  jest.mocked(findDirectByokCatalogModels).mockResolvedValue([]);
  jest.mocked(getModelInferenceUserByokProviders).mockResolvedValue([]);
  jest.mocked(getModelGatewayUserByokProviders).mockResolvedValue(['openrouter']);
  jest.mocked(isValidOpenRouterModelId).mockImplementation(async id => id === CATALOG_MODEL);
  jest.mocked(shouldRouteToVercel).mockResolvedValue(false);
});

describe('getProvider for an endpoint model id', () => {
  test('serves the model with the endpoint, exempt from the organization policy', async () => {
    const user = await insertTestUser();
    const organizationId = await organizationWithKeys(user, [
      { providerId: ENDPOINT_ID, endpoint: endpoint() },
    ]);

    const { result, decision } = await route(user, organizationId, `${ENDPOINT_ID}/acme/coder`);

    const served = await onlyRoute(result);
    expect(served).toMatchObject({
      provider: {
        type: 'byok-endpoint',
        apiUrl: 'https://llm.acme.example/v1',
        apiKey: 'endpoint-secret',
        inferenceProviderId: ENDPOINT_ID,
      },
      userByok: [{ decryptedAPIKey: CREDENTIALS, providerId: ENDPOINT_ID }],
      isFree: false,
      bypassAccessCheck: true,
    });
    expect(endpointSteps(decision)).toEqual([
      { step: 'byok-endpoint-model', outcome: 'selected', provider_id: ENDPOINT_ID },
    ]);
    expect(decision.result).toMatchObject({
      kind: 'provider',
      route: 'byok-endpoint-model',
      provider_type: 'byok-endpoint',
      payer: 'owner-byok-key',
    });
  });

  test.each([
    {
      name: 'a personal request',
      keys: [{ providerId: ENDPOINT_ID, endpoint: endpoint() }],
      personal: true,
      model: `${ENDPOINT_ID}/acme/coder`,
      reason: 'no-organization',
    },
    {
      name: 'an endpoint the organization does not have',
      keys: [{ providerId: OTHER_ENDPOINT_ID, endpoint: endpoint() }],
      model: `${ENDPOINT_ID}/acme/coder`,
      reason: 'no-key',
    },
    {
      name: 'a disabled endpoint',
      keys: [{ providerId: ENDPOINT_ID, endpoint: endpoint(), isEnabled: false }],
      model: `${ENDPOINT_ID}/acme/coder`,
      reason: 'disabled',
    },
    {
      name: 'a model the endpoint does not list',
      keys: [{ providerId: ENDPOINT_ID, endpoint: endpoint() }],
      model: `${ENDPOINT_ID}/acme/other`,
      reason: 'unknown-model',
    },
    {
      name: 'credentials that do not parse',
      keys: [{ providerId: ENDPOINT_ID, endpoint: endpoint(), secret: 'not json' }],
      model: `${ENDPOINT_ID}/acme/coder`,
      reason: 'invalid-credentials',
    },
    {
      name: 'a stored definition that no longer parses',
      keys: [
        {
          providerId: ENDPOINT_ID,
          endpoint: { name: 'Broken' } as unknown as ByokEndpointDefinition,
        },
      ],
      model: `${ENDPOINT_ID}/acme/coder`,
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
    expect(result).toEqual({ kind: 'byok-endpoint-unavailable' });
    expect(endpointSteps(decision)).toEqual([
      {
        step: 'byok-endpoint-model',
        outcome: 'rejected',
        provider_id: ENDPOINT_ID,
        reason: testCase.reason,
      },
    ]);
    expect(decision.result).toEqual({ kind: 'byok-endpoint-unavailable' });
  });

  test('refuses a bespoke id of a catalog-mode endpoint, naming the catalog id', async () => {
    const user = await insertTestUser();
    const organizationId = await organizationWithKeys(user, [
      { providerId: ENDPOINT_ID, endpoint: endpoint(), catalogMode: true },
    ]);

    const catalog = await route(user, organizationId, `${ENDPOINT_ID}/${CATALOG_MODEL}`);
    const bespoke = await route(user, organizationId, `${ENDPOINT_ID}/acme/coder`);

    expect(catalog.result).toEqual({
      kind: 'byok-endpoint-catalog-only',
      endpointName: 'Acme',
      catalogModelId: CATALOG_MODEL,
    });
    expect(bespoke.result).toEqual({
      kind: 'byok-endpoint-catalog-only',
      endpointName: 'Acme',
      catalogModelId: null,
    });
    expect(endpointSteps(catalog.decision)).toEqual([
      {
        step: 'byok-endpoint-model',
        outcome: 'rejected',
        provider_id: ENDPOINT_ID,
        reason: 'catalog-only',
        catalog_model_id: CATALOG_MODEL,
      },
    ]);
  });
});

describe('getProvider for a catalog id an endpoint serves in catalog mode', () => {
  test('serves it with the endpoint ahead of other keys by default, failing over to them', async () => {
    const user = await insertTestUser();
    const organizationId = await organizationWithKeys(user, [
      { providerId: 'openrouter' },
      { providerId: ENDPOINT_ID, endpoint: endpoint(), catalogMode: true },
    ]);

    const { result, decision } = await route(user, organizationId, CATALOG_MODEL);

    expectProviderResult(result);
    expect(result.routes).toHaveLength(2);
    expect(await result.routes[0]()).toMatchObject({
      provider: { type: 'byok-endpoint', inferenceProviderId: ENDPOINT_ID },
      userByok: [{ providerId: ENDPOINT_ID }],
      bypassAccessCheck: false,
    });
    expect(await result.routes[1]?.()).toMatchObject({ userByok: [{ providerId: 'openrouter' }] });
    expect(decision.byok_candidates).toEqual([
      expect.objectContaining({
        route: 'endpoint-byok',
        provider_id: ENDPOINT_ID,
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
      { providerId: ENDPOINT_ID, endpoint: endpoint(), catalogMode: true, priority: 1 },
    ]);

    const { result } = await route(user, organizationId, CATALOG_MODEL);

    expect(await firstRoute(result)).toMatchObject({ userByok: [{ providerId: 'openrouter' }] });
  });

  test('skips the endpoint when the organization model policy does not admit the model', async () => {
    const user = await insertTestUser();
    const organizationId = await organizationWithKeys(user, [
      { providerId: 'openrouter' },
      { providerId: ENDPOINT_ID, endpoint: endpoint(), catalogMode: true },
    ]);

    const { result, decision } = await route(user, organizationId, CATALOG_MODEL, {
      isByokEndpointModelAllowed: false,
    });

    expect(await onlyRoute(result)).toMatchObject({ userByok: [{ providerId: 'openrouter' }] });
    expect(decision.steps).toContainEqual({
      step: 'organization-policy',
      excluded_provider_ids: [ENDPOINT_ID],
    });
  });

  test('ignores endpoints outside catalog mode and models they do not list', async () => {
    const user = await insertTestUser();
    const organizationId = await organizationWithKeys(user, [
      { providerId: ENDPOINT_ID, endpoint: endpoint() },
      {
        providerId: OTHER_ENDPOINT_ID,
        endpoint: endpoint({ models: [endpoint().models[0]] }),
        catalogMode: true,
      },
    ]);
    jest.mocked(getModelGatewayUserByokProviders).mockResolvedValue([]);

    const { result } = await route(user, organizationId, CATALOG_MODEL);

    expect(await onlyRoute(result)).toMatchObject({ userByok: null });
  });

  test('fails with the endpoint over another API kind instead of falling back to Kilo', async () => {
    const user = await insertTestUser();
    const organizationId = await organizationWithKeys(user, [
      { providerId: ENDPOINT_ID, endpoint: endpoint(), catalogMode: true },
    ]);
    jest.mocked(getModelGatewayUserByokProviders).mockResolvedValue([]);

    const { result, decision } = await route(user, organizationId, CATALOG_MODEL, {
      apiKind: 'messages',
    });

    expect(await onlyRoute(result)).toMatchObject({
      provider: { type: 'byok-endpoint', supportedChatApis: ['chat_completions'] },
      userByok: [{ providerId: ENDPOINT_ID }],
    });
    expect(decision.steps).toContainEqual({
      step: 'unsupported-api-kind',
      outcome: 'selected',
      provider_id: ENDPOINT_ID,
      supported_api_kinds: ['chat_completions'],
    });
  });

  test('never applies to a personal request', async () => {
    const user = await insertTestUser();
    await organizationWithKeys(user, [
      { providerId: ENDPOINT_ID, endpoint: endpoint(), catalogMode: true },
    ]);
    jest.mocked(getModelGatewayUserByokProviders).mockResolvedValue([]);

    const { result } = await route(user, undefined, CATALOG_MODEL);

    expect(await onlyRoute(result)).toMatchObject({ userByok: null });
  });
});

describe('previewByokRouting with endpoints', () => {
  test.each([
    { apiKind: 'chat_completions' as const, outcome: 'used', reason: 'serves' },
    { apiKind: 'messages' as const, outcome: 'skipped', reason: 'unsupported-api-kind' },
  ])('shows a catalog-mode endpoint for $apiKind', async ({ apiKind, outcome, reason }) => {
    const user = await insertTestUser();
    const organizationId = await organizationWithKeys(user, [
      { providerId: 'openrouter' },
      { providerId: ENDPOINT_ID, endpoint: endpoint(), catalogMode: true },
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
      route: 'endpoint-byok',
      outcome,
      providerId: ENDPOINT_ID,
      reason,
      supportedApiKinds: ['chat_completions'],
    });
  });

  test('treats an endpoint model id as outside the catalog', async () => {
    const user = await insertTestUser();
    const organizationId = await organizationWithKeys(user, [
      { providerId: ENDPOINT_ID, endpoint: endpoint() },
    ]);

    const preview = await previewByokRouting({
      fromDb: db,
      owner: { type: 'organization', id: organizationId },
      requestedModel: `${ENDPOINT_ID}/acme/coder`,
      apiKind: 'chat_completions',
    });

    expect(preview).toEqual({ kind: 'not-catalog-model' });
  });
});
