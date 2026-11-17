import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { z } from 'zod';
import { captureException } from '@sentry/nextjs';
import type * as Sentry from '@sentry/nextjs';
import { errorExceptInTest } from '@kilocode/web-shared/lib/utils.server';
import { TypeSafeClient, choice, noul, score } from '@typesafe-ai/sdk';
import type { User } from '@kilocode/db/schema';
import type { GatewayModelWithEndpoints } from '@kilocode/web-shared/lib/ai-gateway/providers/gateway-model-metadata';
import { KILO_GATEWAY_AUDIENCE } from '@kilocode/worker-utils/internal-service-token-audiences';
import { after, NextRequest, NextResponse } from 'next/server';
import type * as NextServer from 'next/server';
import { getUserFromAuth } from '@kilocode/web-shared/lib/user/server';
import { getBalanceAndOrgSettings } from '@kilocode/web-shared/lib/organizations/organization-usage';
import { readDb } from '@kilocode/web-shared/lib/drizzle';
import { resolveOrganizationMemberModelDecision } from '@kilocode/web-shared/lib/organizations/group-policies/model-access/model-access.server';
import {
  gatewayRateLimitKey,
  isGatewayAccountRateLimited,
} from '@kilocode/web-shared/lib/ai-gateway/gateway-account-rate-limit';
import { isFreeModelRateLimited } from '@kilocode/web-shared/lib/ai-gateway/free-model-rate-limit';
import { getRuntimeOrganizationFeatures } from '@kilocode/web-shared/lib/ai-gateway/organization-features';
import { DEFAULT_ORGANIZATION_FEATURES } from '@kilocode/web-shared/lib/ai-gateway/gateway-config';
import {
  creditsBlockedResponse,
  extractFraudAndProjectHeaders,
  extractHeaderAndLimitLength,
  getOrganizationProviderPrivacy,
  INVALID_TOKEN_CODE,
  modelNotAllowedResponse,
  wrapInSafeNextResponse,
} from '@kilocode/web-shared/lib/ai-gateway/llm-proxy-helpers';
import type * as LlmProxyHelpers from '@kilocode/web-shared/lib/ai-gateway/llm-proxy-helpers';
import type * as UpstreamRequest from '@kilocode/web-shared/lib/ai-gateway/providers/upstream-request';
import type * as UpstreamUrlPolicy from '@kilocode/web-shared/lib/ai-gateway/providers/upstream-url-policy';
import {
  isUpstreamUrlPolicyEnforced,
  rejectDisallowedUpstreamUrls,
} from '@kilocode/web-shared/lib/ai-gateway/providers/upstream-url-policy';
import { OPENROUTER } from '@kilocode/web-shared/lib/ai-gateway/providers/definitions/openrouter';
import { resolveUsageEndpointRoute } from '@kilocode/web-shared/lib/ai-gateway/providers/usage-endpoint-provider';
import { mapModelIdToVercel } from '@kilocode/web-shared/lib/ai-gateway/providers/vercel/mapModelIdToVercel';
import type { BYOKResult, Provider } from '@kilocode/web-shared/lib/ai-gateway/providers/types';
import { getProviderSlugsForModel } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/models-by-provider-index.server';
import {
  getCachedVercelInferenceProviderIdsForModel,
  getOpenRouterModelsMetadataFromDatabase,
  getOpenRouterSystemOneModelsFromDatabase,
  resolveOpenRouterModelAlias,
} from '@kilocode/web-shared/lib/ai-gateway/providers/gateway-models-cache';
import { generateProviderSpecificHash } from '@kilocode/web-shared/lib/ai-gateway/providerHash';
import {
  logMicrodollarUsageAndReportToBouncer,
  mapToUsageStats,
} from '@kilocode/web-shared/lib/ai-gateway/processUsage';
import { fetchGeneration } from '@kilocode/web-shared/lib/ai-gateway/providers/upstream-request';
import type { OpenRouterGeneration } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/types';
import { emitGatewayApiMetrics } from '@kilocode/web-shared/lib/ai-gateway/o11y/api-metrics.server';
import {
  systemOneRequestSchema,
  SYSTEM_ONE_MAX_QUESTIONS,
  SYSTEM_ONE_MAX_STATE_BYTES,
  TYPESAFE_MODEL,
} from '@kilocode/web-shared/lib/ai-gateway/typesafe/schemas';
import { EmptyFraudDetectionHeaders } from '@kilocode/web-shared/lib/fraud-detection-headers';
import { FEATURE_HEADER } from '@kilocode/web-shared/lib/feature-detection';
import { startBouncerDecide } from '@kilocode/web-shared/lib/bouncer/inference';
import type * as BouncerInference from '@kilocode/web-shared/lib/bouncer/inference';
import type { DecideResponse } from '@kilocode/web-shared/lib/bouncer/client';
import type { CustomPricingConfig } from '@kilocode/db/schema-types';
import { getCustomPricingConfig } from '@kilocode/web-shared/lib/ai-gateway/custom-pricing-config';
import { EMPTY_CUSTOM_PRICING_CONFIG } from '@kilocode/web-shared/lib/ai-gateway/custom-pricing.constants';
import { handleSystemOneRequest } from './handler';

jest.mock('next/server', () => ({
  ...jest.requireActual<typeof NextServer>('next/server'),
  after: jest.fn(),
}));
jest.mock('@sentry/nextjs', () => ({
  ...jest.requireActual<typeof Sentry>('@sentry/nextjs'),
  captureException: jest.fn(),
}));
jest.mock('@kilocode/web-shared/lib/utils.server', () => ({
  errorExceptInTest: jest.fn(),
  warnExceptInTest: jest.fn(),
  sentryLogger: jest.fn(() => jest.fn()),
}));
jest.mock('@kilocode/web-shared/lib/bouncer/inference', () => ({
  ...jest.requireActual<typeof BouncerInference>('@kilocode/web-shared/lib/bouncer/inference'),
  startBouncerDecide: jest.fn(),
}));
jest.mock(
  '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/models-by-provider-index.server',
  () => ({
    getProviderSlugsForModel: jest.fn(),
  })
);
jest.mock('@kilocode/web-shared/lib/ai-gateway/providers/gateway-models-cache', () => ({
  getCachedVercelInferenceProviderIdsForModel: jest.fn(),
  getOpenRouterModelsMetadataFromDatabase: jest.fn(),
  getOpenRouterSystemOneModelsFromDatabase: jest.fn(),
  resolveOpenRouterModelAlias: jest.fn(),
}));
jest.mock('@kilocode/web-shared/lib/user/server', () => ({ getUserFromAuth: jest.fn() }));
jest.mock('@kilocode/web-shared/lib/organizations/organization-usage', () => ({
  getBalanceAndOrgSettings: jest.fn(),
}));
jest.mock(
  '@kilocode/web-shared/lib/organizations/group-policies/model-access/model-access.server',
  () => ({
    resolveOrganizationMemberModelDecision: jest.fn(),
  })
);
jest.mock('@kilocode/web-shared/lib/ai-gateway/gateway-account-rate-limit', () => ({
  gatewayRateLimitKey: jest.fn(),
  isGatewayAccountRateLimited: jest.fn(),
}));
jest.mock('@kilocode/web-shared/lib/ai-gateway/organization-features', () => ({
  ...jest.requireActual<Record<string, unknown>>(
    '@kilocode/web-shared/lib/ai-gateway/organization-features'
  ),
  getRuntimeOrganizationFeatures: jest.fn(),
}));
jest.mock('@kilocode/web-shared/lib/ai-gateway/free-model-rate-limit', () => ({
  ...jest.requireActual<Record<string, unknown>>(
    '@kilocode/web-shared/lib/ai-gateway/free-model-rate-limit'
  ),
  isFreeModelRateLimited: jest.fn(),
}));
jest.mock('@kilocode/web-shared/lib/ai-gateway/llm-proxy-helpers', () => ({
  ...jest.requireActual<typeof LlmProxyHelpers>(
    '@kilocode/web-shared/lib/ai-gateway/llm-proxy-helpers'
  ),
  creditsBlockedResponse: jest.fn(),
  extractFraudAndProjectHeaders: jest.fn(),
  extractHeaderAndLimitLength: jest.fn(),
  getOrganizationProviderPrivacy: jest.fn(),
  modelNotAllowedResponse: jest.fn(),
  wrapInSafeNextResponse: jest.fn(),
}));
jest.mock('@kilocode/web-shared/lib/ai-gateway/providers/definitions/openrouter', () => ({
  OPENROUTER: {
    type: 'openrouter',
    apiUrl: 'https://openrouter.ai/api/v1',
    apiKey: 'test-platform-openrouter-key',
  },
}));
jest.mock('@kilocode/web-shared/lib/ai-gateway/providers/usage-endpoint-provider', () => ({
  resolveUsageEndpointRoute: jest.fn(),
}));
jest.mock('@kilocode/web-shared/lib/ai-gateway/providers/vercel/mapModelIdToVercel', () => ({
  mapModelIdToVercel: jest.fn(),
}));
jest.mock('@kilocode/web-shared/lib/ai-gateway/providerHash', () => ({
  generateProviderSpecificHash: jest.fn(),
}));
jest.mock('@kilocode/web-shared/lib/ai-gateway/processUsage', () => ({
  logMicrodollarUsageAndReportToBouncer: jest.fn(),
  mapToUsageStats: jest.fn(),
}));
jest.mock('@kilocode/web-shared/lib/ai-gateway/providers/upstream-request', () => ({
  ...jest.requireActual<typeof UpstreamRequest>(
    '@kilocode/web-shared/lib/ai-gateway/providers/upstream-request'
  ),
  fetchGeneration: jest.fn(),
}));
jest.mock('@kilocode/web-shared/lib/ai-gateway/providers/upstream-url-policy', () => ({
  ...jest.requireActual<typeof UpstreamUrlPolicy>(
    '@kilocode/web-shared/lib/ai-gateway/providers/upstream-url-policy'
  ),
  isUpstreamUrlPolicyEnforced: jest.fn(),
  rejectDisallowedUpstreamUrls: jest.fn(),
}));
jest.mock('@kilocode/web-shared/lib/ai-gateway/o11y/api-metrics.server', () => ({
  emitGatewayApiMetrics: jest.fn(),
}));
jest.mock('@kilocode/web-shared/lib/ai-gateway/custom-pricing-config', () => ({
  getCustomPricingConfig: jest.fn(),
}));

const routeUrl = 'http://localhost:3000/api/gateway/typesafe/v1/systemone';
// The handler reads `performance.now()` once per measured point: request start, the upstream
// fetch start and its headers (read by `fetchUpstream`), first byte, then the metrics read.
// Advancing by one step per read makes each measured interval exact.
const CLOCK_START_MS = 1_000;
const CLOCK_STEP_MS = 500;
const METERED_LATENCY_MS = 3 * CLOCK_STEP_MS;
const METERED_COMPLETE_REQUEST_MS = 4 * CLOCK_STEP_MS;
const OTHER_SYSTEM_ONE_MODEL = 'respan/span-01-lite:free';
const SYSTEM_ONE_ALIAS = '~typesafe/jev-latest';
const pricedSystemOneModels: Record<string, GatewayModelWithEndpoints> = {
  [TYPESAFE_MODEL]: {
    id: TYPESAFE_MODEL,
    name: 'TypeSafe: Jev 1.13',
    endpoints: [{ pricing: { prompt: '0.000000042', completion: '0' } }],
  },
  [OTHER_SYSTEM_ONE_MODEL]: {
    id: OTHER_SYSTEM_ONE_MODEL,
    name: 'Respan: Span-01 Lite (free)',
    endpoints: [{ pricing: { prompt: '0', completion: '0' } }],
  },
};
const user = {
  id: 'oauth/test-user',
  google_user_email: 'test@example.com',
  microdollars_used: 123,
} as User;
const questions = {
  billing: noul('Is this about billing?'),
  category: choice('Choose a category', { billing: 'Payments', other: null }),
  urgency: score('How urgent is this?', ['Low', 'High']),
};
const requestBody = { state: { message: 'I was charged twice.' }, questions };
const upstreamBody = {
  id: 'gen-systemone-123',
  model: TYPESAFE_MODEL,
  provider: 'TypeSafe upstream',
  answers: {
    billing: { type: 'noul', noul: 0.95 },
    category: {
      type: 'choice',
      choice: 'billing',
      confidence: 0.9,
      probabilities: { billing: 0.9, other: 0.1 },
    },
    urgency: {
      type: 'score',
      score: 0.75,
      confidence: 0.8,
      probabilities: { '0': 0.25, '1': 0.75 },
      legend: { '0': 'Low', '1': 'High' },
    },
  },
  usage: { input_tokens: 23, output_tokens: 7, cost: 0.0001236, total_tokens: 30 },
  upstream_metadata: { retained: true },
};
// The caller sees the cost the ledger row bills, in whole microdollars.
const billedBody = {
  ...upstreamBody,
  usage: { ...upstreamBody.usage, cost: 0.000124, is_byok: false },
};
const memberDecision = {
  policy: {
    requireModelInCurrentSnapshot: false,
    organizationModelDenyList: [],
    memberGrant: { mode: 'unrestricted' as const },
    policyRevision: 1,
    customLlmGrantee: { organizationId: 'org-1', groupIds: [] },
  },
  decision: { allowed: true },
};
const VERCEL_SYSTEM_ONE_MODEL = 'typesafe-ai/jev';
const VERCEL_TYPESAFE_URL = 'https://ai-gateway.vercel.sh/typesafe/v1/systemone';
const kiloVercelProvider = {
  type: 'vercel',
  apiUrl: 'https://ai-gateway.vercel.sh/v1',
  apiKey: 'test-platform-vercel-key',
} as Provider;
const userOpenRouterProvider = { ...OPENROUTER, apiKey: 'test-user-openrouter-key' } as Provider;
const userOpenRouterKey: BYOKResult = {
  providerId: 'openrouter',
  decryptedAPIKey: 'test-user-openrouter-key',
};
const userVercelGatewayKey: BYOKResult = {
  providerId: 'vercel-ai-gateway',
  decryptedAPIKey: 'test-user-vercel-key',
};
const userAnthropicKey: BYOKResult = {
  providerId: 'anthropic',
  decryptedAPIKey: 'test-user-anthropic-key',
};
const vercelUpstreamBody = {
  model: VERCEL_SYSTEM_ONE_MODEL,
  answers: upstreamBody.answers,
  usage: { input_tokens: 23, output_tokens: 7 },
  provider_metadata: {
    gateway: {
      routing: { finalProvider: 'typesafe-ai' },
      cost: '0.0001236',
      marketCost: '0.0002',
      generationId: 'gen_vercel_systemone',
    },
  },
};
const mockedFetch = jest.fn() as jest.MockedFunction<typeof fetch>;
const originalFetch = globalThis.fetch;

const reconciledStats = {
  messageId: upstreamBody.id,
  model: TYPESAFE_MODEL,
  responseContent: '',
  hasError: false,
  inference_provider: 'TypeSafe upstream',
  upstream_id: null,
  finish_reason: null,
  latency: null,
  moderation_latency: null,
  generation_time: null,
  streamed: false,
  cancelled: null,
  status_code: 200,
  cost_mUsd: 124,
  inputTokens: 23,
  outputTokens: 7,
  cacheWriteTokens: 0,
  cacheHitTokens: 0,
  is_byok: false,
};

const customPricingTier = {
  start_context_length: 0,
  pricing: {
    prompt_per_million: 2,
    completion_per_million: 10,
    input_cache_read_per_million: null,
    input_cache_write_per_million: null,
  },
};
/** Both System One models billed at $2/M input and $10/M output tokens. */
const systemOneCustomPricingConfig: CustomPricingConfig = {
  models: [
    { model: TYPESAFE_MODEL, pricing: [customPricingTier] },
    { model: OTHER_SYSTEM_ONE_MODEL, pricing: [customPricingTier] },
  ],
};

function makeRequest(
  body: unknown = requestBody,
  headers: Record<string, string> = {},
  signal?: AbortSignal
) {
  return new NextRequest(routeUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal,
  });
}

function setAuth(organizationId?: string) {
  jest.mocked(getUserFromAuth).mockResolvedValue({
    user,
    authFailedResponse: null,
    organizationId,
    botId: 'bot-123',
    tokenSource: 'api-key',
  });
}

function upstreamRequest(expectedUrl = 'https://openrouter.ai/api/v1/systemone') {
  expect(mockedFetch).toHaveBeenCalledTimes(1);
  const [url, init] = mockedFetch.mock.calls[0];
  expect(url).toBe(expectedUrl);
  expect(init?.method).toBe('POST');
  if (typeof init?.body !== 'string') throw new Error('Expected a JSON upstream body');
  return { body: JSON.parse(init.body), headers: new Headers(init.headers) };
}

function deferredUsageCallbacks(): Array<() => Promise<unknown>> {
  // `fetchUpstream` registers its budget-timer cleanup before it calls fetch; the usage writes
  // come after the fetch.
  const fetchedAt = mockedFetch.mock.invocationCallOrder[0] ?? 0;
  const { calls, invocationCallOrder } = jest.mocked(after).mock;
  return calls
    .filter((_call, index) => invocationCallOrder[index] > fetchedAt)
    .map(([arg]) => arg)
    .filter((arg): arg is () => Promise<unknown> => typeof arg === 'function');
}

async function runAfter() {
  // The decide is mocked, so the only `after()` callback is the deferred usage write.
  const callbacks = deferredUsageCallbacks();
  expect(callbacks).toHaveLength(1);
  await callbacks[0]();
}

function mockVerdict(verdict: DecideResponse | null) {
  jest.mocked(startBouncerDecide).mockResolvedValue(verdict);
}

/** Pins every `performance.now()` read to a fixed cadence so the measured times are exact. */
function mockMeteredClock() {
  let now = CLOCK_START_MS;
  jest.spyOn(performance, 'now').mockImplementation(() => (now += CLOCK_STEP_MS));
}

describe('handleSystemOneRequest', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    globalThis.fetch = mockedFetch;
    setAuth();
    mockVerdict(null);
    jest.mocked(getBalanceAndOrgSettings).mockResolvedValue({ balance: 1_000_000 });
    jest.mocked(isGatewayAccountRateLimited).mockResolvedValue(false);
    jest.mocked(gatewayRateLimitKey).mockReturnValue('test-rate-limit-key');
    jest.mocked(getRuntimeOrganizationFeatures).mockResolvedValue(DEFAULT_ORGANIZATION_FEATURES);
    jest.mocked(resolveOrganizationMemberModelDecision).mockResolvedValue(memberDecision);
    jest
      .mocked(getOpenRouterSystemOneModelsFromDatabase)
      .mockResolvedValue(new Set([TYPESAFE_MODEL, OTHER_SYSTEM_ONE_MODEL, SYSTEM_ONE_ALIAS]));
    jest.mocked(getOpenRouterModelsMetadataFromDatabase).mockResolvedValue(pricedSystemOneModels);
    jest.mocked(getCachedVercelInferenceProviderIdsForModel).mockResolvedValue(null);
    jest
      .mocked(resolveOpenRouterModelAlias)
      .mockImplementation(async modelId =>
        modelId === SYSTEM_ONE_ALIAS ? TYPESAFE_MODEL : modelId
      );
    jest.mocked(generateProviderSpecificHash).mockReturnValue('hashed-user');
    jest
      .mocked(resolveUsageEndpointRoute)
      .mockResolvedValue({ provider: OPENROUTER, userByok: null });
    jest
      .mocked(mapModelIdToVercel)
      .mockImplementation(async modelId =>
        modelId === TYPESAFE_MODEL ? VERCEL_SYSTEM_ONE_MODEL : modelId
      );
    jest.mocked(extractFraudAndProjectHeaders).mockReturnValue({
      fraudHeaders: EmptyFraudDetectionHeaders,
      projectId: 'project-123',
      xKiloCodeVersion: null,
      numericKiloCodeVersion: 0,
    });
    jest
      .mocked(extractHeaderAndLimitLength)
      .mockImplementation((request, name) => request.headers.get(name));
    jest.mocked(modelNotAllowedResponse).mockImplementation(() =>
      NextResponse.json(
        {
          error: 'Model not allowed',
          error_type: 'model_not_allowed',
          message: 'Model not allowed',
        },
        { status: 404 }
      )
    );
    mockedFetch.mockImplementation(async () => Response.json(upstreamBody));
    jest.mocked(fetchGeneration).mockResolvedValue(undefined);
    jest.mocked(mapToUsageStats).mockReturnValue(reconciledStats);
    jest.mocked(getCustomPricingConfig).mockResolvedValue(EMPTY_CUSTOM_PRICING_CONFIG);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('supports the TypeSafe SDK contract through a custom fetch transport', async () => {
    const routeFetch = jest.fn(async (input: string, init?: RequestInit) =>
      handleSystemOneRequest(new NextRequest(new Request(input, init)))
    );
    const client = new TypeSafeClient({
      apiKey: 'test-kilo-key',
      baseURL: 'http://localhost:3000/api/gateway/typesafe',
      defaultModel: 'jev-1.13',
      retry: { maxRetries: 0 },
      logLevel: 'off',
      fetch: routeFetch,
    });

    const { data, response } = await client.systemOne(requestBody).withResponse();

    expect(response.status).toBe(200);
    expect(data).toEqual(billedBody);
    expect(data.answers.billing.noul).toBe(0.95);
    expect(data.answers.category.choice).toBe('billing');
    expect(data.answers.urgency.score).toBe(0.75);
    expect(routeFetch).toHaveBeenCalledTimes(1);
    const [url, init] = routeFetch.mock.calls[0];
    expect(url).toBe(routeUrl);
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer test-kilo-key');
    expect(upstreamRequest().body).toEqual({
      ...JSON.parse(JSON.stringify(requestBody)),
      model: TYPESAFE_MODEL,
      user: 'hashed-user',
    });
    expect(getUserFromAuth).toHaveBeenCalledWith({
      adminOnly: false,
      expectedAudience: KILO_GATEWAY_AUDIENCE,
    });
    expect(resolveOrganizationMemberModelDecision).not.toHaveBeenCalled();
  });

  it.each([undefined, 'jev-1.13', 'typesafe/jev-1.13'])(
    'pins model %s to OpenRouter and drops client credentials and routing overrides',
    async model => {
      const response = await handleSystemOneRequest(
        makeRequest(
          {
            ...requestBody,
            model,
            provider: { only: ['attacker'], api_key: 'test-body-key' },
            user: 'attacker-user',
            api_key: 'test-body-key',
            byok: true,
            user_byok: [{ providerId: 'typesafe', apiKey: 'test-byok-key' }],
            base_url: 'https://attacker.invalid',
          },
          {
            Authorization: 'Bearer test-client-key',
            'Proxy-Authorization': 'Bearer test-proxy-key',
            'x-api-key': 'test-forwarded-key',
            'x-openrouter-api-key': 'test-user-openrouter-key',
            Cookie: 'session=test-cookie',
            'HTTP-Referer': 'https://attacker.invalid',
            'X-Title': 'Attacker',
          }
        )
      );

      expect(response.status).toBe(200);
      const upstream = upstreamRequest();
      expect(upstream.body).toEqual({
        ...JSON.parse(JSON.stringify(requestBody)),
        model: 'typesafe/jev-1.13',
        user: 'hashed-user',
      });
      expect(Object.fromEntries(upstream.headers)).toEqual({
        authorization: 'Bearer test-platform-openrouter-key',
        'content-type': 'application/json',
        'http-referer': 'https://kilocode.ai',
        'x-title': 'Kilo Code',
      });
      expect(generateProviderSpecificHash).toHaveBeenCalledWith(user.id, OPENROUTER);
      expect(getOrganizationProviderPrivacy).toHaveBeenCalledWith(undefined);
    }
  );

  it('defers billing and converts upstream cost to rounded microdollars without a markup', async () => {
    setAuth('org-123');
    const response = await handleSystemOneRequest(
      makeRequest(requestBody, {
        'x-kilocode-editorname': 'vscode',
        'x-kilocode-machineid': 'machine-123',
        'x-kilocode-feature': 'cli',
        'X-KiloCode-TaskId': 'task-123',
        'x-kilocode-mode': 'code',
      })
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(billedBody);
    expect(logMicrodollarUsageAndReportToBouncer).not.toHaveBeenCalled();
    await runAfter();
    expect(logMicrodollarUsageAndReportToBouncer).toHaveBeenCalledTimes(1);
    expect(logMicrodollarUsageAndReportToBouncer).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: upstreamBody.id,
        model: TYPESAFE_MODEL,
        inference_provider: 'TypeSafe upstream',
        cost_mUsd: 124,
        market_cost: 124,
        inputTokens: 23,
        outputTokens: 7,
        cacheWriteTokens: 0,
        cacheHitTokens: 0,
        is_byok: false,
        streamed: false,
        hasError: false,
        status_code: 200,
        responseContent: '',
        latency: expect.any(Number),
      }),
      expect.objectContaining({
        api_kind: 'systemone',
        kiloUserId: user.id,
        provider: 'openrouter',
        requested_model: TYPESAFE_MODEL,
        is_free: false,
        organizationId: 'org-123',
        prior_microdollar_usage: 123,
        posthog_distinct_id: user.google_user_email,
        project_id: 'project-123',
        fraudHeaders: EmptyFraudDetectionHeaders,
        editor_name: 'vscode',
        machine_id: 'machine-123',
        feature: 'cli',
        session_id: 'task-123',
        mode: 'code',
        user_byok: false,
        isStreaming: false,
        ttfb_ms: expect.any(Number),
      })
    );
    expect(emitGatewayApiMetrics).toHaveBeenCalledTimes(1);
    expect(emitGatewayApiMetrics).toHaveBeenCalledWith({
      kiloUserId: user.id,
      organizationId: 'org-123',
      isAnonymous: false,
      isStreaming: false,
      userByok: false,
      mode: 'code',
      provider: 'openrouter',
      inferenceProvider: 'TypeSafe upstream',
      requestedModel: TYPESAFE_MODEL,
      resolvedModel: TYPESAFE_MODEL,
      toolsAvailable: [],
      toolsUsed: [],
      ttfbMs: expect.any(Number),
      completeRequestMs: expect.any(Number),
      statusCode: 200,
    });
  });

  it.each([
    {
      provider: { data_collection: 'allow' },
      organizationDataCollection: 'deny',
      expected: { data_collection: 'deny' },
    },
    {
      provider: { zdr: false },
      organizationDataCollection: 'allow',
      expected: { data_collection: 'allow', zdr: false },
    },
  ] as const)(
    'merges effective privacy without coupling ZDR: %j',
    async ({ provider, organizationDataCollection, expected }) => {
      if (organizationDataCollection !== undefined) {
        setAuth('org-123');
        jest.mocked(getBalanceAndOrgSettings).mockResolvedValue({
          balance: 1000,
          settings: { data_collection: organizationDataCollection },
        });
        jest
          .mocked(getOrganizationProviderPrivacy)
          .mockReturnValue({ data_collection: organizationDataCollection });
      }

      const response = await handleSystemOneRequest(makeRequest({ ...requestBody, provider }));

      expect(response.status).toBe(200);
      expect(upstreamRequest().body.provider).toEqual(expected);
    }
  );

  it.each([undefined, { only: ['attacker'] }])(
    'omits provider without effective settings: %j',
    async provider => {
      const response = await handleSystemOneRequest(makeRequest({ ...requestBody, provider }));

      expect(response.status).toBe(200);
      expect(upstreamRequest().body).not.toHaveProperty('provider');
    }
  );

  it('reports the custom-priced cost the ledger row bills', async () => {
    const customPricing: CustomPricingConfig = {
      models: [
        {
          model: TYPESAFE_MODEL,
          pricing: [
            {
              start_context_length: 0,
              pricing: {
                prompt_per_million: 2,
                completion_per_million: 10,
                input_cache_read_per_million: null,
                input_cache_write_per_million: null,
              },
            },
          ],
        },
      ],
    };
    jest.mocked(getCustomPricingConfig).mockResolvedValue(customPricing);

    const response = await handleSystemOneRequest(makeRequest());

    // 23 input tokens at $2/M plus 7 output tokens at $10/M.
    expect(await response.json()).toEqual({
      ...billedBody,
      usage: { ...billedBody.usage, cost: 0.000116 },
    });
    await runAfter();
    expect(logMicrodollarUsageAndReportToBouncer).toHaveBeenCalledWith(
      expect.objectContaining({ cost_mUsd: 116, market_cost: 124 }),
      expect.anything()
    );
  });

  it('reports the provider cost the ledger row bills even when the body claims BYOK', async () => {
    const usage = {
      ...upstreamBody.usage,
      is_byok: true,
      cost_details: { upstream_inference_cost: 0.002 },
    };
    mockedFetch.mockResolvedValue(Response.json({ ...upstreamBody, usage }));

    const response = await handleSystemOneRequest(makeRequest());

    expect(await response.json()).toEqual({
      ...billedBody,
      usage: { ...usage, cost: 0.000124, is_byok: false },
    });
    await runAfter();
    expect(logMicrodollarUsageAndReportToBouncer).toHaveBeenCalledWith(
      expect.objectContaining({ cost_mUsd: 124, market_cost: 124 }),
      expect.anything()
    );
  });

  it('forwards privacy without exposing client routing, credentials, or identity', async () => {
    const response = await handleSystemOneRequest(
      makeRequest({
        ...requestBody,
        model: 'jev-1.13',
        provider: {
          data_collection: 'deny',
          zdr: false,
          only: ['attacker'],
          ignore: ['typesafe'],
          order: ['attacker'],
          sort: 'price',
          allow_fallbacks: true,
          api_key: 'test-key',
          credentials: { api_key: 'test-key' },
          byok: true,
          user_byok: [{ providerId: 'typesafe', apiKey: 'test-key' }],
          base_url: 'https://attacker.invalid',
          user: 'attacker',
        },
        user: 'attacker',
        api_key: 'test-key',
        byok: true,
        base_url: 'https://attacker.invalid',
      })
    );

    expect(response.status).toBe(200);
    const upstream = upstreamRequest();
    expect(upstream.body).toEqual({
      ...JSON.parse(JSON.stringify(requestBody)),
      model: TYPESAFE_MODEL,
      provider: { data_collection: 'deny', zdr: false },
      user: 'hashed-user',
    });
  });

  it('accepts zero-cost usage and leaves an absent inference provider unknown', async () => {
    mockedFetch.mockResolvedValue(
      Response.json({
        ...upstreamBody,
        provider: undefined,
        usage: { ...upstreamBody.usage, cost: 0 },
      })
    );

    expect((await handleSystemOneRequest(makeRequest())).status).toBe(200);
    await runAfter();

    expect(logMicrodollarUsageAndReportToBouncer).toHaveBeenCalledWith(
      expect.objectContaining({ inference_provider: null, cost_mUsd: 0, market_cost: 0 }),
      expect.objectContaining({ provider: 'openrouter', user_byok: false })
    );
  });

  it('returns the authentication failure and requests the gateway audience', async () => {
    const authFailedResponse = NextResponse.json(
      { success: false as const, error: 'Unauthorized' },
      { status: 401 }
    );
    jest.mocked(getUserFromAuth).mockResolvedValue({ user: null, authFailedResponse });

    expect(await handleSystemOneRequest(makeRequest())).toBe(authFailedResponse);
    expect(getUserFromAuth).toHaveBeenCalledWith({
      adminOnly: false,
      expectedAudience: KILO_GATEWAY_AUDIENCE,
    });
    expect(getBalanceAndOrgSettings).not.toHaveBeenCalled();
    expect(mockedFetch).not.toHaveBeenCalled();
    expect(deferredUsageCallbacks()).toHaveLength(0);
  });

  it('answers a rejected credential with INVALID_TOKEN', async () => {
    jest.mocked(getUserFromAuth).mockResolvedValue({
      user: null,
      authFailedResponse: NextResponse.json(
        { success: false as const, error: 'Invalid API token' },
        { status: 401 }
      ),
      credentialsRejected: true,
    });

    const response = await handleSystemOneRequest(makeRequest());

    expect(response.status).toBe(401);
    expect(response.headers.get('WWW-Authenticate')).toBe('Bearer error="invalid_token"');
    await expect(response.json()).resolves.toMatchObject({ error: { code: INVALID_TOKEN_CODE } });
    expect(getBalanceAndOrgSettings).not.toHaveBeenCalled();
    expect(mockedFetch).not.toHaveBeenCalled();
  });

  it('rate limits before authentication or upstream work', async () => {
    jest.mocked(isGatewayAccountRateLimited).mockResolvedValue(true);
    const request = makeRequest(requestBody, { 'x-forwarded-for': ' 192.0.2.1, 192.0.2.2' });

    const response = await handleSystemOneRequest(request);

    expect(response.status).toBe(429);
    // The same response chat and the other inference routes answer.
    expect(await response.json()).toEqual({
      error: 'Rate limit exceeded',
      error_type: 'rate_limit_exceeded',
      message: 'Too many requests. Please try again later.',
    });
    expect(gatewayRateLimitKey).toHaveBeenCalledWith(request.headers, '192.0.2.1');
    expect(isGatewayAccountRateLimited).toHaveBeenCalledWith(request, 'test-rate-limit-key');
    expect(getUserFromAuth).not.toHaveBeenCalled();
    expect(mockedFetch).not.toHaveBeenCalled();
  });

  it('limits a free System One model per account before reading the balance', async () => {
    jest.mocked(isFreeModelRateLimited).mockResolvedValue(true);

    const response = await handleSystemOneRequest(
      makeRequest({ ...requestBody, model: OTHER_SYSTEM_ONE_MODEL })
    );

    expect(response.status).toBe(429);
    expect(response.headers.get('x-should-retry')).toBe('false');
    await expect(response.json()).resolves.toMatchObject({ error_type: 'rate_limit_exceeded' });
    expect(isFreeModelRateLimited).toHaveBeenCalledWith(expect.anything(), {
      kind: 'account',
      kiloUserId: user.id,
    });
    expect(getBalanceAndOrgSettings).not.toHaveBeenCalled();
    expect(mockedFetch).not.toHaveBeenCalled();
  });

  it.each([
    { features: ['org-123'], status: 403 },
    { features: [], status: 200 },
  ])(
    'rejects a request when the organization disabled OpenRouter, with feature organizations $features',
    async ({ features, status }) => {
      setAuth('org-123');
      jest.mocked(getBalanceAndOrgSettings).mockResolvedValue({
        balance: 1_000_000,
        plan: 'enterprise',
        settings: { disable_openrouter: true },
      });
      jest
        .mocked(getRuntimeOrganizationFeatures)
        .mockResolvedValue({ ...DEFAULT_ORGANIZATION_FEATURES, gateway_settings: features });

      const response = await handleSystemOneRequest(makeRequest());

      expect(response.status).toBe(status);
      if (status === 403) {
        await expect(response.json()).resolves.toMatchObject({
          error:
            'This request would be routed through OpenRouter, which your organization has disabled.',
          error_type: 'provider_not_allowed',
        });
      }
      expect(mockedFetch).toHaveBeenCalledTimes(status === 200 ? 1 : 0);
    }
  );

  it('does not count a paid System One model against the free-model limit', async () => {
    jest.mocked(isFreeModelRateLimited).mockResolvedValue(true);

    const response = await handleSystemOneRequest(makeRequest());

    expect(response.status).toBe(200);
    expect(isFreeModelRateLimited).not.toHaveBeenCalled();
  });

  it.each([
    { model: OTHER_SYSTEM_ONE_MODEL, policyModel: OTHER_SYSTEM_ONE_MODEL, isFree: true },
    { model: SYSTEM_ONE_ALIAS, policyModel: TYPESAFE_MODEL, isFree: false },
  ])(
    'forwards OpenRouter System One model $model unchanged',
    async ({ model, policyModel, isFree }) => {
      setAuth('org-123');

      const response = await handleSystemOneRequest(makeRequest({ ...requestBody, model }));

      expect(response.status).toBe(200);
      // A free model reports no cost, and an id other than an alias reports the requested model.
      await expect(response.json()).resolves.toMatchObject({
        model: model === SYSTEM_ONE_ALIAS ? TYPESAFE_MODEL : model,
        usage: { cost: isFree ? 0 : 0.000124 },
      });
      expect(upstreamRequest().body.model).toBe(model);
      expect(resolveOrganizationMemberModelDecision).toHaveBeenCalledWith(
        expect.objectContaining({ modelId: policyModel })
      );
      await runAfter();
      expect(logMicrodollarUsageAndReportToBouncer).toHaveBeenCalledWith(
        expect.objectContaining({ cost_mUsd: isFree ? 0 : 124, market_cost: 124 }),
        expect.objectContaining({ requested_model: model, is_free: isFree })
      );
    }
  );

  it.each(['openai/gpt-4o', 'jev-latest', 'respan/span-01-lite', 'jev-2.0'])(
    'rejects %s when it is not an OpenRouter System One model',
    async model => {
      const response = await handleSystemOneRequest(makeRequest({ ...requestBody, model }));

      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({ error_type: 'model_not_found' });
      expect(getBalanceAndOrgSettings).not.toHaveBeenCalled();
      expect(mockedFetch).not.toHaveBeenCalled();
      expect(deferredUsageCallbacks()).toHaveLength(0);
    }
  );

  it('answers 503 when the catalog has no metadata for the model', async () => {
    jest.mocked(getOpenRouterSystemOneModelsFromDatabase).mockResolvedValue(new Set());

    const response = await handleSystemOneRequest(
      makeRequest({ ...requestBody, model: 'vendor/unlisted-decide' })
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error_type: 'temporarily_unavailable' });
    expect(mockedFetch).not.toHaveBeenCalled();
    expect(deferredUsageCallbacks()).toHaveLength(0);
  });

  it('answers 503 when the catalog cannot price the model', async () => {
    jest.mocked(getOpenRouterModelsMetadataFromDatabase).mockResolvedValue({
      ...pricedSystemOneModels,
      [TYPESAFE_MODEL]: { id: TYPESAFE_MODEL, name: 'TypeSafe: Jev 1.13', endpoints: [] },
    });

    const response = await handleSystemOneRequest(makeRequest());

    expect(response.status).toBe(503);
    expect(errorExceptInTest).toHaveBeenCalledWith(
      'System One request cost unavailable',
      expect.stringContaining('unusable pricing')
    );
    expect(mockedFetch).not.toHaveBeenCalled();
  });

  it.each([
    ['malformed JSON', '{'],
    ['an empty model', JSON.stringify({ ...requestBody, model: ' ' })],
    ['a non-string model', JSON.stringify({ ...requestBody, model: 1 })],
    ['empty questions', JSON.stringify({ ...requestBody, questions: {} })],
    [
      'invalid data collection',
      JSON.stringify({ ...requestBody, provider: { data_collection: 'invalid' } }),
    ],
    ['string ZDR', JSON.stringify({ ...requestBody, provider: { zdr: 'false' } })],
  ])('rejects %s', async (_name, body) => {
    const response = await handleSystemOneRequest(
      new NextRequest(routeUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      })
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error_type: 'invalid_request' });
    expect(getBalanceAndOrgSettings).not.toHaveBeenCalled();
    expect(mockedFetch).not.toHaveBeenCalled();
    expect(deferredUsageCallbacks()).toHaveLength(0);
  });

  it('formats validation errors with Zod while preserving the TypeSafe error shape', async () => {
    const body = { ...requestBody, questions: { refund: { type: 'invalid' } } };
    const validation = systemOneRequestSchema.safeParse(body);
    if (validation.success) throw new Error('Expected an invalid question');

    const response = await handleSystemOneRequest(makeRequest(body));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      message: z.prettifyError(validation.error),
      error_type: 'invalid_request',
    });
    expect(mockedFetch).not.toHaveBeenCalled();
  });

  it.each([0, -1])('blocks balance %s using the shared credits response', async balance => {
    setAuth('org-123');
    jest.mocked(getBalanceAndOrgSettings).mockResolvedValue({
      balance,
      balanceLimitedByUserAllowance: true,
    });
    const blockedResponse = NextResponse.json(
      {
        error_type: 'usage_limit_exceeded' as const,
        error: {
          title: 'Credits exhausted',
          message: 'Credits exhausted',
          balance,
          buyCreditsUrl: '',
        },
      },
      { status: 402 }
    );
    jest.mocked(creditsBlockedResponse).mockResolvedValue(blockedResponse);

    expect(await handleSystemOneRequest(makeRequest())).toBe(blockedResponse);
    const [organizationId, balanceUser, fromDb, funding] =
      jest.mocked(getBalanceAndOrgSettings).mock.lastCall ?? [];
    expect(organizationId).toBe('org-123');
    expect(balanceUser).toEqual(user);
    expect(fromDb).toBe(readDb);
    expect(funding).toBe('usage');
    expect(creditsBlockedResponse).toHaveBeenCalledWith({
      user,
      balance,
      organizationId: 'org-123',
      balanceLimitedByUserAllowance: true,
    });
    expect(getOrganizationProviderPrivacy).not.toHaveBeenCalled();
    expect(mockedFetch).not.toHaveBeenCalled();
    expect(deferredUsageCallbacks()).toHaveLength(0);
  });

  it('denies a model rejected by the effective organization member decision', async () => {
    setAuth('org-123');
    jest.mocked(resolveOrganizationMemberModelDecision).mockResolvedValue({
      ...memberDecision,
      decision: { allowed: false },
    });

    expect((await handleSystemOneRequest(makeRequest())).status).toBe(404);
    const { fromDb, ...decisionParams } =
      jest.mocked(resolveOrganizationMemberModelDecision).mock.lastCall?.[0] ?? {};
    expect(decisionParams).toEqual({
      organizationId: 'org-123',
      kiloUserId: user.id,
      modelId: TYPESAFE_MODEL,
      providerLookup: getProviderSlugsForModel,
    });
    expect(fromDb).toBe(readDb);
    expect(modelNotAllowedResponse).toHaveBeenCalledTimes(1);
    expect(mockedFetch).not.toHaveBeenCalled();
    expect(deferredUsageCallbacks()).toHaveLength(0);
  });

  it.each([
    { eligible: ['typesafe'], expected: { only: ['typesafe'] } },
    { eligible: ['typesafe', 'virtual'], expected: { only: ['typesafe'] } },
    { eligible: undefined, expected: {} },
  ])('routes through the member decision provider routes: %j', async ({ eligible, expected }) => {
    setAuth('org-123');
    jest.mocked(getBalanceAndOrgSettings).mockResolvedValue({
      balance: 1000,
      settings: { data_collection: 'allow' },
    });
    jest.mocked(getOrganizationProviderPrivacy).mockReturnValue({ data_collection: 'allow' });
    jest.mocked(resolveOrganizationMemberModelDecision).mockResolvedValue({
      ...memberDecision,
      decision: { allowed: true, eligibleProviderRoutes: eligible ? new Set(eligible) : undefined },
    });

    const response = await handleSystemOneRequest(
      makeRequest({
        ...requestBody,
        provider: { only: ['attacker'], data_collection: 'deny', zdr: false },
      })
    );

    expect(response.status).toBe(200);
    expect(upstreamRequest().body.provider).toEqual({
      ...expected,
      data_collection: 'deny',
      zdr: false,
    });
  });

  it('preserves privacy with a group-only provider restriction', async () => {
    const provider = { zdr: false };
    setAuth('org-123');
    jest.mocked(resolveOrganizationMemberModelDecision).mockResolvedValue({
      ...memberDecision,
      decision: { allowed: true, eligibleProviderRoutes: new Set(['typesafe']) },
    });

    const response = await handleSystemOneRequest(makeRequest({ ...requestBody, provider }));

    expect(response.status).toBe(200);
    expect(upstreamRequest().body.provider).toEqual({ ...provider, only: ['typesafe'] });
  });

  it('answers data_collection_required under an organization data collection policy', async () => {
    setAuth('org-123');
    jest.mocked(getBalanceAndOrgSettings).mockResolvedValue({
      balance: 1000,
      settings: { data_collection: 'deny' },
    });
    jest.mocked(getOrganizationProviderPrivacy).mockReturnValue({ data_collection: 'deny' });

    const response = await handleSystemOneRequest(
      makeRequest({ ...requestBody, model: OTHER_SYSTEM_ONE_MODEL })
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error_type: 'data_collection_required',
    });
    expect(mockedFetch).not.toHaveBeenCalled();
    expect(logMicrodollarUsageAndReportToBouncer).not.toHaveBeenCalled();
    expect(startBouncerDecide).not.toHaveBeenCalled();
  });

  it('answers data_collection_required under a request data collection policy', async () => {
    const response = await handleSystemOneRequest(
      makeRequest({
        ...requestBody,
        model: OTHER_SYSTEM_ONE_MODEL,
        provider: { data_collection: 'deny' },
      })
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error_type: 'data_collection_required',
    });
    expect(mockedFetch).not.toHaveBeenCalled();
    expect(logMicrodollarUsageAndReportToBouncer).not.toHaveBeenCalled();
    expect(startBouncerDecide).not.toHaveBeenCalled();
  });

  it('answers data_collection_required under a zero data retention policy', async () => {
    const response = await handleSystemOneRequest(
      makeRequest({ ...requestBody, model: OTHER_SYSTEM_ONE_MODEL, provider: { zdr: true } })
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error_type: 'data_collection_required',
    });
    expect(mockedFetch).not.toHaveBeenCalled();
    expect(logMicrodollarUsageAndReportToBouncer).not.toHaveBeenCalled();
    expect(startBouncerDecide).not.toHaveBeenCalled();
  });

  it('serves a model under an allowing data collection policy', async () => {
    setAuth('org-123');
    jest.mocked(getBalanceAndOrgSettings).mockResolvedValue({
      balance: 1000,
      settings: { data_collection: 'allow' },
    });
    jest.mocked(getOrganizationProviderPrivacy).mockReturnValue({ data_collection: 'allow' });

    const response = await handleSystemOneRequest(
      makeRequest({ ...requestBody, model: OTHER_SYSTEM_ONE_MODEL })
    );

    expect(response.status).toBe(200);
    expect(upstreamRequest().body.provider).toEqual({ data_collection: 'allow' });
  });

  it('forwards a data collection policy on a paid model', async () => {
    setAuth('org-123');
    jest.mocked(getBalanceAndOrgSettings).mockResolvedValue({
      balance: 1000,
      settings: { data_collection: 'deny' },
    });
    jest.mocked(getOrganizationProviderPrivacy).mockReturnValue({ data_collection: 'deny' });

    const response = await handleSystemOneRequest(makeRequest());

    expect(response.status).toBe(200);
    expect(upstreamRequest().body.provider).toEqual({ data_collection: 'deny' });
  });

  it.each([[[]], [['virtual']]])(
    'rejects member routes without a real provider: %j',
    async eligible => {
      setAuth('org-123');
      jest.mocked(getOrganizationProviderPrivacy).mockReturnValue({ data_collection: 'deny' });
      jest.mocked(resolveOrganizationMemberModelDecision).mockResolvedValue({
        ...memberDecision,
        decision: { allowed: true, eligibleProviderRoutes: new Set(eligible) },
      });

      expect((await handleSystemOneRequest(makeRequest())).status).toBe(404);
      expect(modelNotAllowedResponse).toHaveBeenCalledTimes(1);
      expect(mockedFetch).not.toHaveBeenCalled();
      expect(deferredUsageCallbacks()).toHaveLength(0);
    }
  );

  it('cancels the upstream body on credit exhaustion and records the attempt row', async () => {
    const cancel = jest.fn();
    mockedFetch.mockResolvedValue(new Response(new ReadableStream({ cancel }), { status: 402 }));

    const response = await handleSystemOneRequest(makeRequest());

    expect(response.status).toBe(503);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(await response.json()).toEqual({
      message: 'Service temporarily unavailable',
      error_type: 'upstream_error',
    });
    expect(errorExceptInTest).toHaveBeenCalledWith('OpenRouter System One balance exhausted');
    expect(wrapInSafeNextResponse).not.toHaveBeenCalled();
    await runAfter();
    expect(logMicrodollarUsageAndReportToBouncer).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: null,
        hasError: true,
        cancelled: false,
        status_code: 402,
        cost_mUsd: 0,
        market_cost: 0,
      }),
      expect.objectContaining({ api_kind: 'systemone', status_code: 402 })
    );
  });

  it('explains an OpenRouter refusal for lack of an allowed provider', async () => {
    mockedFetch.mockResolvedValue(
      Response.json(
        {
          error: {
            message: 'No allowed providers are available for the selected model.',
            code: 404,
            metadata: { available_providers: ['openai'], requested_providers: ['azure'] },
          },
        },
        { status: 404 }
      )
    );

    const response = await handleSystemOneRequest(makeRequest());

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: 'No eligible provider can serve the selected model.',
      error_type: 'provider_not_allowed',
    });
    expect(wrapInSafeNextResponse).not.toHaveBeenCalled();
    await runAfter();
    expect(logMicrodollarUsageAndReportToBouncer).toHaveBeenCalledWith(
      expect.objectContaining({ hasError: true, status_code: 404, cost_mUsd: 0 }),
      expect.objectContaining({ status_code: 404 })
    );
  });

  it.each([400, 429, 500])(
    'delegates upstream HTTP %s to the safe response wrapper and records the attempt',
    async status => {
      const upstream = Response.json({ error: 'upstream failure' }, { status });
      const safeResponse = NextResponse.json({ error: 'upstream failure' }, { status });
      mockedFetch.mockResolvedValue(upstream);
      jest.mocked(wrapInSafeNextResponse).mockReturnValue(safeResponse);

      expect(await handleSystemOneRequest(makeRequest())).toBe(safeResponse);
      expect(wrapInSafeNextResponse).toHaveBeenCalledWith(upstream);
      await runAfter();
      expect(logMicrodollarUsageAndReportToBouncer).toHaveBeenCalledWith(
        expect.objectContaining({ hasError: true, status_code: status, cost_mUsd: 0 }),
        expect.objectContaining({ status_code: status })
      );
      expect(emitGatewayApiMetrics).toHaveBeenCalledWith(
        expect.objectContaining({ statusCode: status, inferenceProvider: undefined })
      );
    }
  );

  it.each([
    {
      case: 'a transport failure',
      arrange: () => mockedFetch.mockRejectedValue(new Error('connection failed')),
      latency: null,
    },
  ])(
    'records a zero-cost attempt row when the upstream call ends with $case',
    async ({ arrange, latency }) => {
      mockMeteredClock();
      arrange();

      const response = await handleSystemOneRequest(makeRequest());

      expect(response.status).toBe(502);
      expect(await response.json()).toEqual({
        message: 'Upstream request failed',
        error_type: 'upstream_error',
      });
      expect(errorExceptInTest).toHaveBeenCalledWith(
        'AI gateway upstream fetch failed',
        expect.objectContaining({ path: '/systemone', failureFamily: 'unknown' })
      );
      await runAfter();
      expect(logMicrodollarUsageAndReportToBouncer).toHaveBeenCalledWith(
        expect.objectContaining({
          messageId: null,
          hasError: true,
          status_code: 502,
          latency,
          cost_mUsd: 0,
        }),
        expect.objectContaining({ status_code: 502, ttfb_ms: latency })
      );
    }
  );

  it.each([
    { bodyFailure: 'invalid JSON', recovered: false, readError: { errorName: 'SyntaxError' } },
    { bodyFailure: 'invalid JSON', recovered: true, readError: { errorName: 'SyntaxError' } },
    { bodyFailure: 'read failure', recovered: false, readError: { errorName: 'Error' } },
    { bodyFailure: 'read failure', recovered: true, readError: { errorName: 'Error' } },
  ])(
    'reconciles an unreadable $bodyFailure response using its header id (recovered: $recovered)',
    async ({ bodyFailure, recovered, readError }) => {
      mockMeteredClock();
      const messageId = 'gen-systemone-header';
      const body =
        bodyFailure === 'read failure'
          ? new ReadableStream({ start: controller => controller.error(new Error('private body')) })
          : 'private body, not JSON';
      mockedFetch.mockResolvedValue(
        new Response(body, {
          status: 201,
          headers: { 'content-type': 'application/json', 'x-generation-id': messageId },
        })
      );
      if (recovered) {
        jest
          .mocked(fetchGeneration)
          .mockResolvedValue({ data: { id: messageId } } as OpenRouterGeneration);
        jest.mocked(mapToUsageStats).mockReturnValue({ ...reconciledStats, messageId });
      }

      const response = await handleSystemOneRequest(makeRequest());

      expect(response.status).toBe(502);
      expect(await response.json()).toEqual({
        message: 'Upstream request failed',
        error_type: 'upstream_error',
      });
      expect(logMicrodollarUsageAndReportToBouncer).not.toHaveBeenCalled();
      await runAfter();
      expect(fetchGeneration).toHaveBeenCalledWith(messageId, OPENROUTER);
      expect(logMicrodollarUsageAndReportToBouncer).toHaveBeenCalledTimes(1);
      expect(logMicrodollarUsageAndReportToBouncer).toHaveBeenCalledWith(
        expect.objectContaining({
          messageId,
          model: TYPESAFE_MODEL,
          hasError: true,
          status_code: 201,
          latency: METERED_LATENCY_MS,
          cost_mUsd: recovered ? 124 : 0,
          market_cost: recovered ? 124 : 0,
          inputTokens: recovered ? 23 : 0,
          outputTokens: recovered ? 7 : 0,
          streamed: false,
          cancelled: false,
          is_byok: false,
        }),
        expect.objectContaining({
          status_code: 201,
          ttfb_ms: METERED_LATENCY_MS,
          bouncer: expect.objectContaining({
            requestId: expect.any(String),
            accountId: `user:${user.id}`,
          }),
        })
      );
      expect(captureException).toHaveBeenCalledTimes(1);
      expect(captureException).toHaveBeenCalledWith(
        new Error('Unable to read or parse upstream usage response'),
        {
          tags: { source: 'usage_response_parsing', api_kind: 'systemone' },
          extra: {
            usageId: undefined,
            kiloUserId: user.id,
            organizationId: undefined,
            provider: 'openrouter',
            messageId,
            ...readError,
          },
        }
      );
      expect(errorExceptInTest).not.toHaveBeenCalled();
    }
  );

  const rootZodIssue = { errorName: 'ZodError', issues: [{ path: '', code: 'invalid_type' }] };
  it.each([
    [null, rootZodIssue],
    [7, rootZodIssue],
    [[], rootZodIssue],
    [
      { answers: 'private answer' },
      {
        errorName: 'ZodError',
        issues: [
          { path: 'id', code: 'invalid_type' },
          { path: 'model', code: 'invalid_type' },
          { path: 'answers', code: 'invalid_type' },
          { path: 'usage', code: 'invalid_type' },
        ],
      },
    ],
    [
      { ...upstreamBody, id: undefined, usage: 'private usage' },
      {
        errorName: 'ZodError',
        issues: [
          { path: 'id', code: 'invalid_type' },
          { path: 'usage', code: 'invalid_type' },
        ],
      },
    ],
  ])(
    'records malformed response %j using its header id and upstream status',
    async (body, readError) => {
      mockMeteredClock();
      setAuth('org-123');
      mockedFetch.mockResolvedValue(
        Response.json(body, {
          status: 202,
          headers: { 'x-generation-id': 'gen-malformed-header' },
        })
      );

      expect((await handleSystemOneRequest(makeRequest())).status).toBe(502);

      await runAfter();
      expect(fetchGeneration).toHaveBeenCalledWith('gen-malformed-header', OPENROUTER);
      expect(logMicrodollarUsageAndReportToBouncer).toHaveBeenCalledTimes(1);
      expect(logMicrodollarUsageAndReportToBouncer).toHaveBeenCalledWith(
        expect.objectContaining({
          messageId: 'gen-malformed-header',
          model: TYPESAFE_MODEL,
          hasError: true,
          status_code: 202,
          cost_mUsd: 0,
          market_cost: 0,
          inputTokens: 0,
          outputTokens: 0,
          latency: METERED_LATENCY_MS,
        }),
        expect.objectContaining({ status_code: 202, ttfb_ms: METERED_LATENCY_MS })
      );
      expect(captureException).toHaveBeenCalledTimes(1);
      expect(captureException).toHaveBeenCalledWith(
        new Error('Unable to read or parse upstream usage response'),
        {
          tags: { source: 'usage_response_parsing', api_kind: 'systemone' },
          extra: {
            usageId: undefined,
            kiloUserId: user.id,
            organizationId: 'org-123',
            provider: 'openrouter',
            messageId: 'gen-malformed-header',
            ...readError,
          },
        }
      );
    }
  );

  it.each([
    ['the gateway duration budget', new DOMException('The operation was aborted', 'TimeoutError')],
    [
      "undici's header timeout",
      new TypeError('fetch failed', {
        cause: Object.assign(new Error('Headers Timeout Error'), {
          code: 'UND_ERR_HEADERS_TIMEOUT',
        }),
      }),
    ],
  ])(
    'records a duration-bound attempt row when %s ends the upstream call',
    async (_case, error) => {
      mockedFetch.mockRejectedValue(error);

      const response = await handleSystemOneRequest(makeRequest());

      expect(response.status).toBe(502);
      expect(await response.json()).toEqual({
        message: 'Upstream request failed',
        error_type: 'upstream_error',
      });

      await runAfter();
      expect(logMicrodollarUsageAndReportToBouncer).toHaveBeenCalledWith(
        expect.objectContaining({ hasError: true, status_code: 504, cost_mUsd: 0 }),
        expect.objectContaining({ status_code: 504 })
      );
    }
  );

  it.each([
    ['missing usage', undefined],
    ['null usage', null],
    ['missing cost', { input_tokens: 23, output_tokens: 7 }],
    ['string cost', { ...upstreamBody.usage, cost: '0.01' }],
    ['negative cost', { ...upstreamBody.usage, cost: -0.01 }],
    ['missing input tokens', { output_tokens: 7, cost: 0.01 }],
    ['negative tokens', { ...upstreamBody.usage, input_tokens: -1 }],
    ['fractional tokens', { ...upstreamBody.usage, output_tokens: 1.5 }],
  ])('reconciles the cost of an upstream %s rejection', async (_name, usage) => {
    mockMeteredClock();
    mockedFetch.mockResolvedValue(
      Response.json(
        { ...upstreamBody, usage },
        {
          headers: { 'x-generation-id': 'gen-other-header' },
        }
      )
    );
    jest.mocked(fetchGeneration).mockResolvedValue({
      data: { id: upstreamBody.id },
    } as OpenRouterGeneration);

    const response = await handleSystemOneRequest(makeRequest());

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      message: 'Invalid upstream response',
      error_type: 'upstream_error',
    });
    expect(captureException).toHaveBeenCalledTimes(1);
    await runAfter();
    expect(fetchGeneration).toHaveBeenCalledWith(
      upstreamBody.id,
      expect.objectContaining({ type: 'openrouter' })
    );
    expect(mapToUsageStats).toHaveBeenCalledWith(expect.anything(), '', user.id, 'openrouter');
    expect(emitGatewayApiMetrics).toHaveBeenCalledWith(
      expect.objectContaining({
        ttfbMs: METERED_LATENCY_MS,
        completeRequestMs: METERED_COMPLETE_REQUEST_MS,
      })
    );
    expect(logMicrodollarUsageAndReportToBouncer).toHaveBeenCalledWith(
      expect.objectContaining({
        hasError: true,
        status_code: 200,
        latency: METERED_LATENCY_MS,
        cost_mUsd: 124,
        market_cost: 124,
      }),
      expect.objectContaining({ status_code: 200, ttfb_ms: METERED_LATENCY_MS })
    );
  });

  it('records a zero-cost row when an invalid body carries no generation id', async () => {
    mockedFetch.mockResolvedValue(
      Response.json({ ...upstreamBody, id: undefined, usage: undefined })
    );

    expect((await handleSystemOneRequest(makeRequest())).status).toBe(502);

    await runAfter();
    expect(fetchGeneration).not.toHaveBeenCalled();
    expect(logMicrodollarUsageAndReportToBouncer).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: null, hasError: true, cost_mUsd: 0, status_code: 200 }),
      expect.objectContaining({ status_code: 200 })
    );
  });

  it('records a zero-cost row when the generation lookup has no answer', async () => {
    mockMeteredClock();
    mockedFetch.mockResolvedValue(Response.json({ ...upstreamBody, usage: undefined }));

    expect((await handleSystemOneRequest(makeRequest())).status).toBe(502);

    await runAfter();
    expect(fetchGeneration).toHaveBeenCalledTimes(1);
    expect(mapToUsageStats).not.toHaveBeenCalled();
    expect(logMicrodollarUsageAndReportToBouncer).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: upstreamBody.id,
        hasError: true,
        latency: METERED_LATENCY_MS,
        cost_mUsd: 0,
        status_code: 200,
      }),
      expect.objectContaining({ status_code: 200, ttfb_ms: METERED_LATENCY_MS })
    );
  });

  it.each([false, true])(
    'attributes an unusable body to its provider model (recovered: %s)',
    async recovered => {
      mockedFetch.mockResolvedValue(
        Response.json({
          id: upstreamBody.id,
          model: OTHER_SYSTEM_ONE_MODEL,
          answers: { billing: { type: 'noul', noul: 0.5 } },
        })
      );
      if (recovered) {
        jest
          .mocked(fetchGeneration)
          .mockResolvedValue({ data: { id: upstreamBody.id } } as OpenRouterGeneration);
        jest.mocked(mapToUsageStats).mockReturnValue({ ...reconciledStats, model: null });
      }

      expect((await handleSystemOneRequest(makeRequest())).status).toBe(502);

      await runAfter();
      expect(logMicrodollarUsageAndReportToBouncer).toHaveBeenCalledWith(
        expect.objectContaining({ messageId: upstreamBody.id, model: OTHER_SYSTEM_ONE_MODEL }),
        expect.anything()
      );
    }
  );

  it('attributes an unusable body without a model name to the resolved model', async () => {
    mockedFetch.mockResolvedValue(Response.json({ answers: { billing: { type: 'noul' } } }));

    expect(
      (await handleSystemOneRequest(makeRequest({ ...requestBody, model: SYSTEM_ONE_ALIAS })))
        .status
    ).toBe(502);

    await runAfter();
    expect(fetchGeneration).not.toHaveBeenCalled();
    expect(logMicrodollarUsageAndReportToBouncer).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: null, model: TYPESAFE_MODEL, cost_mUsd: 0 }),
      expect.anything()
    );
  });

  it('keeps the reconciled provider cost as market cost and charges a free model nothing', async () => {
    mockedFetch.mockResolvedValue(
      Response.json({ ...upstreamBody, model: OTHER_SYSTEM_ONE_MODEL, usage: undefined })
    );
    jest.mocked(fetchGeneration).mockResolvedValue({
      data: { id: upstreamBody.id },
    } as OpenRouterGeneration);

    const response = await handleSystemOneRequest(
      makeRequest({ ...requestBody, model: OTHER_SYSTEM_ONE_MODEL })
    );

    expect(response.status).toBe(502);
    await runAfter();
    expect(logMicrodollarUsageAndReportToBouncer).toHaveBeenCalledWith(
      expect.objectContaining({ cost_mUsd: 0, market_cost: 124, hasError: true }),
      expect.objectContaining({ is_free: true })
    );
  });

  it('bills and reports custom pricing for an answered request', async () => {
    jest.mocked(getCustomPricingConfig).mockResolvedValue(systemOneCustomPricingConfig);

    const response = await handleSystemOneRequest(makeRequest());

    expect(response.status).toBe(200);
    // 23 input tokens at $2/M plus 7 output tokens at $10/M.
    expect(await response.json()).toEqual({
      ...billedBody,
      usage: { ...billedBody.usage, cost: 0.000116 },
    });
    await runAfter();
    expect(logMicrodollarUsageAndReportToBouncer).toHaveBeenCalledWith(
      expect.objectContaining({ cost_mUsd: 116, market_cost: 124, hasError: false }),
      expect.objectContaining({ requested_model: TYPESAFE_MODEL, is_free: false })
    );
  });

  it('bills custom pricing from the generation tokens when the body is unusable', async () => {
    mockMeteredClock();
    jest.mocked(getCustomPricingConfig).mockResolvedValue(systemOneCustomPricingConfig);
    mockedFetch.mockResolvedValue(Response.json({ ...upstreamBody, usage: undefined }));
    jest.mocked(fetchGeneration).mockResolvedValue({
      data: { id: upstreamBody.id },
    } as OpenRouterGeneration);
    jest
      .mocked(mapToUsageStats)
      .mockReturnValue({ ...reconciledStats, inputTokens: 50, outputTokens: 10 });

    expect((await handleSystemOneRequest(makeRequest())).status).toBe(502);

    await runAfter();
    // 50 input tokens at $2/M plus 10 output tokens at $10/M.
    expect(logMicrodollarUsageAndReportToBouncer).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: upstreamBody.id,
        model: TYPESAFE_MODEL,
        hasError: true,
        status_code: 200,
        latency: METERED_LATENCY_MS,
        inputTokens: 50,
        outputTokens: 10,
        cost_mUsd: 200,
        market_cost: 124,
      }),
      expect.objectContaining({ requested_model: TYPESAFE_MODEL, is_free: false })
    );
  });

  it('charges a custom-priced free model nothing when the body is unusable', async () => {
    jest.mocked(getCustomPricingConfig).mockResolvedValue(systemOneCustomPricingConfig);
    mockedFetch.mockResolvedValue(
      Response.json({ ...upstreamBody, model: OTHER_SYSTEM_ONE_MODEL, usage: undefined })
    );
    jest.mocked(fetchGeneration).mockResolvedValue({
      data: { id: upstreamBody.id },
    } as OpenRouterGeneration);

    expect(
      (await handleSystemOneRequest(makeRequest({ ...requestBody, model: OTHER_SYSTEM_ONE_MODEL })))
        .status
    ).toBe(502);

    await runAfter();
    expect(logMicrodollarUsageAndReportToBouncer).toHaveBeenCalledWith(
      expect.objectContaining({ cost_mUsd: 0, market_cost: 124, hasError: true }),
      expect.objectContaining({ requested_model: OTHER_SYSTEM_ONE_MODEL, is_free: true })
    );
  });

  it('does not recover deferred accounting errors as parsing failures', async () => {
    const accountingError = new Error('Accounting unavailable');
    jest.mocked(logMicrodollarUsageAndReportToBouncer).mockRejectedValue(accountingError);

    expect((await handleSystemOneRequest(makeRequest())).status).toBe(200);

    await expect(runAfter()).rejects.toBe(accountingError);
    expect(logMicrodollarUsageAndReportToBouncer).toHaveBeenCalledTimes(1);
    expect(captureException).not.toHaveBeenCalled();
    expect(fetchGeneration).not.toHaveBeenCalled();
  });

  it('returns a URL policy refusal without sending or recording', async () => {
    const refusal = NextResponse.json({ error_type: 'upstream_url_rejected' }, { status: 503 });
    jest.mocked(isUpstreamUrlPolicyEnforced).mockReturnValue(true);
    jest.mocked(rejectDisallowedUpstreamUrls).mockResolvedValue(refusal);

    const response = await handleSystemOneRequest(makeRequest());

    expect(response).toBe(refusal);
    expect(mockedFetch).not.toHaveBeenCalled();
    // The only deferred work is `fetchUpstream`'s budget-timer cleanup.
    for (const [callback] of jest.mocked(after).mock.calls) {
      if (typeof callback === 'function') await callback();
    }
    expect(logMicrodollarUsageAndReportToBouncer).not.toHaveBeenCalled();
    expect(emitGatewayApiMetrics).not.toHaveBeenCalled();
  });

  it('answers 499 without sending or recording when the client left before the upstream call', async () => {
    const controller = new AbortController();
    jest.mocked(startBouncerDecide).mockImplementation(async () => {
      controller.abort();
      return null;
    });

    const response = await handleSystemOneRequest(makeRequest(requestBody, {}, controller.signal));

    expect(response.status).toBe(499);
    expect(await response.json()).toMatchObject({ error_type: 'client_disconnect' });
    expect(mockedFetch).not.toHaveBeenCalled();
    expect(deferredUsageCallbacks()).toHaveLength(0);
  });

  it('keeps the upstream call alive and bills the reported cost when the client leaves', async () => {
    const controller = new AbortController();
    mockedFetch.mockImplementation(async (_input, init) => {
      controller.abort();
      expect(init?.signal?.aborted).toBe(false);
      return Response.json(upstreamBody);
    });

    const response = await handleSystemOneRequest(makeRequest(requestBody, {}, controller.signal));

    expect(response.status).toBe(200);
    await runAfter();
    expect(logMicrodollarUsageAndReportToBouncer).toHaveBeenCalledWith(
      expect.objectContaining({ cancelled: true, cost_mUsd: 124, status_code: 200 }),
      expect.objectContaining({ status_code: 200 })
    );
  });

  it('starts one decide and rejects an enforced throttle before upstream', async () => {
    mockVerdict({
      enforced: true,
      code: 'rate_limited',
      retryAfterMs: 500,
      spendWatch: false,
      flags: [],
    });

    const response = await handleSystemOneRequest(makeRequest());

    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('1');
    expect(response.headers.get('retry-after-ms')).toBe('500');
    expect(startBouncerDecide).toHaveBeenCalledTimes(1);
    expect(mockedFetch).not.toHaveBeenCalled();
  });

  it('passes a spend-watched verdict to usage with the decide request id', async () => {
    mockVerdict({ enforced: false, spendWatch: true, flags: [] });

    const response = await handleSystemOneRequest(makeRequest());
    await runAfter();

    expect(response.status).toBe(200);
    const decideParams = await jest.mocked(startBouncerDecide).mock.calls[0]?.[0];
    if (!decideParams) throw new Error('Expected decide params');
    expect(decideParams.account).toMatchObject({
      accountId: `user:${user.id}`,
      userId: user.id,
    });
    expect(logMicrodollarUsageAndReportToBouncer).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        bouncer: expect.objectContaining({ spendWatch: true, requestId: decideParams.requestId }),
      })
    );
  });

  it('gives bouncer the raw IP and the usage row the payer-safe IP, under one request id', async () => {
    const ja4Digest = 'T13D1516H2_8DAAF6152771';
    jest.mocked(extractFraudAndProjectHeaders).mockReturnValue({
      fraudHeaders: { ...EmptyFraudDetectionHeaders, http_x_vercel_ja4_digest: ja4Digest },
      projectId: 'project-123',
      xKiloCodeVersion: null,
      numericKiloCodeVersion: 0,
    });
    mockVerdict({ enforced: false, spendWatch: false, flags: [] });
    const cloudflareIp = '104.16.0.1';
    const headers = { 'x-forwarded-for': cloudflareIp, [FEATURE_HEADER]: 'cloud-agent' };

    const response = await handleSystemOneRequest(makeRequest(requestBody, headers));
    await runAfter();

    expect(response.status).toBe(200);
    expect(startBouncerDecide).toHaveBeenCalledTimes(1);
    const decideParams = await jest.mocked(startBouncerDecide).mock.calls[0]?.[0];
    expect(decideParams).toMatchObject({
      ip: cloudflareIp,
      ja4: ja4Digest.toLowerCase(),
      account: { accountId: `user:${user.id}`, userId: user.id, tier: 'paid' },
    });
    expect(logMicrodollarUsageAndReportToBouncer).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        bouncer: {
          requestId: decideParams?.requestId,
          occurredAt: expect.any(Date),
          accountId: `user:${user.id}`,
          clientIp: undefined,
          clientAttributed: expect.any(Boolean),
          requestedLogprobs: false,
          samples: null,
          promptSimHash: null,
          spendWatch: false,
        },
      })
    );
  });

  it('serves a request when the balance covers its cost bound', async () => {
    jest.mocked(getBalanceAndOrgSettings).mockResolvedValue({ balance: 0.001 });

    const response = await handleSystemOneRequest(makeRequest());

    expect(response.status).toBe(200);
    expect(mockedFetch).toHaveBeenCalledTimes(1);
  });

  it('answers 402 when the balance is below the cost bound', async () => {
    jest.mocked(getBalanceAndOrgSettings).mockResolvedValue({ balance: 0.000001 });

    const response = await handleSystemOneRequest(makeRequest());

    expect(response.status).toBe(402);
    expect(await response.json()).toEqual({
      message: expect.stringContaining('balance'),
      error_type: 'insufficient_credits',
    });
    expect(mockedFetch).not.toHaveBeenCalled();
    expect(startBouncerDecide).not.toHaveBeenCalled();
    expect(deferredUsageCallbacks()).toHaveLength(0);
  });

  it('prices an alias through its target model', async () => {
    jest.mocked(getOpenRouterModelsMetadataFromDatabase).mockResolvedValue({
      ...pricedSystemOneModels,
      [SYSTEM_ONE_ALIAS]: {
        id: SYSTEM_ONE_ALIAS,
        name: 'TypeSafe: Jev Latest',
        alias_target: { slug: TYPESAFE_MODEL },
        endpoints: [],
      },
    });
    jest.mocked(getBalanceAndOrgSettings).mockResolvedValue({ balance: 0.001 });

    const response = await handleSystemOneRequest(
      makeRequest({ ...requestBody, model: SYSTEM_ONE_ALIAS })
    );

    expect(response.status).toBe(200);
    expect(mockedFetch).toHaveBeenCalledTimes(1);
  });

  it('answers 503 for an alias without target pricing', async () => {
    jest.mocked(getOpenRouterModelsMetadataFromDatabase).mockResolvedValue({
      [SYSTEM_ONE_ALIAS]: {
        id: SYSTEM_ONE_ALIAS,
        name: 'TypeSafe: Jev Latest',
        alias_target: { slug: TYPESAFE_MODEL },
        endpoints: [],
      },
    });

    const response = await handleSystemOneRequest(
      makeRequest({ ...requestBody, model: SYSTEM_ONE_ALIAS })
    );

    expect(response.status).toBe(503);
    expect(mockedFetch).not.toHaveBeenCalled();
  });

  it.each([
    ['an oversized state', { ...requestBody, state: 'x'.repeat(SYSTEM_ONE_MAX_STATE_BYTES) }],
    [
      'too many questions',
      {
        ...requestBody,
        questions: Object.fromEntries(
          Array.from({ length: SYSTEM_ONE_MAX_QUESTIONS + 1 }, (_, index) => [
            `q${index}`,
            { type: 'noul' },
          ])
        ),
      },
    ],
  ])('rejects %s', async (_name, body) => {
    const response = await handleSystemOneRequest(makeRequest(body));

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error_type: 'invalid_request' });
    expect(getBalanceAndOrgSettings).not.toHaveBeenCalled();
    expect(mockedFetch).not.toHaveBeenCalled();
    expect(deferredUsageCallbacks()).toHaveLength(0);
  });
  describe('routes', () => {
    function setEnterpriseRegion(dataRegion?: 'eu') {
      setAuth('org-123');
      jest.mocked(getBalanceAndOrgSettings).mockResolvedValue({
        balance: 1_000_000,
        plan: 'enterprise',
        settings: dataRegion ? { data_region: dataRegion } : { disable_openrouter: true },
      });
      jest
        .mocked(getRuntimeOrganizationFeatures)
        .mockResolvedValue({ ...DEFAULT_ORGANIZATION_FEATURES, gateway_settings: ['org-123'] });
    }

    it('passes the member decision provider routes to the route selection', async () => {
      setAuth('org-123');
      const eligibleProviderRoutes = new Set(['typesafe']);
      jest.mocked(resolveOrganizationMemberModelDecision).mockResolvedValue({
        ...memberDecision,
        decision: { allowed: true, eligibleProviderRoutes },
      });

      expect((await handleSystemOneRequest(makeRequest())).status).toBe(200);

      expect(resolveUsageEndpointRoute).toHaveBeenCalledWith({
        requestedModel: TYPESAFE_MODEL,
        modelType: 'evaluation',
        user,
        organizationId: 'org-123',
        allowedProviders: eligibleProviderRoutes,
        openRouterDisabled: false,
      });
    });

    it("sends the request through the owner's OpenRouter key without a balance check", async () => {
      jest.mocked(getBalanceAndOrgSettings).mockResolvedValue({ balance: 0 });
      jest.mocked(resolveUsageEndpointRoute).mockResolvedValue({
        provider: userOpenRouterProvider,
        userByok: [userOpenRouterKey],
      });

      const response = await handleSystemOneRequest(makeRequest());

      expect(response.status).toBe(200);
      expect(creditsBlockedResponse).not.toHaveBeenCalled();
      const upstream = upstreamRequest();
      expect(upstream.headers.get('authorization')).toBe('Bearer test-user-openrouter-key');
      expect(upstream.body.user).toBe('hashed-user');
      expect(generateProviderSpecificHash).toHaveBeenCalledWith(user.id, userOpenRouterProvider);
      await expect(response.json()).resolves.toMatchObject({
        usage: { cost: 0, is_byok: true },
      });
      await runAfter();
      expect(logMicrodollarUsageAndReportToBouncer).toHaveBeenCalledWith(
        expect.objectContaining({ cost_mUsd: 0, market_cost: 124, is_byok: true }),
        expect.objectContaining({ provider: 'openrouter', user_byok: true })
      );
      expect(emitGatewayApiMetrics).toHaveBeenCalledWith(
        expect.objectContaining({ userByok: true, provider: 'openrouter' })
      );
    });

    it("records the upstream inference cost of the owner's OpenRouter key as the market cost", async () => {
      jest.mocked(resolveUsageEndpointRoute).mockResolvedValue({
        provider: userOpenRouterProvider,
        userByok: [userOpenRouterKey],
      });
      mockedFetch.mockImplementation(async () =>
        Response.json({
          ...upstreamBody,
          usage: {
            input_tokens: 23,
            output_tokens: 7,
            cost: 0.0000062,
            is_byok: true,
            cost_details: { upstream_inference_cost: 0.000124 },
          },
        })
      );

      expect((await handleSystemOneRequest(makeRequest())).status).toBe(200);

      await runAfter();
      const [stats] = jest.mocked(logMicrodollarUsageAndReportToBouncer).mock.calls[0];
      expect(stats).toMatchObject({ cost_mUsd: 0, is_byok: true });
      expect(stats.market_cost).toBeGreaterThanOrEqual(124);
    });

    it("passes the owner's provider key through Kilo's Vercel account, exempt from the region", async () => {
      setEnterpriseRegion('eu');
      jest.mocked(resolveUsageEndpointRoute).mockResolvedValue({
        provider: kiloVercelProvider,
        userByok: [userAnthropicKey],
      });
      mockedFetch.mockImplementation(async () => Response.json(vercelUpstreamBody));

      const response = await handleSystemOneRequest(
        makeRequest({ ...requestBody, provider: { zdr: true, data_collection: 'deny' } })
      );

      expect(response.status).toBe(200);
      const upstream = upstreamRequest(VERCEL_TYPESAFE_URL);
      expect(upstream.headers.get('authorization')).toBe('Bearer test-platform-vercel-key');
      expect(upstream.body).toEqual({
        ...JSON.parse(JSON.stringify(requestBody)),
        model: VERCEL_SYSTEM_ONE_MODEL,
        providerOptions: {
          gateway: {
            only: ['anthropic'],
            byok: { anthropic: [{ apiKey: 'test-user-anthropic-key' }] },
            zeroDataRetention: true,
            disallowPromptTraining: true,
          },
        },
      });
      expect(upstream.body.providerOptions.gateway).not.toHaveProperty('inferenceRegion');
      expect(generateProviderSpecificHash).not.toHaveBeenCalled();
      await runAfter();
      expect(logMicrodollarUsageAndReportToBouncer).toHaveBeenCalledWith(
        expect.objectContaining({ cost_mUsd: 0, is_byok: true }),
        expect.objectContaining({ provider: 'vercel', user_byok: true, inference_region: null })
      );
    });

    it("runs on Kilo's Vercel account in the organization's region when OpenRouter is refused", async () => {
      setEnterpriseRegion('eu');
      jest
        .mocked(resolveUsageEndpointRoute)
        .mockResolvedValue({ provider: kiloVercelProvider, userByok: null });
      mockedFetch.mockImplementation(async () => Response.json(vercelUpstreamBody));

      const response = await handleSystemOneRequest(makeRequest());

      expect(response.status).toBe(200);
      expect(resolveUsageEndpointRoute).toHaveBeenCalledWith(
        expect.objectContaining({ openRouterDisabled: true })
      );
      const upstream = upstreamRequest(VERCEL_TYPESAFE_URL);
      expect(upstream.body).toEqual({
        ...JSON.parse(JSON.stringify(requestBody)),
        model: VERCEL_SYSTEM_ONE_MODEL,
        providerOptions: {
          gateway: { inferenceRegion: { scope: 'zone', geoRegion: 'eu' } },
        },
      });
      await runAfter();
      expect(logMicrodollarUsageAndReportToBouncer).toHaveBeenCalledWith(
        expect.objectContaining({ cost_mUsd: 200, is_byok: false }),
        expect.objectContaining({
          provider: 'vercel',
          user_byok: false,
          inference_region: 'eu',
        })
      );
    });

    it("omits the region from Kilo's Vercel route without one", async () => {
      setEnterpriseRegion();
      jest
        .mocked(resolveUsageEndpointRoute)
        .mockResolvedValue({ provider: kiloVercelProvider, userByok: null });
      mockedFetch.mockImplementation(async () => Response.json(vercelUpstreamBody));

      expect((await handleSystemOneRequest(makeRequest())).status).toBe(200);

      expect(upstreamRequest(VERCEL_TYPESAFE_URL).body.providerOptions.gateway).not.toHaveProperty(
        'inferenceRegion'
      );
    });

    it('forwards the effective provider restrictions to the Vercel gateway options', async () => {
      setAuth('org-123');
      jest.mocked(resolveOrganizationMemberModelDecision).mockResolvedValue({
        ...memberDecision,
        decision: { allowed: true, eligibleProviderRoutes: new Set(['typesafe']) },
      });
      jest
        .mocked(resolveUsageEndpointRoute)
        .mockResolvedValue({ provider: kiloVercelProvider, userByok: null });
      mockedFetch.mockImplementation(async () => Response.json(vercelUpstreamBody));

      const response = await handleSystemOneRequest(
        makeRequest({ ...requestBody, provider: { zdr: true } })
      );

      expect(response.status).toBe(200);
      const { gateway } = upstreamRequest(VERCEL_TYPESAFE_URL).body.providerOptions;
      expect(gateway.zeroDataRetention).toBe(true);
      expect(gateway.only).toEqual(['typesafe-ai']);
    });

    it.each([
      { label: "Kilo's Vercel account", userByok: null },
      { label: "the owner's Vercel AI Gateway key", userByok: [userVercelGatewayKey] },
    ])(
      'rejects a provider allow-list that names no Vercel provider of the model on $label',
      async ({ userByok }) => {
        setAuth('org-123');
        jest.mocked(resolveOrganizationMemberModelDecision).mockResolvedValue({
          ...memberDecision,
          decision: { allowed: true, eligibleProviderRoutes: new Set(['openai']) },
        });
        jest
          .mocked(getCachedVercelInferenceProviderIdsForModel)
          .mockResolvedValue(['typesafe-ai', 'digitalocean']);
        jest
          .mocked(resolveUsageEndpointRoute)
          .mockResolvedValue({ provider: kiloVercelProvider, userByok });

        const response = await handleSystemOneRequest(makeRequest());

        expect(response.status).toBe(403);
        await expect(response.json()).resolves.toMatchObject({
          error:
            'No eligible provider can serve the selected model. Please enable provider: typesafe, digitalocean',
          error_type: 'provider_not_allowed',
        });
        expect(getCachedVercelInferenceProviderIdsForModel).toHaveBeenCalledWith(
          VERCEL_SYSTEM_ONE_MODEL
        );
        expect(mockedFetch).not.toHaveBeenCalled();
        expect(startBouncerDecide).not.toHaveBeenCalled();
        expect(after).not.toHaveBeenCalled();
        expect(logMicrodollarUsageAndReportToBouncer).not.toHaveBeenCalled();
      }
    );

    it.each([
      { label: 'OpenRouter', provider: OPENROUTER },
      { label: "Kilo's Vercel AI Gateway", provider: kiloVercelProvider },
    ])('rejects client providerOptions on the $label route', async ({ provider }) => {
      jest.mocked(resolveUsageEndpointRoute).mockResolvedValue({ provider, userByok: null });

      const response = await handleSystemOneRequest(
        makeRequest({ ...requestBody, providerOptions: { gateway: { only: ['typesafe-ai'] } } })
      );

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        error: 'The providerOptions field is not supported. Use provider instead.',
        error_type: 'unsupported_field',
      });
      expect(mockedFetch).not.toHaveBeenCalled();
      expect(logMicrodollarUsageAndReportToBouncer).not.toHaveBeenCalled();
    });

    it('normalizes a Vercel response to the OpenRouter-compatible shape and bills its cost', async () => {
      jest
        .mocked(resolveUsageEndpointRoute)
        .mockResolvedValue({ provider: kiloVercelProvider, userByok: null });
      mockedFetch.mockImplementation(async () => Response.json(vercelUpstreamBody));

      const response = await handleSystemOneRequest(makeRequest());

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toEqual({
        id: 'gen_vercel_systemone',
        model: TYPESAFE_MODEL,
        provider: 'typesafe-ai',
        answers: upstreamBody.answers,
        usage: { input_tokens: 23, output_tokens: 7, cost: 0.0002, is_byok: false },
      });
      await runAfter();
      expect(logMicrodollarUsageAndReportToBouncer).toHaveBeenCalledWith(
        expect.objectContaining({
          messageId: 'gen_vercel_systemone',
          model: VERCEL_SYSTEM_ONE_MODEL,
          inference_provider: 'typesafe-ai',
          cost_mUsd: 200,
          market_cost: 200,
          inputTokens: 23,
          outputTokens: 7,
          hasError: false,
        }),
        expect.objectContaining({ provider: 'vercel' })
      );
    });

    it('reconciles a Vercel response without a usable cost through the Vercel generation', async () => {
      mockMeteredClock();
      jest
        .mocked(resolveUsageEndpointRoute)
        .mockResolvedValue({ provider: kiloVercelProvider, userByok: null });
      const { cost: _cost, ...gateway } = vercelUpstreamBody.provider_metadata.gateway;
      mockedFetch.mockImplementation(async () =>
        Response.json({ ...vercelUpstreamBody, provider_metadata: { gateway } })
      );
      jest.mocked(fetchGeneration).mockResolvedValue({
        data: { id: 'gen_vercel_systemone' },
      } as OpenRouterGeneration);

      expect((await handleSystemOneRequest(makeRequest())).status).toBe(502);

      await runAfter();
      expect(fetchGeneration).toHaveBeenCalledWith('gen_vercel_systemone', kiloVercelProvider);
      expect(mapToUsageStats).toHaveBeenCalledWith(expect.anything(), '', user.id, 'vercel');
    });

    it('refuses the OpenRouter route when an inference region is set', async () => {
      setEnterpriseRegion('eu');

      const response = await handleSystemOneRequest(makeRequest());

      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toMatchObject({ error_type: 'provider_not_allowed' });
      expect(mockedFetch).not.toHaveBeenCalled();
      expect(deferredUsageCallbacks()).toHaveLength(0);
    });

    it("passes the owner's upstream balance error through instead of reporting Kilo's balance", async () => {
      jest.mocked(resolveUsageEndpointRoute).mockResolvedValue({
        provider: userOpenRouterProvider,
        userByok: [userOpenRouterKey],
      });
      const safeResponse = NextResponse.json({ error: 'no credits' }, { status: 402 });
      mockedFetch.mockResolvedValue(Response.json({ error: 'no credits' }, { status: 402 }));
      jest.mocked(wrapInSafeNextResponse).mockReturnValue(safeResponse);

      const response = await handleSystemOneRequest(makeRequest());

      expect(response.status).toBe(402);
      expect(errorExceptInTest).not.toHaveBeenCalled();
    });
  });
});
