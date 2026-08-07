import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_BENCHMARK_ORG_ID,
  DEFAULT_BENCHMARK_USER_ID,
  type BenchmarkConfig,
  type RoutingTable,
} from '@kilocode/auto-routing-contracts';
import { app } from './index';
import type * as DbModule from './db';
import type * as ProfilesModule from './profiles';
import { CLASSIFIER_CASES } from './datasets/classifier-cases';

const TEST_CONFIG: BenchmarkConfig = {
  classifierModels: ['google/gemini-2.5-flash-lite', 'google/gemini-2.5-flash'],
  deciderModels: [
    { id: 'google/gemini-2.5-flash-lite', reasoningEffort: null },
    { id: 'anthropic/claude-sonnet-4.6', reasoningEffort: null },
  ],
  minAccuracy: 0.7,
  switchCostFactor: 3,
  bestAccuracySwitchThreshold: 0.05,
  maxConcurrency: 100,
  userMaxConcurrency: 100,
  benchmarkUserId: null,
  benchmarkOrgId: null,
  classifierRepetitions: 1,
  deciderRepetitions: 1,
  classifierMaxP95LatencyMs: 1000,
  autoDeciderMinCostUsd: 15,
  autoDeciderMaxCostUsd: 25,
  updatedAt: null,
  updatedBy: null,
};

// getConfigRows result that mapConfigRows resolves back to TEST_CONFIG.
const TEST_CONFIG_ROWS = {
  config: {
    id: 1 as const,
    min_accuracy: TEST_CONFIG.minAccuracy,
    switch_cost_factor: TEST_CONFIG.switchCostFactor,
    best_accuracy_switch_threshold: TEST_CONFIG.bestAccuracySwitchThreshold,
    max_concurrency: TEST_CONFIG.maxConcurrency,
    user_max_concurrency: TEST_CONFIG.userMaxConcurrency,
    benchmark_user_id: TEST_CONFIG.benchmarkUserId,
    benchmark_org_id: TEST_CONFIG.benchmarkOrgId,
    classifier_repetitions: TEST_CONFIG.classifierRepetitions,
    decider_repetitions: TEST_CONFIG.deciderRepetitions,
    classifier_max_p95_latency_ms: TEST_CONFIG.classifierMaxP95LatencyMs,
    auto_decider_min_cost_usd: TEST_CONFIG.autoDeciderMinCostUsd,
    auto_decider_max_cost_usd: TEST_CONFIG.autoDeciderMaxCostUsd,
    updated_at: '2026-06-01T00:00:00.000Z',
    updated_by: null,
  },
  classifierModels: TEST_CONFIG.classifierModels,
  deciderModels: TEST_CONFIG.deciderModels.map(m => ({
    model: m.id,
    variant: null,
    reasoning_effort: m.reasoningEffort ?? null,
  })),
  autoDeciderModels: [],
  excludedAutoDeciderModels: [],
};

// ---------------------------------------------------------------------------
// Stubs: the db module is mocked at its function boundary (drizzle generates
// the SQL, so statement-level stubbing would couple tests to its internals).
// ---------------------------------------------------------------------------

vi.mock('./db', async importOriginal => {
  const actual = await importOriginal<typeof DbModule>();
  return {
    ...actual,
    getConfigRows: vi.fn(),
    replaceConfig: vi.fn(),
    listRuns: vi.fn(),
    getLatestRoutingTable: vi.fn(),
    getClassifierWinner: vi.fn(),
    getLatestSummariesByModel: vi.fn(),
    insertRun: vi.fn(),
    markStaleRunsFailed: vi.fn(),
    listStaleRunningDeciderRuns: vi.fn(),
    listPendingCurrentProfiles: vi.fn(),
    syncPlatformRegistryRows: vi.fn(),
    listReadyCurrentProfilesForEntries: vi.fn(),
    getSummariesForRuns: vi.fn(),
    countCurrentProfilesByStatus: vi.fn(),
    requeueFailedCurrentProfiles: vi.fn(),
    markProfilesFailedForRun: vi.fn(),
    markProfilesRunningForRun: vi.fn(),
    markProfilesReadyForRun: vi.fn(),
    getRunningRun: vi.fn(),
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
  existsNewerCompletedRun,
  insertRun,
  listPendingCurrentProfiles,
  markProfilesRunningForRun,
  listReadyCurrentProfilesForEntries,
  getSummariesForRuns,
  syncPlatformRegistryRows,
  listRuns,
  listStaleRunningDeciderRuns,
  markStaleRunsFailed,
  replaceConfig,
} from './db';
import { lookupProfileStatuses, ProfileQuotaExceededError, registerProfiles } from './profiles';

const tokenGet = vi.fn<() => Promise<string>>();
const queueSendBatch = vi.fn();

const env = {
  INTERNAL_API_SECRET_PROD: { get: tokenGet },
  BENCH_DB: {} as D1Database,
  BENCH_QUEUE: { sendBatch: queueSendBatch },
  AUTO_ROUTING_CONFIG: { put: vi.fn(), get: vi.fn(), delete: vi.fn() },
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

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  tokenGet.mockResolvedValue('bench-token');
  vi.mocked(getConfigRows).mockResolvedValue({
    config: null,
    classifierModels: [],
    deciderModels: [],
    autoDeciderModels: [],
    excludedAutoDeciderModels: [],
  });
  vi.mocked(replaceConfig).mockResolvedValue(undefined);
  vi.mocked(listRuns).mockResolvedValue([]);
  vi.mocked(getLatestRoutingTable).mockResolvedValue(null);
  vi.mocked(getClassifierWinner).mockResolvedValue(null);
  vi.mocked(getLatestSummariesByModel).mockResolvedValue(new Map());
  vi.mocked(insertRun).mockResolvedValue(undefined);
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
  vi.mocked(existsNewerCompletedRun).mockResolvedValue(false);
  vi.mocked(registerProfiles).mockReset();
  vi.mocked(lookupProfileStatuses).mockReset();
  queueSendBatch.mockResolvedValue(undefined);
});

// ---------------------------------------------------------------------------
// Auth guard
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// GET /admin/config
// ---------------------------------------------------------------------------

describe('GET /admin/config', () => {
  it('returns a null config when the DB rows are absent', async () => {
    // getConfigRows already returns null config by default
    const res = await authedGet('/admin/config');
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ config: null });
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
        min_accuracy: 0.9,
        switch_cost_factor: 3,
        best_accuracy_switch_threshold: 0.05,
        max_concurrency: 4,
        benchmark_user_id: null,
        benchmark_org_id: null,
        classifier_repetitions: 1,
        decider_repetitions: 1,
        classifier_max_p95_latency_ms: null,
        auto_decider_min_cost_usd: 12,
        auto_decider_max_cost_usd: 24,
        user_max_concurrency: 100,
        updated_at: '2026-06-01T00:00:00.000Z',
        updated_by: 'admin@example.com',
      },
      classifierModels,
      deciderModels,
      autoDeciderModels: [],
      excludedAutoDeciderModels: [],
    });

    const res = await authedGet('/admin/config');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      config: { minAccuracy: number; updatedBy: string | null };
    };
    expect(body.config.minAccuracy).toBe(0.9);
    expect(body.config.updatedBy).toBe('admin@example.com');
  });
});

// ---------------------------------------------------------------------------
// PUT /admin/config
// ---------------------------------------------------------------------------

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

  it('returns 400 for duplicate decider model ids instead of a D1 PK violation', async () => {
    const res = await authedPut('/admin/config', {
      ...TEST_CONFIG,
      deciderModels: [
        { id: 'google/gemini-2.5-flash-lite', reasoningEffort: null },
        { id: 'google/gemini-2.5-flash-lite', reasoningEffort: null },
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
      deciderModels: [
        { id: 'manual/model', reasoningEffort: 'low' },
        { id: 'auto/model', reasoningEffort: null },
      ],
      manualDeciderModels: [{ id: 'manual/model', reasoningEffort: 'low' }],
      autoDeciderModels: [{ id: 'auto/model', reasoningEffort: null, avgAttemptCostUsd: 20 }],
      excludedAutoDeciderModels: ['auto/excluded'],
      updatedAt: null,
      updatedBy: null,
    };

    const res = await authedPut('/admin/config', validConfig, {
      'x-updated-by': 'igor@kilocode.ai',
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      config: { minAccuracy: number; updatedBy: string | null; updatedAt: string | null };
    };
    expect(body.config.minAccuracy).toBe(0.85);
    expect(body.config.updatedBy).toBe('igor@kilocode.ai');
    expect(typeof body.config.updatedAt).toBe('string');

    expect(replaceConfig).toHaveBeenCalledOnce();
    const [, configArg, , deciderModelRows, excludedAutoDeciderModels] =
      vi.mocked(replaceConfig).mock.calls[0];
    expect(configArg.min_accuracy).toBe(0.85);
    expect(configArg.auto_decider_min_cost_usd).toBe(15);
    expect(configArg.auto_decider_max_cost_usd).toBe(25);
    expect(typeof configArg.updated_at).toBe('string');
    expect(configArg.updated_by).toBe('igor@kilocode.ai');
    expect(deciderModelRows).toEqual([
      { model: 'manual/model', variant: null, reasoning_effort: 'low' },
    ]);
    expect(excludedAutoDeciderModels).toEqual(['auto/excluded']);
  });
});

// ---------------------------------------------------------------------------
// GET /admin/runs
// ---------------------------------------------------------------------------

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
});

// ---------------------------------------------------------------------------
// POST /admin/runs
// ---------------------------------------------------------------------------

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
    expect(syncPlatformRegistryRows).toHaveBeenCalledOnce();
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

  it('caps a queue batch by that queue container budget', async () => {
    // user budget 4, repetitions 2 → floor(4/2) = 2 entries per run.
    vi.mocked(getConfigRows).mockResolvedValue({
      ...TEST_CONFIG_ROWS,
      config: {
        ...TEST_CONFIG_ROWS.config,
        user_max_concurrency: 4,
        decider_repetitions: 2,
      },
    });
    vi.mocked(listPendingCurrentProfiles).mockResolvedValue([
      { model: 'm/1', variant: '', requested_at: '2026-06-01T00:00:00.000Z' },
      { model: 'm/2', variant: '', requested_at: '2026-06-01T00:00:01.000Z' },
      { model: 'm/3', variant: '', requested_at: '2026-06-01T00:00:02.000Z' },
    ]);

    await authedPost('/admin/runs', { kind: 'decider', queue: 'user' });

    const [, , modelRows] = vi.mocked(insertRun).mock.calls[0];
    expect(modelRows.map(m => m.model)).toEqual(['m/1', 'm/2']);
  });
});

// ---------------------------------------------------------------------------
// GET /admin/routing-table
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// GET /admin/classifier-winner
// ---------------------------------------------------------------------------

describe('GET /admin/classifier-winner', () => {
  it('returns {winner: null} when no completed classifier run exists', async () => {
    const res = await authedGet('/admin/classifier-winner');
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ winner: null });
  });

  it('returns the winner when a completed classifier run exists', async () => {
    const winner = {
      model: 'google/gemini-2.5-flash-lite',
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

// ---------------------------------------------------------------------------
// POST /admin/profiles/register + /admin/profiles/status
// ---------------------------------------------------------------------------

describe('POST /admin/profiles/register', () => {
  it('returns 400 when benchmark config is not set', async () => {
    const res = await authedPost('/admin/profiles/register', {
      ownerType: 'user',
      ownerId: 'u1',
      entries: [{ model: 'a/b', variant: null }],
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
      entries: [{ model: 'a/b', variant: null }],
      retryEntries: [{ model: 'a/b', variant: null }],
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
        entries: [{ model: 'a/b', variant: null }],
        retryEntries: [{ model: 'a/b', variant: null }],
      })
    );
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
      entries: [{ model: 'a/b', variant: 'xhigh' }],
    });
    expect(res.status).toBe(429);
    await expect(res.json()).resolves.toEqual({
      error:
        'Profile benchmark request limit reached. New benchmarks can be requested after 2026-07-29T12:00:00.000Z.',
      retryAt: '2026-07-29T12:00:00.000Z',
    });
  });
});

describe('POST /admin/profiles/status', () => {
  it('returns 400 when benchmark config is not set', async () => {
    const res = await authedPost('/admin/profiles/status', {
      entries: [{ model: 'a/b', variant: null }],
    });
    expect(res.status).toBe(400);
    expect(lookupProfileStatuses).not.toHaveBeenCalled();
  });

  it('returns current statuses', async () => {
    vi.mocked(getConfigRows).mockResolvedValueOnce(TEST_CONFIG_ROWS);
    vi.mocked(lookupProfileStatuses).mockResolvedValueOnce({
      statuses: [{ entry: { model: 'a/b', variant: null }, status: 'ready', failureReason: null }],
    });

    const res = await authedPost('/admin/profiles/status', {
      entries: [{ model: 'a/b', variant: null }],
    });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      statuses: [{ entry: { model: 'a/b', variant: null }, status: 'ready', failureReason: null }],
    });
  });
});
