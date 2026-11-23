import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AUTO_ROUTING_DENIED_MODELS_PATH,
  CUSTOM_ROUTER_DECIDE_PATH,
  CUSTOM_ROUTER_EVAL_CASE_PATH,
  CUSTOM_ROUTER_EVAL_PLAN_PATH,
  CUSTOM_ROUTER_EVAL_RESULT_PATH,
  CUSTOM_ROUTER_EPOCH_PATH,
  CUSTOM_ROUTER_TABLE_PATH,
  CUSTOM_ROUTER_TABLE_VERSION_PATH,
  CustomRouterDecideResponseSchema,
  verifyAutoDecision,
  type AutoRoutingMode,
  type CustomRouterDefinition,
  type CustomRouterEntry,
  type MirrorPayload,
  type RoutingTable,
} from '@kilocode/auto-routing-contracts';
import type * as DbModule from '@kilocode/db';
import type { SQL } from 'drizzle-orm';
import { signKiloToken, clearSecretCacheForTest } from '@kilocode/worker-utils';
import type * as AccountAccessModule from '@kilocode/worker-utils/account-access';
import type { OrganizationMemberBalanceRow } from '@kilocode/worker-utils/account-access';
import type * as OrganizationMembershipModule from '@kilocode/worker-utils/organization-membership';
import type { UsageRecordRequest } from '@kilocode/usage-contracts';
import type * as ClassifierConfigModule from './classifier-config';
import type * as CustomRouterStoreModule from './custom-router-store';
import type * as ModelCapabilitiesModule from './model-capabilities';
import type * as ModelClassifierModule from './model-classifier';
import { clearEmailDomainBlacklistCache } from './caller-auth';
import { clearCustomRouterTableCache } from './custom-router-decision';
import { clearClassificationHotCache } from './decision-cache';
import { clearOrganizationPolicyCache } from './organization-policy';
import { app } from './index';

const findCustomRouter = vi.hoisted(() => vi.fn());
const findServingCustomRouter = vi.hoisted(() => vi.fn());
const findCustomRouterById = vi.hoisted(() => vi.fn());
const classifyNormalizedInput = vi.hoisted(() => vi.fn());
const findEffectiveOrganizationMemberRole = vi.hoisted(() => vi.fn());
const findOrganizationMemberBalanceRow = vi.hoisted(() => vi.fn());
const capabilityRows = vi.hoisted(
  () =>
    new Map<
      string,
      { inputModalities: Set<string>; contextLength: number | null; isActive: boolean | null }
    >()
);
const dbRows = vi.hoisted(() => ({
  user: [] as unknown[],
  organization: [] as unknown[],
  blacklistedDomains: [] as string[],
  blacklistLookupError: null as Error | null,
  // The domains each blacklisted_domains lookup asked about.
  blacklistLookups: [] as string[][],
}));

vi.mock('./custom-router-store', async importOriginal => ({
  ...(await importOriginal<typeof CustomRouterStoreModule>()),
  findCustomRouter,
  findServingCustomRouter,
  findCustomRouterById,
}));

vi.mock('./model-classifier', async importOriginal => ({
  ...(await importOriginal<typeof ModelClassifierModule>()),
  classifyNormalizedInput,
}));

vi.mock('./model-capabilities', async importOriginal => ({
  ...(await importOriginal<typeof ModelCapabilitiesModule>()),
  getModelCapabilities: async () => new Map(capabilityRows),
}));

vi.mock('./classifier-config', async importOriginal => ({
  ...(await importOriginal<typeof ClassifierConfigModule>()),
  getClassifierModel: async () => 'test/classifier',
  getDecisionLogSampleRate: async () => 0,
  getShadowRoutingTable: async () => null,
}));

vi.mock('@kilocode/worker-utils/account-access', async importOriginal => ({
  ...(await importOriginal<typeof AccountAccessModule>()),
  findOrganizationMemberBalanceRow,
}));

vi.mock('@kilocode/worker-utils/organization-membership', async importOriginal => ({
  ...(await importOriginal<typeof OrganizationMembershipModule>()),
  findEffectiveOrganizationMemberRole,
}));

vi.mock('@kilocode/db', async importOriginal => {
  const actual = await importOriginal<typeof DbModule>();
  const { PgDialect } = await import('drizzle-orm/pg-core');
  const dialect = new PgDialect();
  // Answers `domain in (...)` against the configured blocked domains.
  const blacklistLookup = async (condition: SQL) => {
    const domains = dialect.sqlToQuery(condition).params.map(String);
    dbRows.blacklistLookups.push(domains);
    if (dbRows.blacklistLookupError) throw dbRows.blacklistLookupError;
    return domains
      .filter(domain => dbRows.blacklistedDomains.includes(domain))
      .map(domain => ({ domain }));
  };
  return {
    ...actual,
    getWorkerDb: () => ({
      select: () => ({
        from: (table: unknown) => ({
          where: (condition: SQL) => {
            if (table === actual.blacklisted_domains) return blacklistLookup(condition);
            return {
              limit: async () =>
                table === actual.kilocode_users ? dbRows.user : dbRows.organization,
            };
          },
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
const platformModes = new Map<string, AutoRoutingMode>();
const getPlatformMode = vi.fn(async (key: string) => platformModes.get(key) ?? null);
let customTable: RoutingTable | null = rankedTable;

const env = {
  INTERNAL_API_SECRET_PROD: { get: async () => 'internal-secret' },
  NEXTAUTH_SECRET: { get: async () => NEXTAUTH_SECRET },
  AUTO_ROUTING_DECISION_SECRET: { get: async () => DECISION_SECRET },
  KILO_WEB_API_BASE_URL: 'https://web.example.test',
  KILO_AI_GATEWAY_BASE_URL: 'https://gateway.example.test',
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
  AUTO_ROUTING_MODE_CONFIG: {
    idFromName: (name: string) => name,
    get: (key: string) => ({
      getMode: () => getPlatformMode(key),
      setMode: async (mode: AutoRoutingMode | null) => {
        if (mode === null) platformModes.delete(key);
        else platformModes.set(key, mode);
      },
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

// A request body that reports whether the handler consumed it. A ReadableStream fills its
// queue on construction, so a pull counter cannot distinguish consumption; `bodyUsed` can.
function streamingBody() {
  const text = JSON.stringify({ routerId: '11111111-1111-4111-8111-111111111111' });
  return new Response(text).body as ReadableStream<Uint8Array>;
}

async function postStream(
  path: string,
  body: ReadableStream<Uint8Array>,
  headers: Record<string, string> = {}
) {
  const request = new Request(`https://auto-routing.example.com${path}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${await userToken()}`,
      'content-type': 'application/json',
      ...headers,
    },
    body,
    duplex: 'half',
  } as RequestInit);
  const res = await app.request(request, undefined, env, executionCtx);
  return { res, bodyUsed: request.bodyUsed };
}

// Pads a request object with an unknown field, which the contracts strip, to an exact body size.
function paddedBody(value: Record<string, unknown>, bytes: number) {
  const base = JSON.stringify({ ...value, padding: '' }).length;
  return { ...value, padding: 'x'.repeat(bytes - base) };
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
    payerRootOrganizationId: 'org-1',
    payerRootCreatedAt: '2026-01-01T00:00:00.000Z',
    payerMicrodollarsUsed: 0,
    payerTotalMicrodollarsAcquired: 10_000_000,
    ...overrides,
  } satisfies OrganizationMemberBalanceRow;
}

async function decisionOf(res: Response) {
  expect(res.status).toBe(200);
  return CustomRouterDecideResponseSchema.parse(await res.json());
}

// A user whose credited balance is fully spent.
function spentBalanceUser() {
  return {
    api_token_pepper: 'pepper-1',
    blocked_reason: null,
    google_user_email: 'dev@example.com',
    total_microdollars_acquired: 1_000_000,
    microdollars_used: 1_000_000,
  };
}

async function errorCode(res: Response) {
  const body = (await res.json()) as { error: { code: string } };
  return body.error.code;
}

async function errorResponse(res: Response) {
  return (await res.json()) as { error: { code: string; message: string } };
}

const fetchMock = vi.fn<typeof fetch>();
let gatewayDeniedModelIds: string[] = [];
let gatewayFailuresLeft = 0;
let gatewayFailureStatus = 503;

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
  clearEmailDomainBlacklistCache();
  backgroundTasks.length = 0;
  platformModes.clear();
  getPlatformMode.mockClear();
  customTable = rankedTable;
  capabilityRows.clear();
  capabilityRows.set(SONNET, {
    inputModalities: new Set(['text', 'image']),
    contextLength: 200_000,
    isActive: true,
  });
  // A pin-less alias entry is gated on the live target it would dispatch, so the fixture's alias
  // target needs an active row of its own; an alias id never has one.
  capabilityRows.set(NEW_TARGET, {
    inputModalities: new Set(['text', 'image']),
    contextLength: 200_000,
    isActive: true,
  });
  gatewayDeniedModelIds = [];
  gatewayFailuresLeft = 0;
  gatewayFailureStatus = 503;
  fetchMock.mockReset().mockImplementation(async input => {
    const url = requestUrl(input);
    if (url.startsWith('https://gateway.example.test')) {
      if (gatewayFailuresLeft > 0) {
        gatewayFailuresLeft--;
        return new Response('down', { status: gatewayFailureStatus });
      }
      return Response.json({ deniedModelIds: gatewayDeniedModelIds });
    }
    return new Response('not found', { status: 404 });
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
  dbRows.blacklistedDomains = [];
  dbRows.blacklistLookupError = null;
  dbRows.blacklistLookups = [];
  findCustomRouter.mockReset().mockResolvedValue(customRouter());
  findServingCustomRouter.mockReset().mockImplementation(async () => {
    const router = await findCustomRouter();
    return router ? { router, aliasTargets: new Map([[ALIAS, NEW_TARGET]]) } : null;
  });
  findCustomRouterById.mockReset().mockResolvedValue(customRouter());
  findEffectiveOrganizationMemberRole.mockReset().mockResolvedValue('member');
  findOrganizationMemberBalanceRow.mockReset().mockResolvedValue(memberBalanceRow());
  classifyNormalizedInput.mockReset().mockResolvedValue({
    cost: 0.000002,
    classifierModel: 'test/classifier',
    classification,
  });
  recordUsage.mockClear();
  cacheIdFromName.mockClear();
  benchmarkFetch.mockReset().mockImplementation(async url => {
    if (new URL(url).pathname === CUSTOM_ROUTER_EPOCH_PATH) {
      return Response.json({ epoch: 1 });
    }
    if (new URL(url).pathname === CUSTOM_ROUTER_TABLE_VERSION_PATH) {
      return Response.json({ readinessVersion: 'readiness-1' });
    }
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
  clearEmailDomainBlacklistCache();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const ALIAS = '~anthropic/latest';
const servingPin = {
  model: SONNET,
  pinnedAt: '2026-11-20T00:00:00.000Z',
  requestId: '33333333-3333-4333-8333-333333333333',
  confirmedAt: '2026-11-20T00:00:00.000Z',
};
const aliasEntry: CustomRouterEntry = { kind: 'gateway', model: ALIAS, servingPin };
const aliasTable = table({
  [ROUTE]: [{ model: ALIAS, accuracy: 0.9, avgCostUsd: 0.01, meetsThreshold: true, variant: null }],
});
const usablePin = () =>
  benchmarkFetch.mockImplementation(async url => {
    if (new URL(url).pathname === CUSTOM_ROUTER_EPOCH_PATH) {
      return Response.json({ epoch: 2 });
    }
    if (new URL(url).pathname === CUSTOM_ROUTER_TABLE_VERSION_PATH) {
      return Response.json({ readinessVersion: 'readiness-pinned' });
    }
    if (new URL(url).pathname === CUSTOM_ROUTER_TABLE_PATH) {
      return Response.json({
        table: aliasTable,
        servingPins: { [`gateway:${ALIAS}`]: SONNET },
      });
    }
    return Response.json({ error: 'unexpected path' }, { status: 500 });
  });

// A pinned alias whose saved target the worker catalog no longer has: the pin is unusable, so
// the pool serves the live alias and the worker says so on the entry key.
const retiredPin = () =>
  benchmarkFetch.mockImplementation(async url => {
    const path = new URL(url).pathname;
    if (path === CUSTOM_ROUTER_EPOCH_PATH) return Response.json({ epoch: 2 });
    if (path === CUSTOM_ROUTER_TABLE_VERSION_PATH) {
      return Response.json({ readinessVersion: 'readiness-retired' });
    }
    if (path === CUSTOM_ROUTER_TABLE_PATH) {
      return Response.json({
        table: aliasTable,
        servingFallback: [`gateway:${ALIAS}`],
      });
    }
    return Response.json({ error: 'unexpected path' }, { status: 500 });
  });

const aliasOnlyPool = () =>
  customRouter({ entries: [aliasEntry], defaultEntryKey: `gateway:${ALIAS}` });
const NEW_TARGET = 'openai/gpt-5.2';

// The snapshot the route reads: the pool with its observed pin for the target it measured, and the
// target the alias moved to. A retirement serves the alias, so the stored target is what the
// gateway substitutes for it.
const servingSnapshot = (router = aliasOnlyPool()) => ({
  router,
  aliasTargets: new Map([[ALIAS, NEW_TARGET]]),
});

describe('public custom router decide', () => {
  it.each(['efficient', 'frontier'] as const)(
    'keeps %s custom mode independent of personal and organization platform modes',
    async baseRouter => {
      let router = customRouter({ baseRouter, mode: 'best_accuracy' });
      findCustomRouter.mockImplementation(async () => router);
      platformModes.set(`user:${USER_ID}`, 'cost_per_accuracy');
      platformModes.set(`org:${ORG_ID}`, 'cost_per_accuracy');
      customTable = table({
        [ROUTE]: [
          {
            model: 'client:ollama/qwen3:32b',
            accuracy: 0.8,
            avgCostUsd: 0,
            meetsThreshold: true,
            variant: null,
          },
          { model: SONNET, accuracy: 0.95, avgCostUsd: 0.01, meetsThreshold: true, variant: null },
        ],
      });

      const headers = { 'X-KiloCode-OrganizationId': ORG_ID };
      const first = await decisionOf(await post(CUSTOM_ROUTER_DECIDE_PATH, decideBody(), headers));
      expect(first.decision).toMatchObject({ model: SONNET, fallback: false });

      router = { ...router, mode: 'cost_per_accuracy' };
      const edited = await decisionOf(await post(CUSTOM_ROUTER_DECIDE_PATH, decideBody(), headers));
      expect(edited.decision).toMatchObject({ model: 'client:ollama/qwen3:32b', fallback: false });
      expect(platformModes.get(`user:${USER_ID}`)).toBe('cost_per_accuracy');
      expect(platformModes.get(`org:${ORG_ID}`)).toBe('cost_per_accuracy');

      for (const [ownerType, ownerId] of [
        ['user', USER_ID],
        ['org', ORG_ID],
      ] as const) {
        const updated = await app.request(
          'https://auto-routing.example.com/admin/routing-mode',
          {
            method: 'PUT',
            headers: {
              authorization: 'Bearer internal-secret',
              'content-type': 'application/json',
            },
            body: JSON.stringify({ ownerType, ownerId, mode: 'best_accuracy' }),
          },
          env,
          executionCtx
        );
        expect(updated.status).toBe(200);
      }

      const afterPlatformEdit = await decisionOf(
        await post(CUSTOM_ROUTER_DECIDE_PATH, decideBody(), headers)
      );
      expect(afterPlatformEdit.decision).toMatchObject({
        model: 'client:ollama/qwen3:32b',
        fallback: false,
      });
      expect(router.mode).toBe('cost_per_accuracy');
      expect(getPlatformMode).not.toHaveBeenCalled();
      expect(platformModes.get(`user:${USER_ID}`)).toBe('best_accuracy');
      expect(platformModes.get(`org:${ORG_ID}`)).toBe('best_accuracy');
    }
  );

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

  it('serves the live alias with the fallback marker when the pinned target retired', async () => {
    findServingCustomRouter.mockResolvedValue(servingSnapshot());
    retiredPin();
    const { decision, decisionId } = await decisionOf(
      await post(CUSTOM_ROUTER_DECIDE_PATH, decideBody())
    );
    expect(decision).toMatchObject({
      entry: { kind: 'gateway', model: ALIAS },
      model: ALIAS,
      servingFallback: true,
      fallback: false,
      stale: false,
      tableVersion: 'custom-table-1',
    });
    expect(decision).not.toHaveProperty('servingPin');
    // The verifier needs the entry, the exact saved pin the fallback was proven against, and the
    // stored target it must substitute for the bare alias at redemption.
    const verified = await verifyAutoDecision(decisionId, DECISION_SECRET, Date.now());
    expect(verified).toEqual({
      ok: true,
      payload: expect.objectContaining({
        model: ALIAS,
        entryModel: ALIAS,
        servingFallback: true,
        servingPinModel: SONNET,
        servingFallbackTarget: NEW_TARGET,
      }),
    });
  });

  it('serves the retired pin fallback without a routing table', async () => {
    findServingCustomRouter.mockResolvedValue(servingSnapshot());
    classifyNormalizedInput.mockRejectedValue(new Error('classifier down'));
    benchmarkFetch.mockImplementation(async url => {
      const path = new URL(url).pathname;
      if (path === CUSTOM_ROUTER_EPOCH_PATH) return Response.json({ epoch: 2 });
      if (path === CUSTOM_ROUTER_TABLE_VERSION_PATH) {
        return Response.json({ readinessVersion: 'readiness-empty' });
      }
      if (path === CUSTOM_ROUTER_TABLE_PATH) {
        return Response.json({ table: null, servingFallback: [`gateway:${ALIAS}`] });
      }
      return Response.json({ error: 'unexpected path' }, { status: 500 });
    });
    const { decision } = await decisionOf(await post(CUSTOM_ROUTER_DECIDE_PATH, decideBody()));
    expect(decision).toMatchObject({
      entry: { kind: 'gateway', model: ALIAS },
      model: ALIAS,
      servingFallback: true,
      fallback: true,
      tableVersion: null,
    });
  });

  it('retries a retirement fallback the snapshot cannot name a target for', async () => {
    findServingCustomRouter.mockResolvedValue({ router: aliasOnlyPool(), aliasTargets: new Map() });
    retiredPin();
    const res = await post(CUSTOM_ROUTER_DECIDE_PATH, decideBody());
    expect(res.status).toBe(500);
    expect(res.headers.get('retry-after')).toBe('5');
    expect(await errorCode(res)).toBe('internal_error');
  });

  it('retries a retirement fallback whose stored target never moved off the pin', async () => {
    findServingCustomRouter.mockResolvedValue({
      router: aliasOnlyPool(),
      aliasTargets: new Map([[ALIAS, SONNET]]),
    });
    retiredPin();
    const res = await post(CUSTOM_ROUTER_DECIDE_PATH, decideBody());
    expect(res.status).toBe(500);
    expect(await errorCode(res)).toBe('internal_error');
  });

  it('signs the new stored target when an alias already moved again', async () => {
    findServingCustomRouter.mockResolvedValue({
      router: aliasOnlyPool(),
      aliasTargets: new Map([[ALIAS, NEW_TARGET]]),
    });
    retiredPin();
    const { decisionId } = await decisionOf(await post(CUSTOM_ROUTER_DECIDE_PATH, decideBody()));
    const verified = await verifyAutoDecision(decisionId, DECISION_SECRET, Date.now());
    expect(verified).toEqual({
      ok: true,
      payload: expect.objectContaining({
        servingFallback: true,
        servingPinModel: SONNET,
        servingFallbackTarget: NEW_TARGET,
      }),
    });
  });

  it('ranks a retired-pin entry with its live alias target, not the target that left the catalog', async () => {
    // The saved pin names a model that has left the catalog, so the worker reported it retired and
    // the entry dispatches the live alias target instead. Gating on the retired pin's row would
    // fail the entry closed on a row that no longer exists; the target that actually runs has an
    // active row, so the pool must serve it and mark the retirement.
    findServingCustomRouter.mockResolvedValue(servingSnapshot());
    capabilityRows.delete(SONNET);
    retiredPin();
    const { decision } = await decisionOf(await post(CUSTOM_ROUTER_DECIDE_PATH, decideBody()));
    expect(decision).toMatchObject({
      entry: { kind: 'gateway', model: ALIAS },
      model: ALIAS,
      servingFallback: true,
      fallback: false,
    });
    expect(decision).not.toHaveProperty('servingPin');
  });

  it('marks nothing when the pinned target is still usable', async () => {
    findServingCustomRouter.mockResolvedValue(servingSnapshot());
    usablePin();
    const { decision } = await decisionOf(await post(CUSTOM_ROUTER_DECIDE_PATH, decideBody()));
    expect(decision).toMatchObject({ model: SONNET, servingPin });
    expect(decision).not.toHaveProperty('servingFallback');
  });

  it('marks nothing when the worker reports no retirement for a saved pin', async () => {
    findServingCustomRouter.mockResolvedValue(servingSnapshot());
    benchmarkFetch.mockImplementation(async url => {
      const path = new URL(url).pathname;
      if (path === CUSTOM_ROUTER_EPOCH_PATH) return Response.json({ epoch: 2 });
      if (path === CUSTOM_ROUTER_TABLE_VERSION_PATH) {
        return Response.json({ readinessVersion: 'readiness-alias' });
      }
      if (path === CUSTOM_ROUTER_TABLE_PATH) return Response.json({ table: aliasTable });
      return Response.json({ error: 'unexpected path' }, { status: 500 });
    });
    const { decision } = await decisionOf(await post(CUSTOM_ROUTER_DECIDE_PATH, decideBody()));
    expect(decision).toMatchObject({ entry: { kind: 'gateway', model: ALIAS }, model: ALIAS });
    expect(decision).not.toHaveProperty('servingFallback');
  });

  it('never dispatches a denied retired pin: the allowed live target is served and marked', async () => {
    // The saved pin names a denied model, but the benchmark worker reported that exact target left
    // its catalog (`servingFallback`), so the pin is not what would run. The live alias target is
    // openai/gpt-5.2, which the policy cleared, so the pool serves that and says so on the wire.
    findServingCustomRouter.mockResolvedValue(servingSnapshot());
    gatewayDeniedModelIds = [SONNET];
    retiredPin();
    const { decision, decisionId } = await decisionOf(
      await post(CUSTOM_ROUTER_DECIDE_PATH, decideBody(), {
        'X-KiloCode-OrganizationId': ORG_ID,
      })
    );
    // Safe only because the retirement is marked and the denied model is never dispatched: the
    // decision names the alias, not SONNET, and carries the retirement marker the gateway needs.
    expect(decision).toMatchObject({
      entry: { kind: 'gateway', model: ALIAS },
      model: ALIAS,
      servingFallback: true,
      fallback: false,
    });
    expect(decision).not.toHaveProperty('servingPin');
    expect(decision.model).not.toBe(SONNET);
    // The signature binds the denied pin it retired and the concrete target it must substitute,
    // so redemption cannot follow an alias move into a model the policy never checked.
    const verified = await verifyAutoDecision(decisionId, DECISION_SECRET, Date.now());
    expect(verified).toEqual({
      ok: true,
      payload: expect.objectContaining({
        model: ALIAS,
        entryModel: ALIAS,
        servingFallback: true,
        servingPinModel: SONNET,
        servingFallbackTarget: NEW_TARGET,
      }),
    });
  });

  it('refuses a denied pin that still applies instead of unpinning it', async () => {
    // The same pool and denial, but the worker still lists the pin: it is what would run, so the
    // entry is unservable rather than silently swapped for its alias.
    findServingCustomRouter.mockResolvedValue(servingSnapshot());
    gatewayDeniedModelIds = [SONNET];
    usablePin();
    const res = await post(CUSTOM_ROUTER_DECIDE_PATH, decideBody(), {
      'X-KiloCode-OrganizationId': ORG_ID,
    });
    expect(res.status).toBe(422);
    expect(await errorCode(res)).toBe('custom_router_unavailable');
  });

  it('serves the pinned target the fresh definition carries on the first request after a move', async () => {
    // The isolate's cached read still shows the pre-move pool; the authoritative read the route
    // uses already carries the observed pin, so this request must dispatch the old target.
    findCustomRouter.mockResolvedValue(
      customRouter({
        entries: [{ kind: 'gateway', model: ALIAS }],
        defaultEntryKey: `gateway:${ALIAS}`,
      })
    );
    findServingCustomRouter.mockResolvedValue(servingSnapshot());
    usablePin();
    const { decision } = await decisionOf(await post(CUSTOM_ROUTER_DECIDE_PATH, decideBody()));
    expect(decision).toMatchObject({
      entry: { kind: 'gateway', model: ALIAS },
      model: SONNET,
      servingPin,
    });
    expect(findServingCustomRouter).toHaveBeenCalledWith(
      env,
      { type: 'user', id: USER_ID },
      'mine'
    );
  });

  it('refuses a pool the authoritative read no longer finds', async () => {
    findCustomRouter.mockResolvedValue(aliasOnlyPool());
    findServingCustomRouter.mockResolvedValue(null);
    const res = await post(CUSTOM_ROUTER_DECIDE_PATH, decideBody());
    expect(res.status).toBe(404);
    expect(await errorCode(res)).toBe('router_not_found');
    expect(classifyNormalizedInput).not.toHaveBeenCalled();
  });

  it('turns a failed authoritative read into a retryable error instead of the stale pool', async () => {
    findCustomRouter.mockResolvedValue(aliasOnlyPool());
    findServingCustomRouter.mockRejectedValue(new Error('connection terminated'));
    const res = await post(CUSTOM_ROUTER_DECIDE_PATH, decideBody());
    expect(res.status).toBe(500);
    expect(res.headers.get('retry-after')).toBe('5');
    expect(await errorCode(res)).toBe('internal_error');
    expect(classifyNormalizedInput).not.toHaveBeenCalled();
  });

  it('ignores a caller-supplied definition on the public CLI path', async () => {
    // The public request schema has no such field, so a forged pool is stripped before any policy
    // or ranking runs, and the saved pool still decides.
    findServingCustomRouter.mockResolvedValue(servingSnapshot(customRouter()));
    const forged = customRouter({
      ownerId: 'someone-else',
      slug: 'other',
      entries: [aliasEntry],
      defaultEntryKey: `gateway:${ALIAS}`,
    });
    const { decision } = await decisionOf(
      await post(CUSTOM_ROUTER_DECIDE_PATH, decideBody({ customRouterDefinition: forged }))
    );
    expect(decision).toMatchObject({
      entry: { kind: 'client', provider: 'ollama', model: 'qwen3:32b' },
    });
    expect(findServingCustomRouter).toHaveBeenCalledWith(
      env,
      { type: 'user', id: USER_ID },
      'mine'
    );
  });

  it('dispatches the pinned target of a ranked alias entry under its logical key', async () => {
    findCustomRouter.mockResolvedValue(
      customRouter({ entries: [aliasEntry], defaultEntryKey: `gateway:${ALIAS}` })
    );
    usablePin();
    const { decision, decisionId } = await decisionOf(
      await post(CUSTOM_ROUTER_DECIDE_PATH, decideBody())
    );
    expect(decision).toMatchObject({
      entry: { kind: 'gateway', model: ALIAS },
      model: SONNET,
      servingPin,
      fallback: false,
    });
    const verified = await verifyAutoDecision(decisionId, DECISION_SECRET, Date.now());
    expect(verified).toEqual({
      ok: true,
      payload: expect.objectContaining({ model: SONNET, routerModelId: 'kilo-auto/custom/mine' }),
    });
  });

  it('dispatches the pinned target on the fallback path too', async () => {
    findCustomRouter.mockResolvedValue(
      customRouter({ entries: [aliasEntry], defaultEntryKey: `gateway:${ALIAS}` })
    );
    classifyNormalizedInput.mockRejectedValue(new Error('classifier down'));
    usablePin();
    const { decision } = await decisionOf(await post(CUSTOM_ROUTER_DECIDE_PATH, decideBody()));
    expect(decision).toMatchObject({
      entry: { kind: 'gateway', model: ALIAS },
      model: SONNET,
      servingPin,
      fallback: true,
    });
  });

  it('does not serve a pinned entry whose target the organization policy denies', async () => {
    findCustomRouter.mockResolvedValue(
      customRouter({ entries: [aliasEntry], defaultEntryKey: `gateway:${ALIAS}` })
    );
    gatewayDeniedModelIds = [SONNET];
    usablePin();
    const res = await post(CUSTOM_ROUTER_DECIDE_PATH, decideBody(), {
      'X-KiloCode-OrganizationId': ORG_ID,
    });
    expect(res.status).toBe(422);
    expect(await errorCode(res)).toBe('custom_router_unavailable');
    const [call] = gatewayCalls();
    const { modelIds } = JSON.parse(call?.[1]?.body as string) as { modelIds: string[] };
    // The policy is asked about every id the entry could dispatch: the pool model, the live alias
    // target from the same snapshot, and the saved pin. All three are evaluated, so a denied pin is
    // refused rather than silently unpinned to a target the policy never checked. The policy helper
    // de-duplicates and sorts before it asks, so this is the exact order on the wire.
    expect(modelIds).toEqual([SONNET, NEW_TARGET, ALIAS]);
  });

  it('serves the next request after a settlement because the router epoch moved', async () => {
    await decisionOf(await post(CUSTOM_ROUTER_DECIDE_PATH, decideBody()));
    const paths = () => benchmarkFetch.mock.calls.map(([url]) => new URL(String(url)).pathname);
    const tableFetches = () => paths().filter(path => path === CUSTOM_ROUTER_TABLE_PATH).length;
    expect(tableFetches()).toBe(1);

    // No clock movement and no polling interval: the very next request sees the new epoch, finds
    // this pool's own ready set unchanged, and serves its cache without rebuilding.
    benchmarkFetch.mockImplementation(async url => {
      const path = new URL(String(url)).pathname;
      if (path === CUSTOM_ROUTER_EPOCH_PATH) return Response.json({ epoch: 2 });
      if (path === CUSTOM_ROUTER_TABLE_VERSION_PATH) {
        return Response.json({ readinessVersion: 'readiness-1' });
      }
      if (path === CUSTOM_ROUTER_TABLE_PATH) return Response.json({ table: rankedTable });
      return Response.json({ error: 'unexpected path' }, { status: 500 });
    });
    await decisionOf(await post(CUSTOM_ROUTER_DECIDE_PATH, decideBody()));
    expect(tableFetches()).toBe(1);

    // A pool whose own readiness fingerprint moved under the same new epoch rebuilds once, so a
    // freshly ready measurement in another pool reaches this one on its next request.
    benchmarkFetch.mockImplementation(async url => {
      const path = new URL(String(url)).pathname;
      if (path === CUSTOM_ROUTER_EPOCH_PATH) return Response.json({ epoch: 3 });
      if (path === CUSTOM_ROUTER_TABLE_VERSION_PATH) {
        return Response.json({ readinessVersion: 'readiness-2' });
      }
      if (path === CUSTOM_ROUTER_TABLE_PATH) return Response.json({ table: rankedTable });
      return Response.json({ error: 'unexpected path' }, { status: 500 });
    });
    await decisionOf(await post(CUSTOM_ROUTER_DECIDE_PATH, decideBody()));
    expect(tableFetches()).toBe(2);
  });

  it('never answers a post-settlement request from a build started before it', async () => {
    // Epoch 1's table ranks only the stale client entry, so a leaked pre-settlement build is
    // visible as a fallback/wrong pick rather than just a call count.
    const oldTable = table({
      [ROUTE]: [
        {
          model: 'client:ollama/qwen3:32b',
          accuracy: 0.9,
          avgCostUsd: 0,
          meetsThreshold: true,
          variant: null,
        },
      ],
    });
    const newTable = table({
      [ROUTE]: [
        { model: SONNET, accuracy: 0.95, avgCostUsd: 0.01, meetsThreshold: true, variant: null },
      ],
    });

    let epoch = 1;
    const oldBuildEntered = Promise.withResolvers<void>();
    const oldBuildGate = Promise.withResolvers<void>();
    benchmarkFetch.mockImplementation(async url => {
      const path = new URL(String(url)).pathname;
      if (path === CUSTOM_ROUTER_EPOCH_PATH) return Response.json({ epoch });
      if (path === CUSTOM_ROUTER_TABLE_VERSION_PATH) {
        return Response.json({ readinessVersion: `readiness-${epoch}` });
      }
      if (path === CUSTOM_ROUTER_TABLE_PATH) {
        if (epoch === 1) {
          oldBuildEntered.resolve();
          await oldBuildGate.promise;
          return Response.json({ table: oldTable });
        }
        return Response.json({ table: newTable });
      }
      return Response.json({ error: 'unexpected path' }, { status: 500 });
    });

    const first = post(CUSTOM_ROUTER_DECIDE_PATH, decideBody());
    await oldBuildEntered.promise;
    epoch = 2;
    const { decision: afterSettlement } = await decisionOf(
      await post(CUSTOM_ROUTER_DECIDE_PATH, decideBody()).finally(() => oldBuildGate.resolve())
    );
    await decisionOf(await first);
    const { decision: afterOldBuildLanded } = await decisionOf(
      await post(CUSTOM_ROUTER_DECIDE_PATH, decideBody())
    );

    expect(afterSettlement.model).toBe(SONNET);
    expect(afterOldBuildLanded.model).toBe(SONNET);
  });

  it('re-reads the actual table once when the epoch endpoint is unavailable', async () => {
    await decisionOf(await post(CUSTOM_ROUTER_DECIDE_PATH, decideBody()));
    const tableFetches = () =>
      benchmarkFetch.mock.calls.filter(
        ([url]) => new URL(String(url)).pathname === CUSTOM_ROUTER_TABLE_PATH
      ).length;
    expect(tableFetches()).toBe(1);

    // A benchmark Worker that predates the epoch endpoint answers 404: the serving side can prove
    // nothing about the cached table, so it fetches the real one instead of pretending the epoch
    // is unchanged. The old worker still answers the fingerprint and table paths it always had.
    benchmarkFetch.mockImplementation(async url => {
      const path = new URL(String(url)).pathname;
      if (path === CUSTOM_ROUTER_EPOCH_PATH) return new Response('not found', { status: 404 });
      if (path === CUSTOM_ROUTER_TABLE_VERSION_PATH) {
        return Response.json({ readinessVersion: 'readiness-1' });
      }
      if (path === CUSTOM_ROUTER_TABLE_PATH) return Response.json({ table: rankedTable });
      return Response.json({ error: 'unexpected path' }, { status: 500 });
    });
    const { decision } = await decisionOf(await post(CUSTOM_ROUTER_DECIDE_PATH, decideBody()));
    // The rebuilt table served normally; only the epoch proof was unavailable.
    expect(decision.fallback).toBe(false);
    expect(tableFetches()).toBe(2);

    // The next unprovable request must re-read the actual table again, so a second 404 can observe
    // a table that changed after the first, and an unknown epoch is never cached as proof.
    benchmarkFetch.mockImplementation(async url => {
      const path = new URL(String(url)).pathname;
      if (path === CUSTOM_ROUTER_EPOCH_PATH) return new Response('not found', { status: 404 });
      if (path === CUSTOM_ROUTER_TABLE_VERSION_PATH) {
        return Response.json({ readinessVersion: 'readiness-2' });
      }
      if (path === CUSTOM_ROUTER_TABLE_PATH) {
        return Response.json({
          table: table({
            [ROUTE]: [
              {
                model: SONNET,
                accuracy: 0.99,
                avgCostUsd: 0.01,
                meetsThreshold: true,
                variant: null,
              },
            ],
          }),
        });
      }
      return Response.json({ error: 'unexpected path' }, { status: 500 });
    });
    const second = await decisionOf(await post(CUSTOM_ROUTER_DECIDE_PATH, decideBody()));
    expect(tableFetches()).toBe(3);
    expect(second.decision.entry).toMatchObject({ kind: 'gateway', model: SONNET });
  });

  it('fails retryably when the epoch is unprovable and the table cannot be read', async () => {
    await decisionOf(await post(CUSTOM_ROUTER_DECIDE_PATH, decideBody()));
    benchmarkFetch.mockImplementation(async url => {
      const path = new URL(String(url)).pathname;
      if (path === CUSTOM_ROUTER_EPOCH_PATH) return new Response('not found', { status: 404 });
      return new Response('down', { status: 503 });
    });
    const res = await post(CUSTOM_ROUTER_DECIDE_PATH, decideBody());
    expect(res.status).toBe(500);
    expect(await errorCode(res)).toBe('internal_error');
  });

  it('falls back past a default entry that has no capability row', async () => {
    findCustomRouter.mockResolvedValue(
      customRouter({ entries: [sonnet, ollama], defaultEntryKey: `gateway:${SONNET}` })
    );
    capabilityRows.clear();
    classifyNormalizedInput.mockRejectedValue(new Error('classifier down'));
    const { decision } = await decisionOf(await post(CUSTOM_ROUTER_DECIDE_PATH, decideBody()));
    expect(decision).toMatchObject({ model: 'client:ollama/qwen3:32b', fallback: true });
  });

  it('fails with custom_router_unavailable when the only entry has no capability row', async () => {
    findCustomRouter.mockResolvedValue(customRouter({ entries: [sonnet] }));
    capabilityRows.clear();
    classifyNormalizedInput.mockRejectedValue(new Error('classifier down'));
    const res = await post(CUSTOM_ROUTER_DECIDE_PATH, decideBody());
    expect(res.status).toBe(422);
    expect(await errorCode(res)).toBe('custom_router_unavailable');
  });

  it('falls back past an inactive entry', async () => {
    findCustomRouter.mockResolvedValue(
      customRouter({ entries: [sonnet, ollama], defaultEntryKey: `gateway:${SONNET}` })
    );
    capabilityRows.set(SONNET, {
      inputModalities: new Set(['text', 'image']),
      contextLength: 200_000,
      isActive: false,
    });
    classifyNormalizedInput.mockRejectedValue(new Error('classifier down'));
    const { decision } = await decisionOf(await post(CUSTOM_ROUTER_DECIDE_PATH, decideBody()));
    expect(decision).toMatchObject({ model: 'client:ollama/qwen3:32b', fallback: true });
  });

  const imageMessages = [
    {
      role: 'user',
      content: [
        { type: 'text', text: 'Fix the layout in this screenshot.' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
      ],
    },
  ];

  it('falls back past a default entry that lacks a required modality', async () => {
    findCustomRouter.mockResolvedValue(
      customRouter({ entries: [ollama, sonnet], defaultEntryKey: 'client:ollama/qwen3:32b' })
    );
    classifyNormalizedInput.mockRejectedValue(new Error('classifier down'));
    const { decision } = await decisionOf(
      await post(CUSTOM_ROUTER_DECIDE_PATH, decideBody({ messages: imageMessages }))
    );
    expect(decision).toMatchObject({ model: SONNET, fallback: true });
  });

  it('fails with custom_router_unavailable when the classifier fails and no entry fits', async () => {
    findCustomRouter.mockResolvedValue(
      customRouter({ entries: [ollama, lmstudio], defaultEntryKey: 'client:ollama/qwen3:32b' })
    );
    classifyNormalizedInput.mockRejectedValue(new Error('classifier down'));
    const res = await post(
      CUSTOM_ROUTER_DECIDE_PATH,
      decideBody({
        messages: imageMessages,
        clientEntries: [
          { provider: 'ollama', model: 'qwen3:32b' },
          { provider: 'lmstudio', model: 'gemma' },
        ],
      })
    );
    expect(res.status).toBe(422);
    expect(await errorCode(res)).toBe('custom_router_unavailable');
  });

  it('accepts a body at the size limit and rejects one byte more', async () => {
    const limit = 32_000_000;
    const padded = (bytes: number) => {
      const unpadded = JSON.stringify({ ...decideBody(), padding: '' }).length;
      return { ...decideBody(), padding: 'x'.repeat(bytes - unpadded) };
    };
    await decisionOf(await post(CUSTOM_ROUTER_DECIDE_PATH, padded(limit)));
    const tooLarge = await post(CUSTOM_ROUTER_DECIDE_PATH, padded(limit + 1));
    expect(tooLarge.status).toBe(400);
    expect(await tooLarge.json()).toEqual({
      error: { code: 'invalid_request', message: 'Request body is too large' },
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

  it('asks the policy about the live alias target the entry would actually dispatch', async () => {
    findServingCustomRouter.mockResolvedValue(
      servingSnapshot(
        customRouter({
          entries: [{ kind: 'gateway', model: ALIAS }],
          defaultEntryKey: `gateway:${ALIAS}`,
        })
      )
    );
    await decisionOf(
      await post(CUSTOM_ROUTER_DECIDE_PATH, decideBody(), { 'X-KiloCode-OrganizationId': ORG_ID })
    );
    const [call] = gatewayCalls();
    // The alias and the concrete target it stores from this same snapshot, so the worker can route
    // around a denied target instead of reaching the gateway and being refused there. A pin-less
    // entry contributes exactly those two ids. `deniedOrganizationModelIds` de-duplicates and sorts
    // before it asks, so compare sorted membership rather than request order.
    expect(JSON.parse(call?.[1]?.body as string)).toEqual({
      userId: USER_ID,
      organizationId: ORG_ID,
      // Sorted by the policy helper: `openai/gpt-5.2` then `~anthropic/latest`.
      modelIds: [NEW_TARGET, ALIAS],
    });
  });

  it('routes around an alias entry whose live target the organization policy denies', async () => {
    findServingCustomRouter.mockResolvedValue(
      servingSnapshot(
        customRouter({
          entries: [
            { kind: 'gateway', model: ALIAS },
            { kind: 'gateway', model: SONNET },
          ],
          defaultEntryKey: `gateway:${ALIAS}`,
        })
      )
    );
    customTable = table({
      [ROUTE]: [
        { model: ALIAS, accuracy: 0.95, avgCostUsd: 0.01, meetsThreshold: true, variant: null },
        { model: SONNET, accuracy: 0.85, avgCostUsd: 0.01, meetsThreshold: true, variant: null },
      ],
    });
    gatewayDeniedModelIds = [NEW_TARGET];
    const { decision } = await decisionOf(
      await post(CUSTOM_ROUTER_DECIDE_PATH, decideBody({ clientEntries: [] }), {
        'X-KiloCode-OrganizationId': ORG_ID,
      })
    );
    // The alias entry is unservable because its stored target is denied, so the sibling serves.
    expect(decision).toMatchObject({ model: SONNET, entry: { model: SONNET } });
    expect(decision).not.toHaveProperty('servingFallback');
  });

  it('skips the organization policy for a personal context', async () => {
    await decisionOf(await post(CUSTOM_ROUTER_DECIDE_PATH, decideBody()));
    expect(gatewayCalls()).toHaveLength(0);
  });

  it('does not retry a policy failure that cannot clear', async () => {
    gatewayFailuresLeft = 2;
    gatewayFailureStatus = 404;
    const res = await post(CUSTOM_ROUTER_DECIDE_PATH, decideBody({ clientEntries: [] }), {
      'X-KiloCode-OrganizationId': ORG_ID,
    });
    expect(res.status).toBe(500);
    expect(gatewayCalls()).toHaveLength(1);
  });

  it('retries a transient organization policy failure once', async () => {
    gatewayFailuresLeft = 1;
    gatewayDeniedModelIds = [];
    const { decision } = await decisionOf(
      await post(CUSTOM_ROUTER_DECIDE_PATH, decideBody({ clientEntries: [] }), {
        'X-KiloCode-OrganizationId': ORG_ID,
      })
    );
    expect(decision).toMatchObject({ model: SONNET, fallback: false });
    expect(gatewayCalls()).toHaveLength(2);
  });

  it('returns a retryable error when a gateway-only request cannot read the policy', async () => {
    gatewayFailuresLeft = 2;
    const res = await post(CUSTOM_ROUTER_DECIDE_PATH, decideBody({ clientEntries: [] }), {
      'X-KiloCode-OrganizationId': ORG_ID,
    });
    expect(res.status).toBe(500);
    expect(res.headers.get('retry-after')).toBe('5');
    expect(await errorCode(res)).toBe('internal_error');
    expect(classifyNormalizedInput).not.toHaveBeenCalled();

    const retried = await post(CUSTOM_ROUTER_DECIDE_PATH, decideBody({ clientEntries: [] }), {
      'X-KiloCode-OrganizationId': ORG_ID,
    });
    expect(retried.status).toBe(200);
  });

  it('serves a listed client entry when the organization policy cannot be read', async () => {
    gatewayFailuresLeft = 2;
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
    dbRows.blacklistedDomains = ['example.com'];
    const decide = await post(CUSTOM_ROUTER_DECIDE_PATH, decideBody());
    expect(decide.status).toBe(403);
    expect(await errorCode(decide)).toBe('forbidden');
    const plan = await post(CUSTOM_ROUTER_EVAL_PLAN_PATH, { routerId: ROUTER_ID });
    expect(plan.status).toBe(403);
    expect(dbRows.blacklistLookups[0]).toEqual(['example.com', 'com']);
    expect(classifyNormalizedInput).not.toHaveBeenCalled();
    expect(benchmarkFetch).not.toHaveBeenCalled();
  });

  it('refuses a user in a subdomain of a blocked email domain', async () => {
    dbRows.blacklistedDomains = ['example.com'];
    dbRows.user = [
      {
        api_token_pepper: 'pepper-1',
        blocked_reason: null,
        google_user_email: 'dev@Mail.Example.com',
        total_microdollars_acquired: 5_000_000,
        microdollars_used: 1_000_000,
      },
    ];
    const res = await post(CUSTOM_ROUTER_DECIDE_PATH, decideBody());
    expect(res.status).toBe(403);
    expect(await errorCode(res)).toBe('forbidden');
  });

  it('refuses a user whose block timestamp is set', async () => {
    dbRows.user = [
      {
        api_token_pepper: 'pepper-1',
        blocked_at: '2026-01-15T12:00:00.000Z',
        blocked_reason: null,
        google_user_email: 'dev@example.com',
        total_microdollars_acquired: 1_000_000,
        microdollars_used: 0,
      },
    ];
    const decide = await post(CUSTOM_ROUTER_DECIDE_PATH, decideBody());
    expect(decide.status).toBe(403);
    expect(await errorCode(decide)).toBe('forbidden');
    expect(classifyNormalizedInput).not.toHaveBeenCalled();
    expect(benchmarkFetch).not.toHaveBeenCalled();
  });

  it('admits a user whose email domain is not blocked', async () => {
    dbRows.blacklistedDomains = ['notexample.com', 'mail.example.com'];
    await decisionOf(await post(CUSTOM_ROUTER_DECIDE_PATH, decideBody()));
    expect(dbRows.blacklistLookups).toEqual([['example.com', 'com']]);
  });

  it('maps a failed blocked-domain lookup to a retryable internal error and retries it on the next request', async () => {
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    dbRows.blacklistLookupError = new Error('connection terminated');
    const res = await post(CUSTOM_ROUTER_DECIDE_PATH, decideBody());
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      error: { code: 'internal_error', message: 'Account checks are temporarily unavailable' },
    });
    expect(res.headers.get('retry-after')).toBe('5');
    expect(JSON.parse(String(consoleWarn.mock.calls[0]?.[0]))).toMatchObject({
      event: 'auto_routing_blacklisted_domains_read_failed',
      error: 'connection terminated',
    });
    expect(classifyNormalizedInput).not.toHaveBeenCalled();

    dbRows.blacklistLookupError = null;
    await decisionOf(await post(CUSTOM_ROUTER_DECIDE_PATH, decideBody()));
    expect(dbRows.blacklistLookups).toHaveLength(2);
  });

  it('looks up the blocked-domain status of a user once per minute', async () => {
    for (let i = 0; i < 3; i++) {
      await decisionOf(await post(CUSTOM_ROUTER_DECIDE_PATH, decideBody()));
    }
    expect(dbRows.blacklistLookups).toHaveLength(1);
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
    expect(findServingCustomRouter).toHaveBeenCalledWith(
      env,
      { type: 'user', id: USER_ID },
      'mine'
    );
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
    expect(findServingCustomRouter).toHaveBeenCalledWith(env, { type: 'org', id: ORG_ID }, 'team');
    expect(findEffectiveOrganizationMemberRole).toHaveBeenCalledWith(expect.anything(), {
      kiloUserId: USER_ID,
      organizationId: ORG_ID,
    });
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
    expect(findServingCustomRouter).toHaveBeenCalledWith(
      env,
      { type: 'org', id: otherOrg },
      'team'
    );
  });

  it('denies an organization context the user is not a member of', async () => {
    findEffectiveOrganizationMemberRole.mockResolvedValue(null);
    const res = await post(CUSTOM_ROUTER_DECIDE_PATH, decideBody(), {
      'X-KiloCode-OrganizationId': ORG_ID,
    });
    expect(res.status).toBe(403);
    expect(await errorResponse(res)).toEqual({
      error: { code: 'forbidden', message: 'Not a member of the organization' },
    });
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

  it('requires a paid-usage balance from a personal caller', async () => {
    dbRows.user = [
      {
        api_token_pepper: 'pepper-1',
        blocked_reason: null,
        google_user_email: 'dev@example.com',
        total_microdollars_acquired: 1_000_000,
        microdollars_used: 1_000_000,
      },
    ];
    const { res, bodyUsed } = await postStream(CUSTOM_ROUTER_DECIDE_PATH, streamingBody());
    expect(res.status).toBe(402);
    expect(await errorCode(res)).toBe('insufficient_balance');
    expect(bodyUsed).toBe(false);
    expect(findCustomRouter).not.toHaveBeenCalled();
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
  function internalDecide(
    payload: Partial<MirrorPayload>,
    requestedModel = 'kilo-auto/custom/mine'
  ) {
    return app.request(
      'https://auto-routing.example.com/decide',
      {
        method: 'POST',
        headers: { authorization: 'Bearer internal-secret', 'content-type': 'application/json' },
        body: JSON.stringify({
          input: {
            apiKind: 'chat_completions',
            requestedModel,
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

  it('keeps the saved Efficient custom ID on its canonical table and cache scope', async () => {
    findCustomRouter.mockResolvedValue(customRouter({ slug: 'efficient', entries: [sonnet] }));
    const response = await internalDecide(
      { customRouter: { scope: 'user', slug: 'efficient' } },
      'kilo-auto/custom/efficient'
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toHaveProperty(
      'decision',
      expect.objectContaining({ model: SONNET })
    );
    // Exactly one table build; the readiness probe is a separate, cheap call by design.
    const benchmarkPaths = () =>
      benchmarkFetch.mock.calls.map(([url]) => new URL(String(url)).pathname);
    expect(benchmarkPaths().filter(path => path === CUSTOM_ROUTER_TABLE_PATH)).toHaveLength(1);
    expect(benchmarkPaths().filter(path => path === CUSTOM_ROUTER_TABLE_VERSION_PATH)).toHaveLength(
      1
    );
    expect(
      cacheIdFromName.mock.calls.every(([key]) => key.startsWith(`custom:${ROUTER_ID}:`))
    ).toBe(true);
    await drainBackgroundTasks();
    expect(recordUsage.mock.calls.map(([usage]) => usage.core.requested_model)).toContain(
      'kilo-auto/custom/efficient'
    );
  });

  it('returns router_not_found for an organization router without an organization', async () => {
    const res = await internalDecide({ customRouter: { scope: 'org', slug: 'team' } });
    expect(res.status).toBe(404);
    expect(findCustomRouter).not.toHaveBeenCalled();
  });

  it('routes from the definition the authenticated caller supplied', async () => {
    findCustomRouter.mockResolvedValue(null);
    const res = await internalDecide({
      customRouter: { scope: 'user', slug: 'mine' },
      customRouterDefinition: customRouter({
        entries: [sonnet],
        defaultEntryKey: `gateway:${SONNET}`,
      }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toHaveProperty('decision', expect.objectContaining({ model: SONNET }));
    expect(findCustomRouter).not.toHaveBeenCalled();
  });

  it.each([
    ['another owner', { ownerId: 'someone-else' }],
    ['an organization owner', { ownerType: 'org' as const, ownerId: ORG_ID }],
    ['another slug', { slug: 'other' }],
    ['another base router', { baseRouter: 'frontier' as const }],
  ])('refuses a supplied definition that names %s', async (_label, overrides) => {
    findCustomRouter.mockResolvedValue(customRouter());
    const res = await internalDecide({
      router: 'efficient',
      customRouter: { scope: 'user', slug: 'mine' },
      customRouterDefinition: customRouter(overrides),
    });
    expect(res.status).toBe(404);
    expect(await errorCode(res)).toBe('router_not_found');
    expect(classifyNormalizedInput).not.toHaveBeenCalled();
  });

  it('accepts a supplied definition without a stated base router', async () => {
    const res = await internalDecide({
      customRouter: { scope: 'user', slug: 'mine' },
      customRouterDefinition: customRouter({ baseRouter: 'frontier' }),
    });
    expect(res.status).toBe(200);
  });

  it('keeps the stored pool and its deny policy for callers without a definition', async () => {
    findCustomRouter.mockResolvedValue(
      customRouter({ entries: [aliasEntry, ollama], defaultEntryKey: `gateway:${ALIAS}` })
    );
    const res = await internalDecide({
      router: 'efficient',
      routingPolicy: { deniedModelIds: [SONNET] },
      customRouter: { scope: 'user', slug: 'mine' },
      clientEntries: [{ provider: 'ollama', model: 'qwen3:32b' }],
    });
    expect(res.status).toBe(200);
    expect(findCustomRouter).toHaveBeenCalledWith(env, { type: 'user', id: USER_ID }, 'mine');
    expect(await res.json()).toHaveProperty(
      'decision',
      expect.objectContaining({ model: 'client:ollama/qwen3:32b' })
    );
  });

  it('carries the retired-pin marker on the private path', async () => {
    findCustomRouter.mockResolvedValue(aliasOnlyPool());
    benchmarkFetch.mockImplementation(async url => {
      const path = new URL(url).pathname;
      if (path === CUSTOM_ROUTER_EPOCH_PATH) return Response.json({ epoch: 2 });
      if (path === CUSTOM_ROUTER_TABLE_VERSION_PATH) {
        return Response.json({ readinessVersion: 'readiness-retired' });
      }
      if (path === CUSTOM_ROUTER_TABLE_PATH) {
        return Response.json({ table: aliasTable, servingFallback: [`gateway:${ALIAS}`] });
      }
      return Response.json({ error: 'unexpected path' }, { status: 500 });
    });
    const res = await internalDecide({ customRouter: { scope: 'user', slug: 'mine' } });
    expect(res.status).toBe(200);
    expect(await res.json()).toHaveProperty(
      'decision',
      expect.objectContaining({ model: ALIAS, servingFallback: true })
    );
  });

  it('does not let a denied retired pin block the pool it left', async () => {
    // The saved pin names a model the policy denies, but the worker proved that target left the
    // catalog: the live alias serves instead, so the entry is still servable and still ranked.
    findCustomRouter.mockResolvedValue(aliasOnlyPool());
    customTable = aliasTable;
    retiredPin();
    const res = await internalDecide({
      customRouter: { scope: 'user', slug: 'mine' },
      routingPolicy: { deniedModelIds: [SONNET] },
      customRouterAliasTargets: { [ALIAS]: NEW_TARGET },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toHaveProperty(
      'decision',
      expect.objectContaining({ model: ALIAS, servingFallback: true, fallback: false })
    );
  });

  it('routes around an entry whose live alias target the policy denies', async () => {
    // No saved pin: the entry would dispatch whatever the alias stores, and that target is denied.
    // Its sibling stays servable, so the pool serves the sibling instead of failing.
    findCustomRouter.mockResolvedValue(
      customRouter({
        entries: [{ kind: 'gateway', model: ALIAS }, sonnet],
        defaultEntryKey: `gateway:${ALIAS}`,
      })
    );
    customTable = table({
      [ROUTE]: [
        { model: ALIAS, accuracy: 0.95, avgCostUsd: 0.01, meetsThreshold: true, variant: null },
        { model: SONNET, accuracy: 0.85, avgCostUsd: 0.01, meetsThreshold: true, variant: null },
      ],
    });
    const res = await internalDecide({
      customRouter: { scope: 'user', slug: 'mine' },
      routingPolicy: { deniedModelIds: [NEW_TARGET] },
      customRouterAliasTargets: { [ALIAS]: NEW_TARGET },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toHaveProperty(
      'decision',
      expect.objectContaining({ model: SONNET, fallback: false })
    );
  });

  it('refuses the alias entry when its only live target the policy denies has no sibling', async () => {
    findCustomRouter.mockResolvedValue(aliasOnlyPool());
    customTable = aliasTable;
    const res = await internalDecide({
      customRouter: { scope: 'user', slug: 'mine' },
      routingPolicy: { deniedModelIds: [NEW_TARGET] },
      customRouterAliasTargets: { [ALIAS]: NEW_TARGET },
    });
    expect(res.status).toBe(422);
    expect(await errorCode(res)).toBe('custom_router_unavailable');
  });

  it('ignores alias targets the supplied definition does not own', async () => {
    // A map naming a model outside the pool cannot make that model servable, and a target for an
    // entry this definition lacks is dropped before it can steer the decision.
    findCustomRouter.mockResolvedValue(null);
    const res = await internalDecide({
      customRouter: { scope: 'user', slug: 'mine' },
      customRouterDefinition: customRouter({
        entries: [sonnet],
        defaultEntryKey: `gateway:${SONNET}`,
      }),
      customRouterAliasTargets: { [ALIAS]: NEW_TARGET },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toHaveProperty('decision', expect.objectContaining({ model: SONNET }));
  });

  it('rejects an alias-target map with an alias or virtual target', async () => {
    const res = await internalDecide({
      customRouter: { scope: 'user', slug: 'mine' },
      customRouterAliasTargets: { [ALIAS]: '~openai/latest' },
    });
    expect(res.status).toBe(400);
  });

  it('decides from the stored pool when the caller sends no alias targets', async () => {
    // An older gateway sends no map: the pool still serves its measured entry, never a bare alias.
    findCustomRouter.mockResolvedValue(customRouter({ entries: [sonnet] }));
    const res = await internalDecide({ customRouter: { scope: 'user', slug: 'mine' } });
    expect(res.status).toBe(200);
    expect(await res.json()).toHaveProperty('decision', expect.objectContaining({ model: SONNET }));
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

  function resultUpload(overrides: Record<string, unknown> = {}) {
    return {
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
      ...overrides,
    };
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
    findEffectiveOrganizationMemberRole.mockResolvedValue('billing_manager');
    findOrganizationMemberBalanceRow.mockResolvedValue(null);
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
    findEffectiveOrganizationMemberRole.mockResolvedValue('admin');
    dbRows.organization = [{ total_microdollars_acquired: 1_000, microdollars_used: 1_000 }];
    const res = await post(
      CUSTOM_ROUTER_EVAL_PLAN_PATH,
      { routerId: ROUTER_ID },
      { 'X-KiloCode-OrganizationId': ORG_ID }
    );
    expect(res.status).toBe(402);
    expect(benchmarkFetch).not.toHaveBeenCalled();
  });

  it('requires a funded payer for an eval plan', async () => {
    dbRows.user = [spentBalanceUser()];
    dbRows.organization = [{ total_microdollars_acquired: 1_000, microdollars_used: 1_000 }];
    const { res, bodyUsed } = await postStream(CUSTOM_ROUTER_EVAL_PLAN_PATH, streamingBody(), {
      'X-KiloCode-OrganizationId': ORG_ID,
    });
    expect(res.status).toBe(402);
    expect(await errorCode(res)).toBe('insufficient_balance');
    expect(bodyUsed).toBe(false);
    expect(findCustomRouterById).not.toHaveBeenCalled();
    expect(benchmarkFetch).not.toHaveBeenCalled();
  });

  it('runs an eval plan for an owner inherited from the live parent organization', async () => {
    findCustomRouterById.mockResolvedValue(
      customRouter({ ownerType: 'org', ownerId: ORG_ID, slug: 'team' })
    );
    findEffectiveOrganizationMemberRole.mockResolvedValue('owner');
    dbRows.user = [spentBalanceUser()];
    benchmarkFetch.mockResolvedValueOnce(Response.json({}));
    const res = await post(
      CUSTOM_ROUTER_EVAL_PLAN_PATH,
      { routerId: ROUTER_ID },
      { 'X-KiloCode-OrganizationId': ORG_ID }
    );
    expect(res.status).toBe(200);
    expect(findEffectiveOrganizationMemberRole).toHaveBeenCalledWith(expect.anything(), {
      kiloUserId: USER_ID,
      organizationId: ORG_ID,
    });
    expect(forwarded(CUSTOM_ROUTER_EVAL_PLAN_PATH)).toMatchObject({
      routerId: ROUTER_ID,
      ownerType: 'org',
      ownerId: ORG_ID,
    });
  });

  it('runs an eval plan for an organization billing manager funded by the organization', async () => {
    findCustomRouterById.mockResolvedValue(
      customRouter({ ownerType: 'org', ownerId: ORG_ID, slug: 'team' })
    );
    findEffectiveOrganizationMemberRole.mockResolvedValue('billing_manager');
    findOrganizationMemberBalanceRow.mockResolvedValue(null);
    dbRows.user = [spentBalanceUser()];
    benchmarkFetch.mockResolvedValueOnce(Response.json({}));
    const res = await post(
      CUSTOM_ROUTER_EVAL_PLAN_PATH,
      { routerId: ROUTER_ID },
      { 'X-KiloCode-OrganizationId': ORG_ID }
    );
    expect(res.status).toBe(200);
    expect(forwarded(CUSTOM_ROUTER_EVAL_PLAN_PATH)).toMatchObject({
      routerId: ROUTER_ID,
      ownerType: 'org',
      ownerId: ORG_ID,
    });
  });

  it('accepts an eval plan at the body cap and refuses a larger one', async () => {
    const limit = 16_000;
    benchmarkFetch.mockResolvedValueOnce(Response.json({}));
    const atLimit = await postStream(
      CUSTOM_ROUTER_EVAL_PLAN_PATH,
      new Response(JSON.stringify(paddedBody({ routerId: ROUTER_ID }, limit)))
        .body as ReadableStream<Uint8Array>
    );
    expect(atLimit.res.status).toBe(200);
    expect(atLimit.bodyUsed).toBe(true);
    const tooLarge = await post(
      CUSTOM_ROUTER_EVAL_PLAN_PATH,
      paddedBody({ routerId: ROUTER_ID }, limit + 1)
    );
    expect(tooLarge.status).toBe(400);
    expect(await tooLarge.json()).toEqual({
      error: { code: 'invalid_request', message: 'Request body is too large' },
    });
    expect(benchmarkFetch).toHaveBeenCalledTimes(1);
  });

  it('accepts an eval case at the body cap and refuses a larger one', async () => {
    const limit = 16_000;
    const body = { routerId: ROUTER_ID, caseId: 'case-1' };
    benchmarkFetch.mockResolvedValueOnce(Response.json({}));
    const atLimit = await post(CUSTOM_ROUTER_EVAL_CASE_PATH, paddedBody(body, limit));
    expect(atLimit.status).toBe(200);
    expect(forwarded(CUSTOM_ROUTER_EVAL_CASE_PATH)).toMatchObject({
      routerId: ROUTER_ID,
      caseId: 'case-1',
    });
    const tooLarge = await post(CUSTOM_ROUTER_EVAL_CASE_PATH, paddedBody(body, limit + 1));
    expect(tooLarge.status).toBe(400);
    expect(await tooLarge.json()).toEqual({
      error: { code: 'invalid_request', message: 'Request body is too large' },
    });
    expect(benchmarkFetch).toHaveBeenCalledTimes(1);
  });

  it('accepts a maximal client output and refuses a body above the result cap', async () => {
    benchmarkFetch.mockResolvedValueOnce(Response.json({ score: 1 }));
    const res = await post(
      CUSTOM_ROUTER_EVAL_RESULT_PATH,
      resultUpload({ output: 'x'.repeat(1_000_000) })
    );
    expect(res.status).toBe(200);
    const tooLarge = await post(
      CUSTOM_ROUTER_EVAL_RESULT_PATH,
      paddedBody(resultUpload(), 8_000_000 + 1)
    );
    expect(tooLarge.status).toBe(400);
    expect(await tooLarge.json()).toEqual({
      error: { code: 'invalid_request', message: 'Request body is too large' },
    });
    expect(benchmarkFetch).toHaveBeenCalledTimes(1);
  });
});
