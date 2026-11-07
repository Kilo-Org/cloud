import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import { getProvider } from '@kilocode/web-shared/lib/ai-gateway/providers/get-provider';
import { getProviderInput } from '@kilocode/web-shared/tests/helpers/get-provider-input.helper';
import {
  KiloRoutingDecisionRecordSchema,
  type ProviderRoutingDecision,
} from '@kilocode/web-shared/lib/ai-gateway/providers/routing-decision';
import {
  findDirectByokCatalogModels,
  getDirectByokCatalogModelId,
  getDirectByokModel,
  type DirectByokCatalogModel,
} from '@kilocode/web-shared/lib/ai-gateway/providers/direct-byok';
import { apiKeyUpstream } from '@kilocode/web-shared/lib/ai-gateway/providers/direct-byok/types';
import syntheticDefinition from '@kilocode/web-shared/lib/ai-gateway/providers/direct-byok/synthetic';
import zaiCodingDefinition from '@kilocode/web-shared/lib/ai-gateway/providers/direct-byok/zai-coding';
import neuralwattDefinition from '@kilocode/web-shared/lib/ai-gateway/providers/direct-byok/neurowatt';
import {
  getModelGatewayUserByokProviders,
  getModelInferenceUserByokProviders,
  getStoredByokKeys,
} from '@kilocode/web-shared/lib/ai-gateway/byok';
import type * as byokModule from '@kilocode/web-shared/lib/ai-gateway/byok';
import type * as directByokModule from '@kilocode/web-shared/lib/ai-gateway/providers/direct-byok';
import type * as encryptionModule from '@kilocode/web-shared/lib/ai-gateway/byok/encryption';
import { decryptApiKey, encryptApiKey } from '@kilocode/web-shared/lib/ai-gateway/byok/encryption';
import { getByokKeyDefaultRank } from '@kilocode/web-shared/lib/ai-gateway/byok/route-order';
import { checkOpenAiChatGptByok } from '@kilocode/web-shared/lib/ai-gateway/openai-chatgpt/routing';
import type * as chatGptRoutingModule from '@kilocode/web-shared/lib/ai-gateway/openai-chatgpt/routing';
import {
  canRouteToVercel,
  shouldRouteToVercel,
} from '@kilocode/web-shared/lib/ai-gateway/providers/vercel';
import { OPENROUTER } from '@kilocode/web-shared/lib/ai-gateway/providers/definitions/openrouter';
import type { GatewayRequest } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/types';
import type { GatewayChatApiKind } from '@kilocode/web-shared/lib/ai-gateway/providers/types';
import type { UserByokProviderId } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/inference-provider-id';
import { BYOK_ENCRYPTION_KEY } from '@kilocode/web-shared/lib/config.server';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { byok_api_keys, claude_billing_connections, type User } from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';
import { isAnonymousContext } from '@kilocode/web-shared/lib/anonymous';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { insertCustomLlmForTest } from '@kilocode/web-shared/tests/helpers/custom-llm.helper';
import type { CustomLlmDefinition } from '@kilocode/db/schema-types';
import { createTestOrganization } from '@kilocode/web-shared/tests/helpers/organization.helper';
import { isClaudePlatformOAuthEnabled } from '@kilocode/web-shared/lib/auth/claude/feature-flag.server';

jest.mock('@kilocode/web-shared/lib/ai-gateway/providers/direct-byok', () => {
  const actual = jest.requireActual<typeof directByokModule>(
    '@kilocode/web-shared/lib/ai-gateway/providers/direct-byok'
  );
  return {
    ...actual,
    findDirectByokCatalogModels: jest.fn(),
    getDirectByokModel: jest.fn(actual.getDirectByokModel),
    getDirectByokCatalogModelId: jest.fn(),
  };
});
jest.mock('@kilocode/web-shared/lib/ai-gateway/byok', () => {
  const actual = jest.requireActual<typeof byokModule>('@kilocode/web-shared/lib/ai-gateway/byok');
  return {
    ...actual,
    getModelInferenceUserByokProviders: jest.fn(),
    getModelGatewayUserByokProviders: jest.fn(),
    getStoredByokKeys: jest.fn(actual.getStoredByokKeys),
  };
});
jest.mock('@kilocode/web-shared/lib/ai-gateway/byok/encryption', () => {
  const actual = jest.requireActual<typeof encryptionModule>(
    '@kilocode/web-shared/lib/ai-gateway/byok/encryption'
  );
  return { ...actual, decryptApiKey: jest.fn(actual.decryptApiKey) };
});
jest.mock('@kilocode/web-shared/lib/ai-gateway/openai-chatgpt/routing', () => ({
  ...jest.requireActual<typeof chatGptRoutingModule>(
    '@kilocode/web-shared/lib/ai-gateway/openai-chatgpt/routing'
  ),
  checkOpenAiChatGptByok: jest.fn(),
  getOpenAiChatGptCandidateModel: jest.fn(async (apiKind: GatewayChatApiKind) =>
    apiKind === 'responses' ? 'gpt-test' : null
  ),
}));
jest.mock('@kilocode/web-shared/lib/ai-gateway/providers/vercel', () => ({
  canRouteToVercel: jest.fn(),
  shouldRouteToVercel: jest.fn(),
}));
jest.mock('@kilocode/web-shared/lib/auth/claude/feature-flag.server', () => ({
  isClaudePlatformOAuthEnabled: jest.fn(async () => false),
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

function request(apiKind: GatewayChatApiKind, ignore?: string[]): GatewayRequest {
  const provider = ignore ? { ignore } : undefined;
  switch (apiKind) {
    case 'chat_completions':
      return { kind: apiKind, body: { model: MODEL, messages: [], provider } };
    case 'responses':
      return { kind: apiKind, body: { model: MODEL, input: 'hello', provider } };
    case 'messages':
      return { kind: apiKind, body: { model: MODEL, messages: [], max_tokens: 16, provider } };
  }
}

type KeyFixture = {
  providerId: UserByokProviderId;
  catalogMode?: boolean;
  priority?: number;
  isEnabled?: boolean;
};

async function insertKeys(user: User, keys: KeyFixture[], organizationId?: string): Promise<void> {
  if (keys.length === 0) return;
  await db.insert(byok_api_keys).values(
    keys.map(({ providerId, catalogMode = false, priority, isEnabled = true }) => ({
      ...(organizationId ? { organization_id: organizationId } : { kilo_user_id: user.id }),
      provider_id: providerId,
      encrypted_api_key: encryptApiKey(`${providerId}-secret`, BYOK_ENCRYPTION_KEY),
      created_by: user.id,
      is_enabled: isEnabled,
      settings: { serve_catalog_models: catalogMode, priority },
    }))
  );
}

async function routeAndRecord(
  input: Omit<Parameters<typeof getProviderInput>[0], 'onDecision'>
): Promise<ProviderRoutingDecision> {
  const decisions: ProviderRoutingDecision[] = [];
  await getProvider(
    getProviderInput({ ...input, onDecision: decision => decisions.push(decision) })
  );
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
  expect(serialized).not.toMatch(/secret|hello|upstream-key/);
  if (input.organizationId) expect(serialized).not.toContain(input.organizationId);
  if (!isAnonymousContext(input.user)) {
    expect(serialized).not.toContain(input.user.id);
    expect(serialized).not.toContain(input.user.google_user_email);
  }
  return decision;
}

function candidate(
  route: 'direct-byok' | 'vercel-byok' | 'gateway-byok',
  providerId: UserByokProviderId,
  routeOrder: number,
  outcome: 'selected' | 'skipped' | 'unreached',
  extra: { priority?: number; reason?: string } = {}
) {
  return {
    route,
    provider_id: providerId,
    priority: extra.priority ?? null,
    default_rank: getByokKeyDefaultRank(providerId),
    route_order: routeOrder,
    outcome,
    ...(extra.reason ? { reason: extra.reason } : {}),
  };
}

const NO_CUSTOM_LLM = { step: 'custom-llm', outcome: 'skipped', reason: 'no-match' } as const;
const NO_DIRECT_BYOK_MODEL = {
  step: 'direct-byok-model',
  outcome: 'skipped',
  reason: 'no-match',
} as const;
const CHATGPT_UNAVAILABLE = { step: 'chatgpt', outcome: 'skipped', reason: 'unavailable' } as const;

beforeEach(() => {
  jest.mocked(findDirectByokCatalogModels).mockResolvedValue([]);
  jest.mocked(getModelInferenceUserByokProviders).mockResolvedValue(['moonshotai', 'anthropic']);
  jest.mocked(getModelGatewayUserByokProviders).mockResolvedValue(['openrouter']);
  jest.mocked(checkOpenAiChatGptByok).mockReset().mockResolvedValue(null);
  jest.mocked(canRouteToVercel).mockResolvedValue(true);
  jest.mocked(shouldRouteToVercel).mockResolvedValue(true);
  jest.mocked(decryptApiKey).mockClear();
  jest.spyOn(console, 'debug').mockImplementation(() => {});
});

afterEach(() => {
  for (const method of ['debug', 'warn', 'error'] as const) {
    const logger = console[method];
    if (jest.isMockFunction(logger)) logger.mockRestore();
  }
});

describe('getProvider routing decision', () => {
  test.each([false, true])(
    'never falls back from a connected Claude payer for an ineligible requester (org=%s)',
    async organization => {
      const scope = organization ? 'org' : 'personal';
      const user = await insertTestUser({ google_user_email: `requester-${scope}@example.com` });
      const connector = await insertTestUser({
        google_user_email: `connector-${scope}@kilocode.ai`,
      });
      const org = organization
        ? await createTestOrganization('Claude requester', user.id, 0)
        : null;
      await db.insert(claude_billing_connections).values({
        kilo_user_id: org ? null : user.id,
        organization_id: org?.id ?? null,
        user_profile_id: `uprof_${user.id}`,
        status: 'connected',
        connection_id: `ocon_${user.id}`,
        created_by: connector.id,
      });
      await insertKeys(user, [{ providerId: 'anthropic' }], org?.id);
      jest.mocked(getStoredByokKeys).mockClear();
      jest.mocked(isClaudePlatformOAuthEnabled).mockClear();
      const model = 'anthropic/claude-sonnet-4.6';
      const result = await getProvider(
        getProviderInput({
          user,
          organizationId: org?.id,
          requestedModel: model,
          request: {
            kind: 'messages',
            body: { model, messages: [], max_tokens: 16 },
          },
        })
      );
      expect(result).toMatchObject({ kind: 'claude-billing-unavailable' });
      expect(isClaudePlatformOAuthEnabled).toHaveBeenCalledWith(user.google_user_email);
      expect(isClaudePlatformOAuthEnabled).not.toHaveBeenCalledWith(connector.google_user_email);
      expect(getStoredByokKeys).not.toHaveBeenCalled();
      expect(decryptApiKey).not.toHaveBeenCalled();
      expect(checkOpenAiChatGptByok).not.toHaveBeenCalled();
    }
  );

  test('keeps normal routing for a Claude request without a connection and does not evaluate the gate', async () => {
    const user = await insertTestUser();
    const model = 'anthropic/claude-sonnet-4.6';
    jest.mocked(isClaudePlatformOAuthEnabled).mockClear();
    const result = await getProvider(
      getProviderInput({
        user,
        organizationId: undefined,
        requestedModel: model,
        request: {
          kind: 'messages',
          body: { model, messages: [], max_tokens: 16 },
        },
      })
    );
    expect(result).toMatchObject({ kind: 'provider' });
    expect(isClaudePlatformOAuthEnabled).not.toHaveBeenCalled();
    if (result.kind !== 'provider') throw new Error('Expected normal gateway routing');
    expect(result.provider.type).not.toBe('claude-billing');
  });

  describe.each([
    { provider: zaiCodingDefinition, inferenceProviderId: 'z-ai' },
    { provider: neuralwattDefinition, inferenceProviderId: 'neuralwatt' },
  ])('$provider.id inference provider attribution', ({ provider, inferenceProviderId }) => {
    test.each([false, true])('uses the policy ID with catalog mode=%s', async catalogMode => {
      const user = await insertTestUser();
      await insertKeys(user, [{ providerId: provider.id, catalogMode }]);
      const model = {
        id: 'upstream-model',
        name: 'Model',
        context_length: 1,
        max_completion_tokens: 1,
      };
      const requestedModel = catalogMode ? MODEL : `${provider.id}/${model.id}`;
      if (catalogMode) {
        jest.mocked(findDirectByokCatalogModels).mockResolvedValue([{ provider, model }]);
      } else {
        jest.mocked(getDirectByokModel).mockResolvedValueOnce({ provider, model });
      }

      const result = await getProvider(
        getProviderInput({
          requestedModel,
          request: { kind: 'chat_completions', body: { model: requestedModel, messages: [] } },
          user,
          organizationId: undefined,
        })
      );

      expect(result).toMatchObject({
        kind: 'provider',
        provider: { type: 'direct-byok', inferenceProviderId },
        userByok: [{ providerId: provider.id }],
      });
    });
  });

  test('records a catalog key that serves ahead of a lower-ranked provider key', async () => {
    const user = await insertTestUser();
    await insertKeys(user, [
      { providerId: 'zai-coding', catalogMode: true, priority: 0 },
      { providerId: 'moonshotai', priority: 1 },
    ]);
    jest
      .mocked(findDirectByokCatalogModels)
      .mockResolvedValue([catalogModel('zai-coding', ['chat_completions'])]);

    const decision = await routeAndRecord({
      requestedModel: MODEL,
      request: request('chat_completions'),
      user,
      organizationId: undefined,
    });

    expect(decision).toEqual({
      requested_model: MODEL,
      api_kind: 'chat_completions',
      owner_type: 'user',
      steps: [
        NO_CUSTOM_LLM,
        NO_DIRECT_BYOK_MODEL,
        { step: 'byok-key', outcome: 'selected', route: 'direct-byok', provider_id: 'zai-coding' },
      ],
      byok_candidates: [
        candidate('direct-byok', 'zai-coding', 0, 'selected', { priority: 0 }),
        candidate('vercel-byok', 'moonshotai', 1, 'unreached', { priority: 1 }),
      ],
      result: {
        kind: 'provider',
        route: 'direct-byok',
        provider_type: 'direct-byok',
        byok_provider_ids: ['zai-coding'],
        payer: 'owner-byok-key',
        is_free: false,
      },
    });
    expect(decryptApiKey).toHaveBeenCalledTimes(1);
  });

  test('records a provider key sent through Vercel', async () => {
    const user = await insertTestUser();
    await insertKeys(user, [{ providerId: 'moonshotai' }]);

    const decision = await routeAndRecord({
      requestedModel: MODEL,
      request: request('chat_completions'),
      user,
      organizationId: undefined,
    });

    expect(decision.steps).toEqual([
      NO_CUSTOM_LLM,
      NO_DIRECT_BYOK_MODEL,
      { step: 'byok-key', outcome: 'selected', route: 'vercel-byok', provider_id: 'moonshotai' },
    ]);
    expect(decision.byok_candidates).toEqual([
      candidate('vercel-byok', 'moonshotai', 0, 'selected'),
    ]);
    expect(decision.result).toEqual({
      kind: 'provider',
      route: 'vercel-byok',
      provider_type: 'vercel',
      byok_provider_ids: ['moonshotai'],
      payer: 'owner-byok-key',
      is_free: false,
    });
  });

  test('records a gateway key and why a higher-ranked gateway key was skipped', async () => {
    const user = await insertTestUser();
    await insertKeys(user, [
      { providerId: 'vercel-ai-gateway', priority: 0 },
      { providerId: 'openrouter', priority: 1 },
      { providerId: 'moonshotai', priority: 2 },
    ]);
    jest
      .mocked(getModelGatewayUserByokProviders)
      .mockResolvedValue(['vercel-ai-gateway', 'openrouter']);
    jest.mocked(canRouteToVercel).mockResolvedValue(false);

    const decision = await routeAndRecord({
      requestedModel: MODEL,
      request: request('chat_completions'),
      user,
      organizationId: undefined,
    });

    expect(decision.byok_candidates).toEqual([
      candidate('gateway-byok', 'vercel-ai-gateway', 0, 'skipped', {
        priority: 0,
        reason: 'provider-settings',
      }),
      candidate('gateway-byok', 'openrouter', 1, 'selected', { priority: 1 }),
      candidate('vercel-byok', 'moonshotai', 2, 'unreached', { priority: 2 }),
    ]);
    expect(decision.steps.at(-1)).toEqual({
      step: 'byok-key',
      outcome: 'selected',
      route: 'gateway-byok',
      provider_id: 'openrouter',
    });
    expect(decision.result).toMatchObject({
      route: 'gateway-byok',
      provider_type: 'openrouter',
      byok_provider_ids: ['openrouter'],
      payer: 'owner-byok-key',
    });
    expect(decryptApiKey).toHaveBeenCalledTimes(1);
  });

  test('records the key the request ignores when no other key serves', async () => {
    const user = await insertTestUser();
    await insertKeys(user, [{ providerId: 'anthropic' }]);
    jest.spyOn(console, 'warn').mockImplementation(() => {});

    const decision = await routeAndRecord({
      requestedModel: MODEL,
      request: request('chat_completions', ['anthropic']),
      user,
      organizationId: undefined,
    });

    expect(decision.byok_candidates).toEqual([
      candidate('vercel-byok', 'anthropic', 0, 'selected', { reason: 'ignored-by-request' }),
    ]);
    expect(decision.result).toMatchObject({
      route: 'vercel-byok',
      byok_provider_ids: ['anthropic'],
    });
  });

  test('records an ignored key passed over for the next key that serves', async () => {
    const user = await insertTestUser();
    await insertKeys(user, [
      { providerId: 'anthropic', priority: 0 },
      { providerId: 'moonshotai', priority: 1 },
    ]);

    const decision = await routeAndRecord({
      requestedModel: MODEL,
      request: request('chat_completions', ['anthropic']),
      user,
      organizationId: undefined,
    });

    expect(decision.byok_candidates).toEqual([
      candidate('vercel-byok', 'anthropic', 0, 'skipped', {
        priority: 0,
        reason: 'ignored-by-request',
      }),
      candidate('vercel-byok', 'moonshotai', 1, 'selected', { priority: 1 }),
    ]);
  });

  test('records a ChatGPT connection that takes the request ahead of the keys', async () => {
    const user = await insertTestUser();
    await insertKeys(user, [{ providerId: 'moonshotai' }]);
    jest.mocked(checkOpenAiChatGptByok).mockResolvedValue({
      kind: 'provider',
      provider: { ...OPENROUTER, type: 'openai-chatgpt' },
      userByok: null,
      bypassAccessCheck: false,
      skipBalanceCheck: true,
    });

    const decision = await routeAndRecord({
      requestedModel: MODEL,
      request: request('responses'),
      user,
      organizationId: undefined,
    });

    expect(decision).toEqual({
      requested_model: MODEL,
      api_kind: 'responses',
      owner_type: 'user',
      steps: [NO_CUSTOM_LLM, NO_DIRECT_BYOK_MODEL, { step: 'chatgpt', outcome: 'selected' }],
      byok_candidates: [candidate('vercel-byok', 'moonshotai', 0, 'unreached')],
      result: {
        kind: 'provider',
        route: 'chatgpt',
        provider_type: 'openai-chatgpt',
        byok_provider_ids: [],
        payer: 'chatgpt-subscription',
        is_free: false,
      },
    });
  });

  test('records a ChatGPT connection that must be reconnected', async () => {
    const user = await insertTestUser();
    jest
      .mocked(checkOpenAiChatGptByok)
      .mockResolvedValue({ kind: 'reconnect', message: 'Reconnect ChatGPT' });

    const decision = await routeAndRecord({
      requestedModel: MODEL,
      request: request('responses'),
      user,
      organizationId: undefined,
    });

    expect(decision.steps.at(-1)).toEqual({
      step: 'chatgpt',
      outcome: 'rejected',
      reason: 'reconnect',
    });
    expect(decision.result).toEqual({ kind: 'chatgpt-reconnect' });
  });

  test('records the Kilo-paid fallback with its spend bound and provider exclusions', async () => {
    const user = await insertTestUser();
    const organization = await createTestOrganization(
      `Decision ${crypto.randomUUID()}`,
      user.id,
      0
    );
    jest.mocked(shouldRouteToVercel).mockResolvedValue(false);

    const decision = await routeAndRecord({
      requestedModel: MODEL,
      request: request('chat_completions'),
      user,
      organizationId: organization.id,
      boundedSpending: true,
      kiloIgnoredProviders: ['deepinfra'],
    });

    expect(decision).toEqual({
      requested_model: MODEL,
      api_kind: 'chat_completions',
      owner_type: 'organization',
      steps: [
        NO_CUSTOM_LLM,
        NO_DIRECT_BYOK_MODEL,
        { step: 'byok-key', outcome: 'skipped', reason: 'no-candidates' },
        {
          step: 'kilo',
          outcome: 'selected',
          gateway: 'openrouter',
          bounded_spending: true,
          organization_disabled_vercel_ai_gateway: false,
          kilo_ignored_providers: ['deepinfra'],
        },
      ],
      byok_candidates: [],
      result: {
        kind: 'provider',
        route: 'kilo',
        provider_type: 'openrouter',
        byok_provider_ids: [],
        payer: 'kilo',
        is_free: false,
      },
    });
    expect(shouldRouteToVercel).toHaveBeenCalledWith(
      expect.objectContaining({ requestedModel: MODEL, boundedSpending: true }),
      expect.any(Function)
    );
  });

  test('records provider keys the organization policy excludes', async () => {
    const user = await insertTestUser();
    const organization = await createTestOrganization(
      `Decision ${crypto.randomUUID()}`,
      user.id,
      0
    );
    await insertKeys(user, [{ providerId: 'moonshotai' }], organization.id);
    jest.mocked(getModelInferenceUserByokProviders).mockResolvedValue(['moonshotai']);
    jest.mocked(getModelGatewayUserByokProviders).mockResolvedValue([]);

    const decision = await routeAndRecord({
      requestedModel: MODEL,
      request: request('chat_completions'),
      user,
      organizationId: organization.id,
      getAllowedProviders: async () => new Set(['anthropic']),
    });

    expect(decision.steps).toContainEqual({
      step: 'organization-policy',
      excluded_provider_ids: ['moonshotai'],
    });
    expect(decision.byok_candidates).toEqual([]);
    expect(decision.result).toMatchObject({ route: 'kilo', payer: 'kilo' });
  });

  test('records a catalog key that serves the model only over another API kind', async () => {
    const user = await insertTestUser();
    await insertKeys(user, [{ providerId: 'synthetic', catalogMode: true }]);
    jest
      .mocked(findDirectByokCatalogModels)
      .mockResolvedValue([catalogModel('synthetic', ['chat_completions'])]);

    const decision = await routeAndRecord({
      requestedModel: MODEL,
      request: request('responses'),
      user,
      organizationId: undefined,
    });

    expect(decision.byok_candidates).toEqual([
      candidate('direct-byok', 'synthetic', 0, 'selected', { reason: 'unsupported-api-kind' }),
    ]);
    expect(decision.steps.slice(-2)).toEqual([
      { step: 'byok-key', outcome: 'skipped', reason: 'none-served' },
      {
        step: 'unsupported-api-kind',
        outcome: 'selected',
        provider_id: 'synthetic',
        supported_api_kinds: ['chat_completions'],
      },
    ]);
    expect(decision.result).toMatchObject({
      route: 'unsupported-api-kind',
      payer: 'owner-byok-key',
    });
  });

  test('records a provider model id whose key serves only catalog ids', async () => {
    const user = await insertTestUser();
    await insertKeys(user, [{ providerId: 'zai-coding', catalogMode: true }]);
    const { provider, model } = catalogModel('zai-coding', ['chat_completions']);
    jest.mocked(getDirectByokModel).mockResolvedValueOnce({ provider, model });
    jest.mocked(getDirectByokCatalogModelId).mockResolvedValueOnce('z-ai/glm-5');

    const decision = await routeAndRecord({
      requestedModel: 'zai-coding/kimi-k2.6',
      request: request('chat_completions'),
      user,
      organizationId: undefined,
    });

    expect(decision.steps).toEqual([
      NO_CUSTOM_LLM,
      {
        step: 'direct-byok-model',
        outcome: 'rejected',
        provider_id: 'zai-coding',
        reason: 'catalog-only',
        catalog_model_id: 'z-ai/glm-5',
      },
    ]);
    expect(decision.result).toEqual({ kind: 'direct-byok-catalog-only' });
  });

  test('records a provider model id served by its own key', async () => {
    const user = await insertTestUser();
    await insertKeys(user, [{ providerId: 'zai-coding' }]);
    const { provider, model } = catalogModel('zai-coding', ['chat_completions']);
    jest.mocked(getDirectByokModel).mockResolvedValueOnce({ provider, model });

    const decision = await routeAndRecord({
      requestedModel: 'zai-coding/kimi-k2.6',
      request: request('chat_completions'),
      user,
      organizationId: undefined,
    });

    expect(decision.steps).toEqual([
      NO_CUSTOM_LLM,
      { step: 'direct-byok-model', outcome: 'selected', provider_id: 'zai-coding' },
    ]);
    expect(decision.result).toEqual({
      kind: 'provider',
      route: 'direct-byok-model',
      provider_type: 'direct-byok',
      byok_provider_ids: ['zai-coding'],
      payer: 'owner-byok-key',
      is_free: false,
    });
  });

  test('records a provider model id without a key before the later steps', async () => {
    const user = await insertTestUser();
    const { provider, model } = catalogModel('zai-coding', ['chat_completions']);
    jest.mocked(getDirectByokModel).mockResolvedValueOnce({ provider, model });
    jest.mocked(shouldRouteToVercel).mockResolvedValue(false);

    const decision = await routeAndRecord({
      requestedModel: 'zai-coding/kimi-k2.6',
      request: request('chat_completions'),
      user,
      organizationId: undefined,
    });

    expect(decision.steps.slice(0, 3)).toEqual([
      NO_CUSTOM_LLM,
      {
        step: 'direct-byok-model',
        outcome: 'skipped',
        provider_id: 'zai-coding',
        reason: 'no-key',
      },
      { step: 'byok-key', outcome: 'skipped', reason: 'no-candidates' },
    ]);
    expect(decision.result).toMatchObject({ route: 'kilo', payer: 'kilo' });
  });

  test('records a ChatGPT connection checked after a serving catalog key the owner ranked lower', async () => {
    const user = await insertTestUser();
    await insertKeys(user, [
      { providerId: 'openrouter', priority: 0 },
      { providerId: 'zai-coding', catalogMode: true, priority: 1 },
    ]);
    jest
      .mocked(findDirectByokCatalogModels)
      .mockResolvedValue([catalogModel('zai-coding', ['chat_completions', 'responses'])]);
    jest.mocked(checkOpenAiChatGptByok).mockResolvedValue({
      kind: 'provider',
      provider: { ...OPENROUTER, type: 'openai-chatgpt' },
      userByok: null,
      bypassAccessCheck: false,
      skipBalanceCheck: true,
    });

    const decision = await routeAndRecord({
      requestedModel: MODEL,
      request: request('responses'),
      user,
      organizationId: undefined,
    });

    expect(decision.steps.slice(2)).toEqual([{ step: 'chatgpt', outcome: 'selected' }]);
    expect(decision.byok_candidates).toEqual([
      candidate('gateway-byok', 'openrouter', 0, 'unreached', { priority: 0 }),
      candidate('direct-byok', 'zai-coding', 1, 'unreached', { priority: 1 }),
    ]);
    expect(decision.result).toMatchObject({ route: 'chatgpt', payer: 'chatgpt-subscription' });
  });

  test('records catalog keys the organization policy excludes', async () => {
    const user = await insertTestUser();
    const organization = await createTestOrganization(
      `Decision ${crypto.randomUUID()}`,
      user.id,
      0
    );
    await insertKeys(user, [{ providerId: 'zai-coding', catalogMode: true }], organization.id);
    jest
      .mocked(findDirectByokCatalogModels)
      .mockResolvedValue([catalogModel('zai-coding', ['chat_completions'])]);
    jest.mocked(getModelGatewayUserByokProviders).mockResolvedValue([]);

    const decision = await routeAndRecord({
      requestedModel: MODEL,
      request: request('chat_completions'),
      user,
      organizationId: organization.id,
      isDirectByokProviderAllowed: async () => false,
    });

    expect(decision.steps).toContainEqual({
      step: 'organization-policy',
      excluded_provider_ids: ['zai-coding'],
    });
    expect(decision.byok_candidates).toEqual([]);
  });

  test('returns the route even when the decision callback throws', async () => {
    const user = await insertTestUser();
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});

    const result = await getProvider(
      getProviderInput({
        requestedModel: MODEL,
        request: request('chat_completions'),
        user,
        organizationId: undefined,
        onDecision: () => {
          throw new TypeError('archive failed');
        },
      })
    );

    expect(result).toMatchObject({ kind: 'provider', userByok: null });
    expect(error).toHaveBeenCalledWith('[getProvider] failed to report the routing decision', {
      errorType: 'TypeError',
    });
  });
});

describe('getProvider route order with a ChatGPT connection', () => {
  const chatGptProvider = {
    kind: 'provider',
    provider: { ...OPENROUTER, type: 'openai-chatgpt' },
    userByok: null,
    bypassAccessCheck: false,
    skipBalanceCheck: true,
  } as const;

  function deleteKeysAfterTheyAreRead(user: User) {
    const actual = jest.requireActual<typeof byokModule>(
      '@kilocode/web-shared/lib/ai-gateway/byok'
    );
    jest.mocked(getStoredByokKeys).mockImplementationOnce(async (fromDb, owner) => {
      const stored = await actual.getStoredByokKeys(fromDb, owner);
      await db.delete(byok_api_keys).where(eq(byok_api_keys.kilo_user_id, user.id));
      return stored;
    });
  }

  test('serves a ranked catalog key whose row is deleted before decryption, never Kilo', async () => {
    const user = await insertTestUser();
    await insertKeys(user, [{ providerId: 'zai-coding', catalogMode: true }]);
    jest
      .mocked(findDirectByokCatalogModels)
      .mockResolvedValue([catalogModel('zai-coding', ['chat_completions', 'responses'])]);
    jest.mocked(checkOpenAiChatGptByok).mockResolvedValue(chatGptProvider);
    deleteKeysAfterTheyAreRead(user);

    const decision = await routeAndRecord({
      requestedModel: MODEL,
      request: request('responses'),
      user,
      organizationId: undefined,
    });

    expect(decision.result).toMatchObject({ route: 'direct-byok', payer: 'owner-byok-key' });
    expect(decision.steps.slice(2)).toEqual([
      { step: 'chatgpt', outcome: 'deferred', reason: 'catalog-key-serves' },
      { step: 'byok-key', outcome: 'selected', route: 'direct-byok', provider_id: 'zai-coding' },
    ]);
    expect(decision.byok_candidates).toEqual([
      candidate('direct-byok', 'zai-coding', 0, 'selected'),
    ]);
    expect(checkOpenAiChatGptByok).not.toHaveBeenCalled();
  });

  test.each([
    { chatGpt: 'connected', route: 'chatgpt' },
    { chatGpt: 'unavailable', route: 'direct-byok' },
  ] as const)(
    'checks a $chatGpt ChatGPT connection ahead of a catalog key when an ignored provider key ranks first',
    async ({ chatGpt, route }) => {
      const user = await insertTestUser();
      await insertKeys(user, [
        { providerId: 'anthropic', priority: 0 },
        { providerId: 'zai-coding', catalogMode: true, priority: 1 },
      ]);
      jest
        .mocked(findDirectByokCatalogModels)
        .mockResolvedValue([catalogModel('zai-coding', ['chat_completions', 'responses'])]);
      jest
        .mocked(checkOpenAiChatGptByok)
        .mockResolvedValue(chatGpt === 'connected' ? chatGptProvider : null);

      const decision = await routeAndRecord({
        requestedModel: MODEL,
        request: request('responses', ['anthropic']),
        user,
        organizationId: undefined,
      });

      expect(checkOpenAiChatGptByok).toHaveBeenCalledTimes(1);
      expect(decision.result).toMatchObject({ route });
      expect(decision.byok_candidates).toEqual(
        chatGpt === 'connected'
          ? [
              candidate('vercel-byok', 'anthropic', 0, 'unreached', { priority: 0 }),
              candidate('direct-byok', 'zai-coding', 1, 'unreached', { priority: 1 }),
            ]
          : [
              candidate('vercel-byok', 'anthropic', 0, 'skipped', {
                priority: 0,
                reason: 'ignored-by-request',
              }),
              candidate('direct-byok', 'zai-coding', 1, 'selected', { priority: 1 }),
            ]
      );
    }
  );

  test('keeps the ChatGPT connection below a serving catalog key when a gateway key ranked first cannot serve', async () => {
    const user = await insertTestUser();
    await insertKeys(user, [
      { providerId: 'openrouter', priority: 0 },
      { providerId: 'zai-coding', catalogMode: true, priority: 1 },
    ]);
    jest
      .mocked(findDirectByokCatalogModels)
      .mockResolvedValue([catalogModel('zai-coding', ['chat_completions', 'responses'])]);
    jest.mocked(getModelGatewayUserByokProviders).mockResolvedValue([]);
    jest.mocked(checkOpenAiChatGptByok).mockResolvedValue(chatGptProvider);

    const decision = await routeAndRecord({
      requestedModel: MODEL,
      request: request('responses'),
      user,
      organizationId: undefined,
    });

    expect(checkOpenAiChatGptByok).not.toHaveBeenCalled();
    expect(decision.byok_candidates).toEqual([
      candidate('gateway-byok', 'openrouter', 0, 'skipped', {
        priority: 0,
        reason: 'model-unavailable',
      }),
      candidate('direct-byok', 'zai-coding', 1, 'selected', { priority: 1 }),
    ]);
  });

  test('checks the ChatGPT connection once, even when the keys ranked below it are deleted', async () => {
    const user = await insertTestUser();
    await insertKeys(user, [
      { providerId: 'anthropic', priority: 0 },
      { providerId: 'moonshotai', priority: 1 },
      { providerId: 'zai-coding', catalogMode: true, priority: 2 },
    ]);
    jest
      .mocked(findDirectByokCatalogModels)
      .mockResolvedValue([catalogModel('zai-coding', ['chat_completions', 'responses'])]);
    deleteKeysAfterTheyAreRead(user);

    const decision = await routeAndRecord({
      requestedModel: MODEL,
      request: request('responses'),
      user,
      organizationId: undefined,
    });

    expect(checkOpenAiChatGptByok).toHaveBeenCalledTimes(1);
    expect(decision.steps.slice(2)).toEqual([
      CHATGPT_UNAVAILABLE,
      { step: 'byok-key', outcome: 'selected', route: 'vercel-byok', provider_id: 'anthropic' },
    ]);
  });

  test('records a disabled key and a key outside catalog mode as skipped', async () => {
    const user = await insertTestUser();
    await insertKeys(user, [
      { providerId: 'synthetic', priority: 0 },
      { providerId: 'zai-coding', catalogMode: true, priority: 1, isEnabled: false },
      { providerId: 'moonshotai', priority: 2 },
    ]);
    jest
      .mocked(findDirectByokCatalogModels)
      .mockResolvedValue([
        catalogModel('synthetic', ['chat_completions']),
        catalogModel('zai-coding', ['chat_completions']),
      ]);

    const decision = await routeAndRecord({
      requestedModel: MODEL,
      request: request('chat_completions'),
      user,
      organizationId: undefined,
    });

    expect(decision.byok_candidates).toEqual([
      candidate('direct-byok', 'synthetic', 0, 'skipped', {
        priority: 0,
        reason: 'not-catalog-mode',
      }),
      candidate('direct-byok', 'zai-coding', 1, 'skipped', { priority: 1, reason: 'disabled' }),
      candidate('vercel-byok', 'moonshotai', 2, 'selected', { priority: 2 }),
    ]);
  });
});

describe('getProvider routing decision for custom LLMs', () => {
  async function routeCustomLlm({
    countryCode = null,
    member = true,
    credentials = JSON.stringify({ type: 'api_key', api_key: 'upstream-key' }),
  }: { countryCode?: string | null; member?: boolean; credentials?: string } = {}) {
    const user = await insertTestUser();
    const organization = await createTestOrganization(`Custom ${crypto.randomUUID()}`, user.id, 0);
    const publicId = `acme/decision-${crypto.randomUUID()}-free`;
    const definition: CustomLlmDefinition = {
      internal_id: 'upstream-model',
      display_name: 'Decision model',
      context_length: 128_000,
      max_completion_tokens: 4096,
      base_url: 'https://custom.example.com/v1',
      organization_ids: [organization.id],
      country_deny_list: ['KP'],
    };
    await insertCustomLlmForTest(
      publicId,
      definition,
      encryptApiKey(credentials, BYOK_ENCRYPTION_KEY)
    );
    return routeAndRecord({
      requestedModel: publicId,
      request: { kind: 'chat_completions', body: { model: publicId, messages: [] } },
      user,
      organizationId: member ? organization.id : undefined,
      countryCode,
    });
  }

  test('records a private custom LLM served on its own credential', async () => {
    const decision = await routeCustomLlm();

    expect(decision.steps).toEqual([
      { step: 'custom-llm', outcome: 'selected', visibility: 'private' },
    ]);
    expect(decision.result).toEqual({
      kind: 'provider',
      route: 'custom-llm',
      provider_type: 'custom',
      byok_provider_ids: [],
      payer: 'custom-llm-credential',
      is_free: true,
    });
  });

  test.each([
    { reason: 'country-denied', options: { countryCode: 'KP' } },
    { reason: 'not-eligible', options: { member: false } },
    { reason: 'invalid-credentials', options: { credentials: 'not json' } },
  ] as const)('records a custom LLM rejected as $reason', async ({ reason, options }) => {
    jest.spyOn(console, 'error').mockImplementation(() => {});

    const decision = await routeCustomLlm(options);

    expect(decision.steps).toEqual([
      { step: 'custom-llm', outcome: 'rejected', visibility: 'private', reason },
    ]);
    expect(decision.result).toEqual({ kind: 'custom-llm-unavailable' });
  });
});
