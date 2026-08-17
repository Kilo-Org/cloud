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
    listStaleRunningDeciderRuns: vi.fn(),
    listPendingCurrentProfiles: vi.fn(),
    markProfilesFailedForEntries: vi.fn(),
    markProfilesFailedForRun: vi.fn(),
    markProfilesReadyForRun: vi.fn(),
    markProfilesRunningForRun: vi.fn(),
    markRunCompleted: vi.fn(),
    markRunFailed: vi.fn(),
    countCaseResultsByLane: vi.fn(),
    listLaneFailures: vi.fn(),
    getCaseResults: vi.fn(),
    getExistingCaseResultIds: vi.fn(),
    getSummaries: vi.fn(),
    replaceModelSummaries: vi.fn(),
    saveRoutingTable: vi.fn(),
    existsNewerCompletedRun: vi.fn(),
    getRunWithModels: vi.fn(),
    listReadyCurrentProfilesForEntries: vi.fn(),
    getSummariesForRuns: vi.fn(),
    countCurrentProfilesByStatus: vi.fn(),
    getLatestRoutingTable: vi.fn(),
    syncPlatformRegistryRows: vi.fn(),
    recordLaneFailure: vi.fn(),
    failOrphanedRunningProfiles: vi.fn(),
    releaseProfileClaims: vi.fn(),
  };
});

import {
  countCaseResultsByLane,
  existsNewerCompletedRun,
  getCaseResults,
  getConfigRows,
  getExistingCaseResultIds,
  getLatestSummariesByModel,
  getRunningRun,
  getRunWithModels,
  getSummaries,
  getSummariesForRuns,
  insertRun,
  listLaneFailures,
  listPendingCurrentProfiles,
  countCurrentProfilesByStatus,
  getLatestRoutingTable,
  listReadyCurrentProfilesForEntries,
  listStaleRunningDeciderRuns,
  failOrphanedRunningProfiles,
  recordLaneFailure,
  releaseProfileClaims,
  markProfilesFailedForEntries,
  markProfilesFailedForRun,
  markProfilesReadyForRun,
  markProfilesRunningForRun,
  markRunCompleted,
  markRunFailed,
  markStaleRunsFailed,
  replaceModelSummaries,
  saveRoutingTable,
  syncPlatformRegistryRows,
} from './db';
import {
  NoEntriesClaimedError,
  drainQueue,
  platformRegistryEntries,
  drainQueues,
  failRunAndDrain,
  processJob,
  startRun,
  sweepStaleRunsAndDrain,
} from './run';
import { getBenchmarkConfig } from './config';

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
  user_max_concurrency: 100,
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
      { model: 'platform/a', variant: null, reasoning_effort: null },
      { model: 'platform/b', variant: null, reasoning_effort: 'high' },
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
  vi.mocked(listStaleRunningDeciderRuns).mockResolvedValue([]);
  vi.mocked(listPendingCurrentProfiles).mockResolvedValue([]);
  vi.mocked(markProfilesRunningForRun).mockImplementation(async (_db, _runId, entries) => [
    ...entries,
  ]);
  vi.mocked(markProfilesReadyForRun).mockResolvedValue(undefined);
  vi.mocked(markProfilesFailedForEntries).mockResolvedValue(undefined);
  vi.mocked(markProfilesFailedForRun).mockResolvedValue(undefined);
  vi.mocked(markRunCompleted).mockResolvedValue(undefined);
  vi.mocked(markRunFailed).mockResolvedValue(undefined);
  vi.mocked(countCaseResultsByLane).mockResolvedValue([]);
  vi.mocked(listLaneFailures).mockResolvedValue([]);
  vi.mocked(existsNewerCompletedRun).mockResolvedValue(false);
  vi.mocked(replaceModelSummaries).mockResolvedValue(undefined);
  vi.mocked(saveRoutingTable).mockResolvedValue(undefined);
  vi.mocked(getCaseResults).mockResolvedValue([]);
  vi.mocked(listReadyCurrentProfilesForEntries).mockResolvedValue([]);
  // Settled platform queue: nothing pending or running, so publishing is allowed.
  vi.mocked(countCurrentProfilesByStatus).mockResolvedValue([]);
  vi.mocked(getLatestRoutingTable).mockResolvedValue(null);
  vi.mocked(getSummariesForRuns).mockResolvedValue([]);
  vi.mocked(syncPlatformRegistryRows).mockResolvedValue(undefined);
  vi.mocked(recordLaneFailure).mockResolvedValue(undefined);
  vi.mocked(failOrphanedRunningProfiles).mockResolvedValue(0);
  vi.mocked(releaseProfileClaims).mockResolvedValue(undefined);
  vi.mocked(getSummaries).mockResolvedValue([]);
  vi.mocked(getExistingCaseResultIds).mockResolvedValue(new Set());
  queueSendBatch.mockResolvedValue(undefined);
  kvDelete.mockResolvedValue(undefined);
});

const RUN_ROW_BASE = {
  kind: 'decider' as const,
  status: 'running' as const,
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
};

function runningRun(id: string, purpose: 'platform' | 'user') {
  return { ...RUN_ROW_BASE, id, purpose };
}

describe('startRun — registry-backed decider runs', () => {
  it('starts a user-queue run from an explicit two-variants-of-one-model snapshot', async () => {
    const entries = [
      { model: 'vendor/m', variant: 'xhigh' },
      { model: 'vendor/m', variant: 'max' },
    ];
    const result = await startRun(env, 'decider', { purpose: 'user', entries });

    expect(result.runId).toMatch(/^user-/);
    expect(result.enqueuedModels).toBe(2);
    expect(insertRun).toHaveBeenCalledOnce();
    const [, runArg, modelRows] = vi.mocked(insertRun).mock.calls[0];
    expect(runArg.purpose).toBe('user');
    expect(runArg.kind).toBe('decider');
    expect(modelRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ model: 'vendor/m', variant: 'xhigh', enqueued: true }),
        expect.objectContaining({ model: 'vendor/m', variant: 'max', enqueued: true }),
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

  it('claims registry rows for platform-queue runs too, and never carries prior summaries', async () => {
    const entries = [{ model: 'platform/a', variant: null }];
    const result = await startRun(env, 'decider', { purpose: 'platform', entries });

    expect(result.runId).toMatch(/^decider-/);
    const [, runArg, modelRows] = vi.mocked(insertRun).mock.calls[0];
    expect(runArg.purpose).toBe('platform');
    expect(modelRows.map(m => m.model)).toEqual(['platform/a']);
    // Registry rows are claimed for both queues — the registry is one shared store.
    expect(markProfilesRunningForRun).toHaveBeenCalledWith(
      env.BENCH_DB,
      result.runId,
      entries,
      expect.objectContaining({ repetitions: 1 })
    );
    // Dedup is the registry's job, so no run-level carry lookup happens.
    expect(getLatestSummariesByModel).not.toHaveBeenCalled();
  });

  it('uses each queue its own container budget', async () => {
    // Platform budget 4, user budget 9, repetitions 1 → the run row snapshots
    // the budget of the queue it belongs to.
    mockConfig({ max_concurrency: 4, user_max_concurrency: 9 });
    await startRun(env, 'decider', {
      purpose: 'platform',
      entries: [{ model: 'p/a', variant: null }],
    });
    expect(vi.mocked(insertRun).mock.calls[0][1].max_concurrency).toBe(4);

    vi.mocked(insertRun).mockClear();
    await startRun(env, 'decider', { purpose: 'user', entries: [{ model: 'u/a', variant: null }] });
    expect(vi.mocked(insertRun).mock.calls[0][1].max_concurrency).toBe(9);
  });

  it('rejects decider runs without a registry entry snapshot', async () => {
    await expect(startRun(env, 'decider')).rejects.toThrow(/non-empty registry entry snapshot/);
    await expect(startRun(env, 'decider', { entries: [] })).rejects.toThrow(
      /non-empty registry entry snapshot/
    );
  });

  it('maps a saved canonical variant from the decider list into the registry entry', async () => {
    vi.mocked(getConfigRows).mockResolvedValue({
      config: configRow,
      classifierModels: ['classifier/a'],
      deciderModels: [{ model: 'platform/a', variant: 'max', reasoning_effort: null }],
      autoDeciderModels: [],
      excludedAutoDeciderModels: [],
    });

    const config = await getBenchmarkConfig(env.BENCH_DB);
    expect(platformRegistryEntries(config!)).toEqual([{ model: 'platform/a', variant: 'max' }]);
  });

  it("keeps a legacy enum effort as today's exact pair", async () => {
    // mockConfig() default: platform/b holds reasoning_effort 'high' (legacy shape).
    const config = await getBenchmarkConfig(env.BENCH_DB);
    expect(platformRegistryEntries(config!)).toEqual([
      { model: 'platform/a', variant: null },
      { model: 'platform/b', variant: 'high' },
    ]);
  });

  it('carries the entry variant into the run_models row', async () => {
    const result = await startRun(env, 'decider', {
      purpose: 'platform',
      entries: [{ model: 'platform/a', variant: 'max' }],
    });
    expect(result.runId).toMatch(/^decider-/);
    const [, , modelRows] = vi.mocked(insertRun).mock.calls[0];
    expect(modelRows).toEqual([
      expect.objectContaining({ model: 'platform/a', variant: 'max', enqueued: true }),
    ]);
  });

  it('writes no run at all when the registry claim rejects', async () => {
    const entries = [{ model: 'vendor/m', variant: 'xhigh' }];
    vi.mocked(markProfilesRunningForRun).mockRejectedValueOnce(new Error('claim failed'));

    await expect(startRun(env, 'decider', { purpose: 'user', entries })).rejects.toThrow(
      'claim failed'
    );

    // The claim precedes the run row, so a failed claim leaves nothing behind —
    // and any rows it did claim are handed straight back to the queue.
    expect(insertRun).not.toHaveBeenCalled();
    expect(queueSendBatch).not.toHaveBeenCalled();
    expect(releaseProfileClaims).toHaveBeenCalledWith(
      env.BENCH_DB,
      expect.stringMatching(/^user-/)
    );
  });

  it('drops entries another queue already claimed instead of measuring them twice', async () => {
    // Both queues can want the same pair. Whoever claims it first owns it; this
    // run must not pay to benchmark the pair a second time.
    vi.mocked(markProfilesRunningForRun).mockResolvedValueOnce([
      { model: 'a/mine', variant: null },
    ]);

    const result = await startRun(env, 'decider', {
      purpose: 'user',
      entries: [
        { model: 'a/mine', variant: null },
        { model: 'b/taken', variant: null },
      ],
    });

    expect(result.enqueuedModels).toBe(1);
    const [, , modelRows] = vi.mocked(insertRun).mock.calls[0];
    expect(modelRows.map(m => m.model)).toEqual(['a/mine']);
  });

  it('starts no run when the whole batch was already claimed', async () => {
    vi.mocked(markProfilesRunningForRun).mockResolvedValueOnce([]);

    await expect(
      startRun(env, 'decider', { purpose: 'user', entries: [{ model: 'b/taken', variant: null }] })
    ).rejects.toThrow(NoEntriesClaimedError);
    expect(insertRun).not.toHaveBeenCalled();
  });
});

describe('decider run completion', () => {
  /** A run measuring `models`, each at one repetition. */
  function mockRunState(
    runId: string,
    purpose: 'platform' | 'user',
    models: { model: string; variant: string }[]
  ) {
    vi.mocked(getRunWithModels).mockResolvedValue({
      run: { ...runningRun(runId, purpose), id: runId },
      models: models.map(m => ({
        run_id: runId,
        model: m.model,
        variant: m.variant,
        enqueued: true,
        reasoning_effort: null,
      })),
    });
  }

  async function caseRowsFor(runId: string, model: string, variant: string) {
    const { DECIDER_CASES } = await import('./datasets/decider-cases');
    return DECIDER_CASES.map(c => ({
      run_id: runId,
      model,
      variant,
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
    }));
  }

  /**
   * Drive finalization through a chunk that has no follow-up work. `variant` is
   * the application form here (null = default), not the '' storage form.
   */
  async function finalizeVia(runId: string, model: string, variant: string | null) {
    const { DECIDER_CASES } = await import('./datasets/decider-cases');
    vi.mocked(getExistingCaseResultIds).mockResolvedValue(new Set([DECIDER_CASES[0].id]));
    await processJob(env, {
      runId,
      kind: 'decider',
      model,
      variant,
      caseIds: [DECIDER_CASES[0].id],
      chunk: 9999,
      shard: 0,
      shardCount: 1,
      rep: 0,
    });
  }

  it('marks registry rows ready and republishes the platform table from the registry', async () => {
    const runId = 'user-complete-1';
    const { DECIDER_CASES } = await import('./datasets/decider-cases');
    mockRunState(runId, 'user', [{ model: 'vendor/m', variant: 'xhigh' }]);
    vi.mocked(countCaseResultsByLane).mockResolvedValue([
      { model: 'vendor/m', variant: 'xhigh', rep: 0, n: DECIDER_CASES.length },
    ]);
    vi.mocked(getCaseResults).mockResolvedValue(await caseRowsFor(runId, 'vendor/m', 'xhigh'));

    await finalizeVia(runId, 'vendor/m', 'xhigh');

    expect(markRunCompleted).toHaveBeenCalledWith(env.BENCH_DB, runId);
    expect(markProfilesReadyForRun).toHaveBeenCalledWith(env.BENCH_DB, runId);
    expect(markProfilesFailedForEntries).not.toHaveBeenCalled();
    // Settle the registry rows first. The orphan reaper spares rows whose run
    // is still running, so completing the run first would open a window where a
    // concurrent sweep fails entries that are fully measured.
    expect(vi.mocked(markProfilesReadyForRun).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(markRunCompleted).mock.invocationCallOrder[0]
    );
    // A user-queue run still triggers a platform republish: the registry is
    // shared, so a pair it measured may complete the platform model list.
    // Nothing is ready here, so publishing is honestly skipped.
    expect(listReadyCurrentProfilesForEntries).toHaveBeenCalled();
    expect(saveRoutingTable).not.toHaveBeenCalled();
  });

  it('fails only the entries whose lane died, and readies the rest', async () => {
    // The failure-isolation guarantee: models A and B finish, C's lane dies.
    // C alone must fail — A and B keep the results they cost money to produce.
    const runId = 'user-partial-1';
    const { DECIDER_CASES } = await import('./datasets/decider-cases');
    mockRunState(runId, 'user', [
      { model: 'vendor/a', variant: '' },
      { model: 'vendor/b', variant: '' },
      { model: 'vendor/c', variant: '' },
    ]);
    vi.mocked(countCaseResultsByLane).mockResolvedValue([
      { model: 'vendor/a', variant: '', rep: 0, n: DECIDER_CASES.length },
      { model: 'vendor/b', variant: '', rep: 0, n: DECIDER_CASES.length },
      { model: 'vendor/c', variant: '', rep: 0, n: 4 },
    ]);
    vi.mocked(listLaneFailures).mockResolvedValue([
      {
        run_id: runId,
        model: 'vendor/c',
        variant: '',
        rep: 0,
        chunk: 0,
        shard: 0,
        failed_at: '2026-06-01T01:00:00.000Z',
      },
    ]);
    vi.mocked(getCaseResults).mockResolvedValue(await caseRowsFor(runId, 'vendor/a', ''));

    await finalizeVia(runId, 'vendor/a', null);

    expect(markProfilesFailedForEntries).toHaveBeenCalledWith(
      env.BENCH_DB,
      runId,
      [{ model: 'vendor/c', variant: '' }],
      expect.stringContaining('did not finish')
    );
    // The ready sweep runs after the per-entry failure, so it only catches A and B.
    expect(markProfilesReadyForRun).toHaveBeenCalledWith(env.BENCH_DB, runId);
    expect(markRunCompleted).toHaveBeenCalledWith(env.BENCH_DB, runId);
  });

  it('fails a platform-queue run per entry as well, never as a whole', async () => {
    const runId = 'decider-partial-1';
    const { DECIDER_CASES } = await import('./datasets/decider-cases');
    mockRunState(runId, 'platform', [
      { model: 'platform/a', variant: '' },
      { model: 'platform/b', variant: 'high' },
    ]);
    vi.mocked(countCaseResultsByLane).mockResolvedValue([
      { model: 'platform/a', variant: '', rep: 0, n: DECIDER_CASES.length },
      { model: 'platform/b', variant: 'high', rep: 0, n: 0 },
    ]);
    vi.mocked(listLaneFailures).mockResolvedValue([
      {
        run_id: runId,
        model: 'platform/b',
        variant: 'high',
        rep: 0,
        chunk: 0,
        shard: 0,
        failed_at: '2026-06-01T01:00:00.000Z',
      },
    ]);
    vi.mocked(getCaseResults).mockResolvedValue(await caseRowsFor(runId, 'platform/a', ''));

    await finalizeVia(runId, 'platform/a', null);

    expect(markProfilesFailedForEntries).toHaveBeenCalledWith(
      env.BENCH_DB,
      runId,
      [{ model: 'platform/b', variant: 'high' }],
      expect.stringContaining('did not finish')
    );
    expect(markRunCompleted).toHaveBeenCalledWith(env.BENCH_DB, runId);
    // Old behaviour failed the whole platform run on a dead lane.
    expect(markRunFailed).not.toHaveBeenCalled();
  });

  it('publishes the platform table from ready registry rows', async () => {
    const runId = 'decider-publish-1';
    const { DECIDER_CASES } = await import('./datasets/decider-cases');
    const { TAXONOMY_ROUTE_KEYS } = await import('@kilocode/auto-routing-contracts');
    mockRunState(runId, 'platform', [{ model: 'platform/a', variant: '' }]);
    vi.mocked(countCaseResultsByLane).mockResolvedValue([
      { model: 'platform/a', variant: '', rep: 0, n: DECIDER_CASES.length },
    ]);
    vi.mocked(getCaseResults).mockResolvedValue(await caseRowsFor(runId, 'platform/a', ''));
    vi.mocked(listReadyCurrentProfilesForEntries).mockResolvedValue([
      { model: 'platform/a', variant: '', run_id: runId },
      { model: 'platform/b', variant: 'high', run_id: runId },
    ]);
    // Every route needs at least one graded candidate or publishing is skipped.
    vi.mocked(getSummariesForRuns).mockResolvedValue(
      TAXONOMY_ROUTE_KEYS.flatMap(routeKey =>
        [
          { model: 'platform/a', variant: null },
          { model: 'platform/b', variant: 'high' },
        ].map(pair => ({
          ...pair,
          runId,
          routeKey,
          accuracy: 0.9,
          avgCostUsd: 0.002,
          avgLatencyMs: 100,
          p50LatencyMs: 100,
          p95LatencyMs: 150,
          cases: 10,
          errors: 0,
          timeouts: 0,
        }))
      )
    );

    await finalizeVia(runId, 'platform/a', null);

    expect(saveRoutingTable).toHaveBeenCalledOnce();
    const [, table] = vi.mocked(saveRoutingTable).mock.calls[0];
    expect(table.source).toBe('benchmark');
    // Version identifies the contributing registry rows, not a single run.
    expect(table.version).toMatch(/^registry-/);
    expect(Object.keys(table.routes)).toHaveLength(TAXONOMY_ROUTE_KEYS.length);
    expect(kvDelete).toHaveBeenCalled();
  });

  it('failRunAndDrain fails the claimed registry rows and drains both queues', async () => {
    vi.mocked(listPendingCurrentProfiles).mockResolvedValue([
      { model: 'vendor/next', variant: 'high', requested_at: '2026-06-01T00:00:00.000Z' },
    ]);

    await failRunAndDrain(env, 'user-fail-1', 'enqueue failed');

    expect(markRunFailed).toHaveBeenCalledWith(env.BENCH_DB, 'user-fail-1', 'enqueue failed');
    expect(markProfilesFailedForRun).toHaveBeenCalledWith(
      env.BENCH_DB,
      'user-fail-1',
      'enqueue failed'
    );
    // Both queues have pending work in this mock, so both start a run.
    expect(vi.mocked(insertRun).mock.calls.map(call => call[1].purpose)).toEqual([
      'platform',
      'user',
    ]);
  });
});

describe('drainQueue', () => {
  it('starts the oldest pending batch of the requested queue', async () => {
    vi.mocked(listPendingCurrentProfiles).mockResolvedValue([
      { model: 'm/old', variant: 'a', requested_at: '2026-06-01T00:00:00.000Z' },
      { model: 'm/new', variant: 'b', requested_at: '2026-06-02T00:00:00.000Z' },
    ]);
    const result = await drainQueue(env, 'user');
    expect(result).not.toBeNull();
    expect(result!.entryCount).toBe(2);
    expect(listPendingCurrentProfiles).toHaveBeenCalledWith(
      env.BENCH_DB,
      expect.anything(),
      'user'
    );
    const [, , modelRows] = vi.mocked(insertRun).mock.calls[0];
    expect(modelRows[0].model).toBe('m/old');
    expect(modelRows[1].model).toBe('m/new');
  });

  it('skips only the queue whose own slot is occupied', async () => {
    // A running user-queue run must not block the platform queue: the two hold
    // independent slots and independent container budgets.
    vi.mocked(getRunningRun).mockImplementation(async (_db, _kind, purpose) =>
      purpose === 'user' ? runningRun('user-busy', 'user') : undefined
    );
    vi.mocked(listPendingCurrentProfiles).mockResolvedValue([
      { model: 'm/pending', variant: '', requested_at: '2026-06-01T00:00:00.000Z' },
    ]);

    expect(await drainQueue(env, 'user')).toBeNull();
    const platformRun = await drainQueue(env, 'platform');
    expect(platformRun).not.toBeNull();
    expect(vi.mocked(insertRun).mock.calls[0][1].purpose).toBe('platform');
  });

  it('caps the batch by the queue container budget', async () => {
    // user budget 4, repetitions 2 → max entries = floor(4/2) = 2
    mockConfig({ max_concurrency: 100, user_max_concurrency: 4, decider_repetitions: 2 });
    vi.mocked(listPendingCurrentProfiles).mockResolvedValue([
      { model: 'm/1', variant: '', requested_at: '2026-06-01T00:00:00.000Z' },
      { model: 'm/2', variant: '', requested_at: '2026-06-01T00:00:01.000Z' },
      { model: 'm/3', variant: '', requested_at: '2026-06-01T00:00:02.000Z' },
      { model: 'm/4', variant: '', requested_at: '2026-06-01T00:00:03.000Z' },
    ]);
    const result = await drainQueue(env, 'user');
    expect(result!.entryCount).toBe(2);
    const [, , modelRows] = vi.mocked(insertRun).mock.calls[0];
    expect(modelRows.map(m => m.model)).toEqual(['m/1', 'm/2']);
  });

  it("drainQueues('both') starts one run per queue", async () => {
    vi.mocked(listPendingCurrentProfiles).mockResolvedValue([
      { model: 'm/x', variant: '', requested_at: '2026-06-01T00:00:00.000Z' },
    ]);
    const started = await drainQueues(env, 'both');
    expect(started.map(run => run.purpose)).toEqual(['platform', 'user']);
  });
});

describe('sweepStaleRunsAndDrain', () => {
  it('salvages a timed-out run per entry instead of failing every entry', async () => {
    // vendor/done finished; vendor/stuck never produced rows. Only vendor/stuck
    // may be lost — re-measuring vendor/done would cost money again.
    const runId = 'user-stale-1';
    const { DECIDER_CASES } = await import('./datasets/decider-cases');
    vi.mocked(listStaleRunningDeciderRuns).mockResolvedValue([{ id: runId, purpose: 'user' }]);
    vi.mocked(getRunWithModels).mockResolvedValue({
      run: runningRun(runId, 'user'),
      models: [
        {
          run_id: runId,
          model: 'vendor/done',
          variant: '',
          enqueued: true,
          reasoning_effort: null,
        },
        {
          run_id: runId,
          model: 'vendor/stuck',
          variant: '',
          enqueued: true,
          reasoning_effort: null,
        },
      ],
    });
    vi.mocked(countCaseResultsByLane).mockResolvedValue([
      { model: 'vendor/done', variant: '', rep: 0, n: DECIDER_CASES.length },
    ]);
    // Salvage writes lane-death rows and then finalizes, which reads them back.
    // Model that read-after-write rather than pretending the ledger stays empty.
    const laneDeaths: Awaited<ReturnType<typeof listLaneFailures>> = [];
    vi.mocked(recordLaneFailure).mockImplementation(async (_db, row) => {
      laneDeaths.push({ ...row, run_id: row.runId, failed_at: '2026-06-01T06:00:00.000Z' });
    });
    vi.mocked(listLaneFailures).mockImplementation(async () => laneDeaths);

    const result = await sweepStaleRunsAndDrain(env);

    expect(result.staleRunIds).toEqual([runId]);
    // The unfinished lane is recorded so normal finalization can settle the run.
    expect(recordLaneFailure).toHaveBeenCalledWith(
      env.BENCH_DB,
      expect.objectContaining({ runId, model: 'vendor/stuck', variant: '', rep: 0 })
    );
    expect(markProfilesFailedForEntries).toHaveBeenCalledWith(
      env.BENCH_DB,
      runId,
      [{ model: 'vendor/stuck', variant: '' }],
      expect.stringContaining('did not finish')
    );
    expect(markProfilesReadyForRun).toHaveBeenCalledWith(env.BENCH_DB, runId);
    // The run completed with partial results rather than being failed wholesale.
    expect(markRunCompleted).toHaveBeenCalledWith(env.BENCH_DB, runId);
  });

  it('does not throw when a queue slot is still occupied after the sweep', async () => {
    vi.mocked(getRunningRun).mockResolvedValue(runningRun('still-running', 'user'));
    vi.mocked(listPendingCurrentProfiles).mockResolvedValue([
      { model: 'm/p', variant: '', requested_at: '2026-06-01T00:00:00.000Z' },
    ]);
    const result = await sweepStaleRunsAndDrain(env);
    expect(result.drained).toEqual([]);
  });

  it('reconciles the platform queue before draining', async () => {
    // Only a reconcile sets `platform_requested`, and the timer is the sole
    // path that runs unattended. Without it a decider model added to the config
    // is invisible to the platform drain, and the publish guard counts its
    // pending row as settled and publishes a table missing it.
    await sweepStaleRunsAndDrain(env);

    expect(syncPlatformRegistryRows).toHaveBeenCalled();
    expect(vi.mocked(syncPlatformRegistryRows).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(listPendingCurrentProfiles).mock.invocationCallOrder[0]
    );
  });
});
