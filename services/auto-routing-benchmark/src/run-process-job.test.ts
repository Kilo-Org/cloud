import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TAXONOMY_ROUTE_KEYS } from '@kilocode/auto-routing-contracts';
import type * as CliRunnerModule from './cli-runner';
import type * as DbModule from './db';
import { DECIDER_CASES } from './datasets/decider-cases';
import { CLASSIFIER_CASES } from './datasets/classifier-cases';
import type * as ConfigModule from './config';

import type * as SchedulerModule from './scheduler';

vi.mock('./scheduler', async importOriginal => {
  const actual = await importOriginal<typeof SchedulerModule>();
  return {
    ...actual,
    beginPaidCase: vi.fn(),
    hasPaidCase: vi.fn(),
    claimScheduledChunks: vi.fn(),
    clearUnbilledCase: vi.fn(),
    cooldownProviders: vi.fn(),
    deferChunk: vi.fn(),
    failChunk: vi.fn(),
    finishChunk: vi.fn(),
    getChunk: vi.fn(),
    getPaidCaseStartedAt: vi.fn(),
    hasUnsettledChunks: vi.fn(),
    recoverChunks: vi.fn(),
    scheduleRunChunks: vi.fn(),
    startChunk: vi.fn(),
  };
});
vi.mock('./decider-judge', () => ({ createDeciderJudge: vi.fn() }));
vi.mock('./openrouter', () => ({ createSystemOneClient: vi.fn() }));
vi.mock('./config', async importOriginal => {
  const actual = await importOriginal<typeof ConfigModule>();
  return { ...actual, getBenchmarkConfig: vi.fn() };
});

vi.mock('./db', async importOriginal => {
  const actual = await importOriginal<typeof DbModule>();
  return {
    ...actual,
    countCaseResultsByLane: vi.fn(),
    listLaneFailures: vi.fn(),
    recordLaneFailure: vi.fn(),
    existsNewerCompletedRun: vi.fn(),
    getCaseResults: vi.fn(),
    getExistingCaseResultIds: vi.fn(),
    getPendingDeciderOutput: vi.fn(),
    savePendingDeciderOutput: vi.fn(),
    getRunWithModels: vi.fn(),
    getSummaries: vi.fn(),
    syncPlatformRegistryRows: vi.fn(),
    getLatestRoutingTable: vi.fn(),
    countCurrentProfilesByStatus: vi.fn(),
    getSummariesForRuns: vi.fn(),
    getRoutingCaseResultsForEntries: vi.fn().mockResolvedValue([]),
    listReadyCurrentProfilesForEntries: vi.fn(),
    markRunCompleted: vi.fn(),
    replaceModelSummaries: vi.fn(),
    saveRoutingTable: vi.fn(),
    upsertCaseResult: vi.fn(),
    listPendingCurrentProfiles: vi.fn(),
    listStaleRunningDeciderRuns: vi.fn(),
    markProfilesFailedForRun: vi.fn(),
    markProfilesReadyForRun: vi.fn(),
    markProfilesRunningForRun: vi.fn(),
    markStaleRunsFailed: vi.fn(),
    getRunningRun: vi.fn(),
    getLiveContainerLanes: vi.fn(),
    getLatestSummariesByModel: vi.fn(),
  };
});

vi.mock('./cli-runner', async importOriginal => {
  const actual = await importOriginal<typeof CliRunnerModule>();
  return {
    ...actual,
    destroyDeciderCliContainer: vi.fn(),
    runDeciderCaseViaCli: vi.fn(),
    warmUpCliContainer: vi.fn(),
  };
});

import {
  destroyDeciderCliContainer,
  runDeciderCaseViaCli,
  warmUpCliContainer,
  type CliRunResult,
} from './cli-runner';
import {
  countCaseResultsByLane,
  getCaseResults,
  getSummaries,
  existsNewerCompletedRun,
  getExistingCaseResultIds,
  getPendingDeciderOutput,
  savePendingDeciderOutput,
  type PendingDeciderOutput,
  getRunWithModels,
  getLiveContainerLanes,
  listPendingCurrentProfiles,
  getRunningRun,
  syncPlatformRegistryRows,
  getLatestRoutingTable,
  countCurrentProfilesByStatus,
  getSummariesForRuns,
  listReadyCurrentProfilesForEntries,
  listLaneFailures,
  listStaleRunningDeciderRuns,
  markRunCompleted,
  recordLaneFailure,
  saveRoutingTable,
  upsertCaseResult,
} from './db';
import { getBenchmarkConfig } from './config';
import { processJob, acceptContainerCaseResult, PAID_OUTPUT_WAIT_MS } from './run';
import { createDeciderJudge } from './decider-judge';
import { createSystemOneClient } from './openrouter';
import type { DeciderJudge } from './grading';
import {
  beginPaidCase,
  hasPaidCase,
  claimScheduledChunks,
  clearUnbilledCase,
  cooldownProviders,
  deferChunk,
  failChunk,
  finishChunk,
  getChunk,
  getPaidCaseStartedAt,
  hasUnsettledChunks,
  recoverChunks,
  scheduleRunChunks,
  startChunk,
  type SchedulerClaim,
} from './scheduler';

const tokenGet = vi.fn<() => Promise<string>>();
const queueSendBatch = vi.fn<(messages: unknown[]) => Promise<void>>();
const queueSend = vi.fn();
const schedulerFirst = vi.fn();
const schedulerAll = vi.fn();
const schedulerRun = vi.fn();
const schedulerPrepare = vi.fn(() => {
  const statement = {
    first: schedulerFirst,
    all: schedulerAll,
    run: schedulerRun,
  };
  return { ...statement, bind: vi.fn(() => statement) };
});
const kvDelete = vi.fn();
const model = 'qwen/qwen3-coder-next';
const runId = 'decider-test-run';
const [benchCase] = DECIDER_CASES;

const successfulCliResult = {
  text: 'not the expected answer',
  costUsd: null,
  latencyMs: 25,
  exitCode: 0,
  stderrTail: '',
  eventCount: 1,
  lastEventTypes: ['session.created'],
  timedOut: false,
} satisfies CliRunResult;

const env = {
  INTERNAL_API_SECRET_PROD: { get: tokenGet },
  KILO_CLI_API_URL: 'http://host.docker.internal:3000',
  KILO_WEB_API_BASE_URL: 'http://host.docker.internal:3000',
  BENCH_RESULT_URL: 'https://bench.test/container/case-result',
  BENCH_DB: { prepare: schedulerPrepare } as unknown as D1Database,
  BENCH_QUEUE: { send: queueSend, sendBatch: queueSendBatch },
  BENCHMARK_SCHEDULER_CONFIG: '{}',
  AUTO_ROUTING_CONFIG: { delete: kvDelete },
} as unknown as Env;

function mockClaim(overrides: Partial<SchedulerClaim> = {}): SchedulerClaim {
  const claim = {
    id: 'chunk-1',
    token: 'token-1',
    run_id: runId,
    model,
    variant: '',
    providers: '["qwen"]',
    rep: 0,
    chunk: 0,
    case_ids: JSON.stringify([benchCase.id]),
    slot: 7,
    attempts: 1,
    ...overrides,
  };
  vi.mocked(getChunk).mockResolvedValue(claim);
  return claim;
}

function mockRunSnapshot(
  models: Array<{
    model: string;
    variant: string;
    enqueued?: boolean;
    reasoning_effort?: string | null;
  }> = [{ model, variant: '', enqueued: true, reasoning_effort: null }]
): void {
  vi.mocked(getRunWithModels).mockResolvedValue({
    run: {
      max_concurrency: 4,
      status: 'running',
      min_accuracy: 0.7,
      switch_cost_factor: 3,
      best_accuracy_switch_threshold: 0.05,
      benchmark_user_id: 'benchmark-user',
      benchmark_org_id: 'benchmark-org',
      repetitions: 1,
      classifier_max_p95_latency_ms: null,
      started_at: '2026-06-16T00:00:00.000Z',
      purpose: 'platform',
    },
    models: models.map(m => ({
      enqueued: true,
      reasoning_effort: null,
      ...m,
    })),
  } as never);
}

it('retries completed classifier publication without repeating classifier cases', async () => {
  const snapshot = await getRunWithModels(env.BENCH_DB, runId);
  if (!snapshot) throw new Error('Run snapshot missing');
  vi.mocked(getRunWithModels).mockResolvedValue({
    ...snapshot,
    run: { ...snapshot.run, status: 'completed' },
  });
  vi.mocked(countCaseResultsByLane).mockResolvedValue([
    { model, variant: '', rep: 0, n: CLASSIFIER_CASES.length },
  ]);
  vi.mocked(getCaseResults).mockResolvedValue([]);
  vi.mocked(getSummaries).mockResolvedValue([]);
  vi.mocked(existsNewerCompletedRun).mockResolvedValue(false);
  kvDelete.mockRejectedValueOnce(new Error('KV unavailable'));
  const message = { runId, kind: 'classifier', model, rep: 0 };
  await expect(processJob(env, message)).rejects.toThrow('KV unavailable');
  await processJob(env, message);
  expect(kvDelete).toHaveBeenCalledTimes(2);
  expect(createSystemOneClient).not.toHaveBeenCalled();
  expect(upsertCaseResult).not.toHaveBeenCalled();
});

function deciderMessage() {
  return {
    runId,
    kind: 'decider' as const,
    model,
    claimId: 'chunk-1',
    claimToken: 'token-1',
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  schedulerFirst.mockResolvedValue(null);
  schedulerAll.mockResolvedValue({ results: [] });
  schedulerRun.mockResolvedValue({ meta: { changes: 0 } });
  queueSend.mockResolvedValue(undefined);
  vi.mocked(startChunk).mockResolvedValue(true);
  vi.mocked(beginPaidCase).mockResolvedValue(true);
  vi.mocked(getPaidCaseStartedAt).mockResolvedValue(null);
  vi.mocked(hasPaidCase).mockResolvedValue(true);
  vi.mocked(claimScheduledChunks).mockResolvedValue([]);
  vi.mocked(recoverChunks).mockResolvedValue([]);
  vi.mocked(hasUnsettledChunks).mockResolvedValue(false);
  mockClaim();
  vi.mocked(getBenchmarkConfig).mockResolvedValue({
    router: 'efficient',
    accuracyNoiseBand: 0.05,
    frontierMinAccuracyDelta: 0,
    classifierModels: ['classifier/a'],
    deciderModels: [{ id: model }],
    minAccuracy: 0.7,
    benchmarkUserId: 'user-1',
    benchmarkOrgId: null,
    switchCostFactor: 3,
    bestAccuracySwitchThreshold: 0.05,
    productionTokenProfile: null,
    switchHorizonTurns: null,
    lowConfidenceThreshold: null,
    classifierRepetitions: 1,
    deciderRepetitions: 1,
    classifierMaxP95LatencyMs: 1000,
    updatedAt: null,
    updatedBy: null,
  });
  vi.mocked(listReadyCurrentProfilesForEntries).mockResolvedValue([]);
  vi.mocked(getSummariesForRuns).mockResolvedValue([]);
  vi.mocked(countCurrentProfilesByStatus).mockResolvedValue([]);
  vi.mocked(getLatestRoutingTable).mockResolvedValue(null);
  vi.mocked(syncPlatformRegistryRows).mockResolvedValue(undefined);
  vi.mocked(listStaleRunningDeciderRuns).mockResolvedValue([]);
  vi.mocked(listPendingCurrentProfiles).mockResolvedValue([]);
  vi.mocked(getRunningRun).mockResolvedValue(undefined);
  vi.mocked(getLiveContainerLanes).mockResolvedValue(0);
  tokenGet.mockResolvedValue('internal-secret');
  queueSendBatch.mockResolvedValue(undefined);
  vi.stubGlobal(
    'fetch',
    vi.fn(async url =>
      String(url).includes('/api/openrouter/models')
        ? Response.json({
            data: [
              { id: model, opencode: { variants: { max: { reasoning: { effort: 'max' } } } } },
            ],
          })
        : Response.json({ token: 'kilo-user-token', expiresAt: '2026-06-16T01:00:00.000Z' })
    )
  );
  mockRunSnapshot();
  vi.mocked(countCaseResultsByLane).mockResolvedValue([]);
  vi.mocked(listLaneFailures).mockResolvedValue([]);
  vi.mocked(recordLaneFailure).mockResolvedValue(undefined);
  vi.mocked(getExistingCaseResultIds).mockResolvedValue(new Set());
  vi.mocked(getPendingDeciderOutput).mockResolvedValue(null);
  vi.mocked(savePendingDeciderOutput).mockResolvedValue(undefined);
  vi.mocked(createSystemOneClient).mockResolvedValue({ apiKey: 'test', attributionHeaders: {} });
  vi.mocked(createDeciderJudge).mockReturnValue(async () => ({ probability: 0.8, costUsd: 0.001 }));
  vi.mocked(destroyDeciderCliContainer).mockResolvedValue(undefined);
  vi.mocked(warmUpCliContainer).mockResolvedValue(undefined);
  vi.mocked(runDeciderCaseViaCli).mockResolvedValue(successfulCliResult);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('processJob — scheduler-owned execution', () => {
  it('uses the stored exact pair, slot, repetition and input rather than message ownership', async () => {
    mockRunSnapshot([
      { model, variant: 'high', reasoning_effort: 'high' },
      { model, variant: 'low', reasoning_effort: 'low' },
    ]);
    mockClaim({ variant: 'low', rep: 2 });

    await processJob(env, {
      ...deciderMessage(),
      model: 'untrusted/message-model',
      variant: 'high',
      rep: 8,
      caseIds: ['not-owned'],
      shard: 99,
    });

    expect(startChunk).toHaveBeenCalledWith(env.BENCH_DB, 'chunk-1', 'token-1', expect.any(Number));
    expect(getChunk).toHaveBeenCalledWith(env.BENCH_DB, 'chunk-1', 'token-1');
    expect(warmUpCliContainer).toHaveBeenCalledWith(
      env,
      expect.objectContaining({
        instanceName: 'benchmark-slot:7',
        model,
        kiloApiUrl: env.KILO_CLI_API_URL,
        orgId: 'benchmark-org',
      })
    );
    expect(runDeciderCaseViaCli).toHaveBeenCalledWith(
      env,
      expect.objectContaining({
        instanceName: 'benchmark-slot:7',
        model,
        variant: 'low',
        benchCase,
        kiloToken: 'kilo-user-token',
        kiloApiUrl: env.KILO_CLI_API_URL,
        orgId: 'benchmark-org',
        resultCallback: {
          url: env.BENCH_RESULT_URL,
          execution: {
            runId,
            model,
            variant: 'low',
            rep: 2,
            caseId: benchCase.id,
            token: 'token-1',
          },
        },
      })
    );
    expect(beginPaidCase).toHaveBeenCalledWith(
      env.BENCH_DB,
      {
        runId,
        model,
        variant: 'low',
        rep: 2,
        caseId: benchCase.id,
        token: 'token-1',
      },
      expect.any(Number)
    );
    expect(upsertCaseResult).toHaveBeenCalledWith(
      env.BENCH_DB,
      expect.objectContaining({
        model,
        variant: 'low',
        rep: 2,
        case_id: benchCase.id,
        latency_ms: 25,
        cost_usd: null,
        exit_code: 0,
        output_prefix: successfulCliResult.text,
      })
    );
    expect(finishChunk).toHaveBeenCalledWith(env.BENCH_DB, 'chunk-1', 'token-1');
    expect(claimScheduledChunks).toHaveBeenCalled();
    expect(queueSendBatch).not.toHaveBeenCalled();
    expect(destroyDeciderCliContainer).not.toHaveBeenCalled();
  });

  it('defers a claim whose exact pair is missing rather than executing another variant', async () => {
    mockRunSnapshot([{ model, variant: 'high', reasoning_effort: 'high' }]);
    mockClaim({ variant: 'medium' });
    await processJob(env, deciderMessage());
    expect(runDeciderCaseViaCli).not.toHaveBeenCalled();
    expect(upsertCaseResult).not.toHaveBeenCalled();
    expect(deferChunk).toHaveBeenCalledWith(env.BENCH_DB, 'chunk-1', 'token-1', expect.any(Number));
    expect(finishChunk).not.toHaveBeenCalled();
  });

  it('makes a delivery whose token no longer owns its chunk a no-op', async () => {
    vi.mocked(startChunk).mockResolvedValue(false);
    await processJob(env, deciderMessage());
    expect(getChunk).toHaveBeenCalledWith(env.BENCH_DB, 'chunk-1', 'token-1');
    expect(getRunWithModels).not.toHaveBeenCalled();
    expect(runDeciderCaseViaCli).not.toHaveBeenCalled();
    expect(beginPaidCase).not.toHaveBeenCalled();
    expect(finishChunk).not.toHaveBeenCalled();
    expect(deferChunk).not.toHaveBeenCalled();
    expect(claimScheduledChunks).not.toHaveBeenCalled();
  });

  it('does not start a claim whose token ownership is absent', async () => {
    vi.mocked(getChunk).mockResolvedValue(null);
    await processJob(env, deciderMessage());
    expect(startChunk).not.toHaveBeenCalled();
    expect(runDeciderCaseViaCli).not.toHaveBeenCalled();
    expect(finishChunk).not.toHaveBeenCalled();
  });

  it('defers a transient run-snapshot read failure instead of parking an active slot', async () => {
    vi.mocked(getRunWithModels).mockRejectedValueOnce(new Error('D1 temporary read failure'));
    await processJob(env, deciderMessage());
    expect(deferChunk).toHaveBeenCalledWith(env.BENCH_DB, 'chunk-1', 'token-1', expect.any(Number));
    expect(queueSend).toHaveBeenCalledWith(
      { runId, kind: 'decider', model, schedulerWake: true },
      { delaySeconds: 15 }
    );
    expect(runDeciderCaseViaCli).not.toHaveBeenCalled();
    expect(upsertCaseResult).not.toHaveBeenCalled();
  });

  it('checks existing results for every claimed case and skips only completed cases', async () => {
    const cases = DECIDER_CASES.slice(0, 3);
    mockClaim({ case_ids: JSON.stringify(cases.map(c => c.id)) });
    vi.mocked(getExistingCaseResultIds).mockResolvedValue(new Set([cases[0].id]));

    await processJob(env, deciderMessage());

    expect(getExistingCaseResultIds).toHaveBeenCalledWith(env.BENCH_DB, {
      runId,
      model,
      variant: null,
      rep: 0,
      caseIds: cases.map(c => c.id),
    });
    expect(runDeciderCaseViaCli).toHaveBeenCalledTimes(2);
    for (const c of cases.slice(1)) {
      expect(getPendingDeciderOutput).toHaveBeenCalledWith(env.BENCH_DB, {
        run_id: runId,
        model,
        variant: '',
        rep: 0,
        case_id: c.id,
      });
    }
    expect(finishChunk).toHaveBeenCalled();
  });

  it('finishes an already-written claim without warming or paying again', async () => {
    vi.mocked(getExistingCaseResultIds).mockResolvedValue(new Set([benchCase.id]));
    await processJob(env, deciderMessage());
    expect(warmUpCliContainer).not.toHaveBeenCalled();
    expect(runDeciderCaseViaCli).not.toHaveBeenCalled();
    expect(beginPaidCase).not.toHaveBeenCalled();
    expect(finishChunk).toHaveBeenCalled();
    expect(countCaseResultsByLane).toHaveBeenCalled();
    expect(destroyDeciderCliContainer).not.toHaveBeenCalled();
  });

  it('dispatches a newly available claim instead of chaining model chunks', async () => {
    const next = { ...mockClaim(), id: 'next-chunk', token: 'next-token', model: 'other/model' };
    vi.mocked(claimScheduledChunks).mockResolvedValueOnce([next]).mockResolvedValue([]);
    await processJob(env, deciderMessage());
    expect(queueSend).toHaveBeenCalledWith({
      runId,
      kind: 'decider',
      model: 'other/model',
      claimId: 'next-chunk',
      claimToken: 'next-token',
    });
    expect(queueSendBatch).not.toHaveBeenCalled();
  });

  it('only dispatches on scheduler wakeups', async () => {
    await processJob(env, { runId, kind: 'decider', model, schedulerWake: true });
    expect(recoverChunks).toHaveBeenCalled();
    expect(claimScheduledChunks).toHaveBeenCalled();
    expect(startChunk).not.toHaveBeenCalled();
    expect(runDeciderCaseViaCli).not.toHaveBeenCalled();
  });

  it('releases every unsent claim when a queue send fails mid-batch', async () => {
    const claims = ['a', 'b', 'c'].map(suffix =>
      mockClaim({ id: `chunk-${suffix}`, token: `token-${suffix}`, model: `batch/${suffix}` })
    );
    vi.mocked(claimScheduledChunks).mockResolvedValue(claims);
    queueSend
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('queue unavailable'));
    await expect(
      processJob(env, { runId, kind: 'decider', model, schedulerWake: true })
    ).rejects.toThrow('queue unavailable');
    expect(queueSend).toHaveBeenCalledTimes(2);
    expect(deferChunk).toHaveBeenCalledTimes(2);
    expect(deferChunk).toHaveBeenCalledWith(env.BENCH_DB, 'chunk-b', 'token-b', expect.any(Number));
    expect(deferChunk).toHaveBeenCalledWith(env.BENCH_DB, 'chunk-c', 'token-c', expect.any(Number));
  });
});

describe('processJob — legacy whole-run migration', () => {
  it('initializes every snapshot entry and repetition, ignoring legacy chunk ownership', async () => {
    mockRunSnapshot([
      { model, variant: 'high', reasoning_effort: 'high' },
      { model, variant: 'low', reasoning_effort: 'low' },
      { model: 'not/enqueued', variant: '', enqueued: false },
    ]);
    const snapshot = await getRunWithModels(env.BENCH_DB, runId);
    if (!snapshot) throw new Error('Run snapshot missing');
    vi.mocked(getRunWithModels).mockResolvedValue({
      ...snapshot,
      run: { ...snapshot.run, repetitions: 3 },
    });

    await processJob(env, {
      runId,
      kind: 'decider',
      model,
      caseIds: ['obsolete-case'],
      chunk: 999,
      shard: 3,
      shardCount: 4,
      rep: 2,
      importedChunks: [0, 1],
    });

    expect(schedulerPrepare).toHaveBeenCalledWith(
      'SELECT run_id FROM scheduler_runs WHERE run_id = ?'
    );
    expect(scheduleRunChunks).toHaveBeenCalledWith(env.BENCH_DB, {
      runId,
      entries: [
        { model, variant: 'high', providers: [] },
        { model, variant: 'low', providers: [] },
      ],
      repetitions: 3,
      caseIds: DECIDER_CASES.map(c => c.id),
      chunkSize: 1,
    });
    expect(destroyDeciderCliContainer).toHaveBeenCalledTimes(2);
    for (const variant of ['high', 'low']) {
      expect(destroyDeciderCliContainer).toHaveBeenCalledWith(env, {
        instanceName: `${runId}:${model}:${variant}:2:3`,
      });
    }
    expect(claimScheduledChunks).toHaveBeenCalled();
    expect(runDeciderCaseViaCli).not.toHaveBeenCalled();
    expect(upsertCaseResult).not.toHaveBeenCalled();
    expect(startChunk).not.toHaveBeenCalled();
  });

  it('does not initialize a legacy run already registered with the scheduler', async () => {
    schedulerFirst.mockResolvedValue({ run_id: runId });
    await processJob(env, { runId, kind: 'decider', model, caseIds: [benchCase.id] });
    expect(scheduleRunChunks).not.toHaveBeenCalled();
    expect(runDeciderCaseViaCli).not.toHaveBeenCalled();
    expect(claimScheduledChunks).toHaveBeenCalled();
  });

  it('still migrates and dispatches when legacy container teardown fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      vi.mocked(destroyDeciderCliContainer).mockRejectedValueOnce(new Error('destroy unavailable'));
      await expect(
        processJob(env, { runId, kind: 'decider', model, variant: null, shard: 1 })
      ).resolves.toBeUndefined();
      expect(scheduleRunChunks).toHaveBeenCalled();
      expect(claimScheduledChunks).toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('benchmark_legacy_container_destroy_failed')
      );
    } finally {
      warn.mockRestore();
    }
  });

  it.each(['completed', 'failed'] as const)(
    'never migrates or executes a %s legacy run',
    async status => {
      const snapshot = await getRunWithModels(env.BENCH_DB, runId);
      if (!snapshot) throw new Error('Run snapshot missing');
      vi.mocked(getRunWithModels).mockResolvedValue({
        ...snapshot,
        run: { ...snapshot.run, status },
      });
      await processJob(env, { runId, kind: 'decider', model });
      expect(scheduleRunChunks).not.toHaveBeenCalled();
      expect(runDeciderCaseViaCli).not.toHaveBeenCalled();
      expect(upsertCaseResult).not.toHaveBeenCalled();
    }
  );
});

describe('processJob — scheduler waits and paid-call safety', () => {
  it.each([
    'container /run failed: HTTP 503 There is no Container instance available at this time. This is likely because you have reached your max concurrent instance count.',
    'container /run failed: HTTP 503 Maximum number of running container instances exceeded',
    'container /run failed: HTTP 503 There is no container instance that can be provided to this Durable Object, try again later',
  ])('defers capacity without writing a model failure: %s', async message => {
    vi.mocked(runDeciderCaseViaCli).mockRejectedValueOnce(new Error(message));
    await processJob(env, deciderMessage());
    expect(clearUnbilledCase).toHaveBeenCalled();
    expect(deferChunk).toHaveBeenCalledWith(env.BENCH_DB, 'chunk-1', 'token-1', expect.any(Number));
    expect(queueSend).toHaveBeenCalledWith(
      { runId, kind: 'decider', model, schedulerWake: true },
      { delaySeconds: 15 }
    );
    expect(upsertCaseResult).not.toHaveBeenCalled();
    expect(recordLaneFailure).not.toHaveBeenCalled();
    expect(finishChunk).not.toHaveBeenCalled();
  });

  it('defers warmup capacity before beginning a paid case', async () => {
    vi.mocked(warmUpCliContainer).mockRejectedValueOnce(
      new Error(
        'container /warmup failed: HTTP 503 There is no Container instance available at this time'
      )
    );
    await processJob(env, deciderMessage());
    expect(beginPaidCase).not.toHaveBeenCalled();
    expect(runDeciderCaseViaCli).not.toHaveBeenCalled();
    expect(upsertCaseResult).not.toHaveBeenCalled();
    expect(recordLaneFailure).not.toHaveBeenCalled();
    expect(deferChunk).toHaveBeenCalled();
  });

  it('cools down provider 429s without saving a zero or a lane failure', async () => {
    const claim = mockClaim();
    vi.mocked(runDeciderCaseViaCli).mockResolvedValueOnce({
      ...successfulCliResult,
      text: '',
      exitCode: 1,
      costUsd: 0,
      stderrTail: 'HTTP 429 rate limited',
    });
    await processJob(env, deciderMessage());
    expect(clearUnbilledCase).toHaveBeenCalledWith(env.BENCH_DB, {
      runId,
      model,
      variant: '',
      rep: 0,
      caseId: benchCase.id,
      token: claim.token,
    });
    expect(cooldownProviders).toHaveBeenCalledWith(env.BENCH_DB, claim, expect.any(Number));
    expect(deferChunk).toHaveBeenCalled();
    expect(savePendingDeciderOutput).not.toHaveBeenCalled();
    expect(upsertCaseResult).not.toHaveBeenCalled();
    expect(recordLaneFailure).not.toHaveBeenCalled();
  });

  it('fails the lane without paying again once a prior paid execution can no longer deliver', async () => {
    vi.mocked(getPaidCaseStartedAt).mockResolvedValue(Date.now() - PAID_OUTPUT_WAIT_MS);
    await processJob(env, deciderMessage());
    expect(warmUpCliContainer).not.toHaveBeenCalled();
    expect(beginPaidCase).not.toHaveBeenCalled();
    expect(runDeciderCaseViaCli).not.toHaveBeenCalled();
    expect(upsertCaseResult).not.toHaveBeenCalled();
    expect(failChunk).toHaveBeenCalledWith(env.BENCH_DB, 'chunk-1', 'token-1');
    expect(recordLaneFailure).toHaveBeenCalledWith(env.BENCH_DB, {
      runId,
      model,
      variant: '',
      rep: 0,
      chunk: 0,
      shard: 0,
    });
    expect(deferChunk).not.toHaveBeenCalled();
    expect(finishChunk).not.toHaveBeenCalled();
  });

  it('keeps the slot and rechecks while a prior paid execution may still deliver', async () => {
    vi.mocked(getPaidCaseStartedAt).mockResolvedValue(Date.now() - 1_000);
    await processJob(env, deciderMessage());
    expect(getPaidCaseStartedAt).toHaveBeenCalledWith(env.BENCH_DB, {
      runId,
      model,
      variant: '',
      rep: 0,
      caseId: benchCase.id,
      token: 'token-1',
    });
    expect(warmUpCliContainer).not.toHaveBeenCalled();
    expect(beginPaidCase).not.toHaveBeenCalled();
    expect(runDeciderCaseViaCli).not.toHaveBeenCalled();
    expect(failChunk).not.toHaveBeenCalled();
    expect(recordLaneFailure).not.toHaveBeenCalled();
    expect(deferChunk).not.toHaveBeenCalled();
    expect(queueSend).toHaveBeenCalledWith(deciderMessage(), { delaySeconds: 30 });
  });

  it('rechecks a lost paid connection without killing the lane', async () => {
    vi.mocked(runDeciderCaseViaCli).mockRejectedValue(
      new Error('container /run failed: HTTP 500 container just exited')
    );
    await processJob(env, deciderMessage());

    expect(failChunk).not.toHaveBeenCalled();
    expect(recordLaneFailure).not.toHaveBeenCalled();
    expect(deferChunk).not.toHaveBeenCalled();
    expect(clearUnbilledCase).not.toHaveBeenCalled();
    expect(queueSend).toHaveBeenCalledWith(deciderMessage(), { delaySeconds: 30 });
  });

  it('records a container-posted outcome as pending output or a released ledger row', async () => {
    const execution = {
      runId,
      model,
      variant: '',
      rep: 0,
      caseId: benchCase.id,
      token: 'token-1',
    };
    const response = {
      exitCode: 0,
      durationMs: 12,
      stdoutLines: ['{"type":"text","part":{"text":"42","time":{"end":1}}}'],
      stderrTail: '',
    };

    await expect(
      acceptContainerCaseResult(env, { execution, outcome: { kind: 'completed', response } })
    ).resolves.toBe(true);
    expect(savePendingDeciderOutput).toHaveBeenCalledWith(
      env.BENCH_DB,
      { run_id: runId, model, variant: '', rep: 0, case_id: benchCase.id },
      { result: expect.objectContaining({ text: '42', exitCode: 0 }), retried: false }
    );

    await expect(
      acceptContainerCaseResult(env, { execution, outcome: { kind: 'not_started' } })
    ).resolves.toBe(true);
    expect(clearUnbilledCase).toHaveBeenCalledWith(env.BENCH_DB, execution);

    vi.mocked(hasPaidCase).mockResolvedValue(false);
    await expect(
      acceptContainerCaseResult(env, { execution, outcome: { kind: 'not_started' } })
    ).resolves.toBe(false);
    expect(clearUnbilledCase).toHaveBeenCalledTimes(1);
  });

  it('persists raw failed output and CLI diagnostics before saving its grade', async () => {
    const result = {
      ...successfulCliResult,
      text: '',
      exitCode: 1,
      costUsd: 0.01,
      stderrTail: 'CLI failed',
      latencyMs: 987,
      timedOut: true,
    };
    vi.mocked(runDeciderCaseViaCli).mockResolvedValueOnce(result);
    await processJob(env, deciderMessage());
    expect(savePendingDeciderOutput).toHaveBeenCalledWith(
      env.BENCH_DB,
      { run_id: runId, model, variant: '', rep: 0, case_id: benchCase.id },
      { result, retried: false }
    );
    expect(vi.mocked(savePendingDeciderOutput).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(upsertCaseResult).mock.invocationCallOrder[0]
    );
    expect(upsertCaseResult).toHaveBeenCalledWith(
      env.BENCH_DB,
      expect.objectContaining({
        score: 0,
        error: 'CLI failed',
        latency_ms: 987,
        cost_usd: 0.01,
        exit_code: 1,
        timed_out: 1,
      })
    );
  });

  it('retains an ambiguous paid execution when pending-output persistence fails', async () => {
    vi.mocked(savePendingDeciderOutput).mockRejectedValueOnce(new Error('D1 unavailable'));
    await processJob(env, deciderMessage());
    expect(runDeciderCaseViaCli).toHaveBeenCalledTimes(1);
    expect(deferChunk).toHaveBeenCalled();
    expect(clearUnbilledCase).not.toHaveBeenCalled();
    expect(upsertCaseResult).not.toHaveBeenCalled();

    vi.mocked(beginPaidCase).mockResolvedValue(false);
    await processJob(env, deciderMessage());

    expect(runDeciderCaseViaCli).toHaveBeenCalledTimes(1);
    expect(failChunk).toHaveBeenCalledWith(env.BENCH_DB, 'chunk-1', 'token-1');
    expect(upsertCaseResult).not.toHaveBeenCalled();
  });
});

describe('processJob — canonical registry publication', () => {
  function mockPublishHarness(variant: string, reasoningEffort: string | null) {
    mockRunSnapshot([{ model, variant, enqueued: true, reasoning_effort: reasoningEffort }]);
    mockClaim({ variant });
    vi.mocked(countCaseResultsByLane).mockResolvedValue([
      { model, variant, rep: 0, n: DECIDER_CASES.length },
    ]);
    vi.mocked(getCaseResults).mockResolvedValue(
      DECIDER_CASES.map(c => ({
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
        route_hit: null,
        retried: null,
        exit_code: 0,
        output_prefix: 'ok',
        event_count: 1,
        last_event_types: 'x',
        rep: 0,
        timed_out: 0,
      }))
    );
    vi.mocked(getExistingCaseResultIds).mockResolvedValue(new Set([benchCase.id]));
    vi.mocked(listReadyCurrentProfilesForEntries).mockResolvedValue([
      { model, variant, run_id: runId },
    ]);
    vi.mocked(countCurrentProfilesByStatus).mockResolvedValue([{ status: 'ready', count: 1 }]);
    vi.mocked(getLatestRoutingTable).mockResolvedValue(null);
  }

  async function seedRegistrySummaries(variant: string) {
    vi.mocked(getSummariesForRuns).mockResolvedValue(
      TAXONOMY_ROUTE_KEYS.map(routeKey => ({
        runId,
        model,
        variant,
        routeKey,
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
  }

  it('publishes a routing table carrying variant for a non-enum snapshot key', async () => {
    mockPublishHarness('max', null);
    await seedRegistrySummaries('max');

    await processJob(env, deciderMessage());

    expect(markRunCompleted).toHaveBeenCalledWith(env.BENCH_DB, runId);
    const table = vi.mocked(saveRoutingTable).mock.calls[0]?.[1];
    expect(table?.routes['implementation/code_generation']?.[0]).toEqual({
      model,
      variant: 'max',
      accuracy: 0.9,
      avgCostUsd: 0.001,
      p50LatencyMs: 90,
      p50TtftMs: undefined,
      pricing: null,
      estimatedRequestCostUsd: 0.001,
      cases: 5,
      meetsThreshold: true,
    });
  });
});

describe('processJob — retryable rubric grading', () => {
  const judgedCase = DECIDER_CASES.find(c => c.check.kind === 'judged');
  function judgedMessage() {
    if (!judgedCase) throw new Error('Expected a judged decider case');
    mockClaim({ case_ids: JSON.stringify([judgedCase.id]) });
    return deciderMessage();
  }

  it('retries grading without repeating model calls or losing their cost', async () => {
    const judge = vi
      .fn<DeciderJudge>()
      .mockRejectedValueOnce(new Error('Provider outage'))
      .mockResolvedValueOnce({ probability: 0.76, costUsd: 0.002 });
    vi.mocked(createDeciderJudge).mockReturnValue(judge);
    vi.mocked(runDeciderCaseViaCli)
      .mockResolvedValueOnce({ ...successfulCliResult, text: '', costUsd: 0.01 })
      .mockResolvedValueOnce({ ...successfulCliResult, text: 'A complete answer', costUsd: 0.02 });
    let pending: PendingDeciderOutput | null = null;
    vi.mocked(savePendingDeciderOutput).mockImplementation(async (_db, _key, output) => {
      pending = output;
    });
    vi.mocked(getPendingDeciderOutput).mockImplementation(async () => pending);

    await processJob(env, judgedMessage());
    expect(deferChunk).toHaveBeenCalled();
    expect(finishChunk).not.toHaveBeenCalled();
    expect(savePendingDeciderOutput).toHaveBeenCalledWith(
      env.BENCH_DB,
      expect.objectContaining({ case_id: judgedCase?.id }),
      expect.objectContaining({
        result: expect.objectContaining({ text: 'A complete answer', costUsd: 0.03 }),
        retried: true,
      })
    );
    expect(vi.mocked(savePendingDeciderOutput).mock.invocationCallOrder[0]).toBeLessThan(
      judge.mock.invocationCallOrder[0]
    );
    expect(upsertCaseResult).not.toHaveBeenCalled();
    expect(markRunCompleted).not.toHaveBeenCalled();
    expect(queueSendBatch).not.toHaveBeenCalled();

    await processJob(env, judgedMessage());
    expect(runDeciderCaseViaCli).toHaveBeenCalledTimes(2);
    expect(judge).toHaveBeenCalledTimes(2);
    expect(beginPaidCase).toHaveBeenCalledTimes(1);
    expect(savePendingDeciderOutput).toHaveBeenCalledTimes(1);
    expect(finishChunk).toHaveBeenCalled();
    expect(upsertCaseResult).toHaveBeenCalledWith(
      env.BENCH_DB,
      expect.objectContaining({
        score: 0.76,
        cost_usd: 0.03,
        retried: true,
        error: null,
      })
    );
  });

  it('skips run accounting while scheduled work is unsettled', async () => {
    vi.mocked(hasUnsettledChunks).mockResolvedValue(true);
    await processJob(env, deciderMessage());
    expect(finishChunk).toHaveBeenCalledWith(env.BENCH_DB, 'chunk-1', 'token-1');
    expect(hasUnsettledChunks).toHaveBeenCalledWith(env.BENCH_DB, runId);
    expect(countCaseResultsByLane).not.toHaveBeenCalled();
    expect(getCaseResults).not.toHaveBeenCalled();
    expect(markRunCompleted).not.toHaveBeenCalled();
  });

  it('runs run accounting once scheduled work has settled', async () => {
    vi.mocked(hasUnsettledChunks).mockResolvedValue(false);
    await processJob(env, deciderMessage());
    expect(hasUnsettledChunks).toHaveBeenCalledWith(env.BENCH_DB, runId);
    expect(countCaseResultsByLane).toHaveBeenCalled();
  });

  it('does not call the model or persist a zero when the judge client is unavailable', async () => {
    vi.mocked(createSystemOneClient).mockRejectedValueOnce(new Error('Missing credentials'));
    await processJob(env, judgedMessage());
    expect(deferChunk).toHaveBeenCalled();
    expect(beginPaidCase).not.toHaveBeenCalled();
    expect(recordLaneFailure).not.toHaveBeenCalled();
    expect(runDeciderCaseViaCli).not.toHaveBeenCalled();
    expect(upsertCaseResult).not.toHaveBeenCalled();
  });
});
