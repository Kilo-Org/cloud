import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as DbModule from './db';
import type * as CliRunnerModule from './cli-runner';
import type * as SchedulerModule from './scheduler';
import type * as SubscriptionsModule from './subscriptions';
import type * as EligibilityModule from './probe/eligibility';
import type * as ProfileFailureModule from './profile-failure-history';
import { TAXONOMY_ROUTE_KEYS, benchmarkPairKey } from '@kilocode/auto-routing-contracts';
import type {
  PolicySettingComputedMap,
  PolicySettingOverrides,
  RoutingTable,
} from '@kilocode/auto-routing-contracts';
import { DECIDER_CASES, FRONTIER_CASES } from './datasets/decider-cases';
import { ACTIVE_MEASUREMENT_REVISION, deciderCasesForRouter } from './measurement-revision';
import type { BenchmarkJobMessage } from './run';
import {
  CATALOG_CONTEXT_TOO_SMALL_REASON,
  CATALOG_NO_TOOL_SUPPORT_REASON,
} from './platform-models';
import {
  claimScheduledChunks,
  finishChunk,
  getChunk,
  recoverChunks,
  scheduleRunChunks,
  startChunk,
} from './scheduler';

vi.mock('./subscriptions', () => ({
  PLATFORM_SUBSCRIPTION_OWNER: { ownerType: 'platform', ownerId: '' },
  snapshotPairs: (snapshot: SubscriptionsModule.SubscriptionSnapshot, serving = false) => [
    ...new Map(
      snapshot
        .flatMap(entry => (serving ? entry.servingPairs : entry.pairs))
        .map(pair => [JSON.stringify(pair), pair])
    ).values(),
  ],
  syncSubscriptionSnapshot: vi.fn(),
  servingSubscriptionSnapshot: vi.fn(),
}));
vi.mock('./executable-models', () => ({
  fetchExecutableBenchmarkModelCatalog: vi.fn(),
}));
import {
  PLATFORM_SUBSCRIPTION_OWNER,
  servingSubscriptionSnapshot,
  syncSubscriptionSnapshot,
} from './subscriptions';
import { fetchExecutableBenchmarkModelCatalog } from './executable-models';

vi.mock('./scheduler', async importOriginal => ({
  ...(await importOriginal<typeof SchedulerModule>()),
  claimScheduledChunks: vi.fn(),
  finishChunk: vi.fn(),
  getChunk: vi.fn(),
  recoverChunks: vi.fn(),
  scheduleRunChunks: vi.fn(),
  startChunk: vi.fn(),
}));

vi.mock('./cli-runner', async importOriginal => {
  const actual = await importOriginal<typeof CliRunnerModule>();
  return {
    ...actual,
    destroyDeciderCliContainer: vi.fn().mockResolvedValue(undefined),
    runDeciderCaseViaCli: vi.fn(),
    warmUpCliContainer: vi.fn().mockResolvedValue(undefined),
  };
});

// These suites publish a fully measured pool; the ineligible branch is covered by
// `src/probe/eligibility.test.ts` and `src/probe/publish.test.ts`.
const missingProbeResults = vi.hoisted(() =>
  vi.fn<(db: unknown, params: unknown) => Promise<Set<string>>>(async () => new Set<string>())
);
vi.mock('./probe/eligibility', async importOriginal => ({
  ...(await importOriginal<typeof EligibilityModule>()),
  pairsMissingProbeResults: missingProbeResults,
}));

// Registry settlement writes profile rows through real drizzle statements; the fake D1
// answers none of them, so the calls are observed here instead of their side effects.
vi.mock('./profile-failure-history', async importOriginal => ({
  ...(await importOriginal<typeof ProfileFailureModule>()),
  settleProfileRunAttempts: vi.fn(async () => []),
}));

vi.mock('./db', async importOriginal => {
  const actual = await importOriginal<typeof DbModule>();
  return {
    ...actual,
    getConfigRows: vi.fn(),
    getLatestSummariesByModel: vi.fn(),
    getQueueRunOccupancy: vi.fn(),
    getRunningRun: vi.fn(),
    getLiveContainerLanes: vi.fn(),
    insertRun: vi.fn(),
    markStaleRunsFailed: vi.fn(),
    listStaleRunningDeciderRuns: vi.fn(),
    listPendingCurrentProfiles: vi.fn(),
    markProfilesFailedForEntries: vi.fn(),
    failPendingProfiles: vi.fn(),
    markProfilesFailedForRun: vi.fn(),
    markProfilesReadyForRun: vi.fn(),
    markProfilesReadyForEntries: vi.fn(),
    releaseProfileClaimsForEntries: vi.fn(),
    markProfilesRunningForRun: vi.fn(),
    markRunCompleted: vi.fn(),
    markRunFailed: vi.fn(),
    countCaseResultsByLane: vi.fn(),
    listLaneFailures: vi.fn(),
    getCaseResults: vi.fn(),
    getExistingCaseResultIds: vi.fn(),
    reuseDeciderCaseResults: vi.fn(),
    getSummaries: vi.fn(),
    replaceModelSummaries: vi.fn(),
    saveRoutingTable: vi.fn(),
    existsNewerCompletedRun: vi.fn(),
    getRunWithModels: vi.fn(),
    listReadyCurrentProfilesForEntries: vi.fn(),
    getSummariesForRuns: vi.fn(),
    getRoutingCaseResultsForEntries: vi.fn(),
    countCurrentProfilesByStatus: vi.fn(),
    listCurrentPlatformProfileStatuses: vi.fn(),
    getLatestRoutingTable: vi.fn(),
    syncPlatformRegistryRows: vi.fn(),
    recordLaneFailure: vi.fn(),
    failOrphanedRunningProfiles: vi.fn(),
    releaseProfileClaims: vi.fn(),
    listQueuedRemeasures: vi.fn().mockResolvedValue([]),
    copyRemeasureBaselines: vi.fn().mockResolvedValue(0),
    settleRemeasuresForRun: vi.fn().mockResolvedValue('published'),
  };
});

import {
  countCaseResultsByLane,
  existsNewerCompletedRun,
  getCaseResults,
  getConfigRows,
  getExistingCaseResultIds,
  reuseDeciderCaseResults,
  getLatestSummariesByModel,
  getQueueRunOccupancy,
  getRunningRun,
  getLiveContainerLanes,
  getRunWithModels,
  getSummaries,
  getSummariesForRuns,
  getRoutingCaseResultsForEntries,
  insertRun,
  MAX_RUNNING_RUNS_PER_QUEUE,
  listLaneFailures,
  listPendingCurrentProfiles,
  countCurrentProfilesByStatus,
  listCurrentPlatformProfileStatuses,
  getLatestRoutingTable,
  listReadyCurrentProfilesForEntries,
  listQueuedRemeasures,
  listStaleRunningDeciderRuns,
  failOrphanedRunningProfiles,
  failPendingProfiles,
  recordLaneFailure,
  releaseProfileClaims,
  markProfilesFailedForEntries,
  markProfilesFailedForRun,
  markProfilesReadyForEntries,
  markProfilesReadyForRun,
  markProfilesRunningForRun,
  releaseProfileClaimsForEntries,
  markRunCompleted,
  markRunFailed,
  markStaleRunsFailed,
  replaceModelSummaries,
  saveRoutingTable,
  syncPlatformRegistryRows,
} from './db';
import {
  NoEntriesClaimedError,
  type DrainSkipReason,
  drainQueue,
  drainQueues,
  failRunAndDrain,
  processJob,
  publishPlatformRoutingTable,
  startRun,
  sweepStaleRunsAndDrain,
} from './run';
import { settleProfileRunAttempts } from './profile-failure-history';

const queueSendBatch = vi.fn<(messages: { body: BenchmarkJobMessage }[]) => Promise<void>>();
const queueSend =
  vi.fn<(message: BenchmarkJobMessage, options?: { delaySeconds?: number }) => Promise<void>>();

/** Decider runs inserted by the test whose chunk plan has not yet been written in full. */
function uninitializedRunIds() {
  const scheduled = vi.mocked(scheduleRunChunks).mock;
  const initialized = new Set(
    scheduled.calls.flatMap(([, run], index) => {
      const settled = scheduled.settledResults[index];
      return settled?.type === 'fulfilled' && settled.value ? [run.runId] : [];
    })
  );
  return vi
    .mocked(insertRun)
    .mock.calls.map(([, run]) => run)
    .filter(run => run.kind === 'decider' && !initialized.has(run.id))
    .map(run => ({ id: run.id }));
}

/** Every fixture run starts after this instant, so it is admitted, not fenced. */
const CUTOVER_AT = '2026-01-01T00:00:00.000Z';

/** Every statement the fixture database prepared, with the parameters bound to it. */
let preparedStatements: { sql: string; params: unknown[] }[];

/** Exact desired-membership baselines the publisher recorded on a pre-cutover artifact. */
function recordedDesiredPairs(): string[][] {
  return preparedStatements
    .filter(entry => entry.sql.includes('UPDATE routing_tables SET desired_pairs'))
    .map(entry => JSON.parse(String(entry.params[0])) as string[]);
}

function schedulerDatabase(): D1Database {
  const prepare = (sql: string) => {
    const entry = { sql, params: [] as unknown[] };
    preparedStatements.push(entry);
    const statement = {
      bind: vi.fn((...params: unknown[]) => {
        entry.params = params;
        return statement;
      }),
      first: vi.fn(async () => {
        if (sql.includes('RETURNING token')) return { token: 'lease' };
        if (sql.includes('FROM benchmark_cutover')) return { cutover_at: CUTOVER_AT };
        // The claim fence re-checks that this run was admitted by the paid flow; every run
        // this suite starts is, so answer with the marker the insert writes.
        if (sql.includes('SELECT admission_marker FROM benchmark_runs')) {
          return { admission_marker: 'admitted:test' };
        }
        return null;
      }),
      all: vi.fn(async () => ({
        results: sql.includes('NOT EXISTS (SELECT 1 FROM scheduler_runs')
          ? uninitializedRunIds()
          : [],
      })),
      run: vi.fn(async () => ({ meta: { changes: 0 } })),
    };
    return statement;
  };
  const db = {
    prepare: vi.fn(prepare),
    // D1 returns one result per statement, in order. An empty array made every caller's
    // destructure (`[a, b] = await db.batch([...])`) silently `undefined`, which is why an
    // initialization failure surfaced as `Cannot read properties of undefined (reading
    // 'meta')` instead of the assertion it was meant to make.
    batch: vi.fn(async (statements: unknown[]) =>
      statements.map(() => ({ results: [], success: true, meta: { changes: 0 } }))
    ),
  } as unknown as D1Database;
  return db;
}

/** Delivers the scheduler wakes that starting runs queued, as the queue consumer would. */
async function deliverSchedulerWakes(target: Env = env) {
  const wakes = queueSend.mock.calls
    .map(([message]) => message)
    .filter(message => message.schedulerWake);
  for (const wake of wakes) await processJob(target, wake);
}
const kvDelete = vi.fn();

const configRow = {
  id: 1 as const,
  router: 'efficient' as 'efficient' | 'frontier',
  accuracy_noise_band: 0.05,
  frontier_min_accuracy_delta: 0,
  min_accuracy: 0.7,
  switch_cost_factor: 3,
  best_accuracy_switch_threshold: 0.05,
  production_token_profile: null,
  switch_horizon_turns: null,
  low_confidence_threshold: null,
  max_concurrency: 4,
  benchmark_user_id: 'bot-internal-user-1',
  benchmark_org_id: null,
  classifier_repetitions: 1,
  decider_repetitions: 1,
  classifier_max_p95_latency_ms: 1000,
  user_max_concurrency: 100,
  policy_overrides: null as PolicySettingOverrides | null,
  policy_computed: null as PolicySettingComputedMap | null,
  updated_at: '2026-06-01T00:00:00.000Z',
  updated_by: null,
};

const env = {
  BENCH_DB: schedulerDatabase(),
  BENCH_QUEUE: { sendBatch: queueSendBatch, send: queueSend },
  BENCHMARK_SCHEDULER_CONFIG: '{}',
  AUTO_ROUTING_CONFIG: { delete: kvDelete, put: vi.fn() },
  INTERNAL_API_SECRET_PROD: { get: async () => 'secret' },
  KILO_WEB_API_BASE_URL: 'https://app.test',
  KILO_CLI_API_URL: 'https://api.test',
} as unknown as Env;

function mockConfig(overrides: Partial<typeof configRow> = {}) {
  const row = { ...configRow, ...overrides };
  vi.mocked(getConfigRows).mockImplementation(async (_db, router = 'efficient') => ({
    config: router === row.router ? row : null,
    classifierModels: ['classifier/a'],
    deciderModels: [
      { model: 'platform/a', variant: null, reasoning_effort: null },
      { model: 'platform/b', variant: null, reasoning_effort: 'high' },
    ],
  }));
}

const catalogFetch = vi.fn<typeof fetch>();

afterEach(() => vi.unstubAllGlobals());

beforeEach(() => {
  vi.clearAllMocks();
  preparedStatements = [];
  mockConfig();
  vi.stubGlobal('fetch', catalogFetch);
  catalogFetch.mockImplementation(async () =>
    Response.json({
      data: [
        { id: 'platform/a' },
        { id: 'platform/b', opencode: { variants: { high: { reasoning: { effort: 'high' } } } } },
      ],
    })
  );
  vi.mocked(syncSubscriptionSnapshot)
    .mockReset()
    .mockResolvedValue([
      {
        model: 'platform/a',
        pairs: [{ model: 'platform/a', variant: null }],
        servingPairs: [{ model: 'platform/a', variant: null }],
        resolutionError: null,
      },
      {
        model: 'platform/b',
        pairs: [{ model: 'platform/b', variant: 'high' }],
        servingPairs: [{ model: 'platform/b', variant: 'high' }],
        resolutionError: null,
      },
    ]);
  vi.mocked(servingSubscriptionSnapshot)
    .mockReset()
    .mockResolvedValue([
      {
        model: 'platform/a',
        pairs: [{ model: 'platform/a', variant: null }],
        servingPairs: [{ model: 'platform/a', variant: null }],
        resolutionError: null,
      },
      {
        model: 'platform/b',
        pairs: [{ model: 'platform/b', variant: 'high' }],
        servingPairs: [{ model: 'platform/b', variant: 'high' }],
        resolutionError: null,
      },
    ]);
  vi.mocked(listCurrentPlatformProfileStatuses)
    .mockReset()
    .mockResolvedValue([
      { model: 'platform/a', variant: null, status: 'ready', completed_at: null },
      { model: 'platform/b', variant: 'high', status: 'ready', completed_at: null },
    ]);
  vi.mocked(fetchExecutableBenchmarkModelCatalog)
    .mockReset()
    .mockImplementation(async () => {
      const response = await catalogFetch('https://api.test/models');
      const catalog = (await response.json()) as { data: { id: string }[] };
      return {
        data: [
          ...catalog.data,
          ...Array.from({ length: 100 }, (_, i) => ({ id: `m/${i}` })),
          ...Array.from({ length: 100 }, (_, i) => ({ id: `m/${String(i).padStart(3, '0')}` })),
          ...['m/old', 'm/new'].map(id => ({
            id,
            opencode: {
              variants: {
                a: { reasoning: { effort: 'low' as const } },
                b: { reasoning: { effort: 'high' as const } },
              },
            },
          })),
          ...['m/pending', 'm/x', 'm/p'].map(id => ({ id })),
          {
            id: 'vendor/next',
            opencode: { variants: { high: { reasoning: { effort: 'high' as const } } } },
          },
        ],
      };
    });
  vi.mocked(getRunningRun).mockResolvedValue(undefined);
  vi.mocked(getQueueRunOccupancy).mockResolvedValue({ activeRuns: 0, startingRunId: null });
  vi.mocked(getLiveContainerLanes).mockResolvedValue(0);
  vi.mocked(getLatestSummariesByModel).mockResolvedValue(new Map());
  vi.mocked(insertRun).mockReset().mockResolvedValue({ admitted: true });
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
          measurement_revision: run.measurement_revision ?? ACTIVE_MEASUREMENT_REVISION,
          // The insert SQL stamps the provenance marker itself; `startRun` is not given it.
          admission_marker: 'admitted:test',
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
  vi.mocked(startChunk).mockReset().mockResolvedValue(true);
  vi.mocked(getChunk).mockReset().mockResolvedValue(null);
  vi.mocked(finishChunk).mockReset().mockResolvedValue(undefined);
  queueSend.mockReset().mockResolvedValue(undefined);
  vi.mocked(reuseDeciderCaseResults).mockReset().mockResolvedValue(0);
  vi.mocked(markStaleRunsFailed).mockResolvedValue(undefined);
  vi.mocked(listStaleRunningDeciderRuns).mockResolvedValue([]);
  vi.mocked(listPendingCurrentProfiles).mockResolvedValue([]);
  vi.mocked(listQueuedRemeasures).mockResolvedValue([]);
  vi.mocked(markProfilesRunningForRun).mockImplementation(async (_db, _runId, entries) => [
    ...entries,
  ]);
  vi.mocked(markProfilesReadyForRun).mockResolvedValue('published');
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
  vi.mocked(getRoutingCaseResultsForEntries).mockResolvedValue([]);
  vi.mocked(syncPlatformRegistryRows).mockResolvedValue(undefined);
  vi.mocked(recordLaneFailure).mockResolvedValue(undefined);
  vi.mocked(failOrphanedRunningProfiles).mockResolvedValue(0);
  vi.mocked(releaseProfileClaims).mockResolvedValue(undefined);
  vi.mocked(getSummaries).mockResolvedValue([]);
  vi.mocked(getExistingCaseResultIds).mockResolvedValue(new Set());
  queueSendBatch.mockResolvedValue(undefined);
  kvDelete.mockResolvedValue(undefined);
});

const CURRENT_EFFICIENT_CASE_IDS = deciderCasesForRouter(
  'efficient',
  ACTIVE_MEASUREMENT_REVISION
).map(benchCase => benchCase.id);

const RUN_ROW_BASE = {
  router: 'efficient' as const,
  accuracy_noise_band: 0.05,
  frontier_min_accuracy_delta: 0,
  kind: 'decider' as const,
  status: 'running' as const,
  started_at: '2026-06-01T00:00:00.000Z',
  completed_at: null,
  error: null,
  min_accuracy: 0.7,
  switch_cost_factor: 3,
  best_accuracy_switch_threshold: 0.05,
  max_concurrency: 4,
  benchmark_user_id: 'bot-internal-user-1',
  benchmark_org_id: 'org-1',
  repetitions: 1,
  classifier_max_p95_latency_ms: null,
  engine_identity: 'v1:test',
  measurement_revision: 2,
  // Provenance marker: `retireLegacyRuns` treats a running run without one as legacy work.
  admission_marker: 'admitted:test',
};

/**
 * A published artifact. `desiredPairs` is the exact membership recorded at publication;
 * `null` is a publication that predates that column.
 */
function liveRoutingTable(
  pairs: { model: string; variant: string | null }[],
  desiredPairs: string[] | null = null
): {
  table: RoutingTable;
  publishedAt: string;
  desiredPairs: string[] | null;
} {
  return {
    publishedAt: '2026-10-20T18:00:00.000Z',
    desiredPairs,
    table: {
      version: 'registry-live',
      generatedAt: '2026-10-20T18:00:00.000Z',
      minAccuracy: 0.7,
      switchCostFactor: 3,
      bestAccuracySwitchThreshold: 0.05,
      productionTokenProfile: null,
      switchHorizonTurns: 18,
      source: 'benchmark',
      routes: Object.fromEntries(
        TAXONOMY_ROUTE_KEYS.map(routeKey => [
          routeKey,
          pairs.map(pair => ({
            model: pair.model,
            variant: pair.variant,
            accuracy: 0.9,
            cases: 10,
            avgCostUsd: 0.001,
            p50LatencyMs: 100,
            estimatedRequestCostUsd: 0.002,
            meetsThreshold: true,
            pricing: null,
          })),
        ])
      ) as RoutingTable['routes'],
    },
  };
}

function runningRun(id: string, purpose: 'platform' | 'user') {
  return { ...RUN_ROW_BASE, id, purpose };
}

describe('all-effort platform scheduling', () => {
  it('admits every exact effort together even when live slots are nearly full', async () => {
    vi.mocked(getLiveContainerLanes).mockResolvedValue(246);
    const variants = ['none', 'low', 'medium', 'high', 'max'];
    catalogFetch.mockImplementation(async () =>
      Response.json({
        data: [
          {
            id: 'platform/a',
            opencode: {
              variants: Object.fromEntries(
                variants.map(variant => [variant, { reasoning: { effort: variant } }])
              ),
            },
          },
          { id: 'platform/b' },
        ],
      })
    );
    let pending = variants.map(variant => ({
      model: 'platform/a',
      variant,
      requested_at: configRow.updated_at,
    }));
    vi.mocked(listPendingCurrentProfiles).mockImplementation(async () => pending);
    vi.mocked(markProfilesRunningForRun).mockImplementation(async (_db, _runId, entries) => {
      pending = pending.filter(
        row => !entries.some(entry => entry.model === row.model && entry.variant === row.variant)
      );
      return [...entries];
    });
    await drainQueue(env, 'platform');
    await deliverSchedulerWakes();
    expect(pending).toEqual([]);
    const batches = vi.mocked(insertRun).mock.calls.map(call => call[2]);
    expect(batches.map(batch => batch.length)).toEqual([5]);
    expect(batches.flat().map(row => row.variant)).toEqual(variants);
    expect(scheduleRunChunks).toHaveBeenCalledWith(env.BENCH_DB, {
      runId: expect.any(String),
      entries: variants.map(variant => ({ model: 'platform/a', variant })),
      repetitions: 3,
      caseIds: CURRENT_EFFICIENT_CASE_IDS,
      chunkSize: 1,
    });
  });

  it('does not claim pending platform pairs when the executable catalog lookup fails', async () => {
    vi.mocked(listPendingCurrentProfiles).mockResolvedValue([
      { model: 'platform/a', variant: '', requested_at: '2026-06-01T00:00:00.000Z' },
    ]);
    vi.mocked(fetchExecutableBenchmarkModelCatalog).mockRejectedValue(new Error('catalog failed'));
    await expect(drainQueue(env, 'platform')).rejects.toThrow(/catalog failed/);
    expect(markProfilesRunningForRun).not.toHaveBeenCalled();
  });
});

describe('startRun — registry-backed decider runs', () => {
  it('refuses a user run that no funded paid request authorized', async () => {
    const entries = [
      { model: 'vendor/m', variant: 'xhigh' },
      { model: 'vendor/m', variant: 'max' },
    ];

    await expect(startRun(env, 'decider', { purpose: 'user', entries })).rejects.toThrow(
      /user benchmark queue is retired/
    );

    // Nothing was claimed, written or dispatched: automatic owner enrollment is gone.
    expect(markProfilesRunningForRun).not.toHaveBeenCalled();
    expect(insertRun).not.toHaveBeenCalled();
    expect(scheduleRunChunks).not.toHaveBeenCalled();
    expect(queueSend).not.toHaveBeenCalled();
    expect(queueSendBatch).not.toHaveBeenCalled();
  });

  it('plans the exact snapshot of a funded request and starts only its own run', async () => {
    const entries = [
      { model: 'vendor/m', variant: 'xhigh' },
      { model: 'vendor/m', variant: 'max' },
    ];
    const result = await startRun(env, 'decider', {
      purpose: 'user',
      paidRequestId: 'request-1',
      entries,
    });

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
      expect.objectContaining({ repetitions: 3 })
    );
    // Materialization belongs to the dispatcher's initialization pass, which is the only
    // place that narrows a paid run to the request's own remaining slots.
    expect(scheduleRunChunks).not.toHaveBeenCalled();
    await deliverSchedulerWakes();
    // The pass reads the durable request behind the run; absent one, it spends nothing.
    expect(markRunFailed).toHaveBeenCalledWith(
      env.BENCH_DB,
      result.runId,
      'Paid benchmark request not found.'
    );
    expect(scheduleRunChunks).not.toHaveBeenCalled();
    expect(queueSendBatch).not.toHaveBeenCalled();
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
      expect.objectContaining({ repetitions: 3 })
    );
    // Dedup is the registry's job, so no run-level carry lookup happens.
    expect(getLatestSummariesByModel).not.toHaveBeenCalled();
  });

  it.each(['platform', 'user'] as const)(
    'snapshots zero reserved concurrency for a %s run',
    async purpose => {
      await startRun(env, 'decider', {
        purpose,
        ...(purpose === 'user' ? { paidRequestId: 'request-1' } : {}),
        entries: [{ model: 'p/a', variant: null }],
      });
      expect(vi.mocked(insertRun).mock.calls[0][1].max_concurrency).toBe(0);
    }
  );

  it('admits a decider run even when all live slots are occupied', async () => {
    vi.mocked(getLiveContainerLanes).mockResolvedValue(250);
    const result = await startRun(env, 'decider', {
      purpose: 'platform',
      entries: [{ model: 'p/a', variant: null }],
    });
    expect(result.enqueuedModels).toBe(1);
    expect(queueSend).toHaveBeenCalledExactlyOnceWith({
      runId: result.runId,
      kind: 'decider',
      model: 'p/a',
      schedulerWake: true,
    });
    expect(scheduleRunChunks).not.toHaveBeenCalled();
    await deliverSchedulerWakes();
    expect(scheduleRunChunks).toHaveBeenCalledOnce();
    expect(claimScheduledChunks).toHaveBeenCalled();
  });

  it('plans every admitted entry without dividing free lanes between runs', async () => {
    vi.mocked(getLiveContainerLanes).mockResolvedValue(240);
    const entries = Array.from({ length: 6 }, (_, i) => ({ model: `p/${i}`, variant: null }));
    const result = await startRun(env, 'decider', { purpose: 'platform', entries });
    expect(result.enqueuedModels).toBe(6);
    await deliverSchedulerWakes();
    expect(scheduleRunChunks).toHaveBeenCalledWith(
      env.BENCH_DB,
      expect.objectContaining({ entries })
    );
  });

  it('rejects decider runs without a registry entry snapshot', async () => {
    await expect(startRun(env, 'decider')).rejects.toThrow(/non-empty registry entry snapshot/);
    await expect(startRun(env, 'decider', { entries: [] })).rejects.toThrow(
      /non-empty registry entry snapshot/
    );
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

    await expect(
      startRun(env, 'decider', { purpose: 'user', paidRequestId: 'request-1', entries })
    ).rejects.toThrow('claim failed');

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
      paidRequestId: 'request-1',
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
      startRun(env, 'decider', {
        purpose: 'user',
        paidRequestId: 'request-1',
        entries: [{ model: 'b/taken', variant: null }],
      })
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
    return DECIDER_CASES.map(c => ({
      run_id: runId,
      model,
      variant,
      case_id: c.id,
      route_key: 'implementation/code_generation',
      score: 1,
      latency_ms: 10,
      cost_usd: 0.001,
      input_tokens: null,
      cached_input_tokens: null,
      output_tokens: null,
      reasoning_tokens: null,
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
      prompt_revision: 2,
      tool_calls: null,
      tool_names: null,
      step_count: null,
      final_finish_reason: null,
    }));
  }

  async function finalizeVia(runId: string, model: string, variant: string | null) {
    vi.mocked(getExistingCaseResultIds).mockResolvedValue(new Set([DECIDER_CASES[0].id]));
    vi.mocked(getChunk).mockResolvedValue({
      id: 'completion-claim',
      run_id: runId,
      model,
      variant: variant ?? '',
      rep: 0,
      chunk: 0,
      case_ids: JSON.stringify([DECIDER_CASES[0].id]),
      slot: 0,
      token: 'completion-token',
      attempts: 1,
      throttle_deferrals: 0,
      catalog_deferrals: 0,
    });
    await processJob(env, {
      runId,
      kind: 'decider',
      model,
      claimId: 'completion-claim',
      claimToken: 'completion-token',
    });
    expect(finishChunk).toHaveBeenCalledWith(env.BENCH_DB, 'completion-claim', 'completion-token');
  }

  it('marks registry rows ready and republishes the platform table from the registry', async () => {
    const runId = 'decider-complete-1';
    mockRunState(runId, 'platform', [{ model: 'vendor/m', variant: 'xhigh' }]);
    vi.mocked(countCaseResultsByLane).mockResolvedValue([
      { model: 'vendor/m', variant: 'xhigh', rep: 0, n: DECIDER_CASES.length },
    ]);
    vi.mocked(getCaseResults).mockResolvedValue(await caseRowsFor(runId, 'vendor/m', 'xhigh'));

    await finalizeVia(runId, 'vendor/m', 'xhigh');

    expect(markRunCompleted).toHaveBeenCalledWith(env.BENCH_DB, runId);
    expect(markProfilesReadyForRun).toHaveBeenCalledWith(env.BENCH_DB, runId);
    expect(settleProfileRunAttempts).toHaveBeenCalledWith(
      env.BENCH_DB,
      expect.objectContaining({
        runId,
        attempts: [
          expect.objectContaining({
            entry: { model: 'vendor/m', variant: 'xhigh' },
            enqueued: true,
            failure: null,
            cancelled: false,
          }),
        ],
      })
    );
    // Settle the registry rows first. The orphan reaper spares rows whose run
    // is still running, so completing the run first would open a window where a
    // concurrent sweep fails entries that are fully measured.
    expect(vi.mocked(markProfilesReadyForRun).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(markRunCompleted).mock.invocationCallOrder[0]
    );
    // A completed decider run republishes the shared platform table from the registry;
    // nothing is serveable in this fixture, so publishing is honestly skipped.
    expect(listReadyCurrentProfilesForEntries).toHaveBeenCalled();
    expect(saveRoutingTable).not.toHaveBeenCalled();
  });

  it('fails only the entries whose lane died, and readies the rest', async () => {
    // The failure-isolation guarantee: models A and B finish, C's lane dies.
    // C alone must fail — A and B keep the results they cost money to produce.
    const runId = 'decider-partial-1';
    mockRunState(runId, 'platform', [
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
        failure_class: 'provider_unavailable',
      },
    ]);
    vi.mocked(getCaseResults).mockResolvedValue(await caseRowsFor(runId, 'vendor/a', ''));

    await finalizeVia(runId, 'vendor/a', null);

    // Only C's attempt carries a failure; A and B settle as attempts with none.
    const [, settlement] = vi.mocked(settleProfileRunAttempts).mock.calls[0];
    expect(
      settlement.attempts.map(attempt => ({
        entry: attempt.entry,
        failure: attempt.failure,
      }))
    ).toEqual([
      { entry: { model: 'vendor/a', variant: null }, failure: null },
      { entry: { model: 'vendor/b', variant: null }, failure: null },
      {
        entry: { model: 'vendor/c', variant: null },
        failure: {
          failureClass: 'provider_unavailable',
          reason: expect.stringContaining('did not finish'),
        },
      },
    ]);
    // The ready sweep runs after the per-entry settlement, so it only catches A and B.
    expect(markProfilesReadyForRun).toHaveBeenCalledWith(env.BENCH_DB, runId);
    expect(markRunCompleted).toHaveBeenCalledWith(env.BENCH_DB, runId);
    // One dead lane never fails the whole run.
    expect(markRunFailed).not.toHaveBeenCalled();
  });

  it('settles a lane with no recorded cause as an unknown failure', async () => {
    const runId = 'decider-partial-2';
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
        failure_class: null,
      },
    ]);
    vi.mocked(getCaseResults).mockResolvedValue(await caseRowsFor(runId, 'platform/a', ''));

    await finalizeVia(runId, 'platform/a', null);

    const [, settlement] = vi.mocked(settleProfileRunAttempts).mock.calls[0];
    expect(settlement.attempts.at(1)).toEqual(
      expect.objectContaining({
        entry: { model: 'platform/b', variant: 'high' },
        failure: { failureClass: 'unknown', reason: expect.stringContaining('did not finish') },
      })
    );
    expect(markRunCompleted).toHaveBeenCalledWith(env.BENCH_DB, runId);
    // Old behaviour failed the whole platform run on a dead lane.
    expect(markRunFailed).not.toHaveBeenCalled();
  });

  it('publishes the ready exact pairs while other platform pairs are still measuring', async () => {
    const runId = 'decider-publish-1';
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
          routeAccuracy: null,
          avgInputTokens: null,
          avgCachedInputTokens: null,
          avgOutputTokens: null,
          avgReasoningTokens: null,
        }))
      )
    );
    // A newly admitted pair is still measuring: it is not served yet, so it must
    // not hold back the pairs that are.
    vi.mocked(listCurrentPlatformProfileStatuses).mockResolvedValue([
      { model: 'platform/a', variant: null, status: 'ready', completed_at: null },
      { model: 'platform/b', variant: 'high', status: 'ready', completed_at: null },
      { model: 'platform/c', variant: 'max', status: 'running', completed_at: null },
      { model: 'platform/d', variant: 'low', status: 'pending', completed_at: null },
    ]);

    await finalizeVia(runId, 'platform/a', null);

    expect(saveRoutingTable).toHaveBeenCalledOnce();
    const [, table] = vi.mocked(saveRoutingTable).mock.calls[0];
    expect(table.source).toBe('benchmark');
    expect(getRoutingCaseResultsForEntries).toHaveBeenCalledWith(env.BENCH_DB, [
      { entry: { model: 'platform/a', variant: null }, runId },
      { entry: { model: 'platform/b', variant: 'high' }, runId },
    ]);
    expect(table.effortByComplexity?.['implementation/code_generation']).toEqual({
      'platform/a': { low: null, medium: null, high: null },
      'platform/b': { low: 'high', medium: 'high', high: 'high' },
    });
    // Version identifies the contributing registry rows, not a single run.
    expect(table.version).toMatch(/^registry-/);
    expect(Object.keys(table.routes)).toHaveLength(TAXONOMY_ROUTE_KEYS.length);
    expect(
      table.routes['implementation/code_generation'].map(candidate => candidate.variant)
    ).toEqual([null, 'high']);
    expect(
      table.routes['implementation/code_generation'].every(
        candidate => candidate.reasoningEffort == null
      )
    ).toBe(true);
    expect(kvDelete).toHaveBeenCalled();
  });

  it('keeps the published table while a live pair is still re-measuring', async () => {
    // The baseline is older than the serving set, so this pass is licensed to publish and
    // the live-pair guard — not the unchanged-membership gate — is what holds it back.
    vi.mocked(getLatestRoutingTable).mockResolvedValue(
      liveRoutingTable(
        [
          { model: 'platform/a', variant: null },
          { model: 'platform/b', variant: 'high' },
        ],
        ['["platform/a",null]']
      )
    );
    vi.mocked(listReadyCurrentProfilesForEntries).mockResolvedValue([
      { model: 'platform/a', variant: '', run_id: 'decider-publish-2' },
    ]);
    vi.mocked(listCurrentPlatformProfileStatuses).mockResolvedValue([
      { model: 'platform/a', variant: null, status: 'ready', completed_at: null },
      { model: 'platform/b', variant: 'high', status: 'running', completed_at: null },
    ]);
    vi.mocked(getSummariesForRuns).mockResolvedValue(
      TAXONOMY_ROUTE_KEYS.map(routeKey => ({
        model: 'platform/a',
        variant: null,
        runId: 'decider-publish-2',
        routeKey,
        accuracy: 0.9,
        avgCostUsd: 0.002,
        avgLatencyMs: 100,
        p50LatencyMs: 100,
        p95LatencyMs: 150,
        cases: 10,
        errors: 0,
        timeouts: 0,
        routeAccuracy: null,
        avgInputTokens: null,
        avgCachedInputTokens: null,
        avgOutputTokens: null,
        avgReasoningTokens: null,
      }))
    );

    await expect(publishPlatformRoutingTable(env, fetch)).resolves.toBeNull();

    expect(saveRoutingTable).not.toHaveBeenCalled();
    expect(kvDelete).not.toHaveBeenCalled();
  });

  it('keeps the published table while a live pair has no row under this engine', async () => {
    vi.mocked(getLatestRoutingTable).mockResolvedValue(
      liveRoutingTable(
        [
          { model: 'platform/a', variant: null },
          { model: 'platform/b', variant: 'high' },
        ],
        ['["platform/a",null]']
      )
    );
    vi.mocked(listReadyCurrentProfilesForEntries).mockResolvedValue([
      { model: 'platform/a', variant: '', run_id: 'decider-publish-3' },
    ]);
    vi.mocked(listCurrentPlatformProfileStatuses).mockResolvedValue([
      { model: 'platform/a', variant: null, status: 'ready', completed_at: null },
    ]);
    vi.mocked(getSummariesForRuns).mockResolvedValue(
      TAXONOMY_ROUTE_KEYS.map(routeKey => ({
        model: 'platform/a',
        variant: null,
        runId: 'decider-publish-3',
        routeKey,
        accuracy: 0.9,
        avgCostUsd: 0.002,
        avgLatencyMs: 100,
        p50LatencyMs: 100,
        p95LatencyMs: 150,
        cases: 10,
        errors: 0,
        timeouts: 0,
        routeAccuracy: null,
        avgInputTokens: null,
        avgCachedInputTokens: null,
        avgOutputTokens: null,
        avgReasoningTokens: null,
      }))
    );

    await expect(publishPlatformRoutingTable(env, fetch)).resolves.toBeNull();

    expect(saveRoutingTable).not.toHaveBeenCalled();
  });

  it('drops a settled failed target and publishes the rest of the table', async () => {
    vi.mocked(getLatestRoutingTable).mockResolvedValue(
      liveRoutingTable(
        [
          { model: 'platform/a', variant: null },
          { model: 'platform/b', variant: 'high' },
        ],
        ['["platform/a",null]']
      )
    );
    vi.mocked(listReadyCurrentProfilesForEntries).mockResolvedValue([
      { model: 'platform/a', variant: '', run_id: 'decider-publish-4' },
    ]);
    vi.mocked(listCurrentPlatformProfileStatuses).mockResolvedValue([
      { model: 'platform/a', variant: null, status: 'ready', completed_at: null },
      // The failure settled after the stored cutover, so it is a genuine post-cutover drop.
      {
        model: 'platform/b',
        variant: 'high',
        status: 'failed',
        completed_at: '2026-02-01T00:00:00.000Z',
      },
    ]);
    vi.mocked(getSummariesForRuns).mockResolvedValue(
      TAXONOMY_ROUTE_KEYS.map(routeKey => ({
        model: 'platform/a',
        variant: null,
        runId: 'decider-publish-4',
        routeKey,
        accuracy: 0.9,
        avgCostUsd: 0.002,
        avgLatencyMs: 100,
        p50LatencyMs: 100,
        p95LatencyMs: 150,
        cases: 10,
        errors: 0,
        timeouts: 0,
        routeAccuracy: null,
        avgInputTokens: null,
        avgCachedInputTokens: null,
        avgOutputTokens: null,
        avgReasoningTokens: null,
      }))
    );
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await expect(publishPlatformRoutingTable(env, fetch)).resolves.not.toBeNull();
    const events = log.mock.calls.map(([message]) => JSON.parse(String(message)));
    log.mockRestore();

    expect(saveRoutingTable).toHaveBeenCalledOnce();
    expect(events).toContainEqual({
      event: 'routing_table_publish_dropped_failed_pairs',
      router: 'efficient',
      dropped: [{ model: 'platform/b', variant: 'high', status: 'failed' }],
    });
    expect(
      events.some(entry => entry.event === 'routing_table_publish_skipped_serving_pair_unready')
    ).toBe(false);
  });

  it('does not publish a thin table as an engine bump re-measures the live pairs', async () => {
    vi.mocked(getLatestRoutingTable).mockResolvedValue(
      liveRoutingTable(
        [
          { model: 'platform/a', variant: null },
          { model: 'platform/b', variant: 'high' },
        ],
        ['["platform/a",null]']
      )
    );
    const summariesFor = (model: string, variant: string | null, runId: string) =>
      TAXONOMY_ROUTE_KEYS.map(routeKey => ({
        model,
        variant,
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
        routeAccuracy: null,
        avgInputTokens: null,
        avgCachedInputTokens: null,
        avgOutputTokens: null,
        avgReasoningTokens: null,
      }));
    // The bump promoted only the pairs measured so far, so `a` serves alone while `b` waits.
    vi.mocked(servingSubscriptionSnapshot).mockResolvedValue([
      {
        model: 'platform/a',
        pairs: [{ model: 'platform/a', variant: null }],
        servingPairs: [{ model: 'platform/a', variant: null }],
        resolutionError: null,
      },
      {
        model: 'platform/b',
        pairs: [{ model: 'platform/b', variant: 'high' }],
        servingPairs: [],
        resolutionError: null,
      },
    ]);
    vi.mocked(listReadyCurrentProfilesForEntries).mockResolvedValue([
      { model: 'platform/a', variant: '', run_id: 'bump-a' },
    ]);
    vi.mocked(listCurrentPlatformProfileStatuses).mockResolvedValue([
      { model: 'platform/a', variant: null, status: 'ready', completed_at: null },
      { model: 'platform/b', variant: 'high', status: 'pending', completed_at: null },
    ]);
    vi.mocked(getSummariesForRuns).mockResolvedValue(summariesFor('platform/a', null, 'bump-a'));

    await expect(publishPlatformRoutingTable(env, fetch)).resolves.toBeNull();
    expect(saveRoutingTable).not.toHaveBeenCalled();

    // Once every live pair is ready again the table publishes with both.
    vi.mocked(servingSubscriptionSnapshot).mockResolvedValue([
      {
        model: 'platform/a',
        pairs: [{ model: 'platform/a', variant: null }],
        servingPairs: [{ model: 'platform/a', variant: null }],
        resolutionError: null,
      },
      {
        model: 'platform/b',
        pairs: [{ model: 'platform/b', variant: 'high' }],
        servingPairs: [{ model: 'platform/b', variant: 'high' }],
        resolutionError: null,
      },
    ]);
    vi.mocked(listReadyCurrentProfilesForEntries).mockResolvedValue([
      { model: 'platform/a', variant: '', run_id: 'bump-a' },
      { model: 'platform/b', variant: 'high', run_id: 'bump-b' },
    ]);
    vi.mocked(listCurrentPlatformProfileStatuses).mockResolvedValue([
      { model: 'platform/a', variant: null, status: 'ready', completed_at: null },
      { model: 'platform/b', variant: 'high', status: 'ready', completed_at: null },
    ]);
    vi.mocked(getSummariesForRuns).mockResolvedValue([
      ...summariesFor('platform/a', null, 'bump-a'),
      ...summariesFor('platform/b', 'high', 'bump-b'),
    ]);

    await expect(publishPlatformRoutingTable(env, fetch)).resolves.not.toBeNull();

    const [, table] = vi.mocked(saveRoutingTable).mock.calls[0];
    expect(
      table.routes['implementation/code_generation'].map(candidate => candidate.model)
    ).toEqual(['platform/a', 'platform/b']);
  });

  it('drops a pair without probe results from the agentic routes after activation', async () => {
    vi.mocked(getLatestRoutingTable).mockResolvedValue(
      liveRoutingTable(
        [
          { model: 'platform/a', variant: null },
          { model: 'platform/b', variant: 'high' },
        ],
        ['["platform/a",null]']
      )
    );
    const summariesFor = (model: string, variant: string | null, runId: string) =>
      TAXONOMY_ROUTE_KEYS.map(routeKey => ({
        model,
        variant,
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
        routeAccuracy: null,
        avgInputTokens: null,
        avgCachedInputTokens: null,
        avgOutputTokens: null,
        avgReasoningTokens: null,
      }));
    vi.mocked(servingSubscriptionSnapshot).mockResolvedValue([
      {
        model: 'platform/a',
        pairs: [{ model: 'platform/a', variant: null }],
        servingPairs: [{ model: 'platform/a', variant: null }],
        resolutionError: null,
      },
      {
        model: 'platform/b',
        pairs: [{ model: 'platform/b', variant: 'high' }],
        servingPairs: [{ model: 'platform/b', variant: 'high' }],
        resolutionError: null,
      },
    ]);
    vi.mocked(listCurrentPlatformProfileStatuses).mockResolvedValue([
      { model: 'platform/a', variant: null, status: 'ready', completed_at: null },
      { model: 'platform/b', variant: 'high', status: 'ready', completed_at: null },
    ]);
    // `a` finished its tool-evidence re-measure; `b` still serves its older measurement.
    vi.mocked(listReadyCurrentProfilesForEntries).mockResolvedValue([
      { model: 'platform/a', variant: '', run_id: 'revision-3-a' },
      { model: 'platform/b', variant: 'high', run_id: 'revision-2-b' },
    ]);
    vi.mocked(getSummariesForRuns).mockResolvedValue([
      ...summariesFor('platform/a', null, 'revision-3-a'),
      ...summariesFor('platform/b', 'high', 'revision-2-b'),
    ]);
    missingProbeResults.mockResolvedValueOnce(
      new Set([benchmarkPairKey({ model: 'platform/b', variant: 'high' })])
    );

    await expect(publishPlatformRoutingTable(env, fetch)).resolves.not.toBeNull();

    // Revision 3 is active: `b` lacks the probes, so its agentic results are dropped and
    // every other route keeps both pairs' measurements.
    const [, table] = vi.mocked(saveRoutingTable).mock.calls[0];
    expect(table.routes['agentic_execution/tool_usage'].map(candidate => candidate.model)).toEqual([
      'platform/a',
    ]);
    expect(
      table.routes['implementation/code_generation'].map(candidate => candidate.model)
    ).toEqual(['platform/a', 'platform/b']);
  });

  it('records exact membership on a pre-cutover artifact without rebuilding it', async () => {
    // The live artifact predates the membership column, so there is no durable baseline to
    // compare against. Inferring one from the ranked routes would be wrong: a serving pair
    // whose probe results are incomplete is absent from `routes` while still desired, so a
    // comparison against candidates can look like a change that never happened and rebuild
    // a table the revision would narrow.
    vi.mocked(getLatestRoutingTable).mockResolvedValue(
      liveRoutingTable(
        [
          { model: 'platform/a', variant: null },
          { model: 'platform/b', variant: 'high' },
        ],
        null
      )
    );
    vi.mocked(servingSubscriptionSnapshot).mockResolvedValue([
      {
        model: 'platform/a',
        pairs: [{ model: 'platform/a', variant: null }],
        servingPairs: [{ model: 'platform/a', variant: null }],
        resolutionError: null,
      },
      {
        model: 'platform/b',
        pairs: [{ model: 'platform/b', variant: 'high' }],
        servingPairs: [{ model: 'platform/b', variant: 'high' }],
        resolutionError: null,
      },
    ]);
    vi.mocked(listReadyCurrentProfilesForEntries).mockResolvedValue([
      { model: 'platform/a', variant: '', run_id: 'baseline-a' },
      { model: 'platform/b', variant: 'high', run_id: 'baseline-b' },
    ]);
    vi.mocked(getSummariesForRuns).mockResolvedValue(
      [
        { model: 'platform/a', variant: null, runId: 'baseline-a' },
        { model: 'platform/b', variant: 'high', runId: 'baseline-b' },
      ].flatMap(pair =>
        TAXONOMY_ROUTE_KEYS.map(routeKey => ({
          ...pair,
          routeKey,
          accuracy: 0.9,
          avgCostUsd: 0.002,
          avgLatencyMs: 100,
          p50LatencyMs: 100,
          p95LatencyMs: 150,
          cases: 10,
          errors: 0,
          timeouts: 0,
          routeAccuracy: null,
          avgInputTokens: null,
          avgCachedInputTokens: null,
          avgOutputTokens: null,
          avgReasoningTokens: null,
        }))
      )
    );
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await expect(publishPlatformRoutingTable(env, fetch)).resolves.toBeNull();
    const events = log.mock.calls.map(([message]) => JSON.parse(String(message)));
    log.mockRestore();

    // The artifact is untouched and the reason is the unchanged desired set.
    expect(saveRoutingTable).not.toHaveBeenCalled();
    expect(kvDelete).not.toHaveBeenCalled();
    expect(events).toContainEqual(
      expect.objectContaining({ event: 'routing_table_publish_skipped_unchanged_desired_set' })
    );
    // The exact configured/resolved membership is recorded as the new baseline, once.
    expect(recordedDesiredPairs()).toEqual([['["platform/a",null]', '["platform/b","high"]']]);
    // Recording a baseline is a D1 write: the only network work is the publish's own
    // catalog price read, never a provider call or a measurement.
    expect(
      catalogFetch.mock.calls.map(([input]) =>
        input instanceof Request ? input.url : input instanceof URL ? input.href : input
      )
    ).toEqual(['https://app.test/api/openrouter/models']);
  });

  it('readies a complete paid pair and releases only the incomplete one', async () => {
    // One request, two pairs: X finished every slot, Y ended short. The run is incomplete as
    // a whole, but X's measurement is complete and paid for, so it is readied with its
    // results intact while only Y goes back to the queue.
    const runId = 'user-paid-partial-1';
    mockRunState(runId, 'user', [
      { model: 'vendor/x', variant: '' },
      { model: 'vendor/y', variant: '' },
    ]);
    const xRows = await caseRowsFor(runId, 'vendor/x', '');
    // Y's lane ended terminally after most of its slots, so the run is incomplete.
    const yRows = (await caseRowsFor(runId, 'vendor/y', '')).slice(1);
    vi.mocked(countCaseResultsByLane).mockResolvedValue([
      { model: 'vendor/x', variant: '', rep: 0, n: xRows.length },
      { model: 'vendor/y', variant: '', rep: 0, n: yRows.length },
    ]);
    vi.mocked(listLaneFailures).mockResolvedValue([
      {
        run_id: runId,
        model: 'vendor/y',
        variant: '',
        rep: 0,
        chunk: 0,
        shard: 0,
        failed_at: '2026-06-01T01:00:00.000Z',
        failure_class: 'provider_unavailable',
      },
    ]);
    vi.mocked(getCaseResults).mockResolvedValue([...xRows, ...yRows]);

    await finalizeVia(runId, 'vendor/x', null);

    // X is published ready; Y is released and never readied.
    expect(markProfilesReadyForEntries).toHaveBeenCalledWith(env.BENCH_DB, runId, [
      { model: 'vendor/x', variant: null },
    ]);
    expect(releaseProfileClaimsForEntries).toHaveBeenCalledWith(env.BENCH_DB, runId, [
      { model: 'vendor/y', variant: null },
    ]);
    const [, , readyEntries] = vi.mocked(markProfilesReadyForEntries).mock.calls[0];
    expect(readyEntries).toEqual([{ model: 'vendor/x', variant: null }]);
    // The paired whole-run sweeps never run for a paid run: they would ready or fail Y too.
    expect(markProfilesReadyForRun).not.toHaveBeenCalled();
    expect(markProfilesFailedForEntries).not.toHaveBeenCalled();
    // X keeps every result that cost money; Y contributes only the slots it actually ran.
    expect(xRows).toHaveLength(DECIDER_CASES.length);
    expect(yRows).toHaveLength(DECIDER_CASES.length - 1);
    // The run still closes as a whole, and only Y records its terminal cause.
    expect(markRunCompleted).toHaveBeenCalledWith(env.BENCH_DB, runId);
    expect(markRunFailed).not.toHaveBeenCalled();
    const [, settlement] = vi.mocked(settleProfileRunAttempts).mock.calls[0];
    // `cancelled` is per pair, never per run: X measured every slot, so its attempt counts as
    // progress (a zero score included) even though the run as a whole is incomplete. Only Y,
    // which ended on a dead lane, carries the failure and no cancellation.
    expect(
      settlement.attempts.map(attempt => ({
        model: attempt.entry.model,
        cancelled: attempt.cancelled,
        failureClass: attempt.failure?.failureClass ?? null,
      }))
    ).toEqual([
      { model: 'vendor/x', cancelled: false, failureClass: null },
      { model: 'vendor/y', cancelled: false, failureClass: 'provider_unavailable' },
    ]);
  });

  it('does not hold the frontier table for an efficient-only grading revision', async () => {
    mockConfig({ router: 'frontier' });
    vi.mocked(servingSubscriptionSnapshot).mockResolvedValue([
      {
        model: 'platform/a',
        pairs: [{ model: 'platform/a', variant: null }],
        servingPairs: [{ model: 'platform/a', variant: null }],
        resolutionError: null,
      },
      {
        model: 'platform/b',
        pairs: [{ model: 'platform/b', variant: 'high' }],
        servingPairs: [{ model: 'platform/b', variant: 'high' }],
        resolutionError: null,
      },
    ]);
    vi.mocked(listCurrentPlatformProfileStatuses).mockResolvedValue([
      { model: 'platform/a', variant: null, status: 'ready', completed_at: null },
      { model: 'platform/b', variant: 'high', status: 'ready', completed_at: null },
    ]);
    vi.mocked(listReadyCurrentProfilesForEntries).mockResolvedValue([
      { model: 'platform/a', variant: '', run_id: 'frontier-revision-3' },
      { model: 'platform/b', variant: 'high', run_id: 'frontier-revision-2' },
    ]);
    vi.mocked(getSummariesForRuns).mockResolvedValue(
      [
        { model: 'platform/a', variant: null, runId: 'frontier-revision-3' },
        { model: 'platform/b', variant: 'high', runId: 'frontier-revision-2' },
      ].flatMap(pair =>
        TAXONOMY_ROUTE_KEYS.map(routeKey => ({
          ...pair,
          routeKey,
          accuracy: 0.95,
          avgCostUsd: 0.002,
          avgLatencyMs: 100,
          p50LatencyMs: 100,
          p95LatencyMs: 150,
          cases: 10,
          errors: 0,
          timeouts: 0,
          routeAccuracy: null,
          avgInputTokens: null,
          avgCachedInputTokens: null,
          avgOutputTokens: null,
          avgReasoningTokens: null,
        }))
      )
    );

    await expect(
      publishPlatformRoutingTable(env, catalogFetch, 'frontier')
    ).resolves.not.toBeNull();
    expect(saveRoutingTable).toHaveBeenCalledWith(
      env.BENCH_DB,
      expect.anything(),
      expect.any(String),
      'frontier',
      ['["platform/a",null]', '["platform/b","high"]']
    );
  });

  it('failRunAndDrain fails the claimed registry rows and drains the platform queue', async () => {
    vi.mocked(listPendingCurrentProfiles).mockResolvedValue([
      { model: 'vendor/next', variant: 'high', requested_at: '2026-06-01T00:00:00.000Z' },
    ]);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await failRunAndDrain(env, 'user-fail-1', {
      failureClass: 'run_init_failed',
      reason: 'enqueue failed',
    });
    const events = log.mock.calls.map(([message]) => JSON.parse(String(message)));
    log.mockRestore();

    expect(markRunFailed).toHaveBeenCalledWith(env.BENCH_DB, 'user-fail-1', 'enqueue failed');
    expect(markProfilesFailedForRun).toHaveBeenCalledWith(env.BENCH_DB, 'user-fail-1', {
      failureClass: 'run_init_failed',
      reason: 'enqueue failed',
    });
    // The freed slot goes to the platform queue, which has pending work in this mock. The
    // retired user queue enrolls nothing, so it starts no run at all.
    expect(vi.mocked(insertRun).mock.calls.map(call => call[1].purpose)).toEqual(['platform']);
    expect(events.filter(entry => entry.purpose === 'user')).toEqual([]);
  });
});

describe('drainQueue', () => {
  it('records why it started nothing: an occupied slot, an empty queue or no config', async () => {
    const skipped: DrainSkipReason[] = [];

    // Empty queue: no pending row, no queued re-measure.
    vi.mocked(listPendingCurrentProfiles).mockResolvedValue([]);
    await expect(drainQueue(env, 'platform', 'efficient', { skipped })).resolves.toBeNull();
    expect(skipped).toEqual(['nothing_pending']);

    // Occupied slot.
    skipped.length = 0;
    vi.mocked(getQueueRunOccupancy).mockResolvedValue({
      activeRuns: 1,
      startingRunId: 'platform-busy',
    });
    vi.mocked(listPendingCurrentProfiles).mockResolvedValue([
      { model: 'm/pending', variant: '', requested_at: '2026-06-01T00:00:00.000Z' },
    ]);
    await expect(drainQueue(env, 'platform', 'efficient', { skipped })).resolves.toBeNull();
    expect(skipped).toEqual(['active_run']);

    // Every pending row this drain found is unexecutable, so nothing is claimable.
    skipped.length = 0;
    vi.mocked(getQueueRunOccupancy).mockResolvedValue({ activeRuns: 0, startingRunId: null });
    vi.mocked(fetchExecutableBenchmarkModelCatalog).mockResolvedValue({
      data: [{ id: 'platform/a', supported_parameters: [] }],
    });
    await expect(drainQueue(env, 'platform', 'efficient', { skipped })).resolves.toBeNull();
    expect(skipped).toEqual(['nothing_pending']);

    // No saved config: there is no registry to claim from.
    skipped.length = 0;
    vi.mocked(getConfigRows).mockResolvedValue({
      config: null,
      classifierModels: [],
      deciderModels: [],
    });
    await expect(drainQueue(env, 'platform', 'efficient', { skipped })).resolves.toBeNull();
    expect(skipped).toEqual(['nothing_pending']);
  });

  it('starts nothing for the retired user queue and says so', async () => {
    // The user queue enrolls no subscription, pool edit, schedule or retry any more: only
    // an explicit funded request starts its work, so a drain of it is a no-op.
    const skipped: DrainSkipReason[] = [];
    vi.mocked(listPendingCurrentProfiles).mockResolvedValue([
      { model: 'm/pending', variant: '', requested_at: '2026-06-01T00:00:00.000Z' },
    ]);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await expect(drainQueue(env, 'user', 'efficient', { skipped })).resolves.toBeNull();
    // `drainQueues` is the caller that records why: the retirement is not a silent skip.
    expect(await drainQueues(env, 'user')).toEqual([]);
    const events = log.mock.calls.map(([message]) => JSON.parse(String(message)));
    log.mockRestore();

    expect(skipped).toEqual(['nothing_pending']);
    expect(events).toContainEqual({ event: 'benchmark_user_queue_retired', router: 'efficient' });
    expect(listPendingCurrentProfiles).not.toHaveBeenCalled();
    expect(markProfilesRunningForRun).not.toHaveBeenCalled();
    expect(insertRun).not.toHaveBeenCalled();
  });

  it('starts the oldest pending batch of the platform queue', async () => {
    vi.mocked(listPendingCurrentProfiles).mockResolvedValue([
      { model: 'm/old', variant: 'a', requested_at: '2026-06-01T00:00:00.000Z' },
      { model: 'm/new', variant: 'b', requested_at: '2026-06-02T00:00:00.000Z' },
    ]);
    const result = await drainQueue(env, 'platform');
    expect(result).not.toBeNull();
    expect(result!.entryCount).toBe(2);
    expect(listPendingCurrentProfiles).toHaveBeenCalledWith(
      env.BENCH_DB,
      expect.anything(),
      'platform'
    );
    const [, , modelRows] = vi.mocked(insertRun).mock.calls[0];
    expect(modelRows[0].model).toBe('m/old');
    expect(modelRows[1].model).toBe('m/new');
  });

  it('logs the probe activation apply only when it moved rows', async () => {
    const activationRow = {
      action: 'remeasure',
      model: 'platform/a',
      variant: '',
      engine_identity: 'efficient:v1:6649fed2',
      repetitions: 3,
      requested_at: '2026-11-20T00:00:00.000Z',
    };
    const readmitRow = { ...activationRow, action: 'readmit', model: 'platform/b' };
    // answers the activation read, reports a free dispatch lock, and settles the batch of
    // queued / re-admitted rows with the given change counts.
    const activationDatabase = (rows: unknown[], changes: number[]): D1Database => {
      const prepare = (text: string) => {
        const statement = {
          bind: vi.fn(() => statement),
          first: vi.fn(async () => null),
          all: vi.fn(async () => ({
            results: text.includes('FROM probe_activations') ? rows : [],
          })),
          run: vi.fn(async () => ({ meta: { changes: 0 } })),
        };
        return statement;
      };
      return {
        prepare: vi.fn(prepare),
        batch: vi.fn(async () => changes.map(count => ({ meta: { changes: count } }))),
      } as unknown as D1Database;
    };
    const appliedLog = vi.fn();
    vi.spyOn(console, 'log').mockImplementation(appliedLog);
    vi.mocked(listPendingCurrentProfiles).mockResolvedValue([]);

    await drainQueue(
      {
        ...env,
        BENCH_DB: activationDatabase([activationRow, readmitRow], [2, 1, 0]),
      } as unknown as Env,
      'platform'
    );

    expect(
      appliedLog.mock.calls
        .map(([line]) => String(line))
        .filter(line => line.includes('benchmark_probe_activation_applied'))
        .map(line => JSON.parse(line) as Record<string, unknown>)
    ).toEqual([
      {
        event: 'benchmark_probe_activation_applied',
        router: 'efficient',
        queued: 2,
        readmitted: 1,
      },
    ]);

    appliedLog.mockClear();
    await drainQueue(
      { ...env, BENCH_DB: activationDatabase([], []) } as unknown as Env,
      'platform'
    );
    expect(
      appliedLog.mock.calls
        .map(([line]) => String(line))
        .filter(line => line.includes('benchmark_probe_activation_applied'))
    ).toEqual([]);
  });

  it('fails unavailable owner aliases without retargeting unrelated concrete entries', async () => {
    vi.mocked(fetchExecutableBenchmarkModelCatalog).mockResolvedValue({
      data: [
        { id: 'platform/a' },
        { id: '~platform/a-latest', alias_target: 'platform/replacement' },
        { id: 'platform/replacement' },
      ],
    });
    const requestedAt = '2026-06-01T00:00:00.000Z';
    vi.mocked(listPendingCurrentProfiles).mockResolvedValue([
      { model: '~platform/gone-latest', variant: '', requested_at: requestedAt },
      { model: 'platform/a', variant: '', requested_at: requestedAt },
    ]);

    const result = await drainQueue(env, 'platform', 'efficient', { skipPlatformSync: true });

    expect(result!.entryCount).toBe(1);
    expect(vi.mocked(insertRun).mock.calls[0][2].map(row => row.model)).toEqual(['platform/a']);
    expect(syncSubscriptionSnapshot).not.toHaveBeenCalled();
  });

  it('fails a model with an explicit empty capability list instead of scheduling it', async () => {
    vi.mocked(fetchExecutableBenchmarkModelCatalog).mockResolvedValue({
      data: [{ id: 'platform/a' }, { id: 'platform/no-parameters', supported_parameters: [] }],
    });
    const requestedAt = '2026-06-01T00:00:00.000Z';
    vi.mocked(listPendingCurrentProfiles).mockResolvedValue([
      { model: 'platform/no-parameters', variant: '', requested_at: requestedAt },
      { model: 'platform/a', variant: '', requested_at: requestedAt },
    ]);

    const result = await drainQueue(env, 'platform', 'efficient', { skipPlatformSync: true });

    expect(result!.entryCount).toBe(1);
    expect(vi.mocked(insertRun).mock.calls[0][2].map(row => row.model)).toEqual(['platform/a']);
    expect(failPendingProfiles).toHaveBeenCalledWith(env.BENCH_DB, expect.anything(), [
      {
        model: 'platform/no-parameters',
        variant: '',
        failure: { failureClass: 'catalog_absent', reason: CATALOG_NO_TOOL_SUPPORT_REASON },
      },
    ]);
  });

  it('fails a platform model whose context window is below the harness floor with that reason', async () => {
    vi.mocked(fetchExecutableBenchmarkModelCatalog).mockResolvedValue({
      data: [{ id: 'platform/a' }, { id: 'platform/small', context_length: 16_384 }],
    });
    const requestedAt = '2026-06-01T00:00:00.000Z';
    vi.mocked(listPendingCurrentProfiles).mockResolvedValue([
      { model: 'platform/small', variant: '', requested_at: requestedAt },
      { model: 'platform/a', variant: '', requested_at: requestedAt },
    ]);

    const result = await drainQueue(env, 'platform', 'efficient', { skipPlatformSync: true });

    expect(result!.entryCount).toBe(1);
    expect(vi.mocked(insertRun).mock.calls[0][2].map(row => row.model)).toEqual(['platform/a']);
    expect(failPendingProfiles).toHaveBeenCalledWith(env.BENCH_DB, expect.anything(), [
      {
        model: 'platform/small',
        variant: '',
        failure: { failureClass: 'context_too_small', reason: CATALOG_CONTEXT_TOO_SMALL_REASON },
      },
    ]);
  });

  it('fails an unresolved alias without inserting a run or dispatching CLI work', async () => {
    vi.mocked(fetchExecutableBenchmarkModelCatalog).mockResolvedValue({
      data: [{ id: '~platform/latest', alias_target: 'platform/missing' }],
    });
    vi.mocked(listPendingCurrentProfiles).mockResolvedValue([
      {
        model: '~platform/latest',
        variant: '',
        requested_at: '2026-06-01T00:00:00.000Z',
      },
    ]);

    await expect(
      drainQueue(env, 'platform', 'efficient', { skipPlatformSync: true })
    ).resolves.toBeNull();

    expect(markProfilesRunningForRun).not.toHaveBeenCalled();
    expect(insertRun).not.toHaveBeenCalled();
    expect(scheduleRunChunks).not.toHaveBeenCalled();
    expect(queueSend).not.toHaveBeenCalled();
    expect(queueSendBatch).not.toHaveBeenCalled();
  });

  it('starts another run while initialized runs of the queue are active', async () => {
    vi.mocked(getQueueRunOccupancy).mockResolvedValue({
      activeRuns: MAX_RUNNING_RUNS_PER_QUEUE - 1,
      startingRunId: null,
    });
    vi.mocked(listPendingCurrentProfiles).mockResolvedValue([
      { model: 'm/new', variant: 'a', requested_at: '2026-06-01T00:00:00.000Z' },
    ]);

    const started = await drainQueue(env, 'platform', 'efficient', { skipPlatformSync: true });

    expect(started).toMatchObject({ entryCount: 1 });
    expect(vi.mocked(insertRun).mock.calls.map(call => call[1].purpose)).toEqual(['platform']);
  });

  it.each([
    {
      occupancy: { activeRuns: 1, startingRunId: 'platform-starting' },
      event: 'benchmark_queue_drain_skipped_run_starting',
    },
    {
      occupancy: { activeRuns: MAX_RUNNING_RUNS_PER_QUEUE, startingRunId: null },
      event: 'benchmark_queue_drain_skipped_queue_full',
    },
  ])('skips only the queue that reports $event', async ({ occupancy, event }) => {
    // Only the efficient queue is full; the frontier queue has its own occupancy.
    vi.mocked(getQueueRunOccupancy).mockImplementation(async (_db, router) =>
      router === 'efficient' ? occupancy : { activeRuns: 0, startingRunId: null }
    );
    vi.mocked(listPendingCurrentProfiles).mockResolvedValue([
      { model: 'm/pending', variant: '', requested_at: '2026-06-01T00:00:00.000Z' },
    ]);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    expect(await drainQueue(env, 'platform', 'efficient', { skipPlatformSync: true })).toBeNull();
    expect(log.mock.calls.map(([line]) => JSON.parse(String(line)).event)).toContain(event);
    expect(markProfilesRunningForRun).not.toHaveBeenCalled();
    log.mockClear();
    // The other router's queue is untouched by this one's occupancy.
    mockConfig({ router: 'frontier' });
    expect(
      await drainQueue(env, 'platform', 'frontier', { skipPlatformSync: true })
    ).not.toBeNull();
    expect(vi.mocked(insertRun).mock.calls.map(call => call[1].purpose)).toEqual(['platform']);
    log.mockRestore();
  });

  it('hands the claims back when the run insert refuses admission after the read passed', async () => {
    vi.mocked(insertRun).mockResolvedValue({
      admitted: false,
      occupancy: { activeRuns: 2, startingRunId: 'platform-raced' },
    });
    vi.mocked(listPendingCurrentProfiles).mockResolvedValue([
      { model: 'm/pending', variant: '', requested_at: '2026-06-01T00:00:00.000Z' },
    ]);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    expect(await drainQueue(env, 'platform', 'efficient', { skipPlatformSync: true })).toBeNull();

    const [, claimRunId] = vi.mocked(markProfilesRunningForRun).mock.calls[0] ?? [];
    expect(releaseProfileClaims).toHaveBeenCalledWith(env.BENCH_DB, claimRunId);
    expect(log.mock.calls.map(([line]) => JSON.parse(String(line)))).toContainEqual(
      expect.objectContaining({
        event: 'benchmark_queue_drain_skipped_run_starting',
        startingRunId: 'platform-raced',
      })
    );
    expect(scheduleRunChunks).not.toHaveBeenCalled();
    expect(reuseDeciderCaseResults).not.toHaveBeenCalled();
    log.mockRestore();
  });

  it('plans all entries and repetitions in a large platform batch without fixed shards', async () => {
    mockConfig({ decider_repetitions: 5 });
    vi.mocked(listPendingCurrentProfiles).mockResolvedValue(
      Array.from({ length: 100 }, (_, i) => ({
        model: `m/${i}`,
        variant: '',
        requested_at: `2026-06-01T00:00:${String(i % 60).padStart(2, '0')}.000Z`,
      }))
    );
    const result = await drainQueue(env, 'platform');
    expect(result!.entryCount).toBe(100);
    await deliverSchedulerWakes();
    const [, , modelRows] = vi.mocked(insertRun).mock.calls[0];
    expect(modelRows).toHaveLength(100);
    expect(scheduleRunChunks).toHaveBeenCalledWith(env.BENCH_DB, {
      runId: result!.runId,
      entries: modelRows.map(row => ({ model: row.model, variant: null })),
      repetitions: 3,
      caseIds: CURRENT_EFFICIENT_CASE_IDS,
      chunkSize: 1,
    });
    expect(queueSendBatch).not.toHaveBeenCalled();
    expect(modelRows[0].model).toBe('m/0');
  });

  it('admits pending profiles while the shared scheduler has no free slots', async () => {
    vi.mocked(getLiveContainerLanes).mockResolvedValue(250);
    vi.mocked(listPendingCurrentProfiles).mockResolvedValue([
      { model: 'm/pending', variant: '', requested_at: '2026-06-01T00:00:00.000Z' },
    ]);

    await expect(drainQueue(env, 'platform')).resolves.toMatchObject({ entryCount: 1 });
    expect(insertRun).toHaveBeenCalledOnce();
    expect(scheduleRunChunks).not.toHaveBeenCalled();
    expect(queueSend).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ kind: 'decider', model: 'm/pending', schedulerWake: true })
    );
    await deliverSchedulerWakes();
    expect(scheduleRunChunks).toHaveBeenCalledOnce();
  });

  it('reserves batch space for a queued re-measure ahead of a full pending backlog', async () => {
    vi.mocked(listPendingCurrentProfiles).mockResolvedValue(
      Array.from({ length: 100 }, (_, i) => ({
        model: `m/${String(i).padStart(3, '0')}`,
        variant: '',
        requested_at: '2026-06-01T00:00:00.000Z',
      }))
    );
    vi.mocked(listQueuedRemeasures).mockResolvedValue([
      { model: 'm/repair', variant: '', requested_at: '2026-06-05T00:00:00.000Z' },
    ]);
    const result = await drainQueue(env, 'platform');
    expect(result!.entryCount).toBe(100);
    const [, , modelRows] = vi.mocked(insertRun).mock.calls[0];
    expect(modelRows).toHaveLength(100);
    expect(modelRows[0].model).toBe('m/repair');
    expect(modelRows.at(-1)?.model).toBe('m/098');
  });

  it("drainQueues('both') starts only the platform queue", async () => {
    vi.mocked(listPendingCurrentProfiles).mockResolvedValue([
      { model: 'm/x', variant: '', requested_at: '2026-06-01T00:00:00.000Z' },
    ]);
    const started = await drainQueues(env, 'both');
    // Both selectors run, but the user queue has no automatic enrollment left.
    expect(started.map(run => run.purpose)).toEqual(['platform']);
    expect(listPendingCurrentProfiles).toHaveBeenCalledTimes(1);
    expect(listPendingCurrentProfiles).toHaveBeenCalledWith(
      env.BENCH_DB,
      expect.anything(),
      'platform'
    );
  });
});

describe('sweepStaleRunsAndDrain', () => {
  it('salvages a timed-out run per entry instead of failing every entry', async () => {
    // vendor/done finished; vendor/stuck never produced rows. Only vendor/stuck
    // may be lost — re-measuring vendor/done would cost money again.
    const runId = 'decider-stale-1';
    vi.mocked(listStaleRunningDeciderRuns).mockResolvedValue([{ id: runId, purpose: 'platform' }]);
    vi.mocked(getRunWithModels).mockResolvedValue({
      run: runningRun(runId, 'platform'),
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
      laneDeaths.push({
        ...row,
        run_id: row.runId,
        failed_at: '2026-06-01T06:00:00.000Z',
        failure_class: row.failureClass,
      });
    });
    vi.mocked(listLaneFailures).mockImplementation(async () => laneDeaths);

    const result = await sweepStaleRunsAndDrain(env);

    expect(result.staleRunIds).toEqual([runId]);
    // The unfinished lane is recorded so normal finalization can settle the run.
    expect(recordLaneFailure).toHaveBeenCalledWith(
      env.BENCH_DB,
      expect.objectContaining({
        runId,
        model: 'vendor/stuck',
        variant: '',
        rep: 0,
        failureClass: 'run_timed_out',
      })
    );
    // The unfinished lane settles as a failed attempt; the finished one does not.
    const [, settlement] = vi.mocked(settleProfileRunAttempts).mock.calls.at(-1)!;
    expect(
      settlement.attempts.map(attempt => ({
        entry: attempt.entry,
        failureClass: attempt.failure?.failureClass ?? null,
        cancelled: attempt.cancelled,
      }))
    ).toEqual([
      { entry: { model: 'vendor/done', variant: null }, failureClass: null, cancelled: false },
      {
        entry: { model: 'vendor/stuck', variant: null },
        failureClass: 'run_timed_out',
        cancelled: false,
      },
    ]);
    expect(markProfilesReadyForRun).toHaveBeenCalledWith(env.BENCH_DB, runId);
    // The run completed with partial results rather than being failed wholesale.
    expect(markRunCompleted).toHaveBeenCalledWith(env.BENCH_DB, runId);
  });

  it('does not throw when a queue is still starting a run after the sweep', async () => {
    vi.mocked(getQueueRunOccupancy).mockResolvedValue({
      activeRuns: 1,
      startingRunId: 'still-starting',
    });
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

    expect(syncSubscriptionSnapshot).toHaveBeenCalledWith(
      env,
      expect.anything(),
      PLATFORM_SUBSCRIPTION_OWNER,
      [{ model: 'platform/a' }, { model: 'platform/b' }],
      { fetchImpl: fetch }
    );
    expect(syncPlatformRegistryRows).toHaveBeenCalledWith(env.BENCH_DB, expect.anything(), [
      { model: 'platform/a', variant: null },
      { model: 'platform/b', variant: 'high' },
    ]);
    expect(vi.mocked(syncPlatformRegistryRows).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(listPendingCurrentProfiles).mock.invocationCallOrder[0]
    );
  });
});

describe('alias-resolved platform publication', () => {
  it('keeps the existing table while a daily replacement is not ready', async () => {
    vi.mocked(servingSubscriptionSnapshot).mockResolvedValue([
      {
        model: '~vendor/latest',
        pairs: [{ model: 'vendor/next', variant: null }],
        servingPairs: [{ model: 'vendor/current', variant: null }],
        resolutionError: null,
      },
    ]);

    await expect(publishPlatformRoutingTable(env, catalogFetch)).resolves.toBeNull();

    expect(saveRoutingTable).not.toHaveBeenCalled();
    expect(listReadyCurrentProfilesForEntries).not.toHaveBeenCalled();
    expect(syncSubscriptionSnapshot).not.toHaveBeenCalled();
  });

  it('publishes the ready subset of an initial alias snapshot after the queue settles', async () => {
    catalogFetch.mockResolvedValue(Response.json({ data: [{ id: 'vendor/current' }] }));
    vi.mocked(servingSubscriptionSnapshot).mockResolvedValue([
      {
        model: '~vendor/latest',
        pairs: [
          { model: 'vendor/current', variant: 'low' },
          { model: 'vendor/current', variant: 'high' },
        ],
        servingPairs: [{ model: 'vendor/current', variant: 'low' }],
        resolutionError: null,
      },
    ]);
    vi.mocked(countCurrentProfilesByStatus).mockResolvedValue([
      { status: 'ready', count: 1 },
      { status: 'failed', count: 1 },
    ]);
    vi.mocked(listReadyCurrentProfilesForEntries).mockResolvedValue([
      { model: 'vendor/current', variant: 'low', run_id: 'partial-run' },
    ]);
    vi.mocked(getSummariesForRuns).mockResolvedValue(
      TAXONOMY_ROUTE_KEYS.map(routeKey => ({
        model: 'vendor/current',
        variant: 'low',
        runId: 'partial-run',
        routeKey,
        cases: 10,
        errors: 0,
        timeouts: 0,
        routeAccuracy: null,
        avgInputTokens: null,
        avgCachedInputTokens: null,
        avgOutputTokens: null,
        avgReasoningTokens: null,
        accuracy: 0.9,
        avgCostUsd: 0.001,
        avgLatencyMs: 100,
        p50LatencyMs: 100,
        p95LatencyMs: 150,
        p50TtftMs: null,
      }))
    );

    await expect(publishPlatformRoutingTable(env, catalogFetch)).resolves.not.toBeNull();
    expect(listReadyCurrentProfilesForEntries).toHaveBeenCalledWith(
      env.BENCH_DB,
      expect.anything(),
      [{ model: 'vendor/current', variant: 'low' }]
    );
    expect(saveRoutingTable).toHaveBeenCalledWith(
      env.BENCH_DB,
      expect.objectContaining({
        routes: expect.objectContaining({
          [TAXONOMY_ROUTE_KEYS[0]]: [
            expect.objectContaining({ model: 'vendor/current', variant: 'low' }),
          ],
        }),
      }),
      expect.any(String),
      'efficient',
      ['["vendor/current","low"]']
    );
  });

  it('publishes concrete pairs with their concrete catalog prices', async () => {
    vi.mocked(getConfigRows).mockResolvedValue({
      config: configRow,
      classifierModels: ['classifier/a'],
      deciderModels: [
        { model: '~vendor/latest', variant: null, reasoning_effort: null },
        { model: 'vendor/current', variant: null, reasoning_effort: null },
      ],
    });
    catalogFetch.mockImplementation(async () =>
      Response.json({
        data: [
          {
            id: '~vendor/latest',
            alias_target: 'vendor/new',
            pricing: { prompt: '0.01', completion: '0.02' },
          },
          { id: 'vendor/current', pricing: { prompt: '0.001', completion: '0.002' } },
          { id: 'vendor/new', pricing: { prompt: '0.004', completion: '0.008' } },
        ],
      })
    );
    vi.mocked(servingSubscriptionSnapshot).mockResolvedValue([
      {
        model: '~vendor/latest',
        pairs: [{ model: 'vendor/current', variant: null }],
        servingPairs: [{ model: 'vendor/current', variant: null }],
        resolutionError: null,
      },
    ]);
    vi.mocked(listReadyCurrentProfilesForEntries).mockResolvedValue([
      { model: 'vendor/current', variant: '', run_id: 'concrete-run' },
    ]);
    vi.mocked(getSummariesForRuns).mockResolvedValue(
      TAXONOMY_ROUTE_KEYS.map(routeKey => ({
        model: 'vendor/current',
        variant: null,
        runId: 'concrete-run',
        routeKey,
        cases: 10,
        errors: 0,
        timeouts: 0,
        routeAccuracy: null,
        avgInputTokens: null,
        avgCachedInputTokens: null,
        avgOutputTokens: null,
        avgReasoningTokens: null,
        accuracy: 0.9,
        avgCostUsd: 0.001,
        avgLatencyMs: 100,
        p50LatencyMs: 100,
        p95LatencyMs: 150,
        p50TtftMs: null,
      }))
    );

    await publishPlatformRoutingTable(env, catalogFetch);

    expect(servingSubscriptionSnapshot).toHaveBeenCalledWith(
      env.BENCH_DB,
      expect.anything(),
      PLATFORM_SUBSCRIPTION_OWNER
    );
    expect(syncSubscriptionSnapshot).not.toHaveBeenCalled();
    expect(getSummariesForRuns).toHaveBeenCalledWith(env.BENCH_DB, ['concrete-run']);
    expect(getRoutingCaseResultsForEntries).toHaveBeenCalledWith(env.BENCH_DB, [
      { entry: { model: 'vendor/current', variant: null }, runId: 'concrete-run' },
    ]);
    expect(listReadyCurrentProfilesForEntries).toHaveBeenCalledWith(
      env.BENCH_DB,
      expect.anything(),
      [{ model: 'vendor/current', variant: null }]
    );
    expect(saveRoutingTable).toHaveBeenCalledWith(
      env.BENCH_DB,
      expect.objectContaining({
        routes: expect.objectContaining({
          [TAXONOMY_ROUTE_KEYS[0]]: [
            expect.objectContaining({
              model: 'vendor/current',
              variant: null,
              pricing: {
                promptUsdPerToken: 0.001,
                completionUsdPerToken: 0.002,
                cacheReadUsdPerToken: null,
              },
            }),
          ],
        }),
      }),
      expect.any(String),
      'efficient',
      ['["vendor/current",null]']
    );
  });
});

describe('frontier router runs', () => {
  it('snapshots the router and plans only frontier cases without reserving slots', async () => {
    mockConfig({ router: 'frontier', frontier_min_accuracy_delta: 0.1 });
    const entries = [{ model: 'platform/a', variant: null }];
    const result = await startRun(env, 'decider', { router: 'frontier', entries });
    await deliverSchedulerWakes();
    expect(result.runId).toMatch(/^frontier-decider-/);
    expect(insertRun).toHaveBeenCalledWith(
      env.BENCH_DB,
      expect.objectContaining({
        router: 'frontier',
        max_concurrency: 0,
        frontier_min_accuracy_delta: 0,
        engine_identity: expect.stringMatching(/^frontier:v1:/),
      }),
      expect.anything(),
      []
    );
    expect(markProfilesRunningForRun).toHaveBeenCalledWith(
      env.BENCH_DB,
      result.runId,
      entries,
      expect.objectContaining({ router: 'frontier' })
    );
    expect(scheduleRunChunks).toHaveBeenCalledWith(env.BENCH_DB, {
      runId: result.runId,
      entries: [{ model: 'platform/a', variant: null }],
      repetitions: 1,
      caseIds: FRONTIER_CASES.map(benchCase => benchCase.id),
      chunkSize: 1,
    });
    expect(queueSendBatch).not.toHaveBeenCalled();
  });

  it('starts a frontier owner run for an explicit funded request', async () => {
    mockConfig({ router: 'frontier' });
    const entries = [{ model: 'owner/a', variant: null }];
    const result = await startRun(env, 'decider', {
      router: 'frontier',
      purpose: 'user',
      paidRequestId: 'request-1',
      entries,
    });
    expect(result.runId).toMatch(/^frontier-user-/);
    expect(insertRun).toHaveBeenCalledWith(
      env.BENCH_DB,
      expect.objectContaining({ router: 'frontier', purpose: 'user' }),
      expect.anything(),
      []
    );
    expect(markProfilesRunningForRun).toHaveBeenCalledWith(
      env.BENCH_DB,
      result.runId,
      entries,
      expect.objectContaining({ router: 'frontier' })
    );
  });

  it('drains only the frontier platform registry queue', async () => {
    mockConfig({ router: 'frontier' });
    await drainQueues(env, 'both', undefined, 'frontier');
    expect(listPendingCurrentProfiles).toHaveBeenCalledWith(
      env.BENCH_DB,
      expect.objectContaining({ router: 'frontier' }),
      'platform'
    );
    // The frontier user queue is retired with the efficient one.
    expect(listPendingCurrentProfiles).not.toHaveBeenCalledWith(
      env.BENCH_DB,
      expect.anything(),
      'user'
    );
  });

  it('starts a frontier platform run without consulting the efficient lane budgets', async () => {
    vi.mocked(getConfigRows).mockImplementation(async (_db, router = 'efficient') => ({
      config: { ...configRow, router },
      classifierModels: ['classifier/a'],
      deciderModels: [{ model: 'platform/a', variant: null, reasoning_effort: null }],
    }));
    vi.mocked(getLiveContainerLanes).mockResolvedValue(150);

    const result = await startRun(env, 'decider', {
      router: 'frontier',
      entries: [{ model: 'platform/a', variant: null }],
    });

    expect(result.runId).toMatch(/^frontier-decider-/);
    expect(vi.mocked(insertRun).mock.calls[0][1].max_concurrency).toBe(0);
  });

  function mockFrontierPublishInputs() {
    mockConfig({ router: 'frontier', min_accuracy: 0.8, frontier_min_accuracy_delta: 0.1 });
    vi.mocked(servingSubscriptionSnapshot).mockResolvedValue([
      {
        model: 'platform/a',
        pairs: [{ model: 'platform/a', variant: null }],
        servingPairs: [{ model: 'platform/a', variant: null }],
        resolutionError: null,
      },
    ]);
    vi.mocked(listReadyCurrentProfilesForEntries).mockResolvedValue([
      { model: 'platform/a', variant: '', run_id: 'frontier-measured' },
    ]);
    vi.mocked(getSummariesForRuns).mockResolvedValue(
      TAXONOMY_ROUTE_KEYS.map(routeKey => ({
        model: 'platform/a',
        variant: null,
        runId: 'frontier-measured',
        routeKey,
        accuracy: 0.95,
        avgCostUsd: 0.002,
        avgLatencyMs: 100,
        p50LatencyMs: 100,
        p95LatencyMs: 150,
        cases: 10,
        errors: 0,
        timeouts: 0,
        routeAccuracy: null,
        avgInputTokens: null,
        avgCachedInputTokens: null,
        avgOutputTokens: null,
        avgReasoningTokens: null,
      }))
    );
  }

  it('publishes the frontier router threshold from its effective policy values', async () => {
    mockFrontierPublishInputs();
    await publishPlatformRoutingTable(env, catalogFetch, 'frontier');
    // frontierMinAccuracyDelta is fixed at 0, so the stored threshold applies.
    expect(saveRoutingTable).toHaveBeenCalledWith(
      env.BENCH_DB,
      expect.objectContaining({ minAccuracy: 0.8 }),
      expect.any(String),
      'frontier',
      ['["platform/a",null]']
    );
    expect(getLatestRoutingTable).toHaveBeenCalledWith(env.BENCH_DB, 'frontier');
    expect(kvDelete).toHaveBeenCalledWith('routing_table_frontier_v1');
    expect(kvDelete).toHaveBeenCalledWith('benchmark_routing_table_version_v1:frontier');
    expect(kvDelete).not.toHaveBeenCalledWith('routing_table_v1');
    expect(kvDelete).not.toHaveBeenCalledWith('benchmark_routing_table_version_v1:efficient');
  });

  it('flushes the gateway key when the version pointer cannot be written', async () => {
    mockFrontierPublishInputs();
    kvDelete.mockImplementation(async (key: string) => {
      if (key === 'benchmark_routing_table_version_v1:frontier') throw new Error('KV 429');
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(publishPlatformRoutingTable(env, catalogFetch, 'frontier')).resolves.toEqual({
      version: expect.any(String),
    });

    expect(saveRoutingTable).toHaveBeenCalledOnce();
    expect(kvDelete).toHaveBeenCalledWith('benchmark_routing_table_response_v1:frontier');
    expect(kvDelete).toHaveBeenLastCalledWith('routing_table_frontier_v1');
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('routing_table_version_pointer_failed')
    );
    warn.mockRestore();
  });

  it('publishes an admin override in place of the stored threshold', async () => {
    mockConfig({
      min_accuracy: 0.7,
      policy_overrides: { minAccuracy: 0.9 },
      policy_computed: {
        minAccuracy: {
          value: 0.6,
          computedAt: '2026-06-01T00:00:00.000Z',
          source: 'held-out-grid',
          evidence: 'fixture',
        },
      },
    });
    vi.mocked(servingSubscriptionSnapshot).mockResolvedValue([
      {
        model: 'platform/a',
        pairs: [{ model: 'platform/a', variant: null }],
        servingPairs: [{ model: 'platform/a', variant: null }],
        resolutionError: null,
      },
    ]);
    vi.mocked(listReadyCurrentProfilesForEntries).mockResolvedValue([
      { model: 'platform/a', variant: '', run_id: 'efficient-measured' },
    ]);
    vi.mocked(getSummariesForRuns).mockResolvedValue(
      TAXONOMY_ROUTE_KEYS.map(routeKey => ({
        model: 'platform/a',
        variant: null,
        runId: 'efficient-measured',
        routeKey,
        accuracy: 0.95,
        avgCostUsd: 0.002,
        avgLatencyMs: 100,
        p50LatencyMs: 100,
        p95LatencyMs: 150,
        cases: 10,
        errors: 0,
        timeouts: 0,
        routeAccuracy: null,
        avgInputTokens: null,
        avgCachedInputTokens: null,
        avgOutputTokens: null,
        avgReasoningTokens: null,
      }))
    );
    await publishPlatformRoutingTable(env, catalogFetch, 'efficient');
    expect(saveRoutingTable).toHaveBeenCalledWith(
      env.BENCH_DB,
      expect.objectContaining({ minAccuracy: 0.9 }),
      expect.any(String),
      'efficient',
      ['["platform/a",null]']
    );
  });

  it('publishes the daily computed threshold when no override is set', async () => {
    mockConfig({
      min_accuracy: 0.7,
      policy_computed: {
        minAccuracy: {
          value: 0.6,
          computedAt: '2026-06-01T00:00:00.000Z',
          source: 'held-out-grid',
          evidence: 'fixture',
        },
      },
    });
    vi.mocked(servingSubscriptionSnapshot).mockResolvedValue([
      {
        model: 'platform/a',
        pairs: [{ model: 'platform/a', variant: null }],
        servingPairs: [{ model: 'platform/a', variant: null }],
        resolutionError: null,
      },
    ]);
    vi.mocked(listReadyCurrentProfilesForEntries).mockResolvedValue([
      { model: 'platform/a', variant: '', run_id: 'efficient-measured' },
    ]);
    vi.mocked(getSummariesForRuns).mockResolvedValue(
      TAXONOMY_ROUTE_KEYS.map(routeKey => ({
        model: 'platform/a',
        variant: null,
        runId: 'efficient-measured',
        routeKey,
        accuracy: 0.95,
        avgCostUsd: 0.002,
        avgLatencyMs: 100,
        p50LatencyMs: 100,
        p95LatencyMs: 150,
        cases: 10,
        errors: 0,
        timeouts: 0,
        routeAccuracy: null,
        avgInputTokens: null,
        avgCachedInputTokens: null,
        avgOutputTokens: null,
        avgReasoningTokens: null,
      }))
    );
    await publishPlatformRoutingTable(env, catalogFetch, 'efficient');
    expect(saveRoutingTable).toHaveBeenCalledWith(
      env.BENCH_DB,
      expect.objectContaining({ minAccuracy: 0.6 }),
      expect.any(String),
      'efficient',
      ['["platform/a",null]']
    );
  });
});

describe('run insert failures', () => {
  it('releases registry claims and preserves the database error when inserting a run fails', async () => {
    mockConfig({ router: 'frontier' });
    const error = new Error('D1 write unavailable');
    vi.mocked(insertRun).mockRejectedValue(error);
    await expect(
      startRun(env, 'decider', {
        router: 'frontier',
        entries: [{ model: 'platform/a', variant: null }],
      })
    ).rejects.toBe(error);
    expect(releaseProfileClaims).toHaveBeenCalledWith(
      env.BENCH_DB,
      expect.stringMatching(/^frontier-/)
    );
    expect(scheduleRunChunks).not.toHaveBeenCalled();
    expect(queueSend).not.toHaveBeenCalled();
  });

  it('propagates registry run insert failures rather than hiding them as capacity waits', async () => {
    vi.mocked(insertRun).mockRejectedValue(new Error('D1 write unavailable'));
    vi.mocked(listPendingCurrentProfiles).mockResolvedValue([
      { model: 'm/1', variant: '', requested_at: '2026-06-01T00:00:00.000Z' },
    ]);
    await expect(drainQueue(env, 'platform')).rejects.toThrow('D1 write unavailable');
    expect(releaseProfileClaims).toHaveBeenCalled();
    expect(scheduleRunChunks).not.toHaveBeenCalled();
  });
});

it('reuses prior cases in the initialization pass before delegating the complete chunk plan', async () => {
  vi.mocked(reuseDeciderCaseResults).mockResolvedValue(4);
  const result = await startRun(env, 'decider', {
    entries: [{ model: 'platform/a', variant: null }],
  });
  expect(reuseDeciderCaseResults).not.toHaveBeenCalled();
  await deliverSchedulerWakes();
  expect(reuseDeciderCaseResults).toHaveBeenCalledWith(
    env.BENCH_DB,
    expect.objectContaining({
      runId: result.runId,
      entries: [{ model: 'platform/a', variant: null }],
    })
  );
  expect(vi.mocked(reuseDeciderCaseResults).mock.invocationCallOrder[0]).toBeLessThan(
    vi.mocked(scheduleRunChunks).mock.invocationCallOrder[0]
  );
  expect(scheduleRunChunks).toHaveBeenCalledWith(env.BENCH_DB, {
    runId: result.runId,
    entries: [{ model: 'platform/a', variant: null }],
    repetitions: 3,
    caseIds: CURRENT_EFFICIENT_CASE_IDS,
    chunkSize: 1,
  });
  expect(queueSendBatch).not.toHaveBeenCalled();
});

it('keeps a started run for the next initialization pass when its chunk plan fails', async () => {
  vi.mocked(reuseDeciderCaseResults).mockResolvedValue(1);
  vi.mocked(scheduleRunChunks).mockRejectedValueOnce(new Error('D1 read unavailable'));
  const result = await startRun(env, 'decider', {
    entries: [{ model: 'platform/a', variant: null }],
  });
  await deliverSchedulerWakes();
  expect(scheduleRunChunks).toHaveBeenCalledOnce();
  expect(markRunFailed).not.toHaveBeenCalled();
  expect(markProfilesFailedForRun).not.toHaveBeenCalled();
  await deliverSchedulerWakes();
  expect(scheduleRunChunks).toHaveBeenCalledTimes(2);
  expect(scheduleRunChunks).toHaveBeenLastCalledWith(
    env.BENCH_DB,
    expect.objectContaining({ runId: result.runId })
  );
  expect(queueSendBatch).not.toHaveBeenCalled();
});

it('dispatches every claim of one scheduler pass and stops when a pass claims nothing', async () => {
  const claim = {
    id: 'claim-1',
    run_id: 'decider-existing',
    model: 'platform/a',
    variant: 'high',
    rep: 2,
    chunk: 10,
    case_ids: JSON.stringify([DECIDER_CASES[10].id]),
    slot: 1,
    token: 'claim-token',
    attempts: 1,
    throttle_deferrals: 0,
    catalog_deferrals: 0,
  };
  vi.mocked(claimScheduledChunks)
    .mockResolvedValueOnce([claim, { ...claim, id: 'claim-2', token: 'claim-token-2' }])
    .mockResolvedValue([]);
  const result = await startRun({ ...env, BENCHMARK_SCHEDULER_CONFIG: '{"slots":2}' }, 'decider', {
    entries: [{ model: 'platform/a', variant: 'high' }],
  });
  expect(result.enqueuedModels).toBe(1);
  await deliverSchedulerWakes({ ...env, BENCHMARK_SCHEDULER_CONFIG: '{"slots":2}' });
  expect(recoverChunks).toHaveBeenCalledWith(env.BENCH_DB, expect.any(Number));
  // The pass claims once, then once more after it finished initializing the new run.
  expect(claimScheduledChunks).toHaveBeenCalledTimes(2);
  expect(claimScheduledChunks).toHaveBeenCalledWith(
    env.BENCH_DB,
    expect.objectContaining({ slots: 2 }),
    expect.any(Number),
    expect.any(String)
  );
  expect(queueSend).toHaveBeenCalledTimes(3);
  expect(queueSend).toHaveBeenCalledWith({
    runId: 'decider-existing',
    kind: 'decider',
    model: 'platform/a',
    claimId: 'claim-1',
    claimToken: 'claim-token',
  });
  expect(queueSendBatch).not.toHaveBeenCalled();
});
