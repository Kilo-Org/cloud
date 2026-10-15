import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearClassifierConfigCache, getClassifierModel } from './classifier-config';
import { clearRoutingTableCache } from './routing-table';
import { clearModelCapabilitiesCache } from './model-capabilities';
import type * as ModelCapabilitiesModule from './model-capabilities';
import { clearCustomRoutingTableCache } from './decide';
import { AutoRoutingDecisionCacheDO, clearClassificationHotCache } from './decision-cache';
import { clearAutoRoutingSettingsCache } from './routing-mode';
import { app } from './index';
import { ClassifierRunError, type ClassifierRunResult } from './model-classifier';
import type * as DbModule from '@kilocode/db';
import type * as ModelClassifierModule from './model-classifier';
import type {
  AutoRoutingMode,
  ClassifierOutput,
  EfficientModelPool,
  MirrorPayload,
  NormalizedClassifierInput,
} from '@kilocode/auto-routing-contracts';
import { CLASSIFIER_WINNER_KV_KEY } from '@kilocode/auto-routing-contracts';
import { computeContentHashes } from './conversation-identity';
import { UsageRecordRequestSchema, type UsageRecordRequest } from '@kilocode/usage-contracts';
import {
  buildClassifierUsage,
  writeClassifierUsage,
  type ClassifierCallKind,
} from './classifier-usage';

const classifyNormalizedInput = vi.hoisted(() => vi.fn());
const getWorkerDb = vi.hoisted(() => vi.fn());
const dbSelect = vi.hoisted(() => vi.fn());
const dbFrom = vi.hoisted(() => vi.fn());
const dbWhereCaps = vi.hoisted(() => vi.fn());
const getModelCapabilitiesMock = vi.hoisted(() => vi.fn());

vi.mock('./model-classifier', async importOriginal => {
  const actual = await importOriginal<typeof ModelClassifierModule>();
  return { ...actual, classifyNormalizedInput };
});

vi.mock('./model-capabilities', async importOriginal => {
  const actual = await importOriginal<typeof ModelCapabilitiesModule>();
  getModelCapabilitiesMock.mockImplementation(actual.getModelCapabilities);
  return {
    ...actual,
    getModelCapabilities: (...args: Parameters<typeof actual.getModelCapabilities>) =>
      getModelCapabilitiesMock(...args),
  };
});

vi.mock('@kilocode/db', async importOriginal => {
  const actual = await importOriginal<typeof DbModule>();
  return { ...actual, getWorkerDb };
});

const writeDataPoint = vi.fn();
const configGet = vi.fn();
const configDelete = vi.fn();
const configPut = vi.fn();
const analyticsTokenGet = vi.fn();
const cacheReadConversationState = vi.fn();
const cacheRecordClassifierUsage = vi.fn();
const cachePutEntry = vi.fn();
const cachePutStickyDecision = vi.fn();
const cacheIdFromName = vi.fn(() => 'cache-do-id');
const modeConfigIdFromName = vi.fn((name: string) => name);
const modeConfigGet = vi.fn();
const benchmarkFetch = vi.fn();
const originalFetch = globalThis.fetch;
const mockedFetch = vi.fn<typeof globalThis.fetch>();

const env = {
  INTERNAL_API_SECRET_PROD: {
    get: async () => 'classifier-token',
  },
  KILO_WEB_API_BASE_URL: 'https://web.example.test',
  AUTO_ROUTING_CONFIG: {
    get: configGet,
    delete: configDelete,
    put: configPut,
  },
  BENCHMARK_SERVICE: {
    fetch: benchmarkFetch,
  },
  AUTO_ROUTING_CLASSIFIER_METRICS_V2: {
    writeDataPoint,
  },
  AUTO_ROUTING_DECISION_CACHE: {
    idFromName: cacheIdFromName,
    get: () => ({
      readConversationState: cacheReadConversationState,
      recordClassifierUsage: cacheRecordClassifierUsage,
      putEntry: cachePutEntry,
      putStickyDecision: cachePutStickyDecision,
    }),
  },
  AUTO_ROUTING_MODE_CONFIG: {
    idFromName: modeConfigIdFromName,
    get: modeConfigGet,
  },
  O11Y_CF_ACCOUNT_ID: 'test-account-id',
  O11Y_CF_AE_API_TOKEN: {
    get: analyticsTokenGet,
  },
  HYPERDRIVE: {
    connectionString: 'postgres://worker',
  },
};

const mockClassification = {
  taskType: 'implementation',
  subtaskType: 'feature_development',
  contextComplexity: 'medium',
  reasoningComplexity: 'medium',
  riskLevel: 'low',
  executionMode: 'code_change',
  requiresTools: true,
  confidence: 0.82,
};

const mockClassifierResult = {
  cost: 0.00000123,
  classifierModel: 'google/gemini-2.5-flash-lite',
  classification: mockClassification,
};

const normalizedInput: NormalizedClassifierInput = {
  apiKind: 'chat_completions',
  requestedModel: 'anthropic/claude-sonnet-4',
  systemPromptPrefix: 'You classify auto model routing requests.',
  userPromptPrefix: 'Pick the best model for this request.',
  latestUserPromptPrefix: null,
  messageCount: 3,
  hasTools: true,
  stream: true,
  providerHints: {
    provider: { order: ['anthropic'] },
    providerOptions: { openrouter: { sort: 'price', apiKey: '[REDACTED]' } },
  },
};

const benchmarkRoutingTable = {
  version: 'bench-run-1',
  generatedAt: '2026-06-12T00:00:00.000Z',
  minAccuracy: 0.7,
  switchCostFactor: 3,
  bestAccuracySwitchThreshold: 0.05,
  source: 'benchmark',
  routes: {
    'implementation/feature_development': [
      {
        model: 'google/gemini-2.5-flash-lite',
        accuracy: 0.9,
        avgCostUsd: 0.002,
        meetsThreshold: true,
        reasoningEffort: null,
      },
      {
        model: 'google/gemini-2.5-flash',
        accuracy: 0.85,
        avgCostUsd: 0.002,
        meetsThreshold: true,
        reasoningEffort: null,
      },
      // The planning route's model also qualifies for implementation, within the 3x
      // switch-cost factor of the fresh pick (0.002 * 3 >= 0.005): a session
      // moving routes stays on it.
      {
        model: 'anthropic/claude-sonnet-4.6',
        accuracy: 0.8,
        avgCostUsd: 0.005,
        meetsThreshold: true,
        reasoningEffort: null,
      },
    ],
    'planning_design/system_design': [
      {
        model: 'anthropic/claude-sonnet-4.6',
        accuracy: 0.8,
        avgCostUsd: 0.01,
        meetsThreshold: true,
        reasoningEffort: null,
      },
    ],
  },
};

function mirrorPayload(overrides: Record<string, unknown> = {}): MirrorPayload {
  return {
    input: normalizedInput,
    userId: 'user-1',
    organizationId: null,
    sessionId: 'task-123',
    machineId: 'machine-1',
    clientRequestId: 'req-1',
    mode: 'code',
    userAgent: 'Kilo-Code/4.106.0',
    bodyBytes: 2048,
    ...overrides,
  };
}

type TestConversationState = {
  classification: { value: unknown; storedAt: number } | null;
  sticky: unknown;
};

function conversationState(
  classification: unknown = null,
  sticky: unknown = null
): TestConversationState {
  return {
    classification:
      classification === null ? null : { value: classification, storedAt: Date.now() },
    sticky,
  };
}

const backgroundTasks: Promise<unknown>[] = [];

async function drainBackgroundTasks() {
  while (backgroundTasks.length > 0) {
    await Promise.all(backgroundTasks.splice(0));
  }
}

function mockStoredConversation() {
  const store = new Map<string, unknown>();
  let stickyGeneration = 0;
  cacheReadConversationState.mockImplementation(async (key: string | null) =>
    conversationState(key === null ? null : (store.get(key) ?? null), store.get('sticky') ?? null)
  );
  cachePutStickyDecision.mockImplementation(async (value: unknown, writeGeneration: number) => {
    if (writeGeneration < stickyGeneration) return;
    stickyGeneration = writeGeneration;
    await cachePutEntry('sticky', value);
  });
  cachePutEntry.mockImplementation(async (key: string, value: unknown) => {
    store.set(key, value);
  });
  return store;
}

// Node-environment tests have no workers ExecutionContext; Hono accepts a
// substitute so handler code can use c.executionCtx.waitUntil directly.
const executionCtx = {
  waitUntil: (promise: Promise<unknown>) => {
    backgroundTasks.push(promise);
  },
  passThroughOnException: () => {},
} as unknown as ExecutionContext;

function request(path: string, init: RequestInit = {}) {
  return app.request(`https://auto-routing.example.com${path}`, init, env, executionCtx);
}

function localRequest(path: string, init: RequestInit = {}) {
  return app.request(`http://localhost:8810${path}`, init, env, executionCtx);
}

function decideRequest(payload: unknown) {
  return request('/decide', {
    method: 'POST',
    headers: {
      authorization: 'Bearer classifier-token',
      'content-type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
}

describe('auto routing worker', () => {
  beforeEach(async () => {
    clearClassifierConfigCache();
    clearRoutingTableCache();
    clearModelCapabilitiesCache();
    clearClassificationHotCache();
    clearAutoRoutingSettingsCache();
    backgroundTasks.length = 0;
    const actualCaps =
      await vi.importActual<typeof ModelCapabilitiesModule>('./model-capabilities');
    getModelCapabilitiesMock.mockReset();
    getModelCapabilitiesMock.mockImplementation(actualCaps.getModelCapabilities);
    classifyNormalizedInput.mockReset();
    classifyNormalizedInput.mockResolvedValue(mockClassifierResult);
    getWorkerDb.mockReset();
    getWorkerDb.mockReturnValue({ select: dbSelect });
    dbSelect.mockReset();
    dbSelect.mockReturnValue({ from: dbFrom });
    dbFrom.mockReset();
    dbFrom.mockReturnValue({ where: dbWhereCaps });
    dbWhereCaps.mockReset();
    dbWhereCaps.mockResolvedValue([]);
    writeDataPoint.mockReset();
    configGet.mockReset();
    // Real KV returns null for missing keys; an undefined here would send the
    // routing-table loader down the JSON.parse-throw path instead.
    configGet.mockResolvedValue(null);
    configDelete.mockReset();
    configDelete.mockResolvedValue(undefined);
    configPut.mockReset();
    configPut.mockResolvedValue(undefined);
    modeConfigIdFromName.mockReset();
    modeConfigIdFromName.mockImplementation((name: string) => name);
    modeConfigGet.mockReset();
    modeConfigGet.mockImplementation(() => {
      let mode: AutoRoutingMode | null = null;
      let pool: EfficientModelPool | null = null;
      return {
        getMode: vi.fn(async () => mode),
        setMode: vi.fn(async (next: AutoRoutingMode | null) => {
          mode = next;
        }),
        getPool: vi.fn(async () => pool),
        setPool: vi.fn(async (next: EfficientModelPool | null) => {
          pool = next;
        }),
        getSettings: vi.fn(async () => ({ mode, pool })),
        setSettings: vi.fn(
          async (settings: { mode: AutoRoutingMode | null; pool: EfficientModelPool | null }) => {
            mode = settings.mode;
            pool = settings.pool;
          }
        ),
      };
    });
    benchmarkFetch.mockReset();
    benchmarkFetch.mockImplementation(async (url: string) => {
      if (String(url).includes('/admin/classifier-winner')) {
        return { ok: true, status: 200, json: async () => ({ winner: null }) };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          table: benchmarkRoutingTable,
          publishedAt: benchmarkRoutingTable.generatedAt,
        }),
      };
    });
    analyticsTokenGet.mockReset();
    analyticsTokenGet.mockResolvedValue('analytics-token');
    cacheReadConversationState.mockReset();
    cacheReadConversationState.mockResolvedValue(conversationState());
    cacheRecordClassifierUsage.mockReset();
    cacheRecordClassifierUsage.mockImplementation((usage: UsageRecordRequest) =>
      writeClassifierUsage(env as unknown as Env, usage)
    );
    cachePutEntry.mockReset();
    cachePutEntry.mockResolvedValue(undefined);
    cachePutStickyDecision.mockReset();
    cachePutStickyDecision.mockImplementation(async (value: unknown) =>
      cachePutEntry('sticky', value)
    );
    mockedFetch.mockReset();
    mockedFetch.mockImplementation(async (_url, init) => {
      const body = init?.body;
      if (typeof body !== 'string') throw new Error('Expected serialized usage body');
      const usage = UsageRecordRequestSchema.parse(JSON.parse(body));
      return Response.json({
        status: 'recorded',
        result: {
          usageId: usage.core.id,
          createdAt: usage.core.created_at,
          newMicrodollarsUsed: usage.core.cost,
        },
      });
    });
    globalThis.fetch = mockedFetch;
    clearCustomRoutingTableCache();
  });

  afterEach(async () => {
    await drainBackgroundTasks();
    globalThis.fetch = originalFetch;
    clearCustomRoutingTableCache();
    vi.restoreAllMocks();
  });

  it('defaults /decide to the efficient table and cache namespace', async () => {
    const response = await decideRequest(mirrorPayload());
    expect(response.status).toBe(200);
    expect(configGet).toHaveBeenCalledWith('routing_table_v1');
    expect(cacheIdFromName).toHaveBeenCalledWith('efficient:user:user-1:task:task-123');
  });

  it('reads the frontier table and state without applying the owner efficient pool', async () => {
    modeConfigGet.mockImplementation(() => ({
      getSettings: async () => ({
        mode: 'cost_per_accuracy',
        pool: [{ model: 'owner/efficient', variant: null }],
      }),
    }));
    const frontierTable = {
      ...benchmarkRoutingTable,
      version: 'frontier-table',
      routes: {
        'implementation/feature_development': [
          {
            model: 'anthropic/claude-opus-4.6',
            accuracy: 0.95,
            avgCostUsd: 0.01,
            meetsThreshold: true,
            reasoningEffort: null,
          },
        ],
      },
    };
    configGet.mockImplementation(async (key: string) =>
      key === 'routing_table_frontier_v1' ? JSON.stringify(frontierTable) : null
    );
    dbWhereCaps.mockResolvedValue([
      {
        openrouterId: 'anthropic/claude-opus-4.6',
        inputModalities: ['image', 'file'],
        contextLength: 200_000,
        isActive: true,
      },
    ]);
    const response = await decideRequest(
      mirrorPayload({
        router: 'frontier',
        constraints: { requiredInputModalities: ['image', 'file'] },
      })
    );
    await expect(response.json()).resolves.toMatchObject({
      decision: { model: 'anthropic/claude-opus-4.6', tableVersion: 'frontier-table' },
    });
    expect(getModelCapabilitiesMock).toHaveBeenCalledWith(
      env,
      expect.objectContaining({ router: 'frontier' })
    );
    expect(cacheIdFromName).toHaveBeenCalledWith('frontier:user:user-1:task:task-123');
    expect(cacheReadConversationState).toHaveBeenCalledWith(expect.stringMatching(/^frontier:/));
    expect(configGet).not.toHaveBeenCalledWith('routing_table_v1');
    expect(
      benchmarkFetch.mock.calls.some(
        ([url]) => typeof url === 'string' && url.includes('/admin/custom-routing-table')
      )
    ).toBe(false);
  });

  it('returns no frontier decision when only the efficient table exists', async () => {
    configGet.mockImplementation(async (key: string) =>
      key === 'routing_table_v1' ? JSON.stringify(benchmarkRoutingTable) : null
    );
    benchmarkFetch.mockImplementation(async () =>
      Response.json({ table: null, publishedAt: null, winner: null })
    );
    const response = await decideRequest(mirrorPayload({ router: 'frontier' }));
    await expect(response.json()).resolves.toMatchObject({ decision: null });
    expect(benchmarkFetch).toHaveBeenCalledWith(
      'https://auto-routing-benchmark/admin/routing-table?router=frontier',
      expect.anything()
    );
  });

  it('rejects unknown router identifiers', async () => {
    const response = await decideRequest(mirrorPayload({ router: 'invalid' }));
    expect(response.status).toBe(400);
    expect(classifyNormalizedInput).not.toHaveBeenCalled();
  });

  describe.each([false, true])('classifier overlap (cached=%s)', cacheHit => {
    it.each(['settings', 'capabilities', 'routing-table'])(
      'prepares classification while %s is pending',
      async slowHop => {
        const blocked = Promise.withResolvers<void>();
        modeConfigGet.mockImplementation(() => ({
          getSettings: vi.fn(async () => {
            if (slowHop === 'settings') await blocked.promise;
            return { mode: 'cost_per_accuracy', pool: null };
          }),
        }));
        getModelCapabilitiesMock.mockImplementation(async () => {
          if (slowHop === 'capabilities') await blocked.promise;
          return new Map();
        });
        benchmarkFetch.mockImplementation(async (url: string) => {
          if (String(url).includes('/admin/classifier-winner')) {
            return { ok: true, status: 200, json: async () => ({ winner: null }) };
          }
          if (slowHop === 'routing-table') await blocked.promise;
          return {
            ok: true,
            status: 200,
            json: async () => ({
              table: benchmarkRoutingTable,
              publishedAt: benchmarkRoutingTable.generatedAt,
            }),
          };
        });
        if (cacheHit) {
          cacheReadConversationState.mockResolvedValueOnce(conversationState(mockClassification));
        }

        let finished = false;
        const pending = Promise.resolve(
          decideRequest(mirrorPayload({ constraints: { promptTokensEstimate: 100 } }))
        ).then(response => {
          finished = true;
          return response;
        });
        try {
          await vi.waitFor(() => {
            expect(cacheReadConversationState).toHaveBeenCalledTimes(1);
            if (!cacheHit) expect(classifyNormalizedInput).toHaveBeenCalledTimes(1);
          });
          await new Promise<void>(resolve => setImmediate(resolve));
          expect(finished).toBe(false);
          expect(classifyNormalizedInput).toHaveBeenCalledTimes(cacheHit ? 0 : 1);
        } finally {
          blocked.resolve();
          await pending;
        }

        const response = await pending;
        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toMatchObject({
          cost: 0,
          decision: {
            model: 'google/gemini-2.5-flash-lite',
            reasoningEffort: null,
            source: 'benchmark',
            sticky: false,
          },
          classifierResult: { classification: mockClassification, normalized: normalizedInput },
        });
        expect(cacheReadConversationState).toHaveBeenCalledTimes(1);
        expect(classifyNormalizedInput).toHaveBeenCalledTimes(cacheHit ? 0 : 1);
      }
    );
  });

  it('preserves billing and routing when concurrent settings loading fails', async () => {
    const settings = Promise.withResolvers<{
      mode: AutoRoutingMode | null;
      pool: EfficientModelPool | null;
    }>();
    modeConfigGet.mockImplementation(() => ({ getSettings: () => settings.promise }));
    const pending = decideRequest(mirrorPayload());
    try {
      await vi.waitFor(() => expect(classifyNormalizedInput).toHaveBeenCalledTimes(1));
    } finally {
      settings.reject(new Error('settings unavailable'));
    }
    const response = await pending;
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      cost: 0,
      decision: { model: 'google/gemini-2.5-flash-lite', source: 'benchmark' },
      classifierResult: { classification: mockClassification },
    });
  });

  describe('capability-aware routing', () => {
    // A two-candidate route where the cheaper model is text-only and the
    // second is image-capable. This lets a single fixture exercise both
    // the fresh and cached classification paths in decide.ts.
    const visionTable = {
      ...benchmarkRoutingTable,
      routes: {
        ...benchmarkRoutingTable.routes,
        'implementation/feature_development': [
          {
            model: 'text-only/chat',
            accuracy: 0.95,
            avgCostUsd: 0.001,
            meetsThreshold: true,
            reasoningEffort: null,
          },
          {
            model: 'vision/chat',
            accuracy: 0.85,
            avgCostUsd: 0.002,
            meetsThreshold: true,
            reasoningEffort: null,
          },
        ],
      },
    };

    function setVisionBenchmark() {
      benchmarkFetch.mockImplementation(async (url: string) => {
        if (String(url).includes('/admin/classifier-winner')) {
          return { ok: true, status: 200, json: async () => ({ winner: null }) };
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({
            table: visionTable,
            publishedAt: visionTable.generatedAt,
          }),
        };
      });
    }

    function setVisionCaps() {
      dbWhereCaps.mockResolvedValue([
        { openrouterId: 'text-only/chat', inputModalities: [], contextLength: 1_000_000 },
        { openrouterId: 'vision/chat', inputModalities: ['image'], contextLength: 1_000_000 },
      ]);
    }

    it('skips a non-vision top candidate on the fresh-classification path', async () => {
      setVisionBenchmark();
      setVisionCaps();
      const response = await decideRequest(
        mirrorPayload({ constraints: { requiredInputModalities: ['image'] } })
      );
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        decision: { model: 'vision/chat', sticky: false },
      });
    });

    it('waits for fresh classification when the incumbent fails the current modality constraint', async () => {
      setVisionBenchmark();
      setVisionCaps();
      cacheReadConversationState.mockResolvedValue(
        conversationState(null, {
          model: 'text-only/chat',
          variant: null,
          routeKey: 'implementation/feature_development',
        })
      );
      const classifier = Promise.withResolvers<ClassifierRunResult>();
      classifyNormalizedInput.mockReturnValueOnce(classifier.promise);
      let finished = false;
      const pending = Promise.resolve(
        decideRequest(mirrorPayload({ constraints: { requiredInputModalities: ['image'] } }))
      ).then(response => {
        finished = true;
        return response;
      });
      try {
        await vi.waitFor(() => expect(classifyNormalizedInput).toHaveBeenCalledTimes(1));
        await new Promise<void>(resolve => setImmediate(resolve));
        expect(finished).toBe(false);
      } finally {
        classifier.resolve(mockClassifierResult as ClassifierRunResult);
      }
      const response = await pending;
      await expect(response.json()).resolves.toMatchObject({
        cost: 0,
        decision: { model: 'vision/chat', sticky: false },
        classifierResult: { classification: mockClassification },
      });
    });

    it('skips a non-vision top candidate on the cached-classification-hit path', async () => {
      setVisionBenchmark();
      setVisionCaps();
      cacheReadConversationState.mockResolvedValueOnce(conversationState(mockClassification));
      const response = await decideRequest(
        mirrorPayload({ constraints: { requiredInputModalities: ['image'] } })
      );
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        decision: { model: 'vision/chat', sticky: false },
        classifierResult: { classification: mockClassification },
      });
      expect(classifyNormalizedInput).not.toHaveBeenCalled();
    });

    it('is byte-identical for an old-gateway payload (no constraints field)', async () => {
      vi.spyOn(Math, 'random').mockReturnValue(0);
      const response = await decideRequest(mirrorPayload());
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        decision: { model: 'google/gemini-2.5-flash-lite', sticky: false },
      });
      // No capability fetch on the old-gateway path: the DB chain is not
      // touched by the capability lookup.
      expect(dbWhereCaps).not.toHaveBeenCalled();
    });

    it('proceeds unfiltered when capability lookup fails and constraints only carry an estimate', async () => {
      vi.spyOn(Math, 'random').mockReturnValue(0);
      dbWhereCaps.mockRejectedValue(new Error('db down'));
      const response = await decideRequest(
        mirrorPayload({ constraints: { promptTokensEstimate: 1_000 } })
      );
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        decision: { model: 'google/gemini-2.5-flash-lite', sticky: false },
      });
    });

    it('returns null when capability lookup fails and constraints require an image', async () => {
      dbWhereCaps.mockRejectedValue(new Error('db down'));
      const response = await decideRequest(
        mirrorPayload({ constraints: { requiredInputModalities: ['image'] } })
      );
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        decision: null,
        classifierResult: { classification: mockClassification },
      });
    });

    it('enforces file modality the same way it enforces image', async () => {
      // 'file' is a first-class modality in the gateway's request-side
      // detector and is in ENFORCED_MODALITIES. A candidate without
      // 'file' in its known input_modalities must be excluded.
      setVisionBenchmark();
      dbWhereCaps.mockResolvedValue([
        { openrouterId: 'text-only/chat', inputModalities: ['image'], contextLength: 1_000_000 },
        {
          openrouterId: 'vision/chat',
          inputModalities: ['image', 'file'],
          contextLength: 1_000_000,
        },
      ]);
      const response = await decideRequest(
        mirrorPayload({ constraints: { requiredInputModalities: ['file'] } })
      );
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        decision: { model: 'vision/chat', sticky: false },
      });
    });
  });

  it('returns health without requiring classifier payload fields', async () => {
    const response = await request('/health', {
      headers: { authorization: 'Bearer classifier-token' },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      status: 'ok',
      service: 'auto-routing',
    });
  });

  it('classifies mirrored requests and logs the decision with caller context', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(Math, 'random').mockReturnValue(0);

    const response = await decideRequest(mirrorPayload());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      cost: 0,
      decision: {
        model: expect.any(String),
        taskType: 'implementation',
        subtaskType: 'feature_development',
        source: 'benchmark',
        tableVersion: 'bench-run-1',
        reasoningEffort: null,
        sticky: false,
        switchReason: null,
      },
      classifierResult: {
        classification: mockClassification,
        normalized: normalizedInput,
      },
    });
    expect(classifyNormalizedInput).toHaveBeenCalledWith(env, normalizedInput, 'typesafe/jev-1.13');
    expect(writeDataPoint).toHaveBeenCalledWith({
      indexes: ['google/gemini-2.5-flash-lite'],
      blobs: [
        'google/gemini-2.5-flash-lite',
        'anthropic/claude-sonnet-4',
        'classified',
        'implementation',
        'feature_development',
        'medium',
        'medium',
        'code_change',
        '1',
      ],
      doubles: [expect.any(Number), 0.00000123, 0.82, 0],
    });
    expect(logSpy).toHaveBeenCalledTimes(1);
    const [logMessage] = logSpy.mock.calls[0] ?? [];
    expect(JSON.parse(String(logMessage))).toMatchObject({
      event: 'auto_routing_decision',
      status: 'classified',
      cacheHit: false,
      userIdHash: expect.stringMatching(/^[0-9a-f]{16}$/),
      isAnonymousUser: false,
      sessionId: 'task-123',
      clientRequestId: 'req-1',
      hasMachineId: true,
      mode: 'code',
      uaPrefix: 'Kilo-Code/4.106.0',
      bodyBytes: 2048,
      sticky: false,
      incumbentModel: null,
      switched: false,
      switchReason: null,
      routeChanged: null,
      contextTokens: null,
      sampled: true,
    });
    // The raw user id (which embeds the client IP for anonymous users) must
    // never reach persisted logs.
    expect(String(logMessage)).not.toContain('user-1');
  });

  it('uses organization best-accuracy mode for auto routing decisions', async () => {
    const modes = new Map<string, AutoRoutingMode | null>([
      ['org:00000000-0000-4000-8000-000000000001', 'best_accuracy'],
    ]);
    modeConfigGet.mockImplementation((id: string) => ({
      getMode: vi.fn(async () => modes.get(id) ?? null),
      setMode: vi.fn(async (mode: AutoRoutingMode | null) => {
        modes.set(id, mode);
      }),
      getPool: vi.fn(async () => null),
      setPool: vi.fn(async () => undefined),
      getSettings: vi.fn(async () => ({ mode: modes.get(id) ?? null, pool: null })),
      setSettings: vi.fn(async () => undefined),
    }));
    benchmarkFetch.mockImplementation(async (url: string) => {
      if (String(url).includes('/admin/classifier-winner')) {
        return { ok: true, status: 200, json: async () => ({ winner: null }) };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          table: {
            ...benchmarkRoutingTable,
            routes: {
              ...benchmarkRoutingTable.routes,
              'implementation/feature_development': [
                {
                  model: 'cheap/model',
                  accuracy: 0.8,
                  avgCostUsd: 0.001,
                  meetsThreshold: true,
                  reasoningEffort: null,
                },
                {
                  model: 'accurate/model',
                  accuracy: 0.95,
                  avgCostUsd: 0.1,
                  meetsThreshold: true,
                  reasoningEffort: null,
                },
              ],
            },
          },
          publishedAt: benchmarkRoutingTable.generatedAt,
        }),
      };
    });

    const response = await decideRequest(
      mirrorPayload({
        organizationId: '00000000-0000-4000-8000-000000000001',
      })
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      decision: {
        model: 'accurate/model',
        sticky: false,
      },
    });
  });

  it('falls back to user auto routing mode when org mode is unset', async () => {
    const modes = new Map<string, AutoRoutingMode | null>([['user:user-1', 'best_accuracy']]);
    modeConfigGet.mockImplementation((id: string) => ({
      getMode: vi.fn(async () => modes.get(id) ?? null),
      setMode: vi.fn(async (mode: AutoRoutingMode | null) => {
        modes.set(id, mode);
      }),
      getPool: vi.fn(async () => null),
      setPool: vi.fn(async () => undefined),
      getSettings: vi.fn(async () => ({ mode: modes.get(id) ?? null, pool: null })),
      setSettings: vi.fn(async () => undefined),
    }));
    benchmarkFetch.mockImplementation(async (url: string) => {
      if (String(url).includes('/admin/classifier-winner')) {
        return { ok: true, status: 200, json: async () => ({ winner: null }) };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          table: {
            ...benchmarkRoutingTable,
            routes: {
              ...benchmarkRoutingTable.routes,
              'implementation/feature_development': [
                {
                  model: 'cheap/model',
                  accuracy: 0.8,
                  avgCostUsd: 0.001,
                  meetsThreshold: true,
                  reasoningEffort: null,
                },
                {
                  model: 'accurate/model',
                  accuracy: 0.95,
                  avgCostUsd: 0.1,
                  meetsThreshold: true,
                  reasoningEffort: null,
                },
              ],
            },
          },
          publishedAt: benchmarkRoutingTable.generatedAt,
        }),
      };
    });

    const response = await decideRequest(
      mirrorPayload({
        organizationId: '00000000-0000-4000-8000-000000000001',
      })
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      decision: {
        model: 'accurate/model',
        sticky: false,
      },
    });
  });

  it('reads and updates owner routing mode through admin endpoints', async () => {
    let storedMode: AutoRoutingMode | null = null;
    modeConfigGet.mockImplementation(() => {
      return {
        getMode: vi.fn(async () => storedMode),
        setMode: vi.fn(async (mode: AutoRoutingMode | null) => {
          storedMode = mode;
        }),
        getPool: vi.fn(async () => null),
        setPool: vi.fn(async () => undefined),
        getSettings: vi.fn(async () => ({ mode: storedMode, pool: null })),
        setSettings: vi.fn(
          async (settings: { mode: AutoRoutingMode | null; pool: EfficientModelPool | null }) => {
            storedMode = settings.mode;
          }
        ),
      };
    });

    const updateResponse = await request('/admin/routing-mode', {
      method: 'PUT',
      headers: {
        authorization: 'Bearer classifier-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        ownerType: 'user',
        ownerId: 'user-1',
        mode: 'best_accuracy',
      }),
    });
    expect(updateResponse.status).toBe(200);
    await expect(updateResponse.json()).resolves.toMatchObject({
      ownerType: 'user',
      ownerId: 'user-1',
      mode: 'best_accuracy',
      configuredMode: 'best_accuracy',
      defaultMode: 'cost_per_accuracy',
    });

    const getResponse = await request('/admin/routing-mode?ownerType=user&ownerId=user-1', {
      headers: { authorization: 'Bearer classifier-token' },
    });
    expect(getResponse.status).toBe(200);
    await expect(getResponse.json()).resolves.toMatchObject({
      mode: 'best_accuracy',
      configuredMode: 'best_accuracy',
    });
  });

  describe('admin routing settings', () => {
    const pool: EfficientModelPool = [{ model: 'custom/chat' }];
    const statuses = [
      { entry: { model: 'custom/chat', variant: 'thinking' }, status: 'ready' as const },
    ];

    function ownerSettingsStore(initial?: {
      mode?: AutoRoutingMode | null;
      pool?: EfficientModelPool | null;
    }) {
      let mode: AutoRoutingMode | null = initial?.mode ?? null;
      let poolValue: EfficientModelPool | null = initial?.pool ?? null;
      const setSettings = vi.fn(
        async (settings: { mode: AutoRoutingMode | null; pool: EfficientModelPool | null }) => {
          mode = settings.mode;
          poolValue = settings.pool;
        }
      );
      modeConfigGet.mockImplementation(() => ({
        getMode: vi.fn(async () => mode),
        setMode: vi.fn(async (next: AutoRoutingMode | null) => {
          mode = next;
        }),
        getPool: vi.fn(async () => poolValue),
        setPool: vi.fn(async (next: EfficientModelPool | null) => {
          poolValue = next;
        }),
        getSettings: vi.fn(async () => ({ mode, pool: poolValue })),
        setSettings,
      }));
      return {
        get mode() {
          return mode;
        },
        get pool() {
          return poolValue;
        },
        setSettings,
      };
    }

    it('GET without pool skips the status fetch', async () => {
      ownerSettingsStore({ mode: 'best_accuracy', pool: null });
      const response = await request('/admin/routing-settings?ownerType=user&ownerId=user-1', {
        headers: { authorization: 'Bearer classifier-token' },
      });
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        configuredMode: 'best_accuracy',
        configuredPool: null,
        poolStatuses: [],
      });
      expect(benchmarkFetch).not.toHaveBeenCalledWith(
        expect.stringContaining('/admin/profiles/status'),
        expect.anything()
      );
    });

    it('GET with pool returns statuses from the benchmark worker', async () => {
      ownerSettingsStore({ mode: null, pool });
      benchmarkFetch.mockImplementation(async (url: string) => {
        if (String(url).includes('/admin/profiles/status')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ statuses }),
          };
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({
            table: benchmarkRoutingTable,
            publishedAt: benchmarkRoutingTable.generatedAt,
          }),
        };
      });

      const response = await request('/admin/routing-settings?ownerType=user&ownerId=user-1', {
        headers: { authorization: 'Bearer classifier-token' },
      });
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        configuredPool: pool,
        poolStatuses: statuses,
      });
      expect(benchmarkFetch).toHaveBeenCalledWith(
        expect.stringContaining('/admin/profiles/status'),
        expect.objectContaining({ method: 'POST' })
      );
    });

    it('GET returns 502 when status fetch fails for a configured pool', async () => {
      ownerSettingsStore({ mode: null, pool });
      benchmarkFetch.mockImplementation(async (url: string) => {
        if (String(url).includes('/admin/profiles/status')) {
          return { ok: false, status: 500, text: async () => 'boom', json: async () => ({}) };
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({
            table: benchmarkRoutingTable,
            publishedAt: benchmarkRoutingTable.generatedAt,
          }),
        };
      });

      const response = await request('/admin/routing-settings?ownerType=user&ownerId=user-1', {
        headers: { authorization: 'Bearer classifier-token' },
      });
      expect(response.status).toBe(502);
      await expect(response.json()).resolves.toEqual({
        error: 'Failed to load pool profile statuses',
      });
    });

    it('PUT persists only after successful register and reuses register statuses', async () => {
      const store = ownerSettingsStore();
      benchmarkFetch.mockImplementation(async (url: string) => {
        if (String(url).includes('/admin/profiles/register')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ statuses }),
          };
        }
        throw new Error(`unexpected benchmark call ${url}`);
      });

      const response = await request('/admin/routing-settings', {
        method: 'PUT',
        headers: {
          authorization: 'Bearer classifier-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          ownerType: 'user',
          ownerId: 'user-1',
          mode: 'best_accuracy',
          pool,
        }),
      });
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        configuredMode: 'best_accuracy',
        configuredPool: pool,
        poolStatuses: statuses,
      });
      expect(store.setSettings).toHaveBeenCalledWith({ mode: 'best_accuracy', pool });
      expect(store.pool).toEqual(pool);
      expect(benchmarkFetch).toHaveBeenCalledWith(
        expect.stringContaining('/admin/profiles/register'),
        expect.objectContaining({ method: 'POST' })
      );
      expect(benchmarkFetch).not.toHaveBeenCalledWith(
        expect.stringContaining('/admin/profiles/status'),
        expect.anything()
      );
    });

    it('PUT maps register 429 to 429 with retryAt and persists nothing', async () => {
      const store = ownerSettingsStore({ mode: 'cost_per_accuracy', pool: null });
      const retryAt = '2026-07-29T00:00:00.000Z';
      benchmarkFetch.mockImplementation(async (url: string) => {
        if (String(url).includes('/admin/profiles/register')) {
          return {
            ok: false,
            status: 429,
            json: async () => ({ error: 'quota exceeded', retryAt }),
            text: async () => 'quota exceeded',
          };
        }
        throw new Error(`unexpected benchmark call ${url}`);
      });

      const response = await request('/admin/routing-settings', {
        method: 'PUT',
        headers: {
          authorization: 'Bearer classifier-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          ownerType: 'user',
          ownerId: 'user-1',
          mode: 'best_accuracy',
          pool,
        }),
      });
      expect(response.status).toBe(429);
      await expect(response.json()).resolves.toEqual({
        error: 'quota exceeded',
        retryAt,
      });
      expect(store.setSettings).not.toHaveBeenCalled();
      expect(store.pool).toBeNull();
      expect(store.mode).toBe('cost_per_accuracy');
    });

    it('PUT null pool clears without calling register', async () => {
      const store = ownerSettingsStore({ mode: 'best_accuracy', pool });
      const response = await request('/admin/routing-settings', {
        method: 'PUT',
        headers: {
          authorization: 'Bearer classifier-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          ownerType: 'user',
          ownerId: 'user-1',
          mode: null,
          pool: null,
        }),
      });
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        configuredMode: null,
        configuredPool: null,
        poolStatuses: [],
      });
      expect(store.setSettings).toHaveBeenCalledWith({ mode: null, pool: null });
      expect(benchmarkFetch).not.toHaveBeenCalledWith(
        expect.stringContaining('/admin/profiles/register'),
        expect.anything()
      );
    });

    it('PUT forwards retryEntries on register and persists only after success', async () => {
      const store = ownerSettingsStore();
      const retryEntries = [{ model: 'custom/chat' }];
      let registerBody: unknown;
      benchmarkFetch.mockImplementation(async (url: string, init?: RequestInit) => {
        if (String(url).includes('/admin/profiles/register')) {
          const body = init?.body;
          registerBody =
            typeof body === 'string'
              ? JSON.parse(body)
              : body instanceof Uint8Array
                ? JSON.parse(new TextDecoder().decode(body))
                : undefined;
          return {
            ok: true,
            status: 200,
            json: async () => ({ statuses }),
          };
        }
        throw new Error(`unexpected benchmark call ${url}`);
      });

      const response = await request('/admin/routing-settings', {
        method: 'PUT',
        headers: {
          authorization: 'Bearer classifier-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          ownerType: 'user',
          ownerId: 'user-1',
          mode: 'best_accuracy',
          pool,
          retryEntries,
        }),
      });
      expect(response.status).toBe(200);
      expect(registerBody).toEqual({
        router: 'efficient',
        ownerType: 'user',
        ownerId: 'user-1',
        entries: pool,
        retryEntries,
      });
      expect(store.setSettings).toHaveBeenCalledTimes(1);
      expect(store.setSettings).toHaveBeenCalledWith({ mode: 'best_accuracy', pool });
      expect(store.pool).toEqual(pool);
    });
  });

  describe('custom pool decide path', () => {
    const pool: EfficientModelPool = [{ model: 'pool/chat' }];
    const customTable = {
      version: 'custom-1',
      generatedAt: '2026-06-12T00:00:00.000Z',
      minAccuracy: 0.7,
      switchCostFactor: 3,
      bestAccuracySwitchThreshold: 0.05,
      source: 'benchmark' as const,
      routes: {
        'implementation/feature_development': [
          {
            model: 'pool/chat',
            accuracy: 0.92,
            avgCostUsd: 0.001,
            meetsThreshold: true,
            variant: 'thinking',
          },
        ],
      },
    };

    function setOwnerPool(nextPool: EfficientModelPool | null) {
      modeConfigGet.mockImplementation(() => ({
        getMode: vi.fn(async () => null),
        setMode: vi.fn(async () => undefined),
        getPool: vi.fn(async () => nextPool),
        setPool: vi.fn(async () => undefined),
        getSettings: vi.fn(async () => ({ mode: null, pool: nextPool })),
        setSettings: vi.fn(async () => undefined),
      }));
    }

    it('uses the custom routing table when a pool is configured', async () => {
      setOwnerPool(pool);
      dbWhereCaps.mockResolvedValue([
        {
          openrouterId: 'pool/chat',
          inputModalities: [],
          contextLength: 1_000_000,
          isActive: true,
        },
      ]);
      benchmarkFetch.mockImplementation(async (url: string) => {
        if (String(url).includes('/admin/custom-routing-table')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ table: customTable }),
          };
        }
        if (String(url).includes('/admin/classifier-winner')) {
          return { ok: true, status: 200, json: async () => ({ winner: null }) };
        }
        // Platform table must not be used for the decision.
        return {
          ok: true,
          status: 200,
          json: async () => ({
            table: benchmarkRoutingTable,
            publishedAt: benchmarkRoutingTable.generatedAt,
          }),
        };
      });

      const response = await decideRequest(mirrorPayload());
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        decision: {
          model: 'pool/chat',
          variant: 'thinking',
          source: 'benchmark',
          tableVersion: 'custom-1',
        },
      });
      expect(benchmarkFetch).toHaveBeenCalledWith(
        expect.stringContaining('/admin/custom-routing-table'),
        expect.objectContaining({ method: 'POST' })
      );
      expect(cachePutEntry).toHaveBeenCalledWith(
        'sticky',
        expect.objectContaining({
          model: 'pool/chat',
          variant: 'thinking',
        })
      );
    });

    it('allows every effort of pool models and rejects models outside the pool', async () => {
      setOwnerPool(pool);
      dbWhereCaps.mockResolvedValue([
        {
          openrouterId: 'pool/chat',
          inputModalities: [],
          contextLength: 1_000_000,
          isActive: true,
        },
        {
          openrouterId: 'outside/chat',
          inputModalities: [],
          contextLength: 1_000_000,
          isActive: true,
        },
      ]);
      benchmarkFetch.mockImplementation(async (url: string) => {
        if (String(url).includes('/admin/custom-routing-table')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              table: {
                ...customTable,
                routes: {
                  'implementation/feature_development': [
                    {
                      model: 'outside/chat',
                      variant: 'max',
                      accuracy: 1,
                      avgCostUsd: 0,
                      meetsThreshold: true,
                    },
                    {
                      model: 'pool/chat',
                      variant: 'max',
                      accuracy: 1,
                      avgCostUsd: 0.0001,
                      meetsThreshold: true,
                    },
                    ...customTable.routes['implementation/feature_development'],
                  ],
                },
              },
            }),
          };
        }
        return { ok: true, status: 200, json: async () => ({ winner: null }) };
      });
      const response = await decideRequest(mirrorPayload());
      await expect(response.json()).resolves.toMatchObject({
        decision: { model: 'pool/chat', variant: 'max' },
      });
    });

    it('returns a null decision when custom table lookup fails', async () => {
      setOwnerPool(pool);
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      benchmarkFetch.mockImplementation(async (url: string) => {
        if (String(url).includes('/admin/custom-routing-table')) {
          return { ok: false, status: 500, text: async () => 'fail', json: async () => ({}) };
        }
        if (String(url).includes('/admin/classifier-winner')) {
          return { ok: true, status: 200, json: async () => ({ winner: null }) };
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({
            table: benchmarkRoutingTable,
            publishedAt: benchmarkRoutingTable.generatedAt,
          }),
        };
      });

      const response = await decideRequest(mirrorPayload());
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({ decision: null });
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('auto_routing_custom_table_read_failed')
      );
      warn.mockRestore();
    });

    it('keeps the null-pool path on the platform cached table', async () => {
      setOwnerPool(null);
      const response = await decideRequest(mirrorPayload());
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        decision: {
          model: 'google/gemini-2.5-flash-lite',
          source: 'benchmark',
          tableVersion: 'bench-run-1',
        },
      });
      expect(benchmarkFetch).not.toHaveBeenCalledWith(
        expect.stringContaining('/admin/custom-routing-table'),
        expect.anything()
      );
    });

    it('loads capabilities once with pool model ids for constraints+pool', async () => {
      setOwnerPool(pool);
      dbWhereCaps.mockResolvedValue([
        {
          openrouterId: 'pool/chat',
          inputModalities: ['image'],
          contextLength: 1_000_000,
          isActive: true,
        },
      ]);
      benchmarkFetch.mockImplementation(async (url: string) => {
        if (String(url).includes('/admin/custom-routing-table')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ table: customTable }),
          };
        }
        if (String(url).includes('/admin/classifier-winner')) {
          return { ok: true, status: 200, json: async () => ({ winner: null }) };
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({
            table: benchmarkRoutingTable,
            publishedAt: benchmarkRoutingTable.generatedAt,
          }),
        };
      });

      const response = await decideRequest(
        mirrorPayload({ constraints: { requiredInputModalities: ['image'] } })
      );
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        decision: {
          model: 'pool/chat',
          variant: 'thinking',
          source: 'benchmark',
        },
      });
      expect(getModelCapabilitiesMock).toHaveBeenCalledTimes(1);
      expect(getModelCapabilitiesMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          additionalModelIds: ['pool/chat'],
        })
      );
    });
  });

  it('filters denied routing-policy models from the full decide path', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);

    const response = await decideRequest(
      mirrorPayload({
        routingPolicy: { deniedModelIds: ['google/gemini-2.5-flash-lite'] },
      })
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      decision: {
        model: 'google/gemini-2.5-flash',
        taskType: 'implementation',
        subtaskType: 'feature_development',
        source: 'benchmark',
        tableVersion: 'bench-run-1',
        sticky: false,
      },
    });
  });

  it('serves a cached classification for the session without calling the classifier', async () => {
    cacheReadConversationState.mockResolvedValueOnce(conversationState(mockClassification));

    const response = await decideRequest(mirrorPayload());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      cost: 0,
      decision: {
        model: expect.any(String),
        taskType: 'implementation',
        subtaskType: 'feature_development',
        source: 'benchmark',
        tableVersion: 'bench-run-1',
        reasoningEffort: null,
        sticky: false,
      },
      classifierResult: { classification: mockClassification },
    });
    expect(cacheIdFromName).toHaveBeenCalledWith('efficient:user:user-1:task:task-123');
    expect(classifyNormalizedInput).not.toHaveBeenCalled();
    // The classification is not re-cached; only the served model is
    // remembered for session stickiness.
    expect(cachePutEntry).toHaveBeenCalledTimes(1);
    expect(cachePutEntry).toHaveBeenCalledWith('sticky', {
      model: expect.any(String),
      variant: null,
      routeKey: 'implementation/feature_development',
    });
    expect(writeDataPoint).toHaveBeenCalledWith(
      expect.objectContaining({
        doubles: [0, 0, mockClassification.confidence, 1],
      })
    );
  });

  it('caches fresh classifications for the conversation', async () => {
    const response = await decideRequest(mirrorPayload());

    expect(response.status).toBe(200);
    expect(cachePutEntry).toHaveBeenCalledWith(
      expect.stringMatching(/^efficient:google\/gemini-2\.5-flash-lite:[0-9a-f]{16}$/),
      expect.objectContaining({ taskType: 'implementation' })
    );
  });

  it('waits for classification on the first turn', async () => {
    const classifier = Promise.withResolvers<typeof mockClassifierResult>();
    classifyNormalizedInput.mockReturnValueOnce(classifier.promise);
    let finished = false;
    const pending = Promise.resolve(decideRequest(mirrorPayload())).then(response => {
      finished = true;
      return response;
    });
    try {
      await vi.waitFor(() => expect(classifyNormalizedInput).toHaveBeenCalledTimes(1));
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(finished).toBe(false);
    } finally {
      classifier.resolve(mockClassifierResult);
    }
    await expect((await pending).json()).resolves.toMatchObject({
      cost: 0,
      classifierResult: { classification: mockClassification },
    });
  });

  describe('turn-one speculative classification', () => {
    const classifierModel = 'typesafe/jev-1.13';
    const classifierResult: ClassifierRunResult = {
      ...mockClassifierResult,
      classifierModel,
      classification: mockClassification as ClassifierOutput,
    };
    const generation = 1_780_000_000_000;

    beforeEach(() => {
      vi.spyOn(Date, 'now').mockReturnValue(generation);
      vi.spyOn(performance, 'now').mockReturnValue(10);
    });

    async function expectClassifierUsage(
      input: NormalizedClassifierInput,
      kind: ClassifierCallKind,
      cost: number
    ) {
      await drainBackgroundTasks();
      const hashes = await computeContentHashes(input);
      const expected = await buildClassifierUsage(
        mirrorPayload({ input }),
        {
          conversationKey: 'user:user-1:task:task-123',
          classifierModel,
          contentHash: hashes.exact,
          kind,
          requestStart: `${generation}:10`,
        },
        cost,
        new Date(generation).toISOString()
      );
      expect(cacheRecordClassifierUsage).toHaveBeenCalledTimes(1);
      expect(cacheRecordClassifierUsage).toHaveBeenCalledWith(expected);
      expect(mockedFetch).toHaveBeenCalledTimes(1);
      const body = mockedFetch.mock.calls[0]?.[1]?.body;
      expect(typeof body).toBe('string');
      expect(JSON.parse(body as string)).toEqual(expected);
    }

    describe.each([1, 2, null])('messageCount=%s', messageCount => {
      it.each(['classifier', 'cache'] as const)(
        'overlaps the DO read and classifier when %s settles first',
        async first => {
          const cache = Promise.withResolvers<TestConversationState>();
          const classifier = Promise.withResolvers<ClassifierRunResult>();
          cacheReadConversationState.mockReturnValueOnce(cache.promise);
          classifyNormalizedInput.mockReturnValueOnce(classifier.promise);
          vi.spyOn(Math, 'random').mockReturnValue(0);
          const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
          let now = 10;
          vi.spyOn(performance, 'now').mockImplementation(() => now);
          let finished = false;
          const pending = Promise.resolve(
            decideRequest(mirrorPayload({ input: { ...normalizedInput, messageCount } }))
          ).then(response => {
            finished = true;
            return response;
          });
          try {
            await vi.waitFor(() => {
              expect(cacheReadConversationState).toHaveBeenCalledTimes(1);
              expect(classifyNormalizedInput).toHaveBeenCalledTimes(1);
            });
            expect(finished).toBe(false);
            now = 30;
            if (first === 'classifier') classifier.resolve(classifierResult);
            else cache.resolve(conversationState());
            await new Promise<void>(resolve => setImmediate(resolve));
            expect(finished).toBe(false);
            now = 70;
            if (first === 'classifier') cache.resolve(conversationState());
            else classifier.resolve(classifierResult);
            const response = await pending;
            await expect(response.json()).resolves.toMatchObject({
              cost: 0,
              classifierResult: { classification: mockClassification },
            });
            expect(logSpy).toHaveBeenCalledWith(
              expect.stringContaining('"classification":"speculative"')
            );
            const [message] = logSpy.mock.calls[0] ?? [];
            expect(JSON.parse(String(message))).toMatchObject({
              classification: 'speculative',
              classifierCostCredits: classifierResult.cost,
              timings: {
                classifierMs: first === 'classifier' ? 20 : 60,
                cacheReadMs: first === 'cache' ? 20 : 60,
                totalMs: 60,
              },
            });
            expect(cachePutEntry).toHaveBeenCalledWith(
              expect.stringMatching(/^efficient:typesafe\/jev-1\.13:/),
              mockClassification
            );
            expect(cachePutStickyDecision).toHaveBeenCalledTimes(1);
          } finally {
            cache.resolve(conversationState());
            classifier.resolve(classifierResult);
            await pending;
          }
          await expectClassifierUsage(
            { ...normalizedInput, messageCount } as NormalizedClassifierInput,
            'speculative',
            classifierResult.cost ?? 0
          );
        }
      );
    });

    describe.each(['success', 'billed failure'] as const)('cache hit with %s', result => {
      it.each(['before', 'after'] as const)(
        'bills the speculative cost once when classification settles %s the response',
        async order => {
          const store = mockStoredConversation();
          const input = { ...normalizedInput, messageCount: 2 };
          const hashes = await computeContentHashes(input as NormalizedClassifierInput);
          store.set(`${classifierModel}:${hashes.exact}`, mockClassification);
          const cache = Promise.withResolvers<TestConversationState>();
          const classifier = Promise.withResolvers<ClassifierRunResult>();
          cacheReadConversationState.mockReturnValueOnce(cache.promise);
          classifyNormalizedInput.mockReturnValueOnce(classifier.promise);
          vi.spyOn(Math, 'random').mockReturnValue(0.99);
          const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
          const settleClassifier = () => {
            if (result === 'success') classifier.resolve(classifierResult);
            else {
              classifier.reject(
                new ClassifierRunError('Invalid classification', {
                  cost: classifierResult.cost,
                  classifierModel,
                  failureStage: 'invalid_response',
                })
              );
            }
          };
          let response: Response | undefined;
          const pending = Promise.resolve(decideRequest(mirrorPayload({ input }))).then(value => {
            response = value;
            return value;
          });
          try {
            await vi.waitFor(() => {
              expect(cacheReadConversationState).toHaveBeenCalledTimes(1);
              expect(classifyNormalizedInput).toHaveBeenCalledTimes(1);
            });
            if (order === 'before') {
              settleClassifier();
              await new Promise<void>(resolve => setImmediate(resolve));
            }
            cache.resolve(conversationState(mockClassification));
            await vi.waitFor(() => expect(response).toBeDefined());
            await expect((await pending).json()).resolves.toMatchObject({
              cost: 0,
              classifierResult: { classification: mockClassification },
            });
            if (order === 'after') expect(cacheRecordClassifierUsage).not.toHaveBeenCalled();
            if (order === 'before') {
              expect(logSpy).toHaveBeenCalledWith(
                expect.stringContaining('"classification":"cache"')
              );
            } else {
              expect(logSpy).not.toHaveBeenCalled();
              expect(writeDataPoint).not.toHaveBeenCalled();
            }
          } finally {
            cache.resolve(conversationState(mockClassification));
            settleClassifier();
            await pending;
            await drainBackgroundTasks();
          }
          expect(logSpy).toHaveBeenCalledTimes(1);
          const [logMessage] = logSpy.mock.calls[0] ?? [];
          const loggedDecision = JSON.parse(String(logMessage));
          expect(loggedDecision).toMatchObject({
            event: 'auto_routing_decision',
            classification: 'cache',
            cacheHit: true,
            classifierCostCredits: classifierResult.cost,
            sampled: false,
            timings: { classifierMs: expect.any(Number) },
          });
          expect(loggedDecision).not.toHaveProperty('deferredClassifierCostCredits');
          expect(writeDataPoint).toHaveBeenCalledTimes(1);
          expect(writeDataPoint).toHaveBeenCalledWith(
            expect.objectContaining({
              doubles: [0, classifierResult.cost, mockClassification.confidence, 1],
            })
          );
          await expectClassifierUsage(
            input as NormalizedClassifierInput,
            'speculative',
            classifierResult.cost ?? 0
          );
          await expect(
            (await decideRequest(mirrorPayload({ input }))).json()
          ).resolves.toMatchObject({
            cost: 0,
          });
          await drainBackgroundTasks();
          await expect(
            (await decideRequest(mirrorPayload({ input }))).json()
          ).resolves.toMatchObject({
            cost: 0,
          });
          expect(classifyNormalizedInput).toHaveBeenCalledTimes(1);
          await expectClassifierUsage(
            input as NormalizedClassifierInput,
            'speculative',
            classifierResult.cost ?? 0
          );
        }
      );
    });

    it('does not speculate for later turns', async () => {
      const cache = Promise.withResolvers<TestConversationState>();
      cacheReadConversationState.mockReturnValueOnce(cache.promise);
      const pending = decideRequest(mirrorPayload());
      try {
        await vi.waitFor(() => expect(cacheReadConversationState).toHaveBeenCalledTimes(1));
        await new Promise<void>(resolve => setImmediate(resolve));
        expect(classifyNormalizedInput).not.toHaveBeenCalled();
      } finally {
        cache.resolve(conversationState());
        await pending;
      }
      expect(classifyNormalizedInput).toHaveBeenCalledTimes(1);
      await expectClassifierUsage(
        normalizedInput as NormalizedClassifierInput,
        'sync',
        mockClassifierResult.cost
      );
    });

    it('does not speculate for a hot-cache hit', async () => {
      const input = { ...normalizedInput, messageCount: 2 };
      cacheReadConversationState.mockResolvedValueOnce(conversationState(mockClassification));
      await decideRequest(mirrorPayload({ input: { ...input, messageCount: 3 } }));
      expect(classifyNormalizedInput).not.toHaveBeenCalled();
      const cache = Promise.withResolvers<TestConversationState>();
      cacheReadConversationState.mockReturnValueOnce(cache.promise);
      const pending = decideRequest(mirrorPayload({ input }));
      try {
        await vi.waitFor(() => expect(cacheReadConversationState).toHaveBeenCalledTimes(2));
        await new Promise<void>(resolve => setImmediate(resolve));
        expect(classifyNormalizedInput).not.toHaveBeenCalled();
      } finally {
        cache.resolve(conversationState());
      }
      await expect((await pending).json()).resolves.toMatchObject({
        cost: 0,
        classifierResult: { classification: mockClassification },
      });
      expect(classifyNormalizedInput).not.toHaveBeenCalled();
      await drainBackgroundTasks();
      expect(cacheRecordClassifierUsage).not.toHaveBeenCalled();
    });

    it.each(['success', 'billed failure'] as const)(
      'reuses the speculative %s for a sticky-immediate response without billing it twice',
      async result => {
        const store = mockStoredConversation();
        store.set('sticky', {
          model: 'google/gemini-2.5-flash-lite',
          variant: null,
          routeKey: 'implementation/feature_development',
        });
        const input = { ...normalizedInput, messageCount: 2 };
        const classifier = Promise.withResolvers<ClassifierRunResult>();
        classifyNormalizedInput.mockReturnValueOnce(classifier.promise);
        vi.spyOn(Math, 'random').mockReturnValue(0.99);
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        let response: Response | undefined;
        const pending = Promise.resolve(decideRequest(mirrorPayload({ input }))).then(value => {
          response = value;
          return value;
        });
        try {
          await vi.waitFor(() => expect(response).toBeDefined());
          await expect((await pending).json()).resolves.toMatchObject({
            cost: 0,
            decision: { model: 'google/gemini-2.5-flash-lite' },
            classifierResult: null,
          });
          expect(classifyNormalizedInput).toHaveBeenCalledTimes(1);
          expect(cacheRecordClassifierUsage).not.toHaveBeenCalled();
        } finally {
          if (result === 'success') classifier.resolve(classifierResult);
          else {
            classifier.reject(
              new ClassifierRunError('Invalid classification', {
                cost: classifierResult.cost,
                classifierModel,
                failureStage: 'invalid_response',
              })
            );
          }
          await pending;
          await drainBackgroundTasks();
        }
        await expectClassifierUsage(
          input as NormalizedClassifierInput,
          'speculative',
          classifierResult.cost ?? 0
        );
        const decisionLogs = [...logSpy.mock.calls, ...warnSpy.mock.calls]
          .map(([message]) => JSON.parse(String(message)))
          .filter(entry => entry.event === 'auto_routing_decision');
        expect(decisionLogs).toHaveLength(1);
        expect(decisionLogs[0]).toMatchObject({
          classification: 'background',
          classifierCostCredits: classifierResult.cost,
          sampled: false,
        });
        expect(decisionLogs[0]).not.toHaveProperty('deferredClassifierCostCredits');
        expect(writeDataPoint).toHaveBeenCalledTimes(1);
        expect(writeDataPoint.mock.calls[0]?.[0]?.doubles[1]).toBe(classifierResult.cost);
        classifyNormalizedInput.mockRejectedValue(new Error('unbilled failure'));
        await expect((await decideRequest(mirrorPayload({ input }))).json()).resolves.toMatchObject(
          {
            cost: 0,
          }
        );
        await drainBackgroundTasks();
        await expect((await decideRequest(mirrorPayload({ input }))).json()).resolves.toMatchObject(
          {
            cost: 0,
          }
        );
        await expectClassifierUsage(
          input as NormalizedClassifierInput,
          'speculative',
          classifierResult.cost ?? 0
        );
        expect(classifyNormalizedInput).toHaveBeenCalledTimes(result === 'success' ? 1 : 3);
      }
    );

    it('bills a speculative failure on a miss exactly once', async () => {
      mockStoredConversation();
      const cache = Promise.withResolvers<TestConversationState>();
      cacheReadConversationState.mockReturnValueOnce(cache.promise);
      classifyNormalizedInput.mockRejectedValueOnce(
        new ClassifierRunError('Invalid classification', {
          cost: classifierResult.cost,
          classifierModel,
          failureStage: 'invalid_response',
        })
      );
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const pending = decideRequest(
        mirrorPayload({ input: { ...normalizedInput, messageCount: 2 } })
      );
      try {
        await vi.waitFor(() => expect(classifyNormalizedInput).toHaveBeenCalledTimes(1));
        await new Promise<void>(resolve => setImmediate(resolve));
      } finally {
        cache.resolve(conversationState());
      }
      await expect((await pending).json()).resolves.toEqual({
        cost: 0,
        decision: null,
        classifierResult: null,
      });
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('"classification":"speculative"')
      );
      await expectClassifierUsage(
        { ...normalizedInput, messageCount: 2 } as NormalizedClassifierInput,
        'speculative',
        classifierResult.cost ?? 0
      );
      expect(cachePutEntry).not.toHaveBeenCalled();
      classifyNormalizedInput.mockRejectedValueOnce(new Error('unbilled failure'));
      await expect(
        (
          await decideRequest(mirrorPayload({ input: { ...normalizedInput, messageCount: 2 } }))
        ).json()
      ).resolves.toMatchObject({ cost: 0 });
      await expectClassifierUsage(
        { ...normalizedInput, messageCount: 2 } as NormalizedClassifierInput,
        'speculative',
        classifierResult.cost ?? 0
      );
    });
  });

  it('returns the incumbent immediately, refreshes the next route, and bills background cost once', async () => {
    mockStoredConversation();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const classifierResult = {
      ...mockClassifierResult,
      classifierModel: 'typesafe/jev-1.13',
    } as ClassifierRunResult;
    classifyNormalizedInput.mockResolvedValue(classifierResult);
    const first = await decideRequest(mirrorPayload());
    await expect(first.json()).resolves.toMatchObject({
      cost: 0,
      decision: { model: 'google/gemini-2.5-flash-lite' },
      classifierResult: { classification: mockClassification },
    });
    await drainBackgroundTasks();

    const backgroundClassifier = Promise.withResolvers<ClassifierRunResult>();
    classifyNormalizedInput.mockReturnValueOnce(backgroundClassifier.promise);
    const secondPayload = mirrorPayload({
      input: { ...normalizedInput, userPromptPrefix: 'Design the system next.' },
    });
    let secondResponse: Response | undefined;
    const second = Promise.resolve(decideRequest(secondPayload)).then(response => {
      secondResponse = response;
      return response;
    });
    try {
      await vi.waitFor(() => expect(secondResponse).toBeDefined());
      await expect((await second).json()).resolves.toMatchObject({
        cost: 0,
        decision: {
          model: 'google/gemini-2.5-flash-lite',
          taskType: 'implementation',
          subtaskType: 'feature_development',
          sticky: false,
        },
        classifierResult: null,
      });
    } finally {
      backgroundClassifier.resolve({
        ...classifierResult,
        classification: {
          ...classifierResult.classification,
          taskType: 'planning_design',
          subtaskType: 'system_design',
        },
      });
      await second;
      await drainBackgroundTasks();
    }
    const backgroundLog = logSpy.mock.calls
      .map(([message]) => JSON.parse(String(message)))
      .find(entry => entry.classification === 'background');
    expect(backgroundLog).toMatchObject({
      event: 'auto_routing_decision',
      decidedModel: 'anthropic/claude-sonnet-4.6',
      timings: { classifierMs: expect.any(Number), totalMs: expect.any(Number) },
    });

    const thirdClassifier = Promise.withResolvers<ClassifierRunResult>();
    classifyNormalizedInput.mockReturnValueOnce(thirdClassifier.promise);
    let thirdResponse: Response | undefined;
    const third = Promise.resolve(
      decideRequest(
        mirrorPayload({
          input: { ...normalizedInput, userPromptPrefix: 'Continue the system design.' },
        })
      )
    ).then(response => {
      thirdResponse = response;
      return response;
    });
    try {
      await vi.waitFor(() => expect(thirdResponse).toBeDefined());
      await expect((await third).json()).resolves.toMatchObject({
        cost: 0,
        decision: {
          model: 'anthropic/claude-sonnet-4.6',
          taskType: 'planning_design',
          subtaskType: 'system_design',
          sticky: false,
        },
        classifierResult: null,
      });
    } finally {
      thirdClassifier.resolve({ ...classifierResult, cost: 0 });
      await third;
      await drainBackgroundTasks();
    }
    await expect((await decideRequest(secondPayload)).json()).resolves.toMatchObject({
      cost: 0,
      decision: { model: 'anthropic/claude-sonnet-4.6' },
      classifierResult: { classification: { taskType: 'planning_design' } },
    });
  });

  it.each(['sync', 'background', 'billed-failure'] as const)(
    'posts one classifier usage event on the %s path without another session turn',
    async path => {
      const store = mockStoredConversation();
      if (path === 'background') {
        store.set('sticky', {
          model: 'google/gemini-2.5-flash-lite',
          variant: null,
          routeKey: 'implementation/feature_development',
        });
      }
      if (path === 'billed-failure') {
        classifyNormalizedInput.mockRejectedValueOnce(
          new ClassifierRunError('Invalid classification', {
            cost: mockClassifierResult.cost,
            classifierModel: mockClassifierResult.classifierModel,
            failureStage: 'invalid_response',
          })
        );
      }
      const response = await decideRequest(mirrorPayload());
      await expect(response.json()).resolves.toMatchObject({ cost: 0 });
      await drainBackgroundTasks();
      expect(classifyNormalizedInput).toHaveBeenCalledTimes(1);
      expect(cacheRecordClassifierUsage).toHaveBeenCalledTimes(1);
      expect(mockedFetch).toHaveBeenCalledTimes(1);
      const usage = cacheRecordClassifierUsage.mock.calls[0]?.[0];
      expect(UsageRecordRequestSchema.parse(usage)).toMatchObject({
        core: {
          id: expect.any(String),
          kilo_user_id: 'user-1',
          model: 'auto-routing/classifier',
          cost: Math.round(mockClassifierResult.cost * 1_000_000),
        },
        posthog_distinct_id: null,
      });
      const body = mockedFetch.mock.calls[0]?.[1]?.body;
      if (typeof body !== 'string') throw new Error('Expected serialized usage body');
      expect(JSON.parse(body)).toEqual(usage);
      expect(mockedFetch.mock.calls[0]?.[1]?.headers).toMatchObject({
        'x-internal-api-key': 'classifier-token',
      });
    }
  );

  it('preserves one usage id per sync and background call through actual DO alarm retries', async () => {
    const entries = new Map<string, unknown>();
    let alarm: number | null = null;
    let now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const storage = {
      get: async (key: string | string[]) =>
        Array.isArray(key)
          ? new Map(key.filter(item => entries.has(item)).map(item => [item, entries.get(item)]))
          : entries.get(key),
      put: async (key: string, value: unknown) => {
        entries.set(key, value);
      },
      delete: async (keys: string | string[]) => {
        for (const key of Array.isArray(keys) ? keys : [keys]) entries.delete(key);
      },
      list: async () => new Map(entries),
      getAlarm: async () => alarm,
      setAlarm: async (time: number) => {
        alarm = time;
      },
    };
    const cacheDO = new AutoRoutingDecisionCacheDO(
      { storage } as unknown as DurableObjectState,
      env as unknown as Env
    );
    cacheReadConversationState.mockImplementation((key: string) =>
      cacheDO.readConversationState(key)
    );
    cachePutEntry.mockImplementation(
      (key: string, value: Parameters<AutoRoutingDecisionCacheDO['putEntry']>[1]) =>
        cacheDO.putEntry(key, value)
    );
    cachePutStickyDecision.mockImplementation(
      (value: Parameters<AutoRoutingDecisionCacheDO['putStickyDecision']>[0], generation: number) =>
        cacheDO.putStickyDecision(value, generation)
    );
    cacheRecordClassifierUsage.mockImplementation((usage: UsageRecordRequest) =>
      cacheDO.recordClassifierUsage(usage)
    );

    const deliveries: UsageRecordRequest[] = [];
    const attempts = new Map<string, number>();
    mockedFetch.mockImplementation(async (_url, init) => {
      const body = init?.body;
      if (typeof body !== 'string') throw new Error('Expected serialized usage body');
      const usage = UsageRecordRequestSchema.parse(JSON.parse(body));
      deliveries.push(usage);
      const attempt = (attempts.get(usage.core.id) ?? 0) + 1;
      attempts.set(usage.core.id, attempt);
      if (attempt === 1) return new Response(null, { status: 503 });
      return Response.json({
        status: 'recorded',
        result: {
          usageId: usage.core.id,
          createdAt: usage.core.created_at,
          newMicrodollarsUsed: usage.core.cost,
        },
      });
    });
    const runAlarm = async () => {
      if (alarm === null) throw new Error('Expected a usage retry alarm');
      now = alarm;
      alarm = null;
      await cacheDO.alarm();
    };
    const classifierModel = await getClassifierModel(env as unknown as Env);
    classifyNormalizedInput.mockResolvedValueOnce({
      ...mockClassifierResult,
      classifierModel,
      cost: 0.000013,
    });
    const sync = await decideRequest(mirrorPayload());
    await expect(sync.json()).resolves.toMatchObject({ cost: 0 });
    await drainBackgroundTasks();
    expect(deliveries).toHaveLength(1);
    expect([...entries.keys()].filter(key => key.startsWith('usage:'))).toHaveLength(1);
    await runAlarm();
    expect(deliveries).toHaveLength(2);
    expect(deliveries[1]).toEqual(deliveries[0]);
    expect([...entries.keys()].filter(key => key.startsWith('usage:'))).toHaveLength(0);

    classifyNormalizedInput.mockResolvedValueOnce({
      ...mockClassifierResult,
      classifierModel,
      cost: 0.000029,
    });
    const nextTurn = mirrorPayload({
      input: { ...normalizedInput, userPromptPrefix: 'A different session turn' },
    });
    const background = await decideRequest(nextTurn);
    await expect(background.json()).resolves.toMatchObject({ cost: 0, classifierResult: null });
    await drainBackgroundTasks();
    expect(deliveries).toHaveLength(3);
    await runAlarm();
    expect(deliveries).toHaveLength(4);
    expect(deliveries[3]).toEqual(deliveries[2]);
    expect([...entries.keys()].filter(key => key.startsWith('usage:'))).toHaveLength(0);

    const repeated = await decideRequest(nextTurn);
    await expect(repeated.json()).resolves.toMatchObject({
      cost: 0,
      classifierResult: { classification: mockClassification },
    });
    await drainBackgroundTasks();
    expect(classifyNormalizedInput).toHaveBeenCalledTimes(2);
    expect(cacheRecordClassifierUsage).toHaveBeenCalledTimes(2);
    expect(deliveries).toHaveLength(4);
    expect(attempts.size).toBe(2);
    expect([...attempts.values()]).toEqual([2, 2]);
    for (const cost of [13, 29]) {
      const ids = new Set(
        deliveries.filter(usage => usage.core.cost === cost).map(usage => usage.core.id)
      );
      expect(ids.size).toBe(1);
    }
  });

  it('keeps in-flight classification in waitUntil and bills without consuming the decide response', async () => {
    const classifier = Promise.withResolvers<ClassifierRunResult>();
    classifyNormalizedInput.mockReturnValueOnce(classifier.promise);
    const pending = decideRequest(mirrorPayload());
    try {
      await vi.waitFor(() => expect(classifyNormalizedInput).toHaveBeenCalledTimes(1));
      expect(backgroundTasks.length).toBeGreaterThan(0);
    } finally {
      classifier.resolve(mockClassifierResult as ClassifierRunResult);
      await pending;
      await drainBackgroundTasks();
    }
    expect(cacheRecordClassifierUsage).toHaveBeenCalledTimes(1);
    expect(mockedFetch).toHaveBeenCalledTimes(1);
  });

  it('leaves the sticky route unchanged when background classification fails without usage', async () => {
    const store = mockStoredConversation();
    const sticky = {
      model: 'google/gemini-2.5-flash-lite',
      variant: null,
      routeKey: 'implementation/feature_development',
    };
    store.set('sticky', sticky);
    classifyNormalizedInput.mockRejectedValue(new Error('classifier unavailable'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const response = await decideRequest(mirrorPayload());
    await expect(response.json()).resolves.toMatchObject({
      cost: 0,
      decision: { model: sticky.model },
      classifierResult: null,
    });
    await drainBackgroundTasks();
    expect(store.get('sticky')).toEqual(sticky);
    await expect((await decideRequest(mirrorPayload())).json()).resolves.toMatchObject({
      cost: 0,
      decision: { model: sticky.model },
      classifierResult: null,
    });
    await drainBackgroundTasks();
    expect(cacheRecordClassifierUsage).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('"event":"auto_routing_background_classify_failed"')
    );
  });

  it('bills a paid background failure immediately and never bills it on a later turn', async () => {
    const store = mockStoredConversation();
    store.set('sticky', {
      model: 'google/gemini-2.5-flash-lite',
      variant: null,
      routeKey: 'implementation/feature_development',
    });
    const cost = 0.03;
    classifyNormalizedInput.mockRejectedValueOnce(
      new ClassifierRunError('Invalid classification', {
        cost,
        classifierModel: mockClassifierResult.classifierModel,
        failureStage: 'invalid_response',
      })
    );
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect((await decideRequest(mirrorPayload())).json()).resolves.toMatchObject({ cost: 0 });
    await drainBackgroundTasks();
    expect(cacheRecordClassifierUsage).toHaveBeenCalledTimes(1);
    expect(mockedFetch).toHaveBeenCalledTimes(1);
    classifyNormalizedInput.mockRejectedValue(new Error('unbilled failure'));
    await expect((await decideRequest(mirrorPayload())).json()).resolves.toMatchObject({ cost: 0 });
    await drainBackgroundTasks();
    await expect((await decideRequest(mirrorPayload())).json()).resolves.toMatchObject({ cost: 0 });
    await drainBackgroundTasks();
    expect(cacheRecordClassifierUsage).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])(
    'orders background sticky writes by request start time (equal timestamps: %s)',
    async equalTimestamps => {
      const olderStartedAt = Date.now();
      const now = vi.spyOn(Date, 'now').mockReturnValue(olderStartedAt);
      const store = mockStoredConversation();
      store.set('sticky', {
        model: 'google/gemini-2.5-flash-lite',
        variant: null,
        routeKey: 'implementation/feature_development',
      });
      const older = Promise.withResolvers<ClassifierRunResult>();
      classifyNormalizedInput.mockReturnValueOnce(older.promise);
      await decideRequest(
        mirrorPayload({
          input: { ...normalizedInput, userPromptPrefix: 'Turn A' },
        })
      );
      const olderTasks = backgroundTasks.splice(0);
      classifyNormalizedInput.mockResolvedValueOnce({
        ...mockClassifierResult,
        classification: {
          ...mockClassification,
          taskType: 'planning_design',
          subtaskType: 'system_design',
        },
      });
      now.mockReturnValue(olderStartedAt + (equalTimestamps ? 0 : 1));
      await decideRequest(
        mirrorPayload({
          input: { ...normalizedInput, userPromptPrefix: 'Turn B' },
        })
      );
      await drainBackgroundTasks();
      const newerSticky = store.get('sticky');
      expect(newerSticky).toMatchObject({ routeKey: 'planning_design/system_design' });
      older.resolve(mockClassifierResult as ClassifierRunResult);
      await Promise.all(olderTasks);
      if (equalTimestamps) {
        expect(store.get('sticky')).toMatchObject({
          routeKey: 'implementation/feature_development',
        });
      } else {
        expect(store.get('sticky')).toEqual(newerSticky);
      }
      expect(cachePutStickyDecision.mock.calls.map(([, generation]) => generation)).toEqual([
        olderStartedAt + (equalTimestamps ? 0 : 1),
        olderStartedAt,
      ]);
      await drainBackgroundTasks();
      expect(cacheRecordClassifierUsage).toHaveBeenCalledTimes(2);
    }
  );

  it('keeps the session on the incumbent model when the taxonomy route changes', async () => {
    const store = new Map<string, unknown>();
    cacheReadConversationState.mockImplementation(async (key: string) =>
      conversationState(store.get(key) ?? null, store.get('sticky') ?? null)
    );
    cachePutEntry.mockImplementation(async (key: string, value: unknown) => {
      store.set(key, value);
    });

    classifyNormalizedInput.mockResolvedValueOnce({
      ...mockClassifierResult,
      classification: {
        ...mockClassification,
        taskType: 'planning_design',
        subtaskType: 'system_design',
      },
    });
    const first = await decideRequest(mirrorPayload());
    expect(first.status).toBe(200);
    await expect(first.json()).resolves.toMatchObject({
      decision: {
        model: 'anthropic/claude-sonnet-4.6',
        taskType: 'planning_design',
        subtaskType: 'system_design',
        sticky: false,
      },
    });
    store.set('sticky', { model: 'anthropic/claude-sonnet-4.6' });

    // The second turn (different prompt, same session) classifies to a cheaper route.
    // The fresh implementation pick is cheaper, but not by more than the switch-cost
    // factor, so the session keeps its incumbent.
    const second = await decideRequest(
      mirrorPayload({
        input: { ...normalizedInput, userPromptPrefix: 'Now a much easier follow-up.' },
      })
    );
    expect(second.status).toBe(200);
    await expect(second.json()).resolves.toMatchObject({
      decision: {
        model: 'anthropic/claude-sonnet-4.6',
        taskType: 'implementation',
        subtaskType: 'feature_development',
        sticky: true,
      },
    });
  });

  it('always logs decisions that switch away from the incumbent, marking them unsampled', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    // 0.99 >= the 0.01 default sample rate: a routine decision would be
    // dropped, but a real switch must always be observed.
    vi.spyOn(Math, 'random').mockReturnValue(0.99);
    cacheReadConversationState.mockResolvedValue(
      conversationState(null, { model: 'gone/model', routeKey: 'planning_design/system_design' })
    );

    const response = await decideRequest(mirrorPayload());

    expect(response.status).toBe(200);
    expect(logSpy).toHaveBeenCalledTimes(1);
    const [logMessage] = logSpy.mock.calls[0] ?? [];
    expect(JSON.parse(String(logMessage))).toMatchObject({
      event: 'auto_routing_decision',
      incumbentModel: 'gone/model',
      switched: true,
      switchReason: 'threshold',
      routeChanged: true,
      sampled: false,
    });
  });

  it('drops routine non-switch decisions outside the sample rate', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(Math, 'random').mockReturnValue(0.99);

    const response = await decideRequest(mirrorPayload());

    expect(response.status).toBe(200);
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('leaves routeChanged unknown for sticky entries written before routeKey existed', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(Math, 'random').mockReturnValue(0.99);
    cacheReadConversationState.mockResolvedValue(conversationState(null, { model: 'gone/model' }));

    const response = await decideRequest(mirrorPayload());

    expect(response.status).toBe(200);
    expect(logSpy).toHaveBeenCalledTimes(1);
    const [logMessage] = logSpy.mock.calls[0] ?? [];
    expect(JSON.parse(String(logMessage))).toMatchObject({
      switched: true,
      routeChanged: null,
    });
  });

  it('falls back to a machine-scoped conversation key without a session id', async () => {
    const response = await decideRequest(mirrorPayload({ sessionId: null }));

    expect(response.status).toBe(200);
    expect(cacheIdFromName).toHaveBeenCalledWith('efficient:user:user-1:machine:machine-1');
  });

  it('falls back to a content-fingerprint conversation key without session or machine ids', async () => {
    const response = await decideRequest(mirrorPayload({ sessionId: null, machineId: null }));

    expect(response.status).toBe(200);
    expect(cacheIdFromName).toHaveBeenCalledWith(
      expect.stringMatching(/^efficient:user:user-1:content:[0-9a-f]{16}$/)
    );
  });

  it('uses a zero cost when the classifier result has no usage cost', async () => {
    classifyNormalizedInput.mockResolvedValueOnce({
      cost: null,
      classification: mockClassification,
    });

    const response = await decideRequest(mirrorPayload());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ cost: 0 });
  });

  it('makes no decision when no routing table is published', async () => {
    benchmarkFetch.mockImplementation(async (url: string) => {
      if (String(url).includes('/admin/classifier-winner')) {
        return { ok: true, status: 200, json: async () => ({ winner: null }) };
      }
      return { ok: true, status: 200, json: async () => ({ table: null, publishedAt: null }) };
    });

    const response = await decideRequest(mirrorPayload());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      cost: 0,
      decision: null,
      classifierResult: { classification: mockClassification },
    });
    // A null decision must not overwrite the session's sticky model.
    expect(cachePutEntry).not.toHaveBeenCalledWith('sticky', expect.anything());
  });

  it('returns a null classifier result when the classifier request fails', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    classifyNormalizedInput.mockRejectedValueOnce(
      new ClassifierRunError('Classifier model returned invalid classification', {
        cost: 0.00000123,
        classifierModel: 'google/gemini-2.5-flash-lite',
        failureStage: 'invalid_response',
        schemaIssueSummary: ['taskType:invalid_value'],
      })
    );

    const settings = Promise.withResolvers<void>();
    modeConfigGet.mockImplementation(() => ({
      getSettings: vi.fn(async () => {
        await settings.promise;
        return { mode: null, pool: null };
      }),
    }));
    const onUnhandled = vi.fn();
    process.on('unhandledRejection', onUnhandled);
    const pending = decideRequest(mirrorPayload({ sessionId: null, machineId: null }));
    try {
      await vi.waitFor(() => expect(classifyNormalizedInput).toHaveBeenCalledTimes(1));
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(onUnhandled).not.toHaveBeenCalled();
    } finally {
      settings.resolve();
      await pending;
      process.off('unhandledRejection', onUnhandled);
    }
    const response = await pending;

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      cost: 0,
      decision: null,
      classifierResult: null,
    });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const [logMessage] = warnSpy.mock.calls[0] ?? [];
    expect(typeof logMessage).toBe('string');
    expect(JSON.parse(String(logMessage))).toMatchObject({
      event: 'auto_routing_decision',
      status: 'classifier_error:invalid_response',
      cacheHit: false,
      reason: 'classifier_run_error',
      classifierModel: 'google/gemini-2.5-flash-lite',
      requestedModel: 'anthropic/claude-sonnet-4',
      apiKind: 'chat_completions',
      sessionId: null,
      classifierDurationMs: expect.any(Number),
      classifierCostCredits: 0.00000123,
      classifierFailureStage: 'invalid_response',
      classifierSchemaIssueSummary: ['taskType:invalid_value'],
      error: 'Classifier model returned invalid classification',
      stack: expect.any(String),
    });
    expect(writeDataPoint).toHaveBeenCalledWith({
      indexes: ['google/gemini-2.5-flash-lite'],
      blobs: [
        'google/gemini-2.5-flash-lite',
        'anthropic/claude-sonnet-4',
        'classifier_error:invalid_response',
        '',
        '',
        '',
        '',
        '',
        '',
      ],
      doubles: [expect.any(Number), 0.00000123, -1, 0],
    });
  });

  it('rejects invalid JSON wrapper bodies', async () => {
    const response = await request('/decide', {
      method: 'POST',
      headers: {
        authorization: 'Bearer classifier-token',
        'content-type': 'application/json',
      },
      body: '{"input":',
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: 'Invalid JSON body' });
    expect(classifyNormalizedInput).not.toHaveBeenCalled();
    // Status-only writes fill every other slot with its empty sentinel; the
    // SQL queries rely on this exact layout.
    expect(writeDataPoint).toHaveBeenCalledWith({
      indexes: ['unknown'],
      blobs: ['unknown', '', 'invalid_json', '', '', '', '', '', ''],
      doubles: [0, 0, -1, 0],
    });
  });

  it('rejects wrapper payloads missing required fields', async () => {
    const response = await decideRequest({ input: normalizedInput });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: 'Invalid classifier payload' });
    expect(classifyNormalizedInput).not.toHaveBeenCalled();
    expect(writeDataPoint).toHaveBeenCalledWith(
      expect.objectContaining({ blobs: expect.arrayContaining(['invalid_envelope']) })
    );
  });

  it('rejects wrapper payloads with malformed classifier inputs', async () => {
    const response = await decideRequest(mirrorPayload({ input: { apiKind: 'chat_completions' } }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: 'Invalid classifier payload' });
    expect(classifyNormalizedInput).not.toHaveBeenCalled();
  });

  it('rejects wrapper payloads with empty-string identity fields', async () => {
    // Identity fields are null-or-nonempty by contract; an empty string means
    // a gateway-side regression and rejects the whole payload.
    const response = await decideRequest(mirrorPayload({ sessionId: '' }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: 'Invalid classifier payload' });
    expect(classifyNormalizedInput).not.toHaveBeenCalled();
  });

  it('rejects requests without the backend bearer token', async () => {
    const response = await request('/decide', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(mirrorPayload()),
    });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: 'Unauthorized' });
    expect(classifyNormalizedInput).not.toHaveBeenCalled();
  });

  it('returns the override as the effective classifier model', async () => {
    configGet.mockImplementation(key =>
      Promise.resolve(key === 'classifier_model' ? 'google/gemini-2.5-flash-lite' : null)
    );

    const response = await request('/admin/classifier-model', {
      headers: { authorization: 'Bearer classifier-token' },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      model: 'google/gemini-2.5-flash-lite',
      override: 'google/gemini-2.5-flash-lite',
      benchmarkWinner: null,
      defaultModel: 'typesafe/jev-1.13',
    });
    expect(configGet).toHaveBeenCalledWith('classifier_model');
  });

  it('falls back to the benchmark winner when no override is set', async () => {
    configGet.mockImplementation(key =>
      Promise.resolve(
        key === CLASSIFIER_WINNER_KV_KEY
          ? JSON.stringify({
              engine: 'system-one',
              model: 'cloudflare/clef',
              runId: 'classifier-run-1',
              accuracy: 0.93,
              generatedAt: '2026-06-12T00:00:00.000Z',
            })
          : null
      )
    );

    const response = await request('/admin/classifier-model', {
      headers: { authorization: 'Bearer classifier-token' },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      model: 'cloudflare/clef',
      override: null,
      benchmarkWinner: 'cloudflare/clef',
      defaultModel: 'typesafe/jev-1.13',
    });
  });

  it('updates the classifier model override', async () => {
    const stored = new Map<string, string>();
    configGet.mockImplementation(key => Promise.resolve(stored.get(key) ?? null));
    configPut.mockImplementation((key, value) => {
      stored.set(key, value);
      return Promise.resolve();
    });

    const response = await request('/admin/classifier-model', {
      method: 'PUT',
      headers: {
        authorization: 'Bearer classifier-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ model: 'google/gemini-2.5-flash-lite:free' }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      model: 'google/gemini-2.5-flash-lite:free',
      override: 'google/gemini-2.5-flash-lite:free',
      benchmarkWinner: null,
      defaultModel: 'typesafe/jev-1.13',
    });
    expect(configPut).toHaveBeenCalledWith('classifier_model', 'google/gemini-2.5-flash-lite:free');
  });

  it('clears the override when model is null', async () => {
    const response = await request('/admin/classifier-model', {
      method: 'PUT',
      headers: {
        authorization: 'Bearer classifier-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ model: null }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      model: 'typesafe/jev-1.13',
      override: null,
      benchmarkWinner: null,
      defaultModel: 'typesafe/jev-1.13',
    });
    expect(configDelete).toHaveBeenCalledWith('classifier_model');
  });

  it('rejects blank classifier model updates', async () => {
    const response = await request('/admin/classifier-model', {
      method: 'PUT',
      headers: {
        authorization: 'Bearer classifier-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ model: '   ' }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: 'Invalid classifier model' });
    expect(configPut).not.toHaveBeenCalled();
  });

  it('queries classifier analytics for a selected period', async () => {
    mockedFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          data: [
            {
              total_requests: 10,
              classified_requests: 8,
              cached_requests: 6,
              classifier_errors: 1,
              invalid_requests: 1,
              total_cost_credits: 0.0000123,
              avg_duration_ms: 123.4,
              p95_duration_ms: 456.7,
            },
          ],
        }),
        { status: 200 }
      )
    );
    mockedFetch
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: [
              { status: 'classified', requests: 8 },
              { status: 'classifier_error:invalid_schema', requests: 1 },
            ],
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: [{ task_type: 'implementation', requests: 5, avg_confidence: 0.9 }],
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: [
              {
                task_type: 'implementation',
                subtask_type: 'feature_development',
                requests: 4,
                avg_confidence: 0.88,
              },
            ],
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: [{ classifier_model: 'google/gemini-2.5-flash-lite', requests: 10 }],
          }),
          { status: 200 }
        )
      );

    const response = await request('/admin/classifier-analytics?period=24h', {
      headers: { authorization: 'Bearer classifier-token' },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      period: '24h',
      summary: {
        totalRequests: 10,
        classifiedRequests: 8,
        cachedRequests: 6,
        classifierErrors: 1,
        invalidRequests: 1,
        totalCostCredits: 0.0000123,
        avgDurationMs: 123.4,
        p95DurationMs: 456.7,
      },
      statusBreakdown: [
        { status: 'classified', requests: 8 },
        { status: 'classifier_error:invalid_schema', requests: 1 },
      ],
      taskTypeBreakdown: [{ taskType: 'implementation', requests: 5, avgConfidence: 0.9 }],
      taskSubtypeBreakdown: [
        {
          taskType: 'implementation',
          subtaskType: 'feature_development',
          requests: 4,
          avgConfidence: 0.88,
        },
      ],
      classifierModelBreakdown: [{ classifierModel: 'google/gemini-2.5-flash-lite', requests: 10 }],
    });
    expect(analyticsTokenGet).toHaveBeenCalled();
    expect(mockedFetch).toHaveBeenCalledWith(
      'https://api.cloudflare.com/client/v4/accounts/test-account-id/analytics_engine/sql',
      expect.objectContaining({
        method: 'POST',
        headers: { Authorization: 'Bearer analytics-token' },
      })
    );
    const summarySql = mockedFetch.mock.calls[0]?.[1]?.body as string;
    expect(summarySql).toContain("IF(blob3 = 'classified', 1, 0)");
    expect(summarySql).toContain('FROM auto_routing_classifier_metrics_v2');
    expect(summarySql).not.toContain('invalid_body');
  });

  it('returns empty analytics locally when the local Analytics Engine secret is absent', async () => {
    analyticsTokenGet.mockRejectedValueOnce(new Error('Secret "O11Y_CF_AE_API_TOKEN" not found'));

    const response = await localRequest('/admin/classifier-analytics?period=1h', {
      headers: { authorization: 'Bearer classifier-token' },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      period: '1h',
      summary: {
        totalRequests: 0,
        classifiedRequests: 0,
        cachedRequests: 0,
        classifierErrors: 0,
        invalidRequests: 0,
        totalCostCredits: 0,
        avgDurationMs: 0,
        p95DurationMs: 0,
      },
      statusBreakdown: [],
      taskTypeBreakdown: [],
      taskSubtypeBreakdown: [],
      classifierModelBreakdown: [],
    });
    expect(mockedFetch).not.toHaveBeenCalled();
  });

  it('normalizes nullable Analytics Engine aggregate values', async () => {
    mockedFetch
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: [
              {
                total_requests: 0,
                classified_requests: 0,
                classifier_errors: 0,
                invalid_requests: 0,
                total_cost_credits: 0,
                avg_duration_ms: null,
                p95_duration_ms: null,
              },
            ],
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [] }), { status: 200 }));

    const response = await request('/admin/classifier-analytics?period=24h', {
      headers: { authorization: 'Bearer classifier-token' },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      summary: {
        avgDurationMs: 0,
        p95DurationMs: 0,
      },
    });
  });

  it('rejects malformed Analytics Engine responses', async () => {
    mockedFetch.mockResolvedValueOnce(new Response(JSON.stringify({ data: {} }), { status: 200 }));

    const response = await request('/admin/classifier-analytics?period=24h', {
      headers: { authorization: 'Bearer classifier-token' },
    });

    expect(response.status).toBe(500);
  });
});
