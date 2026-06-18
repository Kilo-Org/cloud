import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearClassifierConfigCache } from './classifier-config';
import { clearRoutingTableCache } from './routing-table';
import { app } from './index';
import { ClassifierRunError } from './model-classifier';
import type * as ModelClassifierModule from './model-classifier';

const classifyNormalizedInput = vi.hoisted(() => vi.fn());

vi.mock('./model-classifier', async importOriginal => {
  const actual = await importOriginal<typeof ModelClassifierModule>();
  return { ...actual, classifyNormalizedInput };
});

const writeDataPoint = vi.fn();
const configGet = vi.fn();
const configDelete = vi.fn();
const configPut = vi.fn();
const analyticsTokenGet = vi.fn();
const cacheGetEntry = vi.fn();
const cachePutEntry = vi.fn();
const cacheIdFromName = vi.fn(() => 'cache-do-id');
const benchmarkFetch = vi.fn();
const originalFetch = globalThis.fetch;
const mockedFetch = vi.fn<typeof globalThis.fetch>();

const env = {
  INTERNAL_API_SECRET_PROD: {
    get: async () => 'classifier-token',
  },
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
    get: () => ({ getEntry: cacheGetEntry, putEntry: cachePutEntry }),
  },
  O11Y_CF_ACCOUNT_ID: 'test-account-id',
  O11Y_CF_AE_API_TOKEN: {
    get: analyticsTokenGet,
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

const normalizedInput = {
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

function mirrorPayload(overrides: Record<string, unknown> = {}) {
  return {
    input: normalizedInput,
    userId: 'user-1',
    sessionId: 'task-123',
    machineId: 'machine-1',
    clientRequestId: 'req-1',
    mode: 'code',
    userAgent: 'Kilo-Code/4.106.0',
    bodyBytes: 2048,
    ...overrides,
  };
}

// Node-environment tests have no workers ExecutionContext; Hono accepts a
// substitute so handler code can use c.executionCtx.waitUntil directly.
const executionCtx = {
  waitUntil: () => {},
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
  beforeEach(() => {
    clearClassifierConfigCache();
    clearRoutingTableCache();
    classifyNormalizedInput.mockReset();
    classifyNormalizedInput.mockResolvedValue(mockClassifierResult);
    writeDataPoint.mockReset();
    configGet.mockReset();
    // Real KV returns null for missing keys; an undefined here would send the
    // routing-table loader down the JSON.parse-throw path instead.
    configGet.mockResolvedValue(null);
    configDelete.mockReset();
    configDelete.mockResolvedValue(undefined);
    configPut.mockReset();
    configPut.mockResolvedValue(undefined);
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
    cacheGetEntry.mockReset();
    cacheGetEntry.mockResolvedValue(null);
    cachePutEntry.mockReset();
    cachePutEntry.mockResolvedValue(undefined);
    mockedFetch.mockReset();
    globalThis.fetch = mockedFetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
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
      cost: 0.00000123,
      decision: {
        model: expect.any(String),
        taskType: 'implementation',
        subtaskType: 'feature_development',
        source: 'benchmark',
        tableVersion: 'bench-run-1',
        reasoningEffort: null,
        sticky: false,
      },
      classifierResult: {
        classification: mockClassification,
        normalized: normalizedInput,
      },
    });
    // The outbound session id is a hash: the conversation key embeds the raw
    // user id, which must not be sent to OpenRouter.
    expect(classifyNormalizedInput).toHaveBeenCalledWith(
      env,
      normalizedInput,
      'google/gemini-2.5-flash-lite',
      { openrouterSessionId: expect.stringMatching(/^[0-9a-f]{16}$/) }
    );
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
    });
    // The raw user id (which embeds the client IP for anonymous users) must
    // never reach persisted logs.
    expect(String(logMessage)).not.toContain('user-1');
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
    cacheGetEntry.mockResolvedValueOnce(mockClassification);

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
    expect(cacheIdFromName).toHaveBeenCalledWith('user:user-1:task:task-123');
    expect(classifyNormalizedInput).not.toHaveBeenCalled();
    // The classification is not re-cached; only the served model is
    // remembered for session stickiness.
    expect(cachePutEntry).toHaveBeenCalledTimes(1);
    expect(cachePutEntry).toHaveBeenCalledWith('sticky', { model: expect.any(String) });
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
      expect.stringMatching(/^google\/gemini-2\.5-flash-lite:[0-9a-f]{16}$/),
      expect.objectContaining({ taskType: 'implementation' })
    );
  });

  it('keeps the session on the incumbent model when the taxonomy route changes', async () => {
    // Back the mocked DO stub with real storage so the sticky model written
    // by the first request is visible to the second.
    const store = new Map<string, unknown>();
    cacheGetEntry.mockImplementation(async (key: string) => store.get(key) ?? null);
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

  it('falls back to a machine-scoped conversation key without a session id', async () => {
    const response = await decideRequest(mirrorPayload({ sessionId: null }));

    expect(response.status).toBe(200);
    expect(cacheIdFromName).toHaveBeenCalledWith('user:user-1:machine:machine-1');
  });

  it('falls back to a content-fingerprint conversation key without session or machine ids', async () => {
    const response = await decideRequest(mirrorPayload({ sessionId: null, machineId: null }));

    expect(response.status).toBe(200);
    expect(cacheIdFromName).toHaveBeenCalledWith(
      expect.stringMatching(/^user:user-1:content:[0-9a-f]{16}$/)
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

  it('logs fallback decisions with failure diagnostics', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    classifyNormalizedInput.mockResolvedValueOnce({
      ...mockClassifierResult,
      classification: {
        ...mockClassification,
        confidence: 0,
      },
      fallback: {
        reason: 'invalid_output',
        failureStage: 'invalid_schema',
        schemaIssueSummary: ['taskType:invalid_value'],
        topLevelKeys: ['minecraft'],
      },
    });

    const response = await decideRequest(mirrorPayload());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      cost: 0.00000123,
      classifierResult: {
        classification: {
          confidence: 0,
        },
      },
    });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const [logMessage] = warnSpy.mock.calls[0] ?? [];
    expect(JSON.parse(String(logMessage))).toMatchObject({
      event: 'auto_routing_decision',
      status: 'fallback:invalid_output',
      cacheHit: false,
      fallbackReason: 'invalid_output',
      classifierModel: 'google/gemini-2.5-flash-lite',
      requestedModel: 'anthropic/claude-sonnet-4',
      apiKind: 'chat_completions',
      sessionId: 'task-123',
      classifierDurationMs: expect.any(Number),
      classifierCostCredits: 0.00000123,
      confidence: 0,
      classifierFailureStage: 'invalid_schema',
      classifierSchemaIssueSummary: ['taskType:invalid_value'],
      classifierOutputTopLevelKeys: ['minecraft'],
    });
    expect(writeDataPoint).toHaveBeenCalledWith({
      indexes: ['google/gemini-2.5-flash-lite'],
      blobs: [
        'google/gemini-2.5-flash-lite',
        'anthropic/claude-sonnet-4',
        'fallback:invalid_output',
        'implementation',
        'feature_development',
        'medium',
        'medium',
        'code_change',
        '1',
      ],
      doubles: [expect.any(Number), 0.00000123, 0, 0],
    });
    // A heuristic fallback classification is served but must not re-anchor
    // the session's sticky model (same rule as the classification cache).
    expect(cachePutEntry).not.toHaveBeenCalledWith('sticky', expect.anything());
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
      cost: 0.00000123,
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
        failureStage: 'invalid_schema',
        schemaIssueSummary: ['taskType:invalid_value'],
        topLevelKeys: ['confidence'],
      })
    );

    const response = await decideRequest(mirrorPayload({ sessionId: null, machineId: null }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      cost: 0.00000123,
      decision: null,
      classifierResult: null,
    });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const [logMessage] = warnSpy.mock.calls[0] ?? [];
    expect(typeof logMessage).toBe('string');
    expect(JSON.parse(String(logMessage))).toMatchObject({
      event: 'auto_routing_decision',
      status: 'classifier_error:invalid_schema',
      cacheHit: false,
      reason: 'classifier_run_error',
      classifierModel: 'google/gemini-2.5-flash-lite',
      requestedModel: 'anthropic/claude-sonnet-4',
      apiKind: 'chat_completions',
      sessionId: null,
      classifierDurationMs: expect.any(Number),
      classifierCostCredits: 0.00000123,
      classifierFailureStage: 'invalid_schema',
      classifierSchemaIssueSummary: ['taskType:invalid_value'],
      classifierOutputTopLevelKeys: ['confidence'],
      error: 'Classifier model returned invalid classification',
      stack: expect.any(String),
    });
    expect(writeDataPoint).toHaveBeenCalledWith({
      indexes: ['google/gemini-2.5-flash-lite'],
      blobs: [
        'google/gemini-2.5-flash-lite',
        'anthropic/claude-sonnet-4',
        'classifier_error:invalid_schema',
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
      defaultModel: 'google/gemini-2.5-flash-lite',
    });
    expect(configGet).toHaveBeenCalledWith('classifier_model');
  });

  it('falls back to the benchmark winner when no override is set', async () => {
    configGet.mockImplementation(key =>
      Promise.resolve(
        key === 'classifier_benchmark_winner'
          ? JSON.stringify({
              model: 'qwen/qwen3.7-plus',
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
      model: 'qwen/qwen3.7-plus',
      override: null,
      benchmarkWinner: 'qwen/qwen3.7-plus',
      defaultModel: 'google/gemini-2.5-flash-lite',
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
      defaultModel: 'google/gemini-2.5-flash-lite',
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
      model: 'google/gemini-2.5-flash-lite',
      override: null,
      benchmarkWinner: null,
      defaultModel: 'google/gemini-2.5-flash-lite',
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
              fallback_requests: 2,
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
        fallbackRequests: 2,
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
    expect(summarySql).toContain("startsWith(blob3, 'fallback:')");
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
        fallbackRequests: 0,
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
                fallback_requests: null,
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
        fallbackRequests: 0,
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
