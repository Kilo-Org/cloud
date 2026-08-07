import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as CliRunnerModule from './cli-runner';
import type * as DbModule from './db';
import { DECIDER_CASES } from './datasets/decider-cases';
import type * as ConfigModule from './config';

// Publishing reads live config to learn which pairs the platform table wants.
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
    getRunWithModels: vi.fn(),
    getSummaries: vi.fn(),
    syncPlatformRegistryRows: vi.fn(),
    getLatestRoutingTable: vi.fn(),
    countCurrentProfilesByStatus: vi.fn(),
    getSummariesForRuns: vi.fn(),
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
  getExistingCaseResultIds,
  getRunWithModels,
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
import { processJob } from './run';

const tokenGet = vi.fn<() => Promise<string>>();
const queueSendBatch = vi.fn<(messages: unknown[]) => Promise<void>>();
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
  BENCH_DB: {} as D1Database,
  BENCH_QUEUE: { sendBatch: queueSendBatch },
  AUTO_ROUTING_CONFIG: { delete: vi.fn() },
} as unknown as Env;

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

function deciderMessage(overrides: { variant?: string | null } = {}) {
  return {
    runId,
    kind: 'decider' as const,
    model,
    caseIds: [benchCase.id],
    chunk: 0,
    rep: 0,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getBenchmarkConfig).mockResolvedValue({
    classifierModels: ['classifier/a'],
    deciderModels: [{ id: model, reasoningEffort: null }],
    minAccuracy: 0.7,
    maxConcurrency: 100,
    userMaxConcurrency: 100,
    benchmarkUserId: 'user-1',
    benchmarkOrgId: null,
    switchCostFactor: 3,
    bestAccuracySwitchThreshold: 0.05,
    classifierRepetitions: 1,
    deciderRepetitions: 1,
    classifierMaxP95LatencyMs: 1000,
    autoDeciderMinCostUsd: 15,
    autoDeciderMaxCostUsd: 25,
    updatedAt: null,
    updatedBy: null,
  });
  vi.mocked(listReadyCurrentProfilesForEntries).mockResolvedValue([]);
  vi.mocked(getSummariesForRuns).mockResolvedValue([]);
  vi.mocked(countCurrentProfilesByStatus).mockResolvedValue([]);
  vi.mocked(getLatestRoutingTable).mockResolvedValue(null);
  vi.mocked(syncPlatformRegistryRows).mockResolvedValue(undefined);
  vi.mocked(listStaleRunningDeciderRuns).mockResolvedValue([]);
  tokenGet.mockResolvedValue('internal-secret');
  queueSendBatch.mockResolvedValue(undefined);
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json({ token: 'kilo-user-token', expiresAt: '2026-06-16T01:00:00.000Z' })
    )
  );
  mockRunSnapshot();
  vi.mocked(countCaseResultsByLane).mockResolvedValue([]);
  vi.mocked(listLaneFailures).mockResolvedValue([]);
  vi.mocked(recordLaneFailure).mockResolvedValue(undefined);
  vi.mocked(getExistingCaseResultIds).mockResolvedValue(new Set());
  vi.mocked(destroyDeciderCliContainer).mockResolvedValue(undefined);
  vi.mocked(warmUpCliContainer).mockResolvedValue(undefined);
  vi.mocked(runDeciderCaseViaCli).mockResolvedValue(successfulCliResult);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('processJob — decider exact-pair snapshot resolution', () => {
  it('throws when an explicit-variant message has no exact snapshot row', async () => {
    mockRunSnapshot([
      { model, variant: 'high', reasoning_effort: 'high' },
      { model, variant: 'low', reasoning_effort: 'low' },
    ]);

    await expect(processJob(env, deciderMessage({ variant: 'medium' }))).rejects.toThrow(
      /no snapshot row for model/
    );

    expect(runDeciderCaseViaCli).not.toHaveBeenCalled();
    expect(upsertCaseResult).not.toHaveBeenCalled();
  });

  it('resolves the exact snapshot row for an explicit (model, variant) pair', async () => {
    mockRunSnapshot([
      { model, variant: 'high', reasoning_effort: 'high' },
      { model, variant: 'low', reasoning_effort: 'low' },
    ]);

    await processJob(env, deciderMessage({ variant: 'low' }));

    expect(runDeciderCaseViaCli).toHaveBeenCalledWith(
      env,
      expect.objectContaining({
        model,
        variant: 'low',
        instanceName: `${runId}:${model}:low:0:0`,
      })
    );
    expect(upsertCaseResult).toHaveBeenCalledWith(
      env.BENCH_DB,
      expect.objectContaining({
        model,
        variant: 'low',
      })
    );
  });

  it('legacy no-variant message resolves the unique snapshot row for the model', async () => {
    mockRunSnapshot([{ model, variant: 'high', reasoning_effort: 'high' }]);

    // Omit variant entirely (legacy pre-deploy message shape).
    await processJob(env, {
      runId,
      kind: 'decider',
      model,
      caseIds: [benchCase.id],
      chunk: 0,
      rep: 0,
    });

    expect(runDeciderCaseViaCli).toHaveBeenCalledWith(
      env,
      expect.objectContaining({
        model,
        variant: 'high',
        instanceName: `${runId}:${model}:high:0:0`,
      })
    );
    expect(upsertCaseResult).toHaveBeenCalledWith(
      env.BENCH_DB,
      expect.objectContaining({
        model,
        variant: 'high',
      })
    );
  });

  it('throws when a legacy no-variant message has multiple snapshot rows for the model', async () => {
    mockRunSnapshot([
      { model, variant: 'high', reasoning_effort: 'high' },
      { model, variant: 'low', reasoning_effort: 'low' },
    ]);

    await expect(
      processJob(env, {
        runId,
        kind: 'decider',
        model,
        caseIds: [benchCase.id],
        chunk: 0,
        rep: 0,
      })
    ).rejects.toThrow(/requires exactly one snapshot row/);

    expect(runDeciderCaseViaCli).not.toHaveBeenCalled();
    expect(upsertCaseResult).not.toHaveBeenCalled();
  });
});

describe('processJob — decider container availability failures', () => {
  it.each([
    'container /run failed: HTTP 503 There is no Container instance available at this time. This is likely because you have reached your max concurrent instance count.',
    'container /run failed: HTTP 503 Maximum number of running container instances exceeded',
    'container /run failed: HTTP 503 There is no container instance that can be provided to this Durable Object, try again later',
  ])('lets the queue retry %s', async message => {
    vi.mocked(runDeciderCaseViaCli).mockRejectedValueOnce(new Error(message));

    await expect(processJob(env, deciderMessage())).rejects.toThrow(message);

    expect(upsertCaseResult).not.toHaveBeenCalled();
    expect(countCaseResultsByLane).not.toHaveBeenCalled();
  });

  it('lets the queue retry warmup capacity failures before running cases', async () => {
    const message =
      'container /warmup failed: HTTP 503 There is no Container instance available at this time';
    vi.mocked(warmUpCliContainer).mockRejectedValueOnce(new Error(message));

    await expect(processJob(env, deciderMessage())).rejects.toThrow(message);

    expect(runDeciderCaseViaCli).not.toHaveBeenCalled();
    expect(upsertCaseResult).not.toHaveBeenCalled();
    expect(countCaseResultsByLane).not.toHaveBeenCalled();
  });
});

describe('processJob — decider chunk chaining', () => {
  it('runs a chunk on the model-repetition shard container and enqueues the next chunk', async () => {
    const message = {
      ...deciderMessage(),
      caseIds: DECIDER_CASES.slice(0, 5).map(c => c.id),
    };

    await processJob(env, message);

    // Instance names include the stored variant segment ('' → empty between colons).
    const instanceName = `${runId}:${model}::0:0`;
    expect(warmUpCliContainer).toHaveBeenCalledWith(
      env,
      expect.objectContaining({
        instanceName,
        kiloApiUrl: 'http://host.docker.internal:3000',
        orgId: 'benchmark-org',
      })
    );
    expect(runDeciderCaseViaCli).toHaveBeenCalledWith(
      env,
      expect.objectContaining({
        instanceName,
        kiloApiUrl: 'http://host.docker.internal:3000',
        orgId: 'benchmark-org',
      })
    );
    expect(queueSendBatch).toHaveBeenCalledWith([
      {
        body: {
          runId,
          kind: 'decider',
          model,
          variant: null,
          chunk: 1,
          shard: 0,
          shardCount: 1,
          rep: 0,
          caseIds: DECIDER_CASES.slice(5, 10).map(c => c.id),
        },
      },
    ]);
    expect(countCaseResultsByLane).not.toHaveBeenCalled();
  });

  it('enqueues the next chunk assigned to the same shard lane', async () => {
    const chunk = 2;
    const shard = 2;
    const shardCount = 8;
    const currentCaseIds = DECIDER_CASES.slice(chunk * 5, chunk * 5 + 5).map(c => c.id);
    const nextChunk = chunk + shardCount;
    const nextCaseIds = DECIDER_CASES.slice(nextChunk * 5, nextChunk * 5 + 5).map(c => c.id);

    await processJob(env, {
      ...deciderMessage(),
      chunk,
      shard,
      shardCount,
      caseIds: currentCaseIds,
    });

    expect(warmUpCliContainer).toHaveBeenCalledWith(
      env,
      expect.objectContaining({ instanceName: `${runId}:${model}::0:2` })
    );
    expect(queueSendBatch).toHaveBeenCalledWith([
      {
        body: {
          runId,
          kind: 'decider',
          model,
          variant: null,
          chunk: nextChunk,
          shard,
          shardCount,
          rep: 0,
          caseIds: nextCaseIds,
        },
      },
    ]);
    expect(countCaseResultsByLane).not.toHaveBeenCalled();
  });

  it('does not rerun completed chunk cases or enqueue a fully completed next chunk', async () => {
    const currentCaseIds = DECIDER_CASES.slice(0, 5).map(c => c.id);
    const nextCaseIds = DECIDER_CASES.slice(5, 10).map(c => c.id);
    vi.mocked(getExistingCaseResultIds)
      .mockResolvedValueOnce(new Set(currentCaseIds))
      .mockResolvedValueOnce(new Set(nextCaseIds));

    await processJob(env, { ...deciderMessage(), caseIds: currentCaseIds });

    expect(warmUpCliContainer).not.toHaveBeenCalled();
    expect(runDeciderCaseViaCli).not.toHaveBeenCalled();
    expect(upsertCaseResult).not.toHaveBeenCalled();
    expect(queueSendBatch).not.toHaveBeenCalled();
  });

  it('re-enqueues a partially completed next chunk so DLQ leftovers cannot strand a run', async () => {
    const currentCaseIds = DECIDER_CASES.slice(0, 5).map(c => c.id);
    const nextCaseIds = DECIDER_CASES.slice(5, 10).map(c => c.id);
    vi.mocked(getExistingCaseResultIds)
      .mockResolvedValueOnce(new Set(currentCaseIds))
      .mockResolvedValueOnce(new Set([nextCaseIds[0]]));

    await processJob(env, { ...deciderMessage(), caseIds: currentCaseIds });

    expect(warmUpCliContainer).not.toHaveBeenCalled();
    expect(runDeciderCaseViaCli).not.toHaveBeenCalled();
    expect(upsertCaseResult).not.toHaveBeenCalled();
    expect(queueSendBatch).toHaveBeenCalledWith([
      {
        body: {
          runId,
          kind: 'decider',
          model,
          variant: null,
          chunk: 1,
          shard: 0,
          shardCount: 1,
          rep: 0,
          caseIds: nextCaseIds,
        },
      },
    ]);
  });

  it('destroys the model-repetition shard container after the terminal chunk', async () => {
    const terminalChunk = Math.floor((DECIDER_CASES.length - 1) / 5);
    const terminalCaseIds = DECIDER_CASES.slice(terminalChunk * 5).map(c => c.id);

    await processJob(env, {
      ...deciderMessage(),
      chunk: terminalChunk,
      shard: 3,
      shardCount: 4,
      caseIds: terminalCaseIds,
    });

    expect(queueSendBatch).not.toHaveBeenCalled();
    expect(destroyDeciderCliContainer).toHaveBeenCalledWith(env, {
      instanceName: `${runId}:${model}::0:3`,
    });
    expect(countCaseResultsByLane).toHaveBeenCalled();
  });

  it('finalizes terminal chunks even when best-effort container destroy fails', async () => {
    const terminalChunk = Math.floor((DECIDER_CASES.length - 1) / 5);
    const terminalCaseIds = DECIDER_CASES.slice(terminalChunk * 5).map(c => c.id);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(destroyDeciderCliContainer).mockRejectedValueOnce(new Error('already stopped'));

    await processJob(env, {
      ...deciderMessage(),
      chunk: terminalChunk,
      shard: 3,
      shardCount: 4,
      caseIds: terminalCaseIds,
    });

    expect(destroyDeciderCliContainer).toHaveBeenCalledWith(env, {
      instanceName: `${runId}:${model}::0:3`,
    });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('benchmark_container_destroy_failed')
    );
    expect(countCaseResultsByLane).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('processJob — saved canonical variant reaches the CLI and publish', () => {
  it('passes a saved canonical variant to the CLI as variant', async () => {
    mockRunSnapshot([{ model, variant: 'max', enqueued: true, reasoning_effort: null }]);

    await processJob(env, deciderMessage({ variant: 'max' }));

    expect(runDeciderCaseViaCli).toHaveBeenCalledWith(
      env,
      expect.objectContaining({
        model,
        variant: 'max',
        instanceName: `${runId}:${model}:max:0:0`,
      })
    );
    expect(upsertCaseResult).toHaveBeenCalledWith(
      env.BENCH_DB,
      expect.objectContaining({ model, variant: 'max' })
    );
  });

  // Publish-fidelity harness: a completed platform run whose snapshot row is
  // variant-only publishes variant; an enum effort row keeps the effort shape.
  function mockPublishHarness(variant: string, reasoningEffort: string | null) {
    mockRunSnapshot([{ model, variant, enqueued: true, reasoning_effort: reasoningEffort }]);
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
    // Publishing reads the registry, not this run's own summaries: the entry is
    // ready with this run as its provenance, and the platform queue is settled.
    vi.mocked(listReadyCurrentProfilesForEntries).mockResolvedValue([
      { model, variant, run_id: runId },
    ]);
    vi.mocked(countCurrentProfilesByStatus).mockResolvedValue([{ status: 'ready', count: 1 }]);
    vi.mocked(getLatestRoutingTable).mockResolvedValue(null);
  }

  async function seedRegistrySummaries(variant: string) {
    const { TAXONOMY_ROUTE_KEYS } = await import('@kilocode/auto-routing-contracts');
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
      }))
    );
  }

  it('publishes a routing table carrying variant for a non-enum snapshot key', async () => {
    mockPublishHarness('max', null);
    await seedRegistrySummaries('max');

    await processJob(env, { ...deciderMessage({ variant: 'max' }), chunk: 9999 });

    expect(markRunCompleted).toHaveBeenCalledWith(env.BENCH_DB, runId);
    const table = vi.mocked(saveRoutingTable).mock.calls[0]?.[1];
    expect(table).toBeDefined();
    const firstRoute = Object.values(table.routes)[0];
    expect(firstRoute[0]).toMatchObject({ model, variant: 'max', reasoningEffort: null });
  });

  it('publishes a routing table with the legacy effort shape for an enum key', async () => {
    mockPublishHarness('high', 'high');
    await seedRegistrySummaries('high');

    await processJob(env, { ...deciderMessage({ variant: 'high' }), chunk: 9999 });

    const table = vi.mocked(saveRoutingTable).mock.calls[0]?.[1];
    expect(table).toBeDefined();
    const firstRoute = Object.values(table.routes)[0];
    expect(firstRoute[0]).toMatchObject({ model, reasoningEffort: 'high' });
    expect(
      firstRoute[0] && 'variant' in firstRoute[0] ? firstRoute[0].variant : undefined
    ).toBeUndefined();
  });
});
