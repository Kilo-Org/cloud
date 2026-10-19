import { DatabaseSync } from 'node:sqlite';
import { createServer } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BenchmarkRegistryResponseSchema,
  DEFAULT_BENCHMARK_ORG_ID,
  DEFAULT_BENCHMARK_USER_ID,
  type BenchmarkConfig,
  type BenchmarkRun,
  type RoutingTable,
} from '@kilocode/auto-routing-contracts';
import { app } from './index';
import type * as DbModule from './db';
import type * as ExecutableModelsModule from './executable-models';
import type * as ProfilesModule from './profiles';
import type * as SchedulerModule from './scheduler';
import { claimScheduledChunks, recoverChunks, scheduleRunChunks } from './scheduler';
import { CLASSIFIER_CASES } from './datasets/classifier-cases';
import { DECIDER_CASES } from './datasets/decider-cases';
import { computeEngineIdentity } from './run';
import { BenchmarkModelCatalogSchema } from './platform-models';
import { fetchExecutableBenchmarkModelCatalog } from './executable-models';
import {
  loadSubscriptionSnapshot,
  type SubscriptionOwner,
  type SubscriptionSnapshot,
} from './subscriptions';

const TEST_CONFIG: BenchmarkConfig = {
  router: 'efficient',
  accuracyNoiseBand: 0.05,
  frontierMinAccuracyDelta: 0,
  classifierModels: ['google/gemini-2.5-flash-lite', 'google/gemini-2.5-flash'],
  deciderModels: [{ id: 'google/gemini-2.5-flash-lite' }, { id: 'anthropic/claude-sonnet-4.6' }],
  minAccuracy: 0.7,
  switchCostFactor: 3,
  bestAccuracySwitchThreshold: 0.05,
  productionTokenProfile: null,
  switchHorizonTurns: null,
  lowConfidenceThreshold: null,
  benchmarkUserId: null,
  benchmarkOrgId: null,
  classifierRepetitions: 1,
  deciderRepetitions: 1,
  classifierMaxP95LatencyMs: 1000,
  updatedAt: null,
  updatedBy: null,
};

// getConfigRows result that mapConfigRows resolves back to TEST_CONFIG.
const TEST_CONFIG_ROWS = {
  config: {
    id: 1 as const,
    router: 'efficient' as const,
    accuracy_noise_band: 0.05,
    frontier_min_accuracy_delta: 0,
    min_accuracy: TEST_CONFIG.minAccuracy,
    switch_cost_factor: TEST_CONFIG.switchCostFactor,
    best_accuracy_switch_threshold: TEST_CONFIG.bestAccuracySwitchThreshold,
    production_token_profile: null,
    switch_horizon_turns: null,
    low_confidence_threshold: null,
    max_concurrency: 80,
    user_max_concurrency: 40,
    benchmark_user_id: TEST_CONFIG.benchmarkUserId,
    benchmark_org_id: TEST_CONFIG.benchmarkOrgId,
    classifier_repetitions: TEST_CONFIG.classifierRepetitions,
    decider_repetitions: TEST_CONFIG.deciderRepetitions,
    classifier_max_p95_latency_ms: TEST_CONFIG.classifierMaxP95LatencyMs,
    policy_overrides: null,
    policy_computed: null,
    updated_at: '2026-06-01T00:00:00.000Z',
    updated_by: null,
  },
  classifierModels: TEST_CONFIG.classifierModels,
  deciderModels: TEST_CONFIG.deciderModels.map(m => ({
    model: m.id,
    variant: null,
    reasoning_effort: null,
  })),
};

// Stubs: the db module is mocked at its function boundary (drizzle generates
// the SQL, so statement-level stubbing would couple tests to its internals).

vi.mock('./executable-models', () => ({
  fetchExecutableBenchmarkModelCatalog: vi.fn(),
}));

vi.mock('./scheduler', async importOriginal => ({
  ...(await importOriginal<typeof SchedulerModule>()),
  claimScheduledChunks: vi.fn(),
  recoverChunks: vi.fn(),
  scheduleRunChunks: vi.fn(),
}));

vi.mock('./db', async importOriginal => {
  const actual = await importOriginal<typeof DbModule>();
  return {
    ...actual,
    getConfigRows: vi.fn(),
    replaceConfig: vi.fn(),
    listRuns: vi.fn(),
    listRunProgressCounts: vi.fn(),
    getLatestRoutingTable: vi.fn(),
    getClassifierWinner: vi.fn(),
    getLatestSummariesByModel: vi.fn(),
    insertRun: vi.fn(),
    getRunWithModels: vi.fn(),
    countCaseResultsByLane: vi.fn().mockResolvedValue([]),
    listLaneFailures: vi.fn().mockResolvedValue([]),
    reuseDeciderCaseResults: vi.fn().mockResolvedValue(0),
    listQueuedRemeasures: vi.fn().mockResolvedValue([]),
    copyRemeasureBaselines: vi.fn().mockResolvedValue(0),
    settleRemeasuresForRun: vi.fn().mockResolvedValue(undefined),
    markStaleRunsFailed: vi.fn(),
    listStaleRunningDeciderRuns: vi.fn(),
    listPendingCurrentProfiles: vi.fn(),
    syncPlatformRegistryRows: vi.fn(),
    listReadyCurrentProfilesForEntries: vi.fn(),
    getSummariesForRuns: vi.fn(),
    getRoutingCaseResultsForEntries: vi.fn().mockResolvedValue([]),
    countCurrentProfilesByStatus: vi.fn(),
    listCurrentPlatformProfileStatuses: vi.fn(),
    requeueFailedCurrentProfiles: vi.fn(),
    markProfilesFailedForRun: vi.fn(),
    markProfilesRunningForRun: vi.fn(),
    markProfilesReadyForRun: vi.fn(),
    getRunningRun: vi.fn(),
    getLiveContainerLanes: vi.fn(),
    existsNewerCompletedRun: vi.fn(),
  };
});

vi.mock('./profiles', async importOriginal => {
  const actual = await importOriginal<typeof ProfilesModule>();
  return {
    ...actual,
    registerProfiles: vi.fn(),
    lookupProfileStatuses: vi.fn(),
  };
});

import {
  getConfigRows,
  getClassifierWinner,
  getLatestRoutingTable,
  getLatestSummariesByModel,
  getRunningRun,
  getLiveContainerLanes,
  existsNewerCompletedRun,
  insertRun,
  getRunWithModels,
  listPendingCurrentProfiles,
  markProfilesRunningForRun,
  listReadyCurrentProfilesForEntries,
  getSummariesForRuns,
  syncPlatformRegistryRows,
  listCurrentPlatformProfileStatuses,
  countCurrentProfilesByStatus,
  listRuns,
  listRunProgressCounts,
  listStaleRunningDeciderRuns,
  markStaleRunsFailed,
  replaceConfig,
} from './db';
import { lookupProfileStatuses, ProfileQuotaExceededError, registerProfiles } from './profiles';

const tokenGet = vi.fn<() => Promise<string>>();
const queueSendBatch = vi.fn();
const queueSend = vi.fn();

let sqlite: DatabaseSync;

function schedulerDatabase(db: DatabaseSync): D1Database {
  return {
    prepare(sql: string) {
      const bound = (params: unknown[]) => ({
        bind(...values: unknown[]) {
          return bound(values);
        },
        async first() {
          return db.prepare(sql).get(...(params as never[])) ?? null;
        },
        async all() {
          return { results: db.prepare(sql).all(...(params as never[])) };
        },
        async run() {
          return { meta: { changes: Number(db.prepare(sql).run(...(params as never[])).changes) } };
        },
      });
      return bound([]);
    },
    async batch(statements: D1PreparedStatement[]) {
      db.exec('BEGIN');
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        db.exec('COMMIT');
        return results;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
  } as unknown as D1Database;
}

const env = {
  INTERNAL_API_SECRET_PROD: { get: tokenGet },
  BENCH_DB: undefined,
  BENCH_QUEUE: { sendBatch: queueSendBatch, send: queueSend },
  BENCHMARK_SCHEDULER_CONFIG: '{}',
  AUTO_ROUTING_CONFIG: { put: vi.fn(), get: vi.fn(), delete: vi.fn() },
  KILO_WEB_API_BASE_URL: 'https://app.test',
} as unknown as Env;

const executionCtx = {
  waitUntil: () => {},
  passThroughOnException: () => {},
} as unknown as ExecutionContext;

function request(path: string, init: RequestInit = {}) {
  return app.request(`https://bench.example.com${path}`, init, env, executionCtx);
}

function authedGet(path: string) {
  return request(path, { headers: { authorization: 'Bearer bench-token' } });
}

function authedPost(path: string, body: unknown) {
  return request(path, {
    method: 'POST',
    headers: { authorization: 'Bearer bench-token', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function authedPut(path: string, body: unknown, extraHeaders: Record<string, string> = {}) {
  return request(path, {
    method: 'PUT',
    headers: {
      authorization: 'Bearer bench-token',
      'content-type': 'application/json',
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  sqlite.close();
});

beforeEach(() => {
  vi.clearAllMocks();
  sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`
    CREATE TABLE benchmark_subscriptions (
      router TEXT, owner_type TEXT, owner_id TEXT, revision TEXT, snapshot TEXT, updated_at TEXT,
      PRIMARY KEY (router, owner_type, owner_id)
    );
    CREATE TABLE config_decider_models (router TEXT, model TEXT);
    CREATE TABLE benchmark_profiles (
      router TEXT, model TEXT, variant TEXT, engine_identity TEXT, repetitions INTEGER,
      status TEXT, run_id TEXT, failure_reason TEXT, requested_at TEXT, updated_at TEXT,
      platform_requested INTEGER, user_requested INTEGER,
      PRIMARY KEY (router, model, variant, engine_identity, repetitions)
    );
    CREATE TABLE scheduler_settings (
      id INTEGER PRIMARY KEY, slots INTEGER, model_concurrency INTEGER,
      provider_concurrency INTEGER, unknown_provider_concurrency INTEGER,
      updated_at TEXT, updated_by TEXT
    );
    CREATE TABLE benchmark_runs (id TEXT, kind TEXT, status TEXT);
    CREATE TABLE scheduler_runs (run_id TEXT);
    CREATE TABLE scheduler_chunks (run_id TEXT, model TEXT, variant TEXT, rep INTEGER, status TEXT);
    CREATE TABLE run_lane_failures (run_id TEXT, model TEXT, variant TEXT, rep INTEGER);
  `);
  for (const router of ['efficient', 'frontier']) {
    for (const model of TEST_CONFIG.deciderModels) {
      sqlite.prepare('INSERT INTO config_decider_models VALUES (?, ?)').run(router, model.id);
    }
  }
  env.BENCH_DB = schedulerDatabase(sqlite);
  vi.mocked(fetchExecutableBenchmarkModelCatalog)
    .mockReset()
    .mockResolvedValue(
      BenchmarkModelCatalogSchema.parse({
        data: [
          ...TEST_CONFIG.deciderModels.map(model => ({ id: model.id })),
          { id: 'a/b' },
          { id: 'platform/a' },
          { id: 'shared/a' },
          { id: 'owner/a', opencode: { variants: { high: { reasoning: { effort: 'high' } } } } },
          ...Array.from({ length: 100 }, (_, i) => ({ id: `m/${i}` })),
        ],
      })
    );
  tokenGet.mockResolvedValue('bench-token');
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>().mockImplementation(async () =>
      Response.json({
        data: [...TEST_CONFIG.deciderModels.map(model => ({ id: model.id })), { id: 'a/b' }],
      })
    )
  );
  vi.mocked(listCurrentPlatformProfileStatuses).mockResolvedValue([]);
  vi.mocked(countCurrentProfilesByStatus).mockResolvedValue([]);
  vi.mocked(getConfigRows).mockResolvedValue({
    config: null,
    classifierModels: [],
    deciderModels: [],
  });
  vi.mocked(replaceConfig).mockResolvedValue(undefined);
  vi.mocked(listRuns).mockResolvedValue([]);
  vi.mocked(listRunProgressCounts).mockResolvedValue([]);
  vi.mocked(getLatestRoutingTable).mockResolvedValue(null);
  vi.mocked(getClassifierWinner).mockResolvedValue(null);
  vi.mocked(getLatestSummariesByModel).mockResolvedValue(new Map());
  vi.mocked(insertRun).mockResolvedValue(undefined);
  vi.mocked(getRunWithModels)
    .mockReset()
    .mockImplementation(async (_db, id) => {
      const inserted = vi.mocked(insertRun).mock.calls.find(([, run]) => run.id === id);
      if (!inserted) return null;
      const [, run, models] = inserted;
      return {
        run: {
          ...run,
          started_at: run.startedAt,
          router: run.router ?? 'efficient',
          purpose: run.purpose ?? 'platform',
          accuracy_noise_band: run.accuracy_noise_band ?? 0.05,
          frontier_min_accuracy_delta: run.frontier_min_accuracy_delta ?? 0,
          status: 'running',
          completed_at: null,
          error: null,
        },
        models,
      };
    });
  vi.mocked(scheduleRunChunks).mockReset().mockResolvedValue(true);
  vi.mocked(claimScheduledChunks).mockReset().mockResolvedValue([]);
  vi.mocked(recoverChunks).mockReset().mockResolvedValue([]);
  queueSend.mockReset().mockResolvedValue(undefined);
  vi.mocked(markStaleRunsFailed).mockResolvedValue(undefined);
  vi.mocked(listStaleRunningDeciderRuns).mockResolvedValue([]);
  vi.mocked(listPendingCurrentProfiles).mockResolvedValue([]);
  vi.mocked(markProfilesRunningForRun).mockImplementation(async (_db, _runId, entries) => [
    ...entries,
  ]);
  vi.mocked(syncPlatformRegistryRows).mockResolvedValue(undefined);
  vi.mocked(listReadyCurrentProfilesForEntries).mockResolvedValue([]);
  vi.mocked(getSummariesForRuns).mockResolvedValue([]);
  vi.mocked(getRunningRun).mockResolvedValue(undefined);
  vi.mocked(getLiveContainerLanes).mockResolvedValue(0);
  vi.mocked(existsNewerCompletedRun).mockResolvedValue(false);
  vi.mocked(registerProfiles).mockReset();
  vi.mocked(lookupProfileStatuses).mockReset();
  queueSendBatch.mockResolvedValue(undefined);
});

describe('auth middleware', () => {
  it('rejects requests without a bearer token', async () => {
    const res = await request('/admin/config');
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: 'Unauthorized' });
  });

  it('rejects requests with the wrong bearer token', async () => {
    const res = await request('/admin/config', {
      headers: { authorization: 'Bearer wrong-token' },
    });
    expect(res.status).toBe(401);
  });
});

describe('GET /admin/config', () => {
  it('returns a null config when the DB rows are absent', async () => {
    // getConfigRows already returns null config by default
    const res = await authedGet('/admin/config');
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ config: null, policySettings: null });
  });

  it('returns the stored config when DB rows exist', async () => {
    const classifierModels = ['some/model'];
    const deciderModels = TEST_CONFIG.deciderModels.map(m => ({
      model: m.id,
      variant: null,
      reasoning_effort: null,
    }));
    vi.mocked(getConfigRows).mockResolvedValueOnce({
      config: {
        id: 1,
        router: 'efficient',
        accuracy_noise_band: TEST_CONFIG.accuracyNoiseBand,
        frontier_min_accuracy_delta: TEST_CONFIG.frontierMinAccuracyDelta,
        min_accuracy: 0.9,
        switch_cost_factor: 3,
        best_accuracy_switch_threshold: 0.05,
        production_token_profile: null,
        switch_horizon_turns: null,
        low_confidence_threshold: null,
        max_concurrency: 4,
        benchmark_user_id: null,
        benchmark_org_id: null,
        classifier_repetitions: 1,
        decider_repetitions: 1,
        classifier_max_p95_latency_ms: null,
        user_max_concurrency: 100,
        policy_overrides: null,
        policy_computed: null,
        updated_at: '2026-06-01T00:00:00.000Z',
        updated_by: 'admin@example.com',
      },
      classifierModels,
      deciderModels,
    });

    const res = await authedGet('/admin/config');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      config: { minAccuracy: number; updatedBy: string | null };
      policySettings: Record<
        string,
        { kind: string; effective: unknown; override: unknown; computed: unknown; reason: unknown }
      >;
    };
    expect(body.config.minAccuracy).toBe(0.9);
    expect(body.config.updatedBy).toBe('admin@example.com');
    expect(body.policySettings.minAccuracy).toMatchObject({
      kind: 'auto',
      effective: 0.9,
      override: null,
      computed: null,
    });
    expect(body.policySettings.switchCostFactor).toMatchObject({
      kind: 'fixed',
      effective: 3,
      reason: expect.any(String),
    });
  });

  it('returns overrides and computed values per policy setting', async () => {
    vi.mocked(getConfigRows).mockResolvedValueOnce({
      ...TEST_CONFIG_ROWS,
      config: {
        ...TEST_CONFIG_ROWS.config,
        policy_overrides: { minAccuracy: 0.95 },
        policy_computed: {
          accuracyNoiseBand: {
            value: 0.08,
            computedAt: '2026-06-02T00:00:00.000Z',
            source: 'held-out-grid',
            evidence: 'fixture',
          },
        },
      },
    });

    const res = await authedGet('/admin/config');
    const body = (await res.json()) as {
      policySettings: Record<string, { effective: number; override: number | null }>;
    };
    expect(body.policySettings.minAccuracy).toMatchObject({ effective: 0.95, override: 0.95 });
    expect(body.policySettings.accuracyNoiseBand).toMatchObject({
      effective: 0.08,
      override: null,
    });
  });
});

describe('PUT /admin/config', () => {
  it('rejects a non-JSON body', async () => {
    const res = await request('/admin/config', {
      method: 'PUT',
      headers: {
        authorization: 'Bearer bench-token',
        'content-type': 'application/json',
      },
      body: 'not json {{{',
    });
    expect(res.status).toBe(500);
  });

  it('returns 400 for a schema-invalid config', async () => {
    const res = await authedPut('/admin/config', { classifierModels: 'oops' });
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      success: false,
      error: 'Invalid benchmark config',
    });
    expect(replaceConfig).not.toHaveBeenCalled();
  });

  it('returns 400 when an override value does not fit its setting', async () => {
    const res = await authedPut('/admin/config', {
      ...TEST_CONFIG,
      policyOverrides: { minAccuracy: { uncachedInputTokens: 1000, cachedInputTokens: 200 } },
    });
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      success: false,
      error: 'Invalid benchmark config',
    });
    expect(replaceConfig).not.toHaveBeenCalled();
  });

  it('returns 400 for duplicate decider model ids instead of a D1 PK violation', async () => {
    const res = await authedPut('/admin/config', {
      ...TEST_CONFIG,
      deciderModels: [
        { id: 'google/gemini-2.5-flash-lite' },
        { id: 'google/gemini-2.5-flash-lite' },
      ],
    });
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      success: false,
      error: 'Invalid benchmark config',
    });
    expect(replaceConfig).not.toHaveBeenCalled();
  });

  it('persists a valid config and returns it', async () => {
    const validConfig = {
      ...TEST_CONFIG,
      minAccuracy: 0.85,
      lowConfidenceThreshold: 0.8,
      deciderModels: [{ id: 'configured/model' }],
      updatedAt: null,
      updatedBy: null,
    };

    const res = await authedPut('/admin/config', validConfig, {
      'x-updated-by': 'igor@kilocode.ai',
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      config: {
        minAccuracy: number;
        lowConfidenceThreshold: number | null;
        updatedBy: string | null;
        updatedAt: string | null;
      };
    };
    expect(body.config.minAccuracy).toBe(0.85);
    expect(body.config.lowConfidenceThreshold).toBe(0.8);
    expect(body.config.updatedBy).toBe('igor@kilocode.ai');
    expect(typeof body.config.updatedAt).toBe('string');

    expect(replaceConfig).toHaveBeenCalledOnce();
    const [, configArg, , deciderModelRows, router] = vi.mocked(replaceConfig).mock.calls[0];
    expect(configArg.min_accuracy).toBe(0.85);
    expect(configArg.low_confidence_threshold).toBe(0.8);
    expect(typeof configArg.updated_at).toBe('string');
    expect(configArg.updated_by).toBe('igor@kilocode.ai');
    expect(deciderModelRows).toEqual([
      { model: 'configured/model', variant: null, reasoning_effort: null },
    ]);
    expect(router).toBe('efficient');
  });
});

describe('GET /admin/runs', () => {
  it('returns an empty runs array when the table is empty', async () => {
    const res = await authedGet('/admin/runs');
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ runs: [] });
  });

  it('sweeps stale runs before listing so a wedged run is recovered', async () => {
    await authedGet('/admin/runs');
    // sweepStaleRuns → markStaleRunsFailed runs on list, independent of starting.
    expect(markStaleRunsFailed).toHaveBeenCalledTimes(1);
  });

  it('attaches live progress to running runs only', async () => {
    const running: BenchmarkRun = {
      id: 'decider-2026-06-15T00-00-00-000Z',
      router: 'efficient',
      kind: 'decider',
      purpose: 'platform',
      status: 'running',
      startedAt: '2026-06-15T00:00:00.000Z',
      completedAt: null,
      error: null,
      summaries: [],
    };
    const completed: BenchmarkRun = {
      ...running,
      id: 'decider-2026-06-14T00-00-00-000Z',
      status: 'completed',
      completedAt: '2026-06-14T01:00:00.000Z',
    };
    vi.mocked(listRuns).mockResolvedValue([running, completed]);
    vi.mocked(listRunProgressCounts).mockResolvedValue([
      {
        runId: running.id,
        kind: 'decider',
        router: 'efficient',
        repetitions: 2,
        engineIdentity: computeEngineIdentity('decider', 'efficient'),
        enqueuedModels: 3,
        completedCases: 40,
        failedCases: 3,
      },
    ]);

    const res = await authedGet('/admin/runs');

    expect(res.status).toBe(200);
    const body = (await res.json()) as { runs: BenchmarkRun[] };
    expect(body.runs[0].progress).toEqual({
      completedCases: 40,
      failedCases: 3,
      totalCases: 3 * DECIDER_CASES.length * 2,
    });
    expect(body.runs[1].progress).toBeUndefined();
    // Only runs that can still change are tallied.
    expect(listRunProgressCounts).toHaveBeenCalledWith(env.BENCH_DB, [running.id]);
  });

  it('still lists runs when the progress query fails', async () => {
    const running: BenchmarkRun = {
      id: 'decider-2026-06-15T00-00-00-000Z',
      router: 'efficient',
      kind: 'decider',
      purpose: 'platform',
      status: 'running',
      startedAt: '2026-06-15T00:00:00.000Z',
      completedAt: null,
      error: null,
      summaries: [],
    };
    vi.mocked(listRuns).mockResolvedValue([running]);
    vi.mocked(listRunProgressCounts).mockRejectedValue(new Error('D1 overloaded'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const res = await authedGet('/admin/runs');

    expect(res.status).toBe(200);
    const body = (await res.json()) as { runs: BenchmarkRun[] };
    expect(body.runs.map(run => run.id)).toEqual([running.id]);
    expect(body.runs[0].progress).toBeUndefined();
  });
});

describe('POST /admin/runs', () => {
  it('rejects a non-JSON body', async () => {
    const res = await request('/admin/runs', {
      method: 'POST',
      headers: {
        authorization: 'Bearer bench-token',
        'content-type': 'application/json',
      },
      body: '<<<',
    });
    expect(res.status).toBe(500);
  });

  it('returns 400 for an invalid kind', async () => {
    const res = await authedPost('/admin/runs', { kind: 'turbo' });
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      success: false,
      error: 'Invalid run request',
    });
    expect(queueSendBatch).not.toHaveBeenCalled();
  });

  it('returns 409 when a run of the same kind is already in progress', async () => {
    vi.mocked(getConfigRows).mockResolvedValue(TEST_CONFIG_ROWS);
    vi.mocked(getRunningRun).mockResolvedValue({
      id: 'classifier-2026-06-15T00-00-00-000Z',
      kind: 'classifier',
      router: 'efficient',
      accuracy_noise_band: 0.05,
      frontier_min_accuracy_delta: 0,
      status: 'running',
      started_at: '2026-06-15T00:00:00.000Z',
      completed_at: null,
      error: null,
      min_accuracy: 0.7,
      switch_cost_factor: 3,
      best_accuracy_switch_threshold: 0.05,
      max_concurrency: 4,
      benchmark_user_id: null,
      benchmark_org_id: null,
      repetitions: 1,
      classifier_max_p95_latency_ms: 1000,
      engine_identity: 'v1:deadbeef',
      purpose: 'platform',
    });

    const res = await authedPost('/admin/runs', { kind: 'classifier' });
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({
      error: expect.stringContaining('already in progress'),
    });
    expect(insertRun).not.toHaveBeenCalled();
    expect(queueSendBatch).not.toHaveBeenCalled();
  });

  it('returns 400 when no config has been saved', async () => {
    // getConfigRows already returns null config by default
    const res = await authedPost('/admin/runs', { kind: 'classifier' });
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      error: 'benchmark config not set: save it in the admin panel before starting a run',
    });
    expect(insertRun).not.toHaveBeenCalled();
    expect(queueSendBatch).not.toHaveBeenCalled();
  });

  it('starts a classifier run and returns runId + enqueuedModels', async () => {
    // No prior summaries → every configured model is enqueued.
    vi.mocked(getConfigRows).mockResolvedValue(TEST_CONFIG_ROWS);
    const res = await authedPost('/admin/runs', { kind: 'classifier' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { runId: string; enqueuedModels: number };
    expect(body.runId).toMatch(/^classifier-/);
    expect(body.enqueuedModels).toBe(TEST_CONFIG.classifierModels.length);
    expect(insertRun).toHaveBeenCalledOnce();
    // The run row snapshots the live config (mid-run edits must not skew results).
    const [, runArg] = vi.mocked(insertRun).mock.calls[0];
    expect(runArg.min_accuracy).toBe(TEST_CONFIG.minAccuracy);
    expect(runArg.switch_cost_factor).toBe(TEST_CONFIG.switchCostFactor);
    expect(runArg.best_accuracy_switch_threshold).toBe(TEST_CONFIG.bestAccuracySwitchThreshold);
    expect(runArg.benchmark_user_id).toBe(DEFAULT_BENCHMARK_USER_ID);
    expect(runArg.benchmark_org_id).toBe(DEFAULT_BENCHMARK_ORG_ID);
    const queuedMessages = queueSendBatch.mock.calls.flatMap(([messages]) => messages);
    expect(queueSendBatch).toHaveBeenCalledTimes(2);
    expect(queuedMessages).toHaveLength(
      TEST_CONFIG.classifierModels.length *
        TEST_CONFIG.classifierRepetitions *
        CLASSIFIER_CASES.length
    );
    expect(queuedMessages[0].body).toMatchObject({
      kind: 'classifier',
      caseIds: [CLASSIFIER_CASES[0].id],
      rep: 0,
    });
  });

  it('drains the platform queue after reconciling it with the decider list', async () => {
    vi.mocked(getConfigRows).mockResolvedValue(TEST_CONFIG_ROWS);
    vi.mocked(listPendingCurrentProfiles).mockResolvedValue([
      { model: 'platform/a', variant: '', requested_at: '2026-06-01T00:00:00.000Z' },
    ]);

    const res = await authedPost('/admin/runs', { kind: 'decider', queue: 'platform' });

    expect(res.status).toBe(200);
    expect(listPendingCurrentProfiles).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      'platform'
    );
    const body = (await res.json()) as { runId: string; startedRuns: { purpose: string }[] };
    expect(body.startedRuns.map(run => run.purpose)).toEqual(['platform']);
    const [, runArg] = vi.mocked(insertRun).mock.calls[0];
    expect(runArg.purpose).toBe('platform');
    expect(runArg.benchmark_user_id).toBe(DEFAULT_BENCHMARK_USER_ID);
    expect(runArg.benchmark_org_id).toBe(DEFAULT_BENCHMARK_ORG_ID);
  });

  it('drains the user queue without touching the platform queue', async () => {
    vi.mocked(getConfigRows).mockResolvedValue(TEST_CONFIG_ROWS);
    vi.mocked(listPendingCurrentProfiles).mockResolvedValue([
      { model: 'owner/a', variant: 'high', requested_at: '2026-06-01T00:00:00.000Z' },
    ]);

    const res = await authedPost('/admin/runs', { kind: 'decider', queue: 'user' });

    expect(res.status).toBe(200);
    // Owner-requested work must not silently re-admit platform models.
    expect(syncPlatformRegistryRows).not.toHaveBeenCalled();
    expect(vi.mocked(insertRun).mock.calls[0][1].purpose).toBe('user');
    expect(scheduleRunChunks).toHaveBeenCalledWith(env.BENCH_DB, {
      runId: expect.any(String),
      entries: [{ model: 'owner/a', variant: 'high', providers: [] }],
      repetitions: TEST_CONFIG.deciderRepetitions,
      caseIds: DECIDER_CASES.map(benchCase => benchCase.id),
      chunkSize: 1,
    });
    expect(queueSendBatch).not.toHaveBeenCalled();
  });

  it('starts one run per queue for queue=both', async () => {
    vi.mocked(getConfigRows).mockResolvedValue(TEST_CONFIG_ROWS);
    vi.mocked(listPendingCurrentProfiles).mockResolvedValue([
      { model: 'shared/a', variant: '', requested_at: '2026-06-01T00:00:00.000Z' },
    ]);

    const res = await authedPost('/admin/runs', { kind: 'decider', queue: 'both' });

    const body = (await res.json()) as { startedRuns: { purpose: string; entryCount: number }[] };
    expect(body.startedRuns.map(run => run.purpose)).toEqual(['platform', 'user']);
    expect(vi.mocked(insertRun).mock.calls.map(call => call[1].purpose)).toEqual([
      'platform',
      'user',
    ]);
  });

  it('reports an empty queue honestly instead of inventing a run', async () => {
    vi.mocked(getConfigRows).mockResolvedValue(TEST_CONFIG_ROWS);
    vi.mocked(listPendingCurrentProfiles).mockResolvedValue([]);
    vi.mocked(syncPlatformRegistryRows).mockResolvedValue(undefined);
    vi.mocked(listReadyCurrentProfilesForEntries).mockResolvedValue([]);
    vi.mocked(getSummariesForRuns).mockResolvedValue([]);

    const res = await authedPost('/admin/runs', { kind: 'decider', queue: 'both' });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      runId: null,
      enqueuedModels: 0,
      startedRuns: [],
    });
    expect(insertRun).not.toHaveBeenCalled();
  });

  it('admits the whole registry batch independently of retired concurrency limits', async () => {
    vi.mocked(getConfigRows).mockResolvedValue({
      ...TEST_CONFIG_ROWS,
      config: {
        ...TEST_CONFIG_ROWS.config,
        user_max_concurrency: 4,
        decider_repetitions: 5,
      },
    });
    vi.mocked(listPendingCurrentProfiles).mockResolvedValue(
      Array.from({ length: 100 }, (_, i) => ({
        model: `m/${i}`,
        variant: '',
        requested_at: `2026-06-01T00:00:${String(i % 60).padStart(2, '0')}.000Z`,
      }))
    );

    const res = await authedPost('/admin/runs', { kind: 'decider', queue: 'user' });

    expect(res.status).toBe(200);
    const [, run, modelRows] = vi.mocked(insertRun).mock.calls[0];
    expect(modelRows).toHaveLength(100);
    expect(run).toMatchObject({ repetitions: 5, max_concurrency: 0, router: 'efficient' });
    expect(modelRows[0].model).toBe('m/0');
    expect(scheduleRunChunks).toHaveBeenCalledWith(env.BENCH_DB, {
      runId: run.id,
      entries: modelRows.map(row => ({ model: row.model, variant: null, providers: [] })),
      repetitions: 5,
      caseIds: DECIDER_CASES.map(benchCase => benchCase.id),
      chunkSize: 1,
    });
    expect(queueSendBatch).not.toHaveBeenCalled();
  });

  it('starts a durable run when all live scheduler slots are occupied', async () => {
    vi.mocked(getConfigRows).mockResolvedValue(TEST_CONFIG_ROWS);
    vi.mocked(getLiveContainerLanes).mockResolvedValue(250);
    vi.mocked(listPendingCurrentProfiles).mockResolvedValue([
      { model: 'm/1', variant: '', requested_at: '2026-06-01T00:00:00.000Z' },
    ]);

    const res = await authedPost('/admin/runs', { kind: 'decider', queue: 'user' });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      startedRuns: { purpose: string; entryCount: number }[];
      drainErrors: string[];
    };
    expect(body.startedRuns).toEqual([expect.objectContaining({ purpose: 'user', entryCount: 1 })]);
    expect(body.drainErrors).toEqual([]);
    expect(insertRun).toHaveBeenCalledOnce();
    expect(scheduleRunChunks).toHaveBeenCalledOnce();
    expect(claimScheduledChunks).toHaveBeenCalled();
    expect(queueSend).not.toHaveBeenCalled();
  });

  it('reports a wedged queue alongside the queue that did start', async () => {
    // The platform queue starts; the user queue's registry read fails. Hiding
    // that behind the started run would leave its pending work looking absent.
    vi.mocked(getConfigRows).mockResolvedValue(TEST_CONFIG_ROWS);
    vi.mocked(listPendingCurrentProfiles).mockImplementation(async (_db, _filter, purpose) => {
      if (purpose === 'user') throw new Error('registry unavailable');
      return [{ model: 'm/1', variant: '', requested_at: '2026-06-01T00:00:00.000Z' }];
    });

    const res = await authedPost('/admin/runs', { kind: 'decider', queue: 'both' });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      startedRuns: { purpose: string }[];
      drainErrors: string[];
    };
    expect(body.startedRuns.map(r => r.purpose)).toEqual(['platform']);
    expect(body.drainErrors).toEqual(['registry unavailable']);
  });
});

describe('GET /admin/registry', () => {
  it.each([
    { query: '', router: 'efficient' as const },
    { query: '?router=efficient', router: 'efficient' as const },
    { query: '?router=frontier', router: 'frontier' as const },
  ])('emits $router for registry request "$query"', async ({ query, router }) => {
    vi.mocked(getConfigRows).mockResolvedValue({
      ...TEST_CONFIG_ROWS,
      config: { ...TEST_CONFIG_ROWS.config, router },
    });

    const response = await authedGet(`/admin/registry${query}`);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({
      router,
      engineIdentity: expect.any(String),
      repetitions: TEST_CONFIG.deciderRepetitions,
      platform: { pending: 0, running: 0, ready: 0, failed: 0 },
      user: { pending: 0, running: 0, ready: 0, failed: 0 },
      platformEntries: [],
    });
    expect(BenchmarkRegistryResponseSchema.parse(body).router).toBe(router);
    expect(getConfigRows).toHaveBeenCalledWith(env.BENCH_DB, router);
  });

  it('exposes exact current platform-pair coverage separately from aggregate queue counts', async () => {
    vi.mocked(getConfigRows).mockResolvedValue(TEST_CONFIG_ROWS);
    const platformEntries = [
      { model: 'model/a', variant: 'thinking', status: 'ready' as const },
      { model: 'model/a', variant: 'instant', status: 'failed' as const },
      { model: 'model/b', variant: null, status: 'pending' as const },
    ];
    vi.mocked(listCurrentPlatformProfileStatuses).mockResolvedValue(platformEntries);
    const response = await authedGet('/admin/registry');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      router: 'efficient',
      repetitions: TEST_CONFIG.deciderRepetitions,
      platformEntries,
    });
  });
});

describe('GET /admin/routing-table', () => {
  it('returns {table: null, publishedAt: null} when no rows exist', async () => {
    const res = await authedGet('/admin/routing-table');
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ table: null, publishedAt: null });
  });

  it('returns the parsed table and publishedAt when a row exists', async () => {
    const candidate = {
      model: 'm',
      accuracy: 1,
      avgCostUsd: 0.1,
      meetsThreshold: true,
    };
    const tableData = {
      version: 'test-v1',
      generatedAt: '2026-06-01T10:00:00.000Z',
      minAccuracy: 0.7,
      switchCostFactor: 3,
      bestAccuracySwitchThreshold: 0.05,
      source: 'benchmark',
      routes: { 'implementation/code_generation': [candidate] },
    };
    vi.mocked(getLatestRoutingTable).mockResolvedValueOnce({
      table: tableData as RoutingTable,
      publishedAt: '2026-06-01T10:00:00.000Z',
    });

    const res = await authedGet('/admin/routing-table');
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      table: tableData,
      publishedAt: '2026-06-01T10:00:00.000Z',
    });
  });
});

describe('GET /admin/classifier-winner', () => {
  it('returns {winner: null} when no completed classifier run exists', async () => {
    const res = await authedGet('/admin/classifier-winner');
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ winner: null });
  });

  it('returns the winner when a completed classifier run exists', async () => {
    const winner = {
      engine: 'system-one' as const,
      model: 'typesafe/jev-1.13',
      runId: 'classifier-2026-06-01T00-00-00-000Z',
      accuracy: 0.92,
      p95LatencyMs: null,
      generatedAt: '2026-06-01T10:00:00.000Z',
    };
    vi.mocked(getClassifierWinner).mockResolvedValueOnce(winner);

    const res = await authedGet('/admin/classifier-winner');
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ winner });
  });
});

function stubCatalog(aliasTarget = 'a/b'): void {
  vi.mocked(fetchExecutableBenchmarkModelCatalog).mockResolvedValue(
    BenchmarkModelCatalogSchema.parse({
      data: [
        {
          id: 'a/b',
          supported_parameters: ['tools'],
          opencode: {
            variants: {
              low: { reasoning: { effort: 'low' } },
              high: { reasoning: { effort: 'high' } },
              fast: {},
            },
          },
        },
        { id: 'c/d', supported_parameters: ['tools'] },
        { id: '~a/latest', alias_target: aliasTarget },
        { id: '~a/fast-latest', alias_target: aliasTarget },
      ],
    })
  );
}

function persistSnapshot(
  snapshot: SubscriptionSnapshot,
  owner: SubscriptionOwner = { ownerType: 'platform', ownerId: '' }
): void {
  if (owner.ownerType === 'platform') {
    sqlite.prepare("DELETE FROM config_decider_models WHERE router = 'efficient'").run();
    for (const entry of snapshot) {
      sqlite.prepare("INSERT INTO config_decider_models VALUES ('efficient', ?)").run(entry.model);
    }
  }
  sqlite
    .prepare(`
    INSERT INTO benchmark_subscriptions (router, owner_type, owner_id, revision, snapshot, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `)
    .run(
      'efficient',
      owner.ownerType,
      owner.ownerId,
      crypto.randomUUID(),
      JSON.stringify({ entries: snapshot, previousEntries: [] }),
      '2026-06-01T00:00:00.000Z'
    );
}

describe('owner model aliases', () => {
  it.each(['register', 'status'])(
    'shares persisted concrete pairs and maps %s statuses back to each requested model',
    async action => {
      vi.mocked(getConfigRows).mockResolvedValueOnce(TEST_CONFIG_ROWS);
      stubCatalog();
      const statuses = [
        { entry: { model: 'a/b', variant: 'low' }, status: 'ready' as const, failureReason: null },
        {
          entry: { model: 'a/b', variant: 'high' },
          status: 'failed' as const,
          failureReason: 'Benchmark failed',
        },
      ];
      vi.mocked(registerProfiles).mockResolvedValueOnce({ statuses });
      vi.mocked(lookupProfileStatuses).mockResolvedValueOnce({ statuses });
      const entries = [{ model: '~a/latest' }, { model: '~a/fast-latest' }, { model: 'a/b' }];
      const pairs = [
        { model: 'a/b', variant: 'low' },
        { model: 'a/b', variant: 'high' },
      ];
      const owner = { ownerType: 'user' as const, ownerId: 'u1' };
      if (action === 'status') {
        persistSnapshot(
          entries.map(({ model }) => ({
            model,
            pairs,
            servingPairs: pairs,
            resolutionError: null,
          })),
          owner
        );
        stubCatalog('c/d');
      }
      const response = await authedPost(`/admin/profiles/${action}`, {
        ...owner,
        entries,
        retryEntries: [{ model: '~a/latest' }],
      });
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        statuses: entries.flatMap(entry =>
          statuses.map(status => ({ ...status, entry: { ...status.entry, model: entry.model } }))
        ),
      });
      expect(await loadSubscriptionSnapshot(env.BENCH_DB, 'efficient', owner)).toEqual(
        entries.map(({ model }) => ({
          model,
          pairs,
          servingPairs: action === 'status' ? pairs : [],
          resolutionError: null,
        }))
      );
      if (action === 'register') {
        expect(registerProfiles).toHaveBeenCalledWith(env.BENCH_DB, expect.anything(), {
          ...owner,
          pairs,
          retryPairs: pairs,
        });
      } else {
        expect(lookupProfileStatuses).toHaveBeenCalledWith(env.BENCH_DB, expect.anything(), {
          pairs,
        });
        expect(fetchExecutableBenchmarkModelCatalog).not.toHaveBeenCalled();
      }
    }
  );

  it('reuses the registered alias snapshot instead of retargeting on another admission', async () => {
    vi.mocked(getConfigRows).mockResolvedValue(TEST_CONFIG_ROWS);
    stubCatalog();
    const owner = { ownerType: 'org' as const, ownerId: 'o1' };
    const entries = [{ model: '~a/latest' }];
    const pairs = [
      { model: 'a/b', variant: 'low' },
      { model: 'a/b', variant: 'high' },
    ];
    const statuses = pairs.map(entry => ({
      entry,
      status: 'pending' as const,
      failureReason: null,
    }));
    vi.mocked(registerProfiles).mockResolvedValue({ statuses });
    const first = await authedPost('/admin/profiles/register', { ...owner, entries });
    expect(first.status).toBe(200);
    const saved = await loadSubscriptionSnapshot(env.BENCH_DB, 'efficient', owner);
    stubCatalog('c/d');
    const response = await authedPost('/admin/profiles/register', { ...owner, entries });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      statuses: statuses.map(status => ({
        ...status,
        entry: { model: '~a/latest', variant: status.entry.variant },
      })),
    });
    expect(registerProfiles).toHaveBeenLastCalledWith(env.BENCH_DB, expect.anything(), {
      ...owner,
      pairs,
      retryPairs: [],
    });
    expect(await loadSubscriptionSnapshot(env.BENCH_DB, 'efficient', owner)).toEqual(saved);
  });

  it.each([false, true])(
    'repairs an unresolved first alias on re-registration with explicit retry=%s',
    async explicitRetry => {
      vi.mocked(getConfigRows).mockResolvedValue(TEST_CONFIG_ROWS);
      vi.mocked(fetchExecutableBenchmarkModelCatalog).mockResolvedValue(
        BenchmarkModelCatalogSchema.parse({ data: [] })
      );
      const owner = { ownerType: 'user' as const, ownerId: 'retry-owner' };
      const entries = [{ model: '~a/latest' }];
      const first = await authedPost('/admin/profiles/register', { ...owner, entries });
      expect(first.status).toBe(200);
      await expect(first.json()).resolves.toMatchObject({
        statuses: [{ entry: { model: '~a/latest', variant: null }, status: 'failed' }],
      });
      expect(registerProfiles).not.toHaveBeenCalled();
      stubCatalog();
      const pairs = [
        { model: 'a/b', variant: 'low' },
        { model: 'a/b', variant: 'high' },
      ];
      vi.mocked(registerProfiles).mockResolvedValue({
        statuses: pairs.map(entry => ({ entry, status: 'pending' as const, failureReason: null })),
      });
      const response = await authedPost('/admin/profiles/register', {
        ...owner,
        entries,
        ...(explicitRetry ? { retryEntries: entries } : {}),
      });
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        statuses: pairs.map(pair => ({
          entry: { model: '~a/latest', variant: pair.variant },
          status: 'pending',
        })),
      });
      expect(registerProfiles).toHaveBeenCalledWith(env.BENCH_DB, expect.anything(), {
        ...owner,
        pairs,
        retryPairs: explicitRetry ? pairs : [],
      });
      expect(await loadSubscriptionSnapshot(env.BENCH_DB, 'efficient', owner)).toEqual([
        { model: '~a/latest', pairs, servingPairs: [], resolutionError: null },
      ]);
    }
  );

  it('does not reuse a removed target when the same alias is saved as a new subscription', async () => {
    vi.mocked(getConfigRows).mockResolvedValue(TEST_CONFIG_ROWS);
    stubCatalog();
    const owner = { ownerType: 'user' as const, ownerId: 'readded-owner' };
    const entries = [{ model: '~a/latest' }];
    vi.mocked(registerProfiles).mockResolvedValue({ statuses: [] });
    expect((await authedPost('/admin/profiles/register', { ...owner, entries })).status).toBe(200);
    expect(
      (await authedPost('/admin/profiles/subscriptions', { ...owner, entries: null })).status
    ).toBe(200);
    stubCatalog('c/d');
    expect((await authedPost('/admin/profiles/register', { ...owner, entries })).status).toBe(200);
    expect(registerProfiles).toHaveBeenLastCalledWith(env.BENCH_DB, expect.anything(), {
      ...owner,
      pairs: [{ model: 'c/d', variant: null }],
      retryPairs: [],
    });
  });

  it('restores a removed serving snapshot only when compensation is explicit', async () => {
    vi.mocked(getConfigRows).mockResolvedValue(TEST_CONFIG_ROWS);
    stubCatalog();
    const owner = { ownerType: 'user' as const, ownerId: 'restore-owner' };
    const entries = [{ model: '~a/latest' }];
    const pairs = [
      { model: 'a/b', variant: 'low' },
      { model: 'a/b', variant: 'high' },
    ];
    persistSnapshot(
      [{ model: '~a/latest', pairs, servingPairs: pairs, resolutionError: null }],
      owner
    );
    expect(
      (await authedPost('/admin/profiles/subscriptions', { ...owner, entries: null })).status
    ).toBe(200);
    stubCatalog('c/d');
    vi.mocked(lookupProfileStatuses).mockResolvedValue({
      statuses: pairs.map(entry => ({ entry, status: 'ready' as const, failureReason: null })),
    });
    const response = await authedPost('/admin/profiles/subscriptions', {
      ...owner,
      entries,
      restorePrevious: true,
    });
    expect(response.status).toBe(200);
    expect(await loadSubscriptionSnapshot(env.BENCH_DB, 'efficient', owner)).toEqual([
      { model: '~a/latest', pairs, servingPairs: pairs, resolutionError: null },
    ]);
    expect(fetchExecutableBenchmarkModelCatalog).not.toHaveBeenCalled();
  });

  it('assembles custom tables from saved serving pairs without resolving the live alias', async () => {
    vi.mocked(getConfigRows).mockResolvedValueOnce(TEST_CONFIG_ROWS);
    stubCatalog('c/d');
    const owner = { ownerType: 'user' as const, ownerId: 'u1' };
    const pairs = [
      { model: 'a/b', variant: 'low' },
      { model: 'a/b', variant: 'high' },
    ];
    const snapshot = [
      {
        model: '~a/latest',
        pairs: [{ model: 'c/d', variant: null }],
        servingPairs: pairs,
        resolutionError: null,
      },
    ];
    persistSnapshot(snapshot, owner);
    persistSnapshot(
      [
        {
          model: '~a/latest',
          pairs: [{ model: 'c/d', variant: null }],
          servingPairs: [{ model: 'c/d', variant: null }],
          resolutionError: null,
        },
      ],
      { ownerType: 'org', ownerId: 'u1' }
    );
    vi.mocked(listReadyCurrentProfilesForEntries)
      .mockResolvedValueOnce([])
      .mockResolvedValue(
        pairs.map(pair => ({ ...pair, variant: pair.variant ?? '', run_id: 'run-a' }))
      );
    vi.mocked(getSummariesForRuns).mockResolvedValue(
      pairs.map(pair => ({
        ...pair,
        runId: 'run-a',
        routeKey: 'implementation/code_generation' as const,
        accuracy: 0.9,
        avgCostUsd: 0.001,
        avgLatencyMs: 100,
        p50LatencyMs: 90,
        p95LatencyMs: 120,
        cases: 5,
        errors: 0,
        timeouts: 0,
        routeAccuracy: null,
      }))
    );
    const response = await authedPost('/admin/custom-routing-table', {
      ...owner,
      entries: [{ model: '~a/latest' }, { model: 'c/d' }],
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      table: { routes: Record<string, { model: string; variant: string }[]> };
    };
    expect(
      body.table.routes['implementation/code_generation']
        .map(({ model, variant }) => ({
          model,
          variant,
        }))
        .sort((left, right) => left.variant.localeCompare(right.variant))
    ).toEqual([
      { model: 'a/b', variant: 'high' },
      { model: 'a/b', variant: 'low' },
    ]);
    expect(listReadyCurrentProfilesForEntries).toHaveBeenCalledTimes(2);
    expect(listReadyCurrentProfilesForEntries).toHaveBeenLastCalledWith(
      env.BENCH_DB,
      expect.anything(),
      pairs
    );
    expect(fetchExecutableBenchmarkModelCatalog).not.toHaveBeenCalled();
    expect(await loadSubscriptionSnapshot(env.BENCH_DB, 'efficient', owner)).toEqual(snapshot);
  });
});

describe('POST /admin/profiles/register', () => {
  it('returns 400 when benchmark config is not set', async () => {
    const res = await authedPost('/admin/profiles/register', {
      ownerType: 'user',
      ownerId: 'u1',
      entries: [{ model: 'a/b' }],
    });
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      error: expect.stringContaining('benchmark config not set'),
    });
    expect(registerProfiles).not.toHaveBeenCalled();
  });

  it('returns 400 for malformed body', async () => {
    // Validation fails before the handler reads config — do not queue a
    // mockResolvedValueOnce here or it will leak into later tests.
    const res = await authedPost('/admin/profiles/register', {
      ownerType: 'user',
      ownerId: 'u1',
      entries: [],
    });
    expect(res.status).toBe(400);
    expect(registerProfiles).not.toHaveBeenCalled();
  });

  it('returns 200 with statuses on successful admission', async () => {
    vi.mocked(getConfigRows).mockResolvedValueOnce(TEST_CONFIG_ROWS);
    vi.mocked(registerProfiles).mockResolvedValueOnce({
      statuses: [
        { entry: { model: 'a/b', variant: null }, status: 'pending', failureReason: null },
      ],
    });

    const res = await authedPost('/admin/profiles/register', {
      ownerType: 'user',
      ownerId: 'u1',
      entries: [{ model: 'a/b' }],
      retryEntries: [{ model: 'a/b' }],
    });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      statuses: [
        { entry: { model: 'a/b', variant: null }, status: 'pending', failureReason: null },
      ],
    });
    expect(registerProfiles).toHaveBeenCalledWith(
      env.BENCH_DB,
      expect.objectContaining({ deciderRepetitions: 1 }),
      expect.objectContaining({
        ownerType: 'user',
        ownerId: 'u1',
        pairs: [{ model: 'a/b', variant: null }],
        retryPairs: [{ model: 'a/b', variant: null }],
      })
    );
    expect(
      await loadSubscriptionSnapshot(env.BENCH_DB, 'efficient', {
        ownerType: 'user',
        ownerId: 'u1',
      })
    ).toEqual([
      {
        model: 'a/b',
        pairs: [{ model: 'a/b', variant: null }],
        servingPairs: [],
        resolutionError: null,
      },
    ]);
  });

  it.each(['benchmark-org', null])(
    'uses configured benchmark credentials rather than the requesting owner (%s)',
    async benchmarkOrgId => {
      const expectedOrganization = benchmarkOrgId ?? DEFAULT_BENCHMARK_ORG_ID;
      const catalogToken = 'scope-catalog-token';
      const server = createServer(async (request, response) => {
        response.setHeader('content-type', 'application/json');
        if (request.url === '/api/internal/auto-routing-benchmark/token') {
          const chunks: Buffer[] = [];
          for await (const chunk of request) {
            if (!Buffer.isBuffer(chunk)) throw new Error('Expected a binary request chunk.');
            chunks.push(chunk);
          }
          const body: unknown = JSON.parse(Buffer.concat(chunks).toString());
          if (
            request.headers.authorization !== 'Bearer bench-token' ||
            typeof body !== 'object' ||
            body === null ||
            !('userId' in body) ||
            body.userId !== 'benchmark-user' ||
            !('organizationId' in body) ||
            body.organizationId !== expectedOrganization
          ) {
            response.writeHead(403).end('{}');
            return;
          }
          response.end(JSON.stringify({ token: catalogToken, expiresAt: '2030-01-01T00:00:00Z' }));
          return;
        }
        if (
          request.url !== `/api/organizations/${expectedOrganization}/models` ||
          request.headers.authorization !== `Bearer ${catalogToken}` ||
          request.headers['x-kilocode-organizationid'] !== expectedOrganization
        ) {
          response.writeHead(403).end('{}');
          return;
        }
        response.end(JSON.stringify({ data: [{ id: 'a/b', supported_parameters: ['tools'] }] }));
      });
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      if (address === null || typeof address === 'string')
        throw new Error('Expected a loopback port.');
      const originalWebUrl = env.KILO_WEB_API_BASE_URL;
      const originalCliUrl = env.KILO_CLI_API_URL;
      env.KILO_WEB_API_BASE_URL = `http://127.0.0.1:${address.port}`;
      env.KILO_CLI_API_URL = env.KILO_WEB_API_BASE_URL;
      vi.unstubAllGlobals();
      const actual = await vi.importActual<typeof ExecutableModelsModule>('./executable-models');
      vi.mocked(fetchExecutableBenchmarkModelCatalog).mockImplementation(
        actual.fetchExecutableBenchmarkModelCatalog
      );
      try {
        vi.mocked(getConfigRows).mockResolvedValueOnce({
          ...TEST_CONFIG_ROWS,
          config: {
            ...TEST_CONFIG_ROWS.config,
            benchmark_user_id: 'benchmark-user',
            benchmark_org_id: benchmarkOrgId,
          },
        });
        const statuses = [
          {
            entry: { model: 'a/b', variant: null },
            status: 'pending' as const,
            failureReason: null,
          },
        ];
        vi.mocked(registerProfiles).mockResolvedValueOnce({ statuses });
        const response = await authedPost('/admin/profiles/register', {
          ownerType: 'org',
          ownerId: 'requesting-org',
          entries: [{ model: 'a/b' }],
        });
        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual({ statuses });
        expect(registerProfiles).toHaveBeenCalledWith(env.BENCH_DB, expect.anything(), {
          ownerType: 'org',
          ownerId: 'requesting-org',
          pairs: [{ model: 'a/b', variant: null }],
          retryPairs: [],
        });
        expect(
          await loadSubscriptionSnapshot(env.BENCH_DB, 'efficient', {
            ownerType: 'org',
            ownerId: 'requesting-org',
          })
        ).toEqual([
          {
            model: 'a/b',
            pairs: [{ model: 'a/b', variant: null }],
            servingPairs: [],
            resolutionError: null,
          },
        ]);
      } finally {
        env.KILO_WEB_API_BASE_URL = originalWebUrl;
        env.KILO_CLI_API_URL = originalCliUrl;
        await new Promise<void>((resolve, reject) =>
          server.close(error => (error ? reject(error) : resolve()))
        );
      }
    }
  );

  it('expands each model to every catalog effort and retries only listed models', async () => {
    vi.mocked(getConfigRows).mockResolvedValueOnce(TEST_CONFIG_ROWS);
    stubCatalog();
    vi.mocked(registerProfiles).mockResolvedValueOnce({ statuses: [] });

    const res = await authedPost('/admin/profiles/register', {
      ownerType: 'org',
      ownerId: 'o1',
      entries: [{ model: 'a/b' }, { model: 'c/d' }],
      retryEntries: [{ model: 'a/b' }],
    });

    expect(res.status).toBe(200);
    expect(registerProfiles).toHaveBeenCalledWith(
      env.BENCH_DB,
      expect.anything(),
      expect.objectContaining({
        pairs: [
          { model: 'a/b', variant: 'low' },
          { model: 'a/b', variant: 'high' },
          { model: 'c/d', variant: null },
        ],
        retryPairs: [
          { model: 'a/b', variant: 'low' },
          { model: 'a/b', variant: 'high' },
        ],
      })
    );
  });

  it('reports unavailable models as failed while admitting unrelated executable pairs', async () => {
    vi.mocked(getConfigRows).mockResolvedValueOnce(TEST_CONFIG_ROWS);
    stubCatalog();
    const pairs = [
      { model: 'a/b', variant: 'low' },
      { model: 'a/b', variant: 'high' },
    ];
    const statuses = pairs.map(entry => ({
      entry,
      status: 'pending' as const,
      failureReason: null,
    }));
    vi.mocked(registerProfiles).mockResolvedValueOnce({ statuses });
    const res = await authedPost('/admin/profiles/register', {
      ownerType: 'user',
      ownerId: 'u1',
      entries: [{ model: 'a/b' }, { model: 'gone/model' }],
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      statuses: [
        ...statuses,
        {
          entry: { model: 'gone/model', variant: null },
          status: 'failed',
          failureReason: 'Model is unavailable in the executable benchmark catalog.',
        },
      ],
    });
    expect(registerProfiles).toHaveBeenCalledWith(env.BENCH_DB, expect.anything(), {
      ownerType: 'user',
      ownerId: 'u1',
      pairs,
      retryPairs: [],
    });
    expect(
      await loadSubscriptionSnapshot(env.BENCH_DB, 'efficient', {
        ownerType: 'user',
        ownerId: 'u1',
      })
    ).toEqual([
      { model: 'a/b', pairs, servingPairs: [], resolutionError: null },
      {
        model: 'gone/model',
        pairs: [],
        servingPairs: [],
        resolutionError: 'Model is unavailable in the executable benchmark catalog.',
      },
    ]);
  });

  it('returns 429 with retryAt when quota is exceeded', async () => {
    vi.mocked(getConfigRows).mockResolvedValueOnce(TEST_CONFIG_ROWS);
    vi.mocked(registerProfiles).mockRejectedValueOnce(
      new ProfileQuotaExceededError({
        error:
          'Profile benchmark request limit reached. New benchmarks can be requested after 2026-07-29T12:00:00.000Z.',
        retryAt: '2026-07-29T12:00:00.000Z',
      })
    );

    const res = await authedPost('/admin/profiles/register', {
      ownerType: 'org',
      ownerId: 'o1',
      entries: [{ model: 'a/b' }],
    });
    expect(res.status).toBe(429);
    await expect(res.json()).resolves.toEqual({
      error:
        'Profile benchmark request limit reached. New benchmarks can be requested after 2026-07-29T12:00:00.000Z.',
      retryAt: '2026-07-29T12:00:00.000Z',
    });
  });
});

describe('POST /admin/profiles/subscriptions', () => {
  it('requires authentication before replacing subscriptions', async () => {
    const response = await request('/admin/profiles/subscriptions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ownerType: 'user', ownerId: 'u1', entries: null }),
    });
    expect(response.status).toBe(401);
    expect(fetchExecutableBenchmarkModelCatalog).not.toHaveBeenCalled();
    expect(sqlite.prepare('SELECT * FROM benchmark_subscriptions').all()).toEqual([]);
  });

  it('returns 400 without a benchmark config', async () => {
    const response = await authedPost('/admin/profiles/subscriptions', {
      ownerType: 'user',
      ownerId: 'u1',
      entries: [{ model: 'a/b' }],
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: 'Benchmark config is not configured.',
    });
    expect(fetchExecutableBenchmarkModelCatalog).not.toHaveBeenCalled();
    expect(lookupProfileStatuses).not.toHaveBeenCalled();
  });

  it.each([
    { ownerType: 'platform', ownerId: 'u1', entries: null },
    { ownerType: 'user', ownerId: '', entries: null },
    { ownerType: 'user', ownerId: 'u1', entries: [] },
    { ownerType: 'user', ownerId: 'u1' },
  ])('rejects invalid replacement $ownerType/$ownerId', async body => {
    const response = await authedPost('/admin/profiles/subscriptions', body);
    expect(response.status).toBe(400);
    expect(fetchExecutableBenchmarkModelCatalog).not.toHaveBeenCalled();
    expect(sqlite.prepare('SELECT * FROM benchmark_subscriptions').all()).toEqual([]);
  });

  it.each(['user', 'org'] as const)(
    'bootstraps a saved %s pool and reports alias statuses using concrete measurements',
    async ownerType => {
      vi.mocked(getConfigRows).mockResolvedValue(TEST_CONFIG_ROWS);
      stubCatalog();
      const owner = { ownerType, ownerId: 'owner' };
      const entries = [{ model: '~a/latest' }, { model: 'a/b' }];
      const pairs = [
        { model: 'a/b', variant: 'low' },
        { model: 'a/b', variant: 'high' },
      ];
      const statuses = [
        { entry: pairs[0], status: 'ready' as const, failureReason: null },
        { entry: pairs[1], status: 'pending' as const, failureReason: null },
      ];
      vi.mocked(lookupProfileStatuses).mockResolvedValue({ statuses });

      const response = await authedPost('/admin/profiles/subscriptions', { ...owner, entries });
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        statuses: entries.flatMap(({ model }) =>
          statuses.map(status => ({ ...status, entry: { ...status.entry, model } }))
        ),
      });
      expect(lookupProfileStatuses).toHaveBeenCalledExactlyOnceWith(
        env.BENCH_DB,
        expect.objectContaining({ router: 'efficient' }),
        { pairs }
      );
      expect(await loadSubscriptionSnapshot(env.BENCH_DB, 'efficient', owner)).toEqual(
        entries.map(({ model }) => ({ model, pairs, servingPairs: [], resolutionError: null }))
      );
      expect(
        sqlite
          .prepare(`
        SELECT model, variant, status, platform_requested, user_requested
        FROM benchmark_profiles ORDER BY variant
      `)
          .all()
      ).toEqual([
        {
          model: 'a/b',
          variant: 'high',
          status: 'pending',
          platform_requested: 0,
          user_requested: 1,
        },
        {
          model: 'a/b',
          variant: 'low',
          status: 'pending',
          platform_requested: 0,
          user_requested: 1,
        },
      ]);
      expect(registerProfiles).not.toHaveBeenCalled();
    }
  );

  it('fully replaces and removes only the selected owner pool without retargeting saved aliases', async () => {
    vi.mocked(getConfigRows).mockResolvedValue(TEST_CONFIG_ROWS);
    stubCatalog();
    const owner = { ownerType: 'user' as const, ownerId: 'owner' };
    const otherOwner = { ownerType: 'org' as const, ownerId: 'owner' };
    const otherSnapshot = [
      {
        model: 'c/d',
        pairs: [{ model: 'c/d', variant: null }],
        servingPairs: [{ model: 'c/d', variant: null }],
        resolutionError: null,
      },
    ];
    persistSnapshot(otherSnapshot, otherOwner);
    const pairs = [
      { model: 'a/b', variant: 'low' },
      { model: 'a/b', variant: 'high' },
    ];
    vi.mocked(lookupProfileStatuses).mockImplementation(async (_db, _config, { pairs }) => ({
      statuses: pairs.map(entry => ({ entry, status: 'pending' as const, failureReason: null })),
    }));
    const initial = await authedPost('/admin/profiles/subscriptions', {
      ...owner,
      entries: [{ model: '~a/latest' }, { model: 'c/d' }],
    });
    expect(initial.status).toBe(200);
    vi.mocked(fetchExecutableBenchmarkModelCatalog).mockClear();
    stubCatalog('c/d');

    const replacement = await authedPost('/admin/profiles/subscriptions', {
      ...owner,
      entries: [{ model: '~a/latest' }],
    });
    expect(replacement.status).toBe(200);
    await expect(replacement.json()).resolves.toEqual({
      statuses: pairs.map(pair => ({
        entry: { model: '~a/latest', variant: pair.variant },
        status: 'pending',
        failureReason: null,
      })),
    });
    expect(await loadSubscriptionSnapshot(env.BENCH_DB, 'efficient', owner)).toEqual([
      { model: '~a/latest', pairs, servingPairs: [], resolutionError: null },
    ]);
    expect(lookupProfileStatuses).toHaveBeenLastCalledWith(env.BENCH_DB, expect.anything(), {
      pairs,
    });
    vi.mocked(lookupProfileStatuses).mockClear();
    const removal = await authedPost('/admin/profiles/subscriptions', { ...owner, entries: null });
    expect(removal.status).toBe(200);
    await expect(removal.json()).resolves.toEqual({ statuses: [] });
    expect(await loadSubscriptionSnapshot(env.BENCH_DB, 'efficient', owner)).toEqual([]);
    expect(await loadSubscriptionSnapshot(env.BENCH_DB, 'efficient', otherOwner)).toEqual(
      otherSnapshot
    );
    expect(fetchExecutableBenchmarkModelCatalog).not.toHaveBeenCalled();
    expect(lookupProfileStatuses).not.toHaveBeenCalled();
    expect(registerProfiles).not.toHaveBeenCalled();
  });

  it('keeps unavailable subscriptions failed without blocking an executable subscription', async () => {
    vi.mocked(getConfigRows).mockResolvedValueOnce(TEST_CONFIG_ROWS);
    vi.mocked(lookupProfileStatuses).mockResolvedValueOnce({
      statuses: [
        { entry: { model: 'a/b', variant: null }, status: 'pending', failureReason: null },
      ],
    });
    const owner = { ownerType: 'user' as const, ownerId: 'u1' };
    const response = await authedPost('/admin/profiles/subscriptions', {
      ...owner,
      entries: [{ model: 'gone/model' }, { model: 'a/b' }],
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      statuses: [
        {
          entry: { model: 'gone/model', variant: null },
          status: 'failed',
          failureReason: 'Model is unavailable in the executable benchmark catalog.',
        },
        { entry: { model: 'a/b', variant: null }, status: 'pending', failureReason: null },
      ],
    });
    expect(sqlite.prepare('SELECT model, variant FROM benchmark_profiles').all()).toEqual([
      { model: 'a/b', variant: '' },
    ]);
    expect(registerProfiles).not.toHaveBeenCalled();
  });
});

describe('POST /admin/profiles/status', () => {
  it('returns 400 when benchmark config is not set', async () => {
    const res = await authedPost('/admin/profiles/status', {
      entries: [{ model: 'a/b' }],
    });
    expect(res.status).toBe(400);
    expect(lookupProfileStatuses).not.toHaveBeenCalled();
  });

  it('returns current statuses', async () => {
    vi.mocked(getConfigRows).mockResolvedValueOnce(TEST_CONFIG_ROWS);
    persistSnapshot([
      {
        model: 'a/b',
        pairs: [{ model: 'a/b', variant: null }],
        servingPairs: [{ model: 'a/b', variant: null }],
        resolutionError: null,
      },
    ]);
    vi.mocked(lookupProfileStatuses).mockResolvedValueOnce({
      statuses: [{ entry: { model: 'a/b', variant: null }, status: 'ready', failureReason: null }],
    });

    const res = await authedPost('/admin/profiles/status', {
      entries: [{ model: 'a/b' }],
    });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      statuses: [{ entry: { model: 'a/b', variant: null }, status: 'ready', failureReason: null }],
    });
    expect(fetchExecutableBenchmarkModelCatalog).not.toHaveBeenCalled();
  });

  it('looks up snapshots by both owner type and owner id rather than the platform snapshot', async () => {
    vi.mocked(getConfigRows).mockResolvedValue(TEST_CONFIG_ROWS);
    stubCatalog('c/d');
    const user = { ownerType: 'user' as const, ownerId: 'owner' };
    const org = { ownerType: 'org' as const, ownerId: 'owner' };
    persistSnapshot(
      [
        {
          model: '~a/latest',
          pairs: [{ model: 'a/b', variant: 'high' }],
          servingPairs: [],
          resolutionError: null,
        },
      ],
      user
    );
    persistSnapshot(
      [
        {
          model: '~a/latest',
          pairs: [{ model: 'c/d', variant: null }],
          servingPairs: [],
          resolutionError: null,
        },
      ],
      org
    );
    persistSnapshot([
      {
        model: '~a/latest',
        pairs: [{ model: 'platform/old', variant: null }],
        servingPairs: [],
        resolutionError: null,
      },
    ]);
    vi.mocked(lookupProfileStatuses)
      .mockResolvedValueOnce({
        statuses: [
          {
            entry: { model: 'a/b', variant: 'high' },
            status: 'ready',
            failureReason: null,
          },
        ],
      })
      .mockResolvedValueOnce({
        statuses: [
          {
            entry: { model: 'c/d', variant: null },
            status: 'pending',
            failureReason: null,
          },
        ],
      });
    const userResponse = await authedPost('/admin/profiles/status', {
      ...user,
      entries: [{ model: '~a/latest' }],
    });
    expect(userResponse.status).toBe(200);
    await expect(userResponse.json()).resolves.toEqual({
      statuses: [
        {
          entry: { model: '~a/latest', variant: 'high' },
          status: 'ready',
          failureReason: null,
        },
      ],
    });
    const orgResponse = await authedPost('/admin/profiles/status', {
      ...org,
      entries: [{ model: '~a/latest' }],
    });
    expect(orgResponse.status).toBe(200);
    await expect(orgResponse.json()).resolves.toEqual({
      statuses: [
        {
          entry: { model: '~a/latest', variant: null },
          status: 'pending',
          failureReason: null,
        },
      ],
    });
    expect(lookupProfileStatuses).toHaveBeenNthCalledWith(1, env.BENCH_DB, expect.anything(), {
      pairs: [{ model: 'a/b', variant: 'high' }],
    });
    expect(lookupProfileStatuses).toHaveBeenNthCalledWith(2, env.BENCH_DB, expect.anything(), {
      pairs: [{ model: 'c/d', variant: null }],
    });
    expect(fetchExecutableBenchmarkModelCatalog).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('looks up every persisted effort and reports unsaved models as failed', async () => {
    vi.mocked(getConfigRows).mockResolvedValueOnce(TEST_CONFIG_ROWS);
    persistSnapshot([
      {
        model: 'a/b',
        pairs: [
          { model: 'a/b', variant: 'low' },
          { model: 'a/b', variant: 'high' },
        ],
        servingPairs: [],
        resolutionError: null,
      },
    ]);
    const statuses = [
      { entry: { model: 'a/b', variant: 'low' }, status: 'ready' as const, failureReason: null },
      { entry: { model: 'a/b', variant: 'high' }, status: 'pending' as const, failureReason: null },
    ];
    vi.mocked(lookupProfileStatuses).mockResolvedValueOnce({ statuses });

    const res = await authedPost('/admin/profiles/status', {
      entries: [{ model: 'gone/model' }, { model: 'a/b' }],
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      statuses: [
        {
          entry: { model: 'gone/model', variant: null },
          status: 'failed',
          failureReason: 'Model is unavailable in the executable benchmark catalog.',
        },
        ...statuses,
      ],
    });
    expect(lookupProfileStatuses).toHaveBeenCalledWith(env.BENCH_DB, expect.anything(), {
      pairs: [
        { model: 'a/b', variant: 'low' },
        { model: 'a/b', variant: 'high' },
      ],
    });
    expect(fetchExecutableBenchmarkModelCatalog).not.toHaveBeenCalled();
  });

  it('skips lookup and live resolution when no requested subscription is persisted', async () => {
    vi.mocked(getConfigRows).mockResolvedValueOnce(TEST_CONFIG_ROWS);

    const res = await authedPost('/admin/profiles/status', {
      entries: [{ model: 'gone/model' }],
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      statuses: [
        {
          entry: { model: 'gone/model', variant: null },
          status: 'failed',
          failureReason: 'Model is unavailable in the executable benchmark catalog.',
        },
      ],
    });
    expect(lookupProfileStatuses).not.toHaveBeenCalled();
    expect(fetchExecutableBenchmarkModelCatalog).not.toHaveBeenCalled();
  });
});

describe('POST /admin/custom-routing-table', () => {
  it('assembles from every saved serving effort of the requested pool models', async () => {
    vi.mocked(getConfigRows).mockResolvedValueOnce(TEST_CONFIG_ROWS);
    const snapshot = [
      {
        model: 'a/b',
        pairs: [
          { model: 'a/b', variant: 'low' },
          { model: 'a/b', variant: 'high' },
        ],
        servingPairs: [
          { model: 'a/b', variant: 'low' },
          { model: 'a/b', variant: 'high' },
        ],
        resolutionError: null,
      },
      {
        model: 'c/d',
        pairs: [{ model: 'c/d', variant: null }],
        servingPairs: [{ model: 'c/d', variant: null }],
        resolutionError: null,
      },
    ];
    persistSnapshot(snapshot);
    vi.mocked(listReadyCurrentProfilesForEntries).mockResolvedValueOnce([]);

    const res = await authedPost('/admin/custom-routing-table', {
      entries: [{ model: 'a/b' }, { model: 'gone/model' }, { model: 'c/d' }],
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ table: null });
    expect(listReadyCurrentProfilesForEntries).toHaveBeenCalledWith(
      env.BENCH_DB,
      expect.objectContaining({ repetitions: TEST_CONFIG.deciderRepetitions }),
      [
        { model: 'a/b', variant: 'low' },
        { model: 'a/b', variant: 'high' },
        { model: 'c/d', variant: null },
      ]
    );
    expect(fetchExecutableBenchmarkModelCatalog).not.toHaveBeenCalled();
  });

  it('returns a null table without a registry read when no subscription is persisted', async () => {
    vi.mocked(getConfigRows).mockResolvedValueOnce(TEST_CONFIG_ROWS);

    const res = await authedPost('/admin/custom-routing-table', {
      entries: [{ model: 'gone/model' }],
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ table: null });
    expect(listReadyCurrentProfilesForEntries).not.toHaveBeenCalled();
    expect(fetchExecutableBenchmarkModelCatalog).not.toHaveBeenCalled();
  });
});

describe('router selection', () => {
  it('uses the selected router preset when a configuration omits its pool', async () => {
    const response = await authedPut('/admin/config?router=frontier', {
      ...TEST_CONFIG,
      deciderModels: undefined,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      config: { router: 'frontier', deciderModels: [{ id: '~openai/gpt-sol-latest' }] },
    });
  });

  it('saves frontier config using query router and its independent thresholds', async () => {
    const response = await authedPut('/admin/config?router=frontier', {
      ...TEST_CONFIG,
      accuracyNoiseBand: 0.03,
      frontierMinAccuracyDelta: 0.02,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      config: { router: 'frontier', accuracyNoiseBand: 0.03, frontierMinAccuracyDelta: 0.02 },
    });
    expect(replaceConfig).toHaveBeenCalledWith(
      env.BENCH_DB,
      expect.objectContaining({
        accuracy_noise_band: 0.03,
        frontier_min_accuracy_delta: 0.02,
      }),
      expect.any(Array),
      expect.any(Array),
      'frontier'
    );
  });

  it('keeps classifier starts on the shared efficient benchmark identity', async () => {
    vi.mocked(getConfigRows).mockResolvedValue(TEST_CONFIG_ROWS);
    const response = await authedPost('/admin/runs?router=frontier', { kind: 'classifier' });
    expect(response.status).toBe(200);
    expect(getConfigRows).toHaveBeenCalledWith(env.BENCH_DB, 'efficient');
    expect(insertRun).toHaveBeenCalledWith(
      env.BENCH_DB,
      expect.objectContaining({
        kind: 'classifier',
        router: 'efficient',
        benchmark_user_id: DEFAULT_BENCHMARK_USER_ID,
        benchmark_org_id: DEFAULT_BENCHMARK_ORG_ID,
      }),
      expect.any(Array),
      expect.any(Array)
    );
  });

  it('defaults config and table reads to efficient', async () => {
    await authedGet('/admin/config');
    await authedGet('/admin/routing-table');
    expect(getConfigRows).toHaveBeenCalledWith(env.BENCH_DB, 'efficient');
    expect(getLatestRoutingTable).toHaveBeenCalledWith(env.BENCH_DB, 'efficient');
  });

  it('selects frontier config, runs and table independently', async () => {
    vi.mocked(getConfigRows).mockResolvedValue({
      ...TEST_CONFIG_ROWS,
      config: { ...TEST_CONFIG_ROWS.config, router: 'frontier' },
    });
    const response = await authedGet('/admin/config?router=frontier');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      config: { router: 'frontier', accuracyNoiseBand: 0.05, frontierMinAccuracyDelta: 0 },
    });
    await authedGet('/admin/runs?router=frontier');
    await authedGet('/admin/routing-table?router=frontier');
    expect(getConfigRows).toHaveBeenCalledWith(env.BENCH_DB, 'frontier');
    expect(listRuns).toHaveBeenCalledWith(
      env.BENCH_DB,
      20,
      expect.objectContaining({ router: 'frontier' })
    );
    expect(getLatestRoutingTable).toHaveBeenCalledWith(env.BENCH_DB, 'frontier');
  });

  it('rejects invalid routers', async () => {
    expect((await authedGet('/admin/config?router=unknown')).status).toBe(400);
  });

  it('inspects owner queue coverage for frontier', async () => {
    vi.mocked(getConfigRows).mockResolvedValue({
      ...TEST_CONFIG_ROWS,
      config: { ...TEST_CONFIG_ROWS.config, router: 'frontier' },
    });
    const response = await authedGet('/admin/registry?router=frontier');
    expect(response.status).toBe(200);
    expect(countCurrentProfilesByStatus).toHaveBeenCalledWith(
      env.BENCH_DB,
      expect.objectContaining({ router: 'frontier' }),
      'user'
    );
  });
});

describe('retired concurrency knobs', () => {
  it('saves a config from a previous admin UI without the retired knobs', async () => {
    const response = await authedPut('/admin/config', {
      ...TEST_CONFIG,
      maxConcurrency: 150,
      userMaxConcurrency: 100,
    });

    expect(response.status).toBe(200);
    const [, saved] = vi.mocked(replaceConfig).mock.calls[0];
    expect(saved).not.toHaveProperty('maxConcurrency');
    expect(saved).not.toHaveProperty('userMaxConcurrency');
  });
});

describe('body router selection', () => {
  it('saves frontier from the body when no query router is supplied', async () => {
    const response = await authedPut('/admin/config', { ...TEST_CONFIG, router: 'frontier' });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ config: { router: 'frontier' } });
    expect(replaceConfig).toHaveBeenCalledWith(
      env.BENCH_DB,
      expect.anything(),
      expect.any(Array),
      expect.any(Array),
      'frontier'
    );
  });

  it('admits frontier owner profiles under the frontier config', async () => {
    vi.mocked(getConfigRows).mockImplementation(async (_db, router = 'efficient') => ({
      ...TEST_CONFIG_ROWS,
      config: { ...TEST_CONFIG_ROWS.config, router },
    }));
    vi.mocked(registerProfiles).mockResolvedValueOnce({ statuses: [] });
    const response = await authedPost('/admin/profiles/register', {
      router: 'frontier',
      ownerType: 'user',
      ownerId: 'owner',
      entries: [{ model: 'a/b' }],
    });
    expect(response.status).toBe(200);
    expect(getConfigRows).toHaveBeenCalledWith(env.BENCH_DB, 'frontier');
    expect(registerProfiles).toHaveBeenCalledWith(
      env.BENCH_DB,
      expect.objectContaining({ router: 'frontier' }),
      expect.objectContaining({ ownerId: 'owner' })
    );
  });
});
