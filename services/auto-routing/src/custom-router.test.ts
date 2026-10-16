import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AUTO_ROUTING_DENIED_MODELS_PATH,
  CUSTOM_ROUTER_DECIDE_PATH,
  CUSTOM_ROUTER_EVAL_PLAN_PATH,
  CUSTOM_ROUTER_EVAL_RESULT_PATH,
  CUSTOM_ROUTER_TABLE_PATH,
  CustomRouterDecideResponseSchema,
  verifyAutoDecision,
  type CustomRouterDefinition,
  type CustomRouterEntry,
  type MirrorPayload,
  type RoutingTable,
} from '@kilocode/auto-routing-contracts';
import type * as DbModule from '@kilocode/db';
import { signKiloToken, clearSecretCacheForTest } from '@kilocode/worker-utils';
import type * as AccountAccessModule from '@kilocode/worker-utils/account-access';
import type { OrganizationMemberBalanceRow } from '@kilocode/worker-utils/account-access';
import type { UsageRecordRequest } from '@kilocode/usage-contracts';
import type * as ClassifierConfigModule from './classifier-config';
import type * as CustomRouterStoreModule from './custom-router-store';
import type * as ModelCapabilitiesModule from './model-capabilities';
import type * as ModelClassifierModule from './model-classifier';
import { clearCustomRouterTableCache } from './custom-router-decision';
import { clearClassificationHotCache } from './decision-cache';
import { clearOrganizationPolicyCache } from './organization-policy';
import { app } from './index';

const findCustomRouter = vi.hoisted(() => vi.fn());
const findCustomRouterById = vi.hoisted(() => vi.fn());
const classifyNormalizedInput = vi.hoisted(() => vi.fn());
const findOrganizationMemberRole = vi.hoisted(() => vi.fn());
const findOrganizationMemberBalanceRow = vi.hoisted(() => vi.fn());
const dbRows = vi.hoisted(() => ({
  user: [] as unknown[],
  organization: [] as unknown[],
}));

vi.mock('./custom-router-store', async importOriginal => ({
  ...(await importOriginal<typeof CustomRouterStoreModule>()),
  findCustomRouter,
  findCustomRouterById,
}));

vi.mock('./model-classifier', async importOriginal => ({
  ...(await importOriginal<typeof ModelClassifierModule>()),
  classifyNormalizedInput,
}));

vi.mock('./model-capabilities', async importOriginal => ({
  ...(await importOriginal<typeof ModelCapabilitiesModule>()),
  getModelCapabilities: async () =>
    new Map([
      [
        'anthropic/claude-sonnet-4.6',
        { inputModalities: new Set(['text', 'image']), contextLength: 200_000, isActive: true },
      ],
    ]),
}));

vi.mock('./classifier-config', async importOriginal => ({
  ...(await importOriginal<typeof ClassifierConfigModule>()),
  getClassifierModel: async () => 'test/classifier',
  getDecisionLogSampleRate: async () => 0,
  getShadowRoutingTable: async () => null,
}));

vi.mock('@kilocode/worker-utils/account-access', async importOriginal => ({
  ...(await importOriginal<typeof AccountAccessModule>()),
  findOrganizationMemberRole,
  findOrganizationMemberBalanceRow,
}));

vi.mock('@kilocode/db', async importOriginal => {
  const actual = await importOriginal<typeof DbModule>();
  return {
    ...actual,
    getWorkerDb: () => ({
      select: () => ({
        from: (table: unknown) => ({
          where: () => ({
            limit: async () =>
              table === actual.kilocode_users ? dbRows.user : dbRows.organization,
          }),
        }),
      }),
    }),
  };
});

const NEXTAUTH_SECRET = 'test-nextauth-secret';
const DECISION_SECRET = 'test-decision-secret';
const USER_ID = 'user-1';
const ORG_ID = '22222222-2222-4222-8222-222222222222';
const ROUTER_ID = '11111111-1111-4111-8111-111111111111';
const SONNET = 'anthropic/claude-sonnet-4.6';

const sonnet: CustomRouterEntry = { kind: 'gateway', model: SONNET };
const ollama: CustomRouterEntry = {
  kind: 'client',
  provider: 'ollama',
  model: 'qwen3:32b',
  variants: [],
  capabilities: {
    contextLength: 32_000,
    inputModalities: ['text'],
    toolCall: true,
    reasoning: false,
  },
  pricing: null,
};
const lmstudio: CustomRouterEntry = {
  kind: 'client',
  provider: 'lmstudio',
  model: 'gemma',
  variants: ['fast', 'slow'],
  capabilities: { contextLength: null, inputModalities: ['text'], toolCall: true, reasoning: true },
  pricing: { inputPerMTokUsd: 0.1, outputPerMTokUsd: 0.2 },
};

function customRouter(overrides: Partial<CustomRouterDefinition> = {}): CustomRouterDefinition {
  return {
    id: ROUTER_ID,
    ownerType: 'user',
    ownerId: USER_ID,
    slug: 'mine',
    name: 'Mine',
    baseRouter: 'efficient',
    mode: 'cost_per_accuracy',
    entries: [sonnet, ollama, lmstudio],
    defaultEntryKey: `gateway:${SONNET}`,
    ...overrides,
  };
}

const ROUTE = 'implementation/feature_development';

function table(routes: RoutingTable['routes']): RoutingTable {
  return {
    version: 'custom-table-1',
    generatedAt: '2026-10-16T00:00:00.000Z',
    minAccuracy: 0.7,
    switchCostFactor: 3,
    bestAccuracySwitchThreshold: 0.05,
    source: 'benchmark',
    routes,
  };
}

// Ranked as the benchmark publishes it; the first candidate sits outside the pool.
const rankedTable = table({
  [ROUTE]: [
    { model: 'openai/gpt-5', accuracy: 0.99, avgCostUsd: 0, meetsThreshold: true, variant: null },
    {
      model: 'client:ollama/qwen3:32b',
      accuracy: 0.9,
      avgCostUsd: 0,
      meetsThreshold: true,
      variant: null,
      stale: true,
    },
    { model: SONNET, accuracy: 0.85, avgCostUsd: 0.01, meetsThreshold: true, variant: null },
  ],
});

const classification = {
  taskType: 'implementation',
  subtaskType: 'feature_development',
  contextComplexity: 'medium',
  reasoningComplexity: 'medium',
  riskLevel: 'low',
  executionMode: 'code_change',
  requiresTools: true,
  confidence: 0.9,
};

const benchmarkFetch = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();
const recordUsage = vi.fn(async (_usage: UsageRecordRequest) => {});
const cacheIdFromName = vi.fn((name: string) => name);
let customTable: RoutingTable | null = rankedTable;

const env = {
  INTERNAL_API_SECRET_PROD: { get: async () => 'internal-secret' },
  NEXTAUTH_SECRET: { get: async () => NEXTAUTH_SECRET },
  AUTO_ROUTING_DECISION_SECRET: { get: async () => DECISION_SECRET },
  KILO_WEB_API_BASE_URL: 'https://web.example.test',
  KILO_AI_GATEWAY_BASE_URL: 'https://gateway.example.test',
  UPSTASH_REDIS_REST_URL: { get: async () => 'https://redis.example.test' },
  UPSTASH_REDIS_REST_TOKEN: { get: async () => 'redis-read-token' },
  HYPERDRIVE: { connectionString: 'postgres://worker' },
  AUTO_ROUTING_CONFIG: { get: async () => null, put: async () => {}, delete: async () => {} },
  BENCHMARK_SERVICE: { fetch: benchmarkFetch },
  AUTO_ROUTING_CLASSIFIER_METRICS_V2: { writeDataPoint: () => {} },
  AUTO_ROUTING_DECISION_CACHE: {
    idFromName: cacheIdFromName,
    get: () => ({
      readConversationState: async () => ({ classification: null, sticky: null }),
      recordClassifierUsage: recordUsage,
      putEntry: async () => {},
      putStickyDecision: async () => {},
    }),
  },
};

const backgroundTasks: Promise<unknown>[] = [];
const executionCtx = {
  waitUntil: (promise: Promise<unknown>) => {
    backgroundTasks.push(promise);
  },
  passThroughOnException: () => {},
} as unknown as ExecutionContext;

async function drainBackgroundTasks() {
  while (backgroundTasks.length > 0) await Promise.all(backgroundTasks.splice(0));
}

async function userToken(extra: { organizationId?: string } = {}, pepper = 'pepper-1') {
  const { token } = await signKiloToken({
    userId: USER_ID,
    pepper,
    secret: NEXTAUTH_SECRET,
    expiresInSeconds: 3600,
    extra,
  });
  return token;
}

async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return app.request(
    `https://auto-routing.example.com${path}`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${await userToken()}`,
        'content-type': 'application/json',
        ...headers,
      },
      body: JSON.stringify(body),
    },
    env,
    executionCtx
  );
}

function decideBody(overrides: Record<string, unknown> = {}) {
  return {
    model: 'kilo-auto/custom/mine',
    messages: [{ role: 'user', content: 'Add a feature flag to the settings page.' }],
    sessionId: 'session-1',
    clientEntries: [{ provider: 'ollama', model: 'qwen3:32b' }],
    ...overrides,
  };
}

function memberBalanceRow(overrides: Partial<OrganizationMemberBalanceRow> = {}) {
  return {
    microdollar_limit: null,
    microdollar_usage: null,
    total_microdollars_acquired: 10_000_000,
    microdollars_used: 0,
    settings: {},
    require_seats: false,
    plan: 'teams',
    auto_top_up_enabled: false,
    next_credit_expiration_at: null,
    created_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  } satisfies OrganizationMemberBalanceRow;
}

async function decisionOf(res: Response) {
  expect(res.status).toBe(200);
  return CustomRouterDecideResponseSchema.parse(await res.json());
}

async function errorCode(res: Response) {
  const body = (await res.json()) as { error: { code: string } };
  return body.error.code;
}

const fetchMock = vi.fn<typeof fetch>();
let gatewayDeniedModelIds: string[] | 'unavailable' = [];
let blacklistedDomainsConfig: string | null = null;
let redisAvailable = true;

function blacklistConfig(domains: string[]) {
  return JSON.stringify({ domains, updated_at: null, updated_by: null, updated_by_email: null });
}

function gatewayCalls() {
  return fetchMock.mock.calls.filter(([input]) =>
    requestUrl(input).startsWith(`https://gateway.example.test${AUTO_ROUTING_DENIED_MODELS_PATH}`)
  );
}

function requestUrl(input: RequestInfo | URL): string {
  return input instanceof Request ? input.url : input.toString();
}

beforeEach(() => {
  clearSecretCacheForTest();
  clearCustomRouterTableCache();
  clearClassificationHotCache();
  clearOrganizationPolicyCache();
  backgroundTasks.length = 0;
  customTable = rankedTable;
  gatewayDeniedModelIds = [];
  blacklistedDomainsConfig = null;
  redisAvailable = true;
  fetchMock.mockReset().mockImplementation(async input => {
    const url = requestUrl(input);
    if (url.startsWith('https://gateway.example.test')) {
      return gatewayDeniedModelIds === 'unavailable'
        ? new Response('down', { status: 503 })
        : Response.json({ deniedModelIds: gatewayDeniedModelIds });
    }
    if (url.startsWith('https://redis.example.test/get/')) {
      return redisAvailable
        ? Response.json({ result: blacklistedDomainsConfig })
        : new Response('unavailable', { status: 503 });
    }
    return new Response('unexpected', { status: 500 });
  });
  vi.stubGlobal('fetch', fetchMock);
  dbRows.user = [
    {
      api_token_pepper: 'pepper-1',
      blocked_reason: null,
      google_user_email: 'dev@example.com',
      total_microdollars_acquired: 5_000_000,
      microdollars_used: 1_000_000,
    },
  ];
  dbRows.organization = [{ total_microdollars_acquired: 3_000_000, microdollars_used: 0 }];
  findCustomRouter.mockReset().mockResolvedValue(customRouter());
  findCustomRouterById.mockReset().mockResolvedValue(customRouter());
  findOrganizationMemberRole.mockReset().mockResolvedValue('member');
  findOrganizationMemberBalanceRow.mockReset().mockResolvedValue(memberBalanceRow());
  classifyNormalizedInput.mockReset().mockResolvedValue({
    cost: 0.000002,
    classifierModel: 'test/classifier',
    classification,
  });
  recordUsage.mockClear();
  cacheIdFromName.mockClear();
  benchmarkFetch.mockReset().mockImplementation(async url => {
    if (new URL(url).pathname === CUSTOM_ROUTER_TABLE_PATH) {
      return Response.json({ table: customTable });
    }
    return Response.json({ error: 'unexpected path' }, { status: 500 });
  });
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(async () => {
  await drainBackgroundTasks();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('public custom router decide', () => {
  it('picks a servable client entry, flags its stale measurement, and signs the decision', async () => {
    const { decision, decisionId } = await decisionOf(
      await post(CUSTOM_ROUTER_DECIDE_PATH, decideBody())
    );

    expect(decision).toMatchObject({
      entry: { kind: 'client', provider: 'ollama', model: 'qwen3:32b' },
      model: 'client:ollama/qwen3:32b',
      variant: null,
      stale: true,
      fallback: false,
      taskType: 'implementation',
      tableVersion: 'custom-table-1',
    });
    const verified = await verifyAutoDecision(decisionId, DECISION_SECRET, Date.now());
    expect(verified).toEqual({
      ok: true,
      payload: expect.objectContaining({
        userId: USER_ID,
        organizationId: null,
        routerModelId: 'kilo-auto/custom/mine',
        model: 'client:ollama/qwen3:32b',
        variant: null,
      }),
    });
    expect((await verifyAutoDecision(decisionId, 'other-secret', Date.now())).ok).toBe(false);
  });

  it('drops client entries the CLI did not list', async () => {
    const { decision } = await decisionOf(
      await post(CUSTOM_ROUTER_DECIDE_PATH, decideBody({ clientEntries: [] }))
    );
    expect(decision).toMatchObject({ model: SONNET, stale: false, fallback: false });
  });

  it('never routes to a ranked candidate outside the pool', async () => {
    customTable = table({
      [ROUTE]: [
        {
          model: 'openai/gpt-5',
          accuracy: 0.99,
          avgCostUsd: 0,
          meetsThreshold: true,
          variant: null,
        },
      ],
    });
    const { decision } = await decisionOf(await post(CUSTOM_ROUTER_DECIDE_PATH, decideBody()));
    expect(decision).toMatchObject({ model: SONNET, fallback: true });
  });

  it('falls back to the default entry when the classifier fails', async () => {
    classifyNormalizedInput.mockRejectedValue(new Error('classifier down'));
    const { decision } = await decisionOf(await post(CUSTOM_ROUTER_DECIDE_PATH, decideBody()));
    expect(decision).toEqual({
      entry: { kind: 'gateway', model: SONNET },
      model: SONNET,
      variant: null,
      stale: false,
      fallback: true,
      sticky: false,
      taskType: null,
      subtaskType: null,
      tableVersion: 'custom-table-1',
    });
  });

  it('drops gateway entries the organization policy denies the member', async () => {
    gatewayDeniedModelIds = [SONNET];
    const { decision } = await decisionOf(
      await post(
        CUSTOM_ROUTER_DECIDE_PATH,
        decideBody({ clientEntries: [{ provider: 'lmstudio', model: 'gemma' }] }),
        { 'X-KiloCode-OrganizationId': ORG_ID }
      )
    );
    expect(decision).toMatchObject({ model: 'client:lmstudio/gemma', fallback: true });
  });

  it('asks the gateway for the policy on the router gateway entries with the internal secret', async () => {
    await decisionOf(
      await post(CUSTOM_ROUTER_DECIDE_PATH, decideBody(), { 'X-KiloCode-OrganizationId': ORG_ID })
    );
    const [call, ...rest] = gatewayCalls();
    expect(rest).toHaveLength(0);
    expect(new Headers(call?.[1]?.headers).get('authorization')).toBe('Bearer internal-secret');
    expect(JSON.parse(call?.[1]?.body as string)).toEqual({
      userId: USER_ID,
      organizationId: ORG_ID,
      modelIds: [SONNET],
    });
  });

  it('skips the organization policy for a personal context', async () => {
    await decisionOf(await post(CUSTOM_ROUTER_DECIDE_PATH, decideBody()));
    expect(gatewayCalls()).toHaveLength(0);
  });

  it('denies every gateway entry when the organization policy cannot be read', async () => {
    gatewayDeniedModelIds = 'unavailable';
    classifyNormalizedInput.mockRejectedValue(new Error('classifier down'));
    const { decision } = await decisionOf(
      await post(
        CUSTOM_ROUTER_DECIDE_PATH,
        decideBody({ clientEntries: [{ provider: 'lmstudio', model: 'gemma' }] }),
        { 'X-KiloCode-OrganizationId': ORG_ID }
      )
    );
    expect(decision).toMatchObject({
      entry: { kind: 'client', provider: 'lmstudio', model: 'gemma' },
      variant: 'fast',
      fallback: true,
    });
  });

  it('refuses a user in a blocked email domain', async () => {
    blacklistedDomainsConfig = blacklistConfig(['example.com']);
    const decide = await post(CUSTOM_ROUTER_DECIDE_PATH, decideBody());
    expect(decide.status).toBe(403);
    expect(await errorCode(decide)).toBe('forbidden');
    const plan = await post(CUSTOM_ROUTER_EVAL_PLAN_PATH, { routerId: ROUTER_ID });
    expect(plan.status).toBe(403);
    expect(classifyNormalizedInput).not.toHaveBeenCalled();
    expect(benchmarkFetch).not.toHaveBeenCalled();
  });

  it('fails closed with a retryable error before the blocked-domain list has ever loaded', async () => {
    redisAvailable = false;
    const res = await post(CUSTOM_ROUTER_DECIDE_PATH, decideBody());
    expect(res.status).toBe(500);
    expect(await errorCode(res)).toBe('internal_error');
    expect(classifyNormalizedInput).not.toHaveBeenCalled();
  });

  it('keeps enforcing the last loaded blocked-domain list when Redis later fails', async () => {
    blacklistedDomainsConfig = blacklistConfig(['example.com']);
    expect((await post(CUSTOM_ROUTER_DECIDE_PATH, decideBody())).status).toBe(403);
    redisAvailable = false;
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 61_000);
    const res = await post(CUSTOM_ROUTER_DECIDE_PATH, decideBody());
    expect(res.status).toBe(403);
    expect(
      fetchMock.mock.calls.filter(([input]) => requestUrl(input).includes('redis'))
    ).toHaveLength(2);
  });

  it('fails with custom_router_unavailable when no entry is servable', async () => {
    findCustomRouter.mockResolvedValue(
      customRouter({ entries: [ollama], defaultEntryKey: 'client:ollama/qwen3:32b' })
    );
    const res = await post(CUSTOM_ROUTER_DECIDE_PATH, decideBody({ clientEntries: [] }));
    expect(res.status).toBe(422);
    expect(await errorCode(res)).toBe('custom_router_unavailable');
  });

  it('resolves a personal router for the authenticated user', async () => {
    await decisionOf(await post(CUSTOM_ROUTER_DECIDE_PATH, decideBody()));
    expect(findCustomRouter).toHaveBeenCalledWith(env, { type: 'user', id: USER_ID }, 'mine');
  });

  it('resolves an organization router only in that organization context', async () => {
    const withoutContext = await post(
      CUSTOM_ROUTER_DECIDE_PATH,
      decideBody({ model: 'kilo-auto/custom/org/team' })
    );
    expect(withoutContext.status).toBe(404);
    expect(await errorCode(withoutContext)).toBe('router_not_found');
    expect(findCustomRouter).not.toHaveBeenCalled();

    const { decisionId } = await decisionOf(
      await post(CUSTOM_ROUTER_DECIDE_PATH, decideBody({ model: 'kilo-auto/custom/org/team' }), {
        'X-KiloCode-OrganizationId': ORG_ID,
      })
    );
    expect(findCustomRouter).toHaveBeenCalledWith(env, { type: 'org', id: ORG_ID }, 'team');
    expect(findOrganizationMemberRole).toHaveBeenCalledWith(expect.anything(), ORG_ID, USER_ID);
    const verified = await verifyAutoDecision(decisionId, DECISION_SECRET, Date.now());
    expect(verified.ok && verified.payload.organizationId).toBe(ORG_ID);
  });

  it('prefers the signed organization claim over the header', async () => {
    const otherOrg = '33333333-3333-4333-8333-333333333333';
    const res = await post(
      CUSTOM_ROUTER_DECIDE_PATH,
      decideBody({ model: 'kilo-auto/custom/org/team' }),
      {
        authorization: `Bearer ${await userToken({ organizationId: otherOrg })}`,
        'X-KiloCode-OrganizationId': ORG_ID,
      }
    );
    expect(res.status).toBe(200);
    expect(findCustomRouter).toHaveBeenCalledWith(env, { type: 'org', id: otherOrg }, 'team');
  });

  it('denies an organization context the user is not a member of', async () => {
    findOrganizationMemberRole.mockResolvedValue(null);
    const res = await post(CUSTOM_ROUTER_DECIDE_PATH, decideBody(), {
      'X-KiloCode-OrganizationId': ORG_ID,
    });
    expect(res.status).toBe(403);
    expect(await errorCode(res)).toBe('forbidden');
    expect(classifyNormalizedInput).not.toHaveBeenCalled();
  });

  it('rejects a token whose pepper was rotated', async () => {
    const res = await post(CUSTOM_ROUTER_DECIDE_PATH, decideBody(), {
      authorization: `Bearer ${await userToken({}, 'old-pepper')}`,
    });
    expect(res.status).toBe(401);
    expect(await errorCode(res)).toBe('unauthorized');
  });

  it('rejects an empty personal balance before classifying', async () => {
    dbRows.user = [
      {
        api_token_pepper: 'pepper-1',
        blocked_reason: null,
        google_user_email: 'dev@example.com',
        total_microdollars_acquired: 1_000_000,
        microdollars_used: 1_000_000,
      },
    ];
    const res = await post(CUSTOM_ROUTER_DECIDE_PATH, decideBody());
    expect(res.status).toBe(402);
    expect(await errorCode(res)).toBe('insufficient_balance');
    expect(classifyNormalizedInput).not.toHaveBeenCalled();
  });

  it('charges an organization context to the member allowance', async () => {
    findOrganizationMemberBalanceRow.mockResolvedValue(
      memberBalanceRow({ microdollar_limit: 1_000_000, microdollar_usage: 1_000_000 })
    );
    const res = await post(CUSTOM_ROUTER_DECIDE_PATH, decideBody(), {
      'X-KiloCode-OrganizationId': ORG_ID,
    });
    expect(res.status).toBe(402);
    expect(await errorCode(res)).toBe('insufficient_balance');
  });

  it('bills classification under the custom router model ID and scope', async () => {
    await decisionOf(await post(CUSTOM_ROUTER_DECIDE_PATH, decideBody()));
    await drainBackgroundTasks();
    expect(recordUsage).toHaveBeenCalledTimes(1);
    const usage = recordUsage.mock.calls[0]?.[0];
    expect(usage?.core.requested_model).toBe('kilo-auto/custom/mine');
    expect(usage?.core.kilo_user_id).toBe(USER_ID);
    expect(cacheIdFromName).toHaveBeenCalledWith(expect.stringMatching(`^custom:${ROUTER_ID}:`));
  });
});

describe('internal custom router decide', () => {
  function internalDecide(payload: Partial<MirrorPayload>) {
    return app.request(
      'https://auto-routing.example.com/decide',
      {
        method: 'POST',
        headers: { authorization: 'Bearer internal-secret', 'content-type': 'application/json' },
        body: JSON.stringify({
          input: {
            apiKind: 'chat_completions',
            requestedModel: 'kilo-auto/custom/mine',
            systemPromptPrefix: '',
            userPromptPrefix: 'Add a feature flag.',
            latestUserPromptPrefix: null,
            messageCount: 1,
            hasTools: false,
            stream: true,
            providerHints: { provider: null, providerOptions: null },
          },
          userId: USER_ID,
          organizationId: null,
          sessionId: 'session-1',
          machineId: null,
          clientRequestId: null,
          mode: null,
          userAgent: null,
          bodyBytes: 100,
          ...payload,
        }),
      },
      env,
      executionCtx
    );
  }

  it('considers gateway entries only and returns the entry fields', async () => {
    const res = await internalDecide({ customRouter: { scope: 'user', slug: 'mine' } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { decision: Record<string, unknown> };
    expect(body.decision).toMatchObject({
      model: SONNET,
      entry: { kind: 'gateway', model: SONNET },
      stale: false,
      fallback: false,
    });
  });

  it('returns router_not_found for an organization router without an organization', async () => {
    const res = await internalDecide({ customRouter: { scope: 'org', slug: 'team' } });
    expect(res.status).toBe(404);
    expect(findCustomRouter).not.toHaveBeenCalled();
  });

  it('still rejects callers without the internal secret', async () => {
    const res = await app.request(
      'https://auto-routing.example.com/decide',
      { method: 'POST', body: '{}' },
      env,
      executionCtx
    );
    expect(res.status).toBe(401);
  });
});

describe('client eval proxy', () => {
  function forwarded(path: string) {
    const call = benchmarkFetch.mock.calls.find(([url]) => new URL(url).pathname === path);
    return call ? (JSON.parse(call[1]?.body as string) as Record<string, unknown>) : null;
  }

  it('forwards a plan with the router context and passes the benchmark answer through', async () => {
    benchmarkFetch.mockResolvedValueOnce(
      Response.json({ error: { code: 'internal_error', message: 'boom' } }, { status: 500 })
    );
    const res = await post(CUSTOM_ROUTER_EVAL_PLAN_PATH, { routerId: ROUTER_ID });
    expect(res.status).toBe(500);
    expect(await errorCode(res)).toBe('internal_error');
    expect(forwarded(CUSTOM_ROUTER_EVAL_PLAN_PATH)).toEqual({
      routerId: ROUTER_ID,
      ownerType: 'user',
      ownerId: USER_ID,
      baseRouter: 'efficient',
      entries: [sonnet, ollama, lmstudio],
      clientEvalEntryKeys: ['client:ollama/qwen3:32b', 'client:lmstudio/gemma'],
    });
    const [url, init] = benchmarkFetch.mock.calls[0] ?? [];
    expect(new URL(String(url)).pathname).toBe(CUSTOM_ROUTER_EVAL_PLAN_PATH);
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer internal-secret');
  });

  it('bills an organization router upload to the organization', async () => {
    findCustomRouterById.mockResolvedValue(
      customRouter({ ownerType: 'org', ownerId: ORG_ID, slug: 'team' })
    );
    findOrganizationMemberRole.mockResolvedValue('billing_manager');
    benchmarkFetch.mockResolvedValueOnce(Response.json({ score: 1 }));
    const upload = {
      routerId: ROUTER_ID,
      engineIdentity: 'router:v3:abc',
      entry: { kind: 'client', provider: 'ollama', model: 'qwen3:32b' },
      variant: null,
      caseId: 'case-1',
      rep: 0,
      output: 'done',
      costUsd: 0,
      durationMs: 1200,
      exitCode: 0,
      timedOut: false,
    };
    const res = await post(CUSTOM_ROUTER_EVAL_RESULT_PATH, upload, {
      'X-KiloCode-OrganizationId': ORG_ID,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ score: 1 });
    expect(forwarded(CUSTOM_ROUTER_EVAL_RESULT_PATH)).toMatchObject({
      ...upload,
      ownerType: 'org',
      ownerId: ORG_ID,
      billing: { userId: USER_ID, organizationId: ORG_ID },
    });
  });

  it('refuses organization members who cannot edit the router', async () => {
    findCustomRouterById.mockResolvedValue(customRouter({ ownerType: 'org', ownerId: ORG_ID }));
    const res = await post(
      CUSTOM_ROUTER_EVAL_PLAN_PATH,
      { routerId: ROUTER_ID },
      { 'X-KiloCode-OrganizationId': ORG_ID }
    );
    expect(res.status).toBe(403);
    expect(benchmarkFetch).not.toHaveBeenCalled();
  });

  it('hides another owner’s router', async () => {
    findCustomRouterById.mockResolvedValue(customRouter({ ownerId: 'someone-else' }));
    const res = await post(CUSTOM_ROUTER_EVAL_PLAN_PATH, { routerId: ROUTER_ID });
    expect(res.status).toBe(404);
    expect(benchmarkFetch).not.toHaveBeenCalled();
  });

  it('rejects an upload when the owning organization has no balance', async () => {
    findCustomRouterById.mockResolvedValue(customRouter({ ownerType: 'org', ownerId: ORG_ID }));
    findOrganizationMemberRole.mockResolvedValue('admin');
    dbRows.organization = [{ total_microdollars_acquired: 1_000, microdollars_used: 1_000 }];
    const res = await post(
      CUSTOM_ROUTER_EVAL_PLAN_PATH,
      { routerId: ROUTER_ID },
      { 'X-KiloCode-OrganizationId': ORG_ID }
    );
    expect(res.status).toBe(402);
    expect(benchmarkFetch).not.toHaveBeenCalled();
  });
});
