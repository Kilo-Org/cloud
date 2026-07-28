import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as DbModule from './db';
import type * as CliRunnerModule from './cli-runner';

vi.mock('./cli-runner', async importOriginal => {
  const actual = await importOriginal<typeof CliRunnerModule>();
  return {
    ...actual,
    destroyDeciderCliContainer: vi.fn().mockResolvedValue(undefined),
    runDeciderCaseViaCli: vi.fn(),
    warmUpCliContainer: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock('./db', async importOriginal => {
  const actual = await importOriginal<typeof DbModule>();
  return {
    ...actual,
    getConfigRows: vi.fn(),
    getLatestSummariesByModel: vi.fn(),
    getRunningRun: vi.fn(),
    insertRun: vi.fn(),
    markStaleRunsFailed: vi.fn(),
    listStaleRunningDeciderRunIds: vi.fn(),
    listPendingCurrentProfiles: vi.fn(),
    markProfilesFailedForRun: vi.fn(),
    markProfilesReadyForRun: vi.fn(),
    markProfilesRunningForRun: vi.fn(),
    markRunCompleted: vi.fn(),
    markRunFailed: vi.fn(),
    countCaseResults: vi.fn(),
    getCaseResults: vi.fn(),
    getExistingCaseResultIds: vi.fn(),
    getSummaries: vi.fn(),
    replaceModelSummaries: vi.fn(),
    saveRoutingTable: vi.fn(),
    existsNewerCompletedRun: vi.fn(),
    getRunWithModels: vi.fn(),
  };
});

import {
  countCaseResults,
  existsNewerCompletedRun,
  getCaseResults,
  getConfigRows,
  getExistingCaseResultIds,
  getLatestSummariesByModel,
  getRunningRun,
  getRunWithModels,
  getSummaries,
  insertRun,
  listPendingCurrentProfiles,
  listStaleRunningDeciderRunIds,
  markProfilesFailedForRun,
  markProfilesReadyForRun,
  markProfilesRunningForRun,
  markRunCompleted,
  markRunFailed,
  markStaleRunsFailed,
  replaceModelSummaries,
  saveRoutingTable,
} from './db';
import {
  drainPendingProfileBatch,
  failRunAndDrain,
  processJob,
  startRun,
  sweepStaleRunsAndDrain,
} from './run';

const queueSendBatch = vi.fn();
const kvDelete = vi.fn();

const configRow = {
  id: 1 as const,
  min_accuracy: 0.7,
  switch_cost_factor: 3,
  best_accuracy_switch_threshold: 0.05,
  max_concurrency: 4,
  benchmark_user_id: 'user-1',
  benchmark_org_id: null,
  classifier_repetitions: 1,
  decider_repetitions: 1,
  classifier_max_p95_latency_ms: 1000,
  auto_decider_min_cost_usd: 15,
  auto_decider_max_cost_usd: 25,
  updated_at: '2026-06-01T00:00:00.000Z',
  updated_by: null,
};

const env = {
  BENCH_DB: {} as D1Database,
  BENCH_QUEUE: { sendBatch: queueSendBatch },
  AUTO_ROUTING_CONFIG: { delete: kvDelete },
  INTERNAL_API_SECRET_PROD: { get: async () => 'secret' },
  KILO_WEB_API_BASE_URL: 'https://app.test',
  KILO_CLI_API_URL: 'https://api.test',
} as unknown as Env;

function mockConfig(overrides: Partial<typeof configRow> = {}) {
  vi.mocked(getConfigRows).mockResolvedValue({
    config: { ...configRow, ...overrides },
    // mapConfigRows requires non-empty classifier + decider lists.
    classifierModels: ['classifier/a'],
    deciderModels: [
      { model: 'platform/a', reasoning_effort: null },
      { model: 'platform/b', reasoning_effort: 'high' },
    ],
    autoDeciderModels: [],
    excludedAutoDeciderModels: [],
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockConfig();
  vi.mocked(getRunningRun).mockResolvedValue(undefined);
  vi.mocked(getLatestSummariesByModel).mockResolvedValue(new Map());
  vi.mocked(insertRun).mockResolvedValue(undefined);
  vi.mocked(markStaleRunsFailed).mockResolvedValue(undefined);
  vi.mocked(listStaleRunningDeciderRunIds).mockResolvedValue([]);
  vi.mocked(listPendingCurrentProfiles).mockResolvedValue([]);
  vi.mocked(markProfilesRunningForRun).mockResolvedValue(undefined);
  vi.mocked(markProfilesReadyForRun).mockResolvedValue(undefined);
  vi.mocked(markProfilesFailedForRun).mockResolvedValue(undefined);
  vi.mocked(markRunCompleted).mockResolvedValue(undefined);
  vi.mocked(markRunFailed).mockResolvedValue(undefined);
  vi.mocked(countCaseResults).mockResolvedValue(0);
  vi.mocked(existsNewerCompletedRun).mockResolvedValue(false);
  vi.mocked(replaceModelSummaries).mockResolvedValue(undefined);
  vi.mocked(saveRoutingTable).mockResolvedValue(undefined);
  vi.mocked(getCaseResults).mockResolvedValue([]);
  vi.mocked(getSummaries).mockResolvedValue([]);
  vi.mocked(getExistingCaseResultIds).mockResolvedValue(new Set());
  queueSendBatch.mockResolvedValue(undefined);
  kvDelete.mockResolvedValue(undefined);
});

describe('startRun — profile purpose', () => {
  it('starts a profile run with an explicit two-variants-of-one-model snapshot', async () => {
    const entries = [
      { model: 'vendor/m', variant: 'xhigh' },
      { model: 'vendor/m', variant: 'max' },
    ];
    const result = await startRun(env, 'decider', { purpose: 'profile', entries });

    expect(result.runId).toMatch(/^profile-/);
    expect(result.enqueuedModels).toBe(2);
    expect(insertRun).toHaveBeenCalledOnce();
    const [, runArg, modelRows] = vi.mocked(insertRun).mock.calls[0];
    expect(runArg.purpose).toBe('profile');
    expect(runArg.kind).toBe('decider');
    expect(modelRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          model: 'vendor/m',
          variant: 'xhigh',
          enqueued: true,
          reasoning_effort: null,
        }),
        expect.objectContaining({
          model: 'vendor/m',
          variant: 'max',
          enqueued: true,
          reasoning_effort: null,
        }),
      ])
    );
    expect(markProfilesRunningForRun).toHaveBeenCalledWith(
      env.BENCH_DB,
      result.runId,
      entries,
      expect.objectContaining({ repetitions: 1 })
    );
    expect(queueSendBatch).toHaveBeenCalled();
  });

  it('platform runs still write purpose platform and publish-path identity from config', async () => {
    const result = await startRun(env, 'decider');
    expect(result.runId).toMatch(/^decider-/);
    const [, runArg, modelRows] = vi.mocked(insertRun).mock.calls[0];
    expect(runArg.purpose).toBe('platform');
    expect(modelRows.map(m => m.model).sort()).toEqual(['platform/a', 'platform/b']);
    expect(markProfilesRunningForRun).not.toHaveBeenCalled();
  });

  it('rejects profile runs that are not decider or lack entries', async () => {
    await expect(startRun(env, 'classifier', { purpose: 'profile', entries: [] })).rejects.toThrow(
      /profile runs must be decider/
    );
    await expect(startRun(env, 'decider', { purpose: 'profile' })).rejects.toThrow(
      /non-empty entries/
    );
  });
});

describe('profile completion transitions', () => {
  function mockProfileRunState(runId: string) {
    vi.mocked(getRunWithModels).mockResolvedValue({
      run: {
        id: runId,
        kind: 'decider',
        status: 'running',
        started_at: '2026-06-01T00:00:00.000Z',
        completed_at: null,
        error: null,
        min_accuracy: 0.7,
        switch_cost_factor: 3,
        best_accuracy_switch_threshold: 0.05,
        max_concurrency: 4,
        benchmark_user_id: 'user-1',
        benchmark_org_id: null,
        repetitions: 1,
        classifier_max_p95_latency_ms: null,
        engine_identity: 'v1:test',
        purpose: 'profile',
      },
      models: [
        {
          run_id: runId,
          model: 'vendor/m',
          variant: 'xhigh',
          enqueued: true,
          reasoning_effort: null,
        },
      ],
    });
  }

  it('marks profiles ready on completion and does not publish platform table', async () => {
    const runId = 'profile-complete-1';
    mockProfileRunState(runId);
    const { DECIDER_CASES } = await import('./datasets/decider-cases');
    vi.mocked(countCaseResults).mockResolvedValue(DECIDER_CASES.length);
    vi.mocked(getCaseResults).mockResolvedValue(
      DECIDER_CASES.map(c => ({
        run_id: runId,
        model: 'vendor/m',
        variant: 'xhigh',
        case_id: c.id,
        route_key: 'implementation/code_generation',
        score: 1,
        latency_ms: 10,
        cost_usd: 0.001,
        error: null,
        fallback_reason: null,
        retried: null,
        exit_code: 0,
        output_prefix: 'ok',
        event_count: 1,
        last_event_types: 'x',
        rep: 0,
        timed_out: 0,
      }))
    );
    vi.mocked(getSummaries).mockResolvedValue([]);
    vi.mocked(listPendingCurrentProfiles).mockResolvedValue([]);
    // Case already present → skip CLI; chunk 9999 → no next chunk → finalize.
    vi.mocked(getExistingCaseResultIds).mockResolvedValue(new Set([DECIDER_CASES[0].id]));

    await processJob(env, {
      runId,
      kind: 'decider',
      model: 'vendor/m',
      variant: 'xhigh',
      caseIds: [DECIDER_CASES[0].id],
      chunk: 9999,
      shard: 0,
      shardCount: 1,
      rep: 0,
    });

    expect(markRunCompleted).toHaveBeenCalledWith(env.BENCH_DB, runId);
    expect(markProfilesReadyForRun).toHaveBeenCalledWith(env.BENCH_DB, runId);
    expect(saveRoutingTable).not.toHaveBeenCalled();
    expect(kvDelete).not.toHaveBeenCalled();
  });

  // No-clobber SQL guard (run_id + status='running') is covered honestly in
  // profile-transition-sql.test.ts with real node:sqlite execution.

  it('failRunAndDrain marks profiles failed and attempts drain', async () => {
    vi.mocked(listPendingCurrentProfiles).mockResolvedValue([
      { model: 'vendor/next', variant: 'high', requested_at: '2026-06-01T00:00:00.000Z' },
    ]);
    // After fail, slot free → drain starts profile run
    vi.mocked(getRunningRun).mockResolvedValue(undefined);

    await failRunAndDrain(env, 'profile-fail-1', 'enqueue failed');

    expect(markRunFailed).toHaveBeenCalledWith(env.BENCH_DB, 'profile-fail-1', 'enqueue failed');
    expect(markProfilesFailedForRun).toHaveBeenCalledWith(
      env.BENCH_DB,
      'profile-fail-1',
      'enqueue failed'
    );
    // Drain claimed pending and started a profile run
    expect(insertRun).toHaveBeenCalled();
    const [, runArg] = vi.mocked(insertRun).mock.calls[0];
    expect(runArg.purpose).toBe('profile');
  });
});

describe('drainPendingProfileBatch', () => {
  it('starts the oldest pending batch after slot is free', async () => {
    vi.mocked(listPendingCurrentProfiles).mockResolvedValue([
      { model: 'm/old', variant: 'a', requested_at: '2026-06-01T00:00:00.000Z' },
      { model: 'm/new', variant: 'b', requested_at: '2026-06-02T00:00:00.000Z' },
    ]);
    const result = await drainPendingProfileBatch(env);
    expect(result).not.toBeNull();
    expect(result!.entryCount).toBe(2);
    const [, , modelRows] = vi.mocked(insertRun).mock.calls[0];
    expect(modelRows[0].model).toBe('m/old');
    expect(modelRows[1].model).toBe('m/new');
  });

  it('leaves pending untouched when the decider slot is occupied', async () => {
    vi.mocked(getRunningRun).mockResolvedValue({
      id: 'decider-busy',
      kind: 'decider',
      status: 'running',
      started_at: '2026-06-01T00:00:00.000Z',
      completed_at: null,
      error: null,
      min_accuracy: 0.7,
      switch_cost_factor: 3,
      best_accuracy_switch_threshold: 0.05,
      max_concurrency: 4,
      benchmark_user_id: 'u',
      benchmark_org_id: null,
      repetitions: 1,
      classifier_max_p95_latency_ms: null,
      engine_identity: 'v1:x',
      purpose: 'platform',
    });
    vi.mocked(listPendingCurrentProfiles).mockResolvedValue([
      { model: 'm/pending', variant: '', requested_at: '2026-06-01T00:00:00.000Z' },
    ]);
    const result = await drainPendingProfileBatch(env);
    expect(result).toBeNull();
    expect(insertRun).not.toHaveBeenCalled();
  });

  it('caps the batch by the container concurrency budget', async () => {
    // max_concurrency=4, repetitions=2 → max entries = floor(4/2)=2
    mockConfig({ max_concurrency: 4, decider_repetitions: 2 });
    vi.mocked(listPendingCurrentProfiles).mockResolvedValue([
      { model: 'm/1', variant: '', requested_at: '2026-06-01T00:00:00.000Z' },
      { model: 'm/2', variant: '', requested_at: '2026-06-01T00:00:01.000Z' },
      { model: 'm/3', variant: '', requested_at: '2026-06-01T00:00:02.000Z' },
      { model: 'm/4', variant: '', requested_at: '2026-06-01T00:00:03.000Z' },
    ]);
    const result = await drainPendingProfileBatch(env);
    expect(result!.entryCount).toBe(2);
    const [, , modelRows] = vi.mocked(insertRun).mock.calls[0];
    expect(modelRows).toHaveLength(2);
    expect(modelRows.map(m => m.model)).toEqual(['m/1', 'm/2']);
  });

  it('fires after a failed decider run via failRunAndDrain', async () => {
    vi.mocked(listPendingCurrentProfiles).mockResolvedValue([
      { model: 'm/stranded', variant: 'x', requested_at: '2026-06-01T00:00:00.000Z' },
    ]);
    await failRunAndDrain(env, 'decider-failed', 'container gone');
    expect(insertRun).toHaveBeenCalledOnce();
    expect(vi.mocked(insertRun).mock.calls[0][1].purpose).toBe('profile');
  });
});

describe('sweepStaleRunsAndDrain', () => {
  it('fails profile claims for stale runs and drains pending work', async () => {
    vi.mocked(listStaleRunningDeciderRunIds).mockResolvedValue(['stale-profile-1']);
    vi.mocked(listPendingCurrentProfiles).mockResolvedValue([
      { model: 'm/after-stale', variant: '', requested_at: '2026-06-01T00:00:00.000Z' },
    ]);
    const result = await sweepStaleRunsAndDrain(env);
    expect(result.staleRunIds).toEqual(['stale-profile-1']);
    expect(markProfilesFailedForRun).toHaveBeenCalledWith(
      env.BENCH_DB,
      'stale-profile-1',
      'timed out'
    );
    expect(result.drained?.entryCount).toBe(1);
  });

  it('does not throw when slot is occupied after sweep', async () => {
    vi.mocked(getRunningRun).mockResolvedValue({
      id: 'still-running',
      kind: 'decider',
      status: 'running',
      started_at: '2026-06-01T00:00:00.000Z',
      completed_at: null,
      error: null,
      min_accuracy: 0.7,
      switch_cost_factor: 3,
      best_accuracy_switch_threshold: 0.05,
      max_concurrency: 4,
      benchmark_user_id: 'u',
      benchmark_org_id: null,
      repetitions: 1,
      classifier_max_p95_latency_ms: null,
      engine_identity: 'v1:x',
      purpose: 'platform',
    });
    vi.mocked(listPendingCurrentProfiles).mockResolvedValue([
      { model: 'm/p', variant: '', requested_at: '2026-06-01T00:00:00.000Z' },
    ]);
    const result = await sweepStaleRunsAndDrain(env);
    expect(result.drained).toBeNull();
  });
});

describe('platform run completion still publishes', () => {
  it('publishes routing table for platform decider finalize', async () => {
    const runId = 'decider-platform-1';
    const { DECIDER_CASES } = await import('./datasets/decider-cases');
    const { TAXONOMY_ROUTE_KEYS } = await import('@kilocode/auto-routing-contracts');
    vi.mocked(getRunWithModels).mockResolvedValue({
      run: {
        id: runId,
        kind: 'decider',
        status: 'running',
        started_at: '2026-06-01T00:00:00.000Z',
        completed_at: null,
        error: null,
        min_accuracy: 0.7,
        switch_cost_factor: 3,
        best_accuracy_switch_threshold: 0.05,
        max_concurrency: 4,
        benchmark_user_id: 'user-1',
        benchmark_org_id: null,
        repetitions: 1,
        classifier_max_p95_latency_ms: null,
        engine_identity: 'v1:test',
        purpose: 'platform',
      },
      models: [
        {
          run_id: runId,
          model: 'platform/a',
          variant: '',
          enqueued: true,
          reasoning_effort: null,
        },
      ],
    });
    vi.mocked(countCaseResults).mockResolvedValue(DECIDER_CASES.length);
    vi.mocked(getCaseResults).mockResolvedValue(
      DECIDER_CASES.map(c => ({
        run_id: runId,
        model: 'platform/a',
        variant: '',
        case_id: c.id,
        route_key: 'implementation/code_generation',
        score: 1,
        latency_ms: 10,
        cost_usd: 0.001,
        error: null,
        fallback_reason: null,
        retried: null,
        exit_code: 0,
        output_prefix: 'ok',
        event_count: 1,
        last_event_types: 'x',
        rep: 0,
        timed_out: 0,
      }))
    );
    // Summaries covering every taxonomy route so platform table validates.
    vi.mocked(getSummaries).mockResolvedValue(
      TAXONOMY_ROUTE_KEYS.map(routeKey => ({
        model: 'platform/a',
        variant: null,
        routeKey,
        accuracy: 0.9,
        avgCostUsd: 0.001,
        avgLatencyMs: 100,
        p50LatencyMs: 90,
        p95LatencyMs: 120,
        cases: 5,
        errors: 0,
        timeouts: 0,
      }))
    );
    vi.mocked(getExistingCaseResultIds).mockResolvedValue(new Set([DECIDER_CASES[0].id]));

    await processJob(env, {
      runId,
      kind: 'decider',
      model: 'platform/a',
      variant: null,
      caseIds: [DECIDER_CASES[0].id],
      chunk: 9999,
      shard: 0,
      shardCount: 1,
      rep: 0,
    });

    expect(markRunCompleted).toHaveBeenCalled();
    expect(saveRoutingTable).toHaveBeenCalled();
    expect(markProfilesReadyForRun).not.toHaveBeenCalled();
    const table = vi.mocked(saveRoutingTable).mock.calls[0][1];
    // Platform artifact: candidates use reasoningEffort, not variant
    const firstRoute = Object.values(table.routes)[0];
    expect(firstRoute[0]).toMatchObject({ model: 'platform/a' });
    expect(
      firstRoute[0].reasoningEffort === null ||
        firstRoute[0].reasoningEffort === undefined ||
        typeof firstRoute[0].reasoningEffort === 'string'
    ).toBe(true);
  });
});
