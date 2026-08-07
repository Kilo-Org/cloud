/**
 * Dead-letter handling: a queue message that exhausted retries must record its
 * lane death and finalize the run — profile runs complete per-entry, platform
 * runs fail fast. Mocks the db module; SQL guards are covered honestly in
 * lane-failure-sql.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as DbModule from './db';
import { DECIDER_CASES } from './datasets/decider-cases';

vi.mock('./db', async importOriginal => {
  const actual = await importOriginal<typeof DbModule>();
  return {
    ...actual,
    countCaseResultsByLane: vi.fn(),
    existsNewerCompletedRun: vi.fn(),
    getCaseResults: vi.fn(),
    getRunningRun: vi.fn(),
    getRunWithModels: vi.fn(),
    getSummaries: vi.fn(),
    listLaneFailures: vi.fn(),
    listPendingCurrentProfiles: vi.fn(),
    markProfilesFailedForEntries: vi.fn(),
    markProfilesFailedForRun: vi.fn(),
    markProfilesReadyForRun: vi.fn(),
    markRunCompleted: vi.fn(),
    markRunFailed: vi.fn(),
    recordLaneFailure: vi.fn(),
    replaceModelSummaries: vi.fn(),
    saveRoutingTable: vi.fn(),
  };
});

import {
  countCaseResultsByLane,
  getCaseResults,
  getRunningRun,
  getRunWithModels,
  getSummaries,
  listLaneFailures,
  listPendingCurrentProfiles,
  markProfilesFailedForEntries,
  markProfilesReadyForRun,
  markRunCompleted,
  markRunFailed,
  recordLaneFailure,
  replaceModelSummaries,
  saveRoutingTable,
} from './db';
import { processDeadLetter, PROFILE_LANE_DEAD_FAILURE_REASON } from './run';

const queueSendBatch = vi.fn();
const kvDelete = vi.fn();
const runId = 'profile-dead-1';

const env = {
  BENCH_DB: {} as D1Database,
  BENCH_QUEUE: { sendBatch: queueSendBatch },
  AUTO_ROUTING_CONFIG: { delete: kvDelete },
  INTERNAL_API_SECRET_PROD: { get: async () => 'secret' },
  KILO_WEB_API_BASE_URL: 'https://app.test',
  KILO_CLI_API_URL: 'https://api.test',
} as unknown as Env;

function mockRunState(
  models: { model: string; variant: string }[],
  purpose: 'platform' | 'profile' = 'profile',
  status: 'running' | 'failed' = 'running'
): void {
  vi.mocked(getRunWithModels).mockResolvedValue({
    run: {
      id: runId,
      kind: 'decider',
      status,
      started_at: '2026-08-07T09:00:00.000Z',
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
      purpose,
    },
    models: models.map(m => ({
      run_id: runId,
      model: m.model,
      variant: m.variant,
      enqueued: true,
      reasoning_effort: null,
    })),
  } as never);
}

function deadLetterMessage(overrides: Record<string, unknown> = {}) {
  return {
    runId,
    kind: 'decider' as const,
    model: 'b/dead',
    variant: 'high',
    chunk: 27,
    shard: 0,
    rep: 0,
    caseIds: DECIDER_CASES.slice(135, 140).map(c => c.id),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(countCaseResultsByLane).mockResolvedValue([]);
  vi.mocked(listLaneFailures).mockResolvedValue([]);
  vi.mocked(recordLaneFailure).mockResolvedValue(undefined);
  vi.mocked(getCaseResults).mockResolvedValue([]);
  vi.mocked(getSummaries).mockResolvedValue([]);
  vi.mocked(replaceModelSummaries).mockResolvedValue(undefined);
  vi.mocked(markRunCompleted).mockResolvedValue(undefined);
  vi.mocked(markRunFailed).mockResolvedValue(undefined);
  vi.mocked(markProfilesFailedForEntries).mockResolvedValue(undefined);
  vi.mocked(markProfilesReadyForRun).mockResolvedValue(undefined);
  vi.mocked(getRunningRun).mockResolvedValue(undefined);
  vi.mocked(listPendingCurrentProfiles).mockResolvedValue([]);
  queueSendBatch.mockResolvedValue(undefined);
});

describe('processDeadLetter', () => {
  it('records the lane death and completes a profile run per-entry', async () => {
    mockRunState([
      { model: 'a/ok', variant: '' },
      { model: 'b/dead', variant: 'high' },
    ]);
    vi.mocked(countCaseResultsByLane).mockResolvedValue([
      { model: 'a/ok', variant: '', rep: 0, n: DECIDER_CASES.length },
    ]);
    // The post-record read already sees the failure.
    vi.mocked(listLaneFailures).mockResolvedValue([
      {
        run_id: runId,
        model: 'b/dead',
        variant: 'high',
        rep: 0,
        chunk: 27,
        shard: 0,
        failed_at: '2026-08-07T12:00:00.000Z',
      },
    ]);

    await processDeadLetter(env, deadLetterMessage());

    expect(recordLaneFailure).toHaveBeenCalledWith(env.BENCH_DB, {
      runId,
      model: 'b/dead',
      variant: 'high',
      rep: 0,
      chunk: 27,
      shard: 0,
    });
    expect(markRunCompleted).toHaveBeenCalledWith(env.BENCH_DB, runId);
    // Only the dead entry fails; the completed entry still goes ready.
    expect(markProfilesFailedForEntries).toHaveBeenCalledWith(
      env.BENCH_DB,
      runId,
      [{ model: 'b/dead', variant: 'high' }],
      PROFILE_LANE_DEAD_FAILURE_REASON
    );
    expect(markProfilesReadyForRun).toHaveBeenCalledWith(env.BENCH_DB, runId);
    // Profile runs never publish platform artifacts.
    expect(saveRoutingTable).not.toHaveBeenCalled();
    expect(kvDelete).not.toHaveBeenCalled();
  });

  it('fails a platform run fast when a lane is dead, without publishing', async () => {
    mockRunState([{ model: 'b/dead', variant: 'high' }], 'platform');
    vi.mocked(listLaneFailures).mockResolvedValue([
      {
        run_id: runId,
        model: 'b/dead',
        variant: 'high',
        rep: 0,
        chunk: 27,
        shard: 0,
        failed_at: '2026-08-07T12:00:00.000Z',
      },
    ]);

    await processDeadLetter(env, deadLetterMessage());

    expect(markRunFailed).toHaveBeenCalledWith(
      env.BENCH_DB,
      runId,
      expect.stringContaining('lane dead-lettered: b/dead variant high rep 0')
    );
    expect(markRunCompleted).not.toHaveBeenCalled();
    expect(saveRoutingTable).not.toHaveBeenCalled();
  });

  it('does not finalize while another lane is still pending', async () => {
    mockRunState([
      { model: 'a/pending', variant: '' },
      { model: 'b/dead', variant: 'high' },
    ]);
    // a/pending has no rows and no failure record yet.
    vi.mocked(listLaneFailures).mockResolvedValue([
      {
        run_id: runId,
        model: 'b/dead',
        variant: 'high',
        rep: 0,
        chunk: 27,
        shard: 0,
        failed_at: '2026-08-07T12:00:00.000Z',
      },
    ]);

    await processDeadLetter(env, deadLetterMessage());

    expect(recordLaneFailure).toHaveBeenCalled();
    expect(markRunCompleted).not.toHaveBeenCalled();
    expect(markRunFailed).not.toHaveBeenCalled();
    expect(markProfilesFailedForEntries).not.toHaveBeenCalled();
  });

  it('lets written rows win over a failure record (message died after writes)', async () => {
    mockRunState([{ model: 'b/dead', variant: 'high' }]);
    vi.mocked(countCaseResultsByLane).mockResolvedValue([
      { model: 'b/dead', variant: 'high', rep: 0, n: DECIDER_CASES.length },
    ]);
    vi.mocked(listLaneFailures).mockResolvedValue([
      {
        run_id: runId,
        model: 'b/dead',
        variant: 'high',
        rep: 0,
        chunk: 27,
        shard: 0,
        failed_at: '2026-08-07T12:00:00.000Z',
      },
    ]);

    await processDeadLetter(env, deadLetterMessage());

    expect(markRunCompleted).toHaveBeenCalledWith(env.BENCH_DB, runId);
    expect(markProfilesFailedForEntries).not.toHaveBeenCalled();
    expect(markProfilesReadyForRun).toHaveBeenCalledWith(env.BENCH_DB, runId);
  });

  it('ignores messages for a run that is no longer running', async () => {
    mockRunState([{ model: 'b/dead', variant: 'high' }], 'profile', 'failed');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await processDeadLetter(env, deadLetterMessage());

    expect(recordLaneFailure).not.toHaveBeenCalled();
    expect(markRunCompleted).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('benchmark_deadletter_run_not_running')
    );
    warn.mockRestore();
  });

  it('drops malformed messages without recording', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await processDeadLetter(env, { nope: true });

    expect(recordLaneFailure).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('benchmark_deadletter_invalid_message')
    );
    warn.mockRestore();
  });

  it('resolves the sole snapshot row variant for legacy variant-less messages', async () => {
    mockRunState([{ model: 'b/dead', variant: 'high' }]);
    const message = deadLetterMessage();
    delete (message as { variant?: unknown }).variant;

    await processDeadLetter(env, message);

    expect(recordLaneFailure).toHaveBeenCalledWith(
      env.BENCH_DB,
      expect.objectContaining({ model: 'b/dead', variant: 'high' })
    );
  });
});
