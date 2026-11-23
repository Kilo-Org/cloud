import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TAXONOMY_ROUTE_KEYS, benchmarkPairKey } from '@kilocode/auto-routing-contracts';
import type * as CliRunnerModule from './cli-runner';
import type * as DbModule from './db';
import type * as PaidStoreModule from './paid-case-store';
import { DECIDER_CASES } from './datasets/decider-cases';
import { CLASSIFIER_CASES } from './datasets/classifier-cases';
import type * as ConfigModule from './config';

import type * as SchedulerModule from './scheduler';
import type * as SubscriptionsModule from './subscriptions';
import type * as EligibilityModule from './probe/eligibility';

vi.mock('./subscriptions', () => ({
  PLATFORM_SUBSCRIPTION_OWNER: { ownerType: 'platform', ownerId: '' },
  snapshotPairs: (snapshot: SubscriptionsModule.SubscriptionSnapshot, serving = false) => [
    ...new Map(
      snapshot
        .flatMap(entry => (serving ? entry.servingPairs : entry.pairs))
        .map(pair => [benchmarkPairKey(pair), pair])
    ).values(),
  ],
  syncSubscriptionSnapshot: vi.fn(),
  servingSubscriptionSnapshot: vi.fn(),
}));

vi.mock('./scheduler', async importOriginal => {
  const actual = await importOriginal<typeof SchedulerModule>();
  return {
    ...actual,
    getPaidCasePromptRevision: vi.fn(),
    claimScheduledChunks: vi.fn(),
    clearUnbilledCase: vi.fn(),
    cooldownCatalog: vi.fn(),
    cooldownModel: vi.fn(),
    deferCatalogChunk: vi.fn(),
    deferChunk: vi.fn(),
    deferThrottledChunk: vi.fn(),
    failChunk: vi.fn(),
    failScheduledEntry: vi.fn(),
    // The terminal-lane and paid-link writes are prepared and committed as ONE batch, so the
    // builders are the seam a test can see.

    finishChunk: vi.fn(),
    getChunk: vi.fn(),
    getPaidCaseStartedAt: vi.fn(),
    hasUnsettledChunks: vi.fn(),
    recoverChunks: vi.fn(),
    restartPaidCase: vi.fn(),
    scheduleRunChunks: vi.fn(),
    startChunk: vi.fn(),
  };
});
vi.mock('./decider-judge', () => ({ createDeciderJudge: vi.fn() }));
vi.mock('./probe/executor', () => ({
  BenchmarkProbeFamilyError: class BenchmarkProbeFamilyError extends Error {},
  runCancellableProbeCase: vi.fn(),
}));
vi.mock('./openrouter', () => ({ createSystemOneClient: vi.fn() }));

// These suites publish a fully measured pool; the ineligible branch is covered by
// `src/probe/eligibility.test.ts` and `src/probe/publish.test.ts`.
const missingProbeResults = vi.hoisted(() =>
  vi.fn<(db: unknown, params: unknown) => Promise<Set<string>>>(async () => new Set<string>())
);
vi.mock('./probe/eligibility', async importOriginal => ({
  ...(await importOriginal<typeof EligibilityModule>()),
  pairsMissingProbeResults: missingProbeResults,
}));
vi.mock('./config', async importOriginal => {
  const actual = await importOriginal<typeof ConfigModule>();
  return { ...actual, getBenchmarkConfig: vi.fn() };
});

vi.mock('./paid-case-store', async importOriginal => {
  const actual = await importOriginal<typeof PaidStoreModule>();
  return {
    ...actual,
    claimPaidCaseStatements: vi.fn(),
    readPaidCaseRun: vi.fn(),
    readPaidBenchmarkRequest: vi.fn(),
    // The unbilled-infrastructure paths release through the real statement builder plus the
    // atomic batch in `db.ts`, so this one stays real (spied, not stubbed).
    releasePaidCaseGenerationStatements: vi.fn(actual.releasePaidCaseGenerationStatements),
    cancelPaidCaseStatements: vi.fn(() => []),
    completePaidBenchmarkRequestStatements: vi.fn(() => []),
    queuePaidCancellationIntentStatements: vi.fn(() => []),
    platformCoverageStatements: vi.fn(() => []),
  };
});
vi.mock('./db', async importOriginal => {
  const actual = await importOriginal<typeof DbModule>();
  return {
    ...actual,
    countCaseResultsByLane: vi.fn(),

    readBenchmarkCutover: vi.fn(),
    readOwnedCaseGeneration: vi.fn(async () => null),
    copyRemeasureBaselines: vi.fn(),
    reuseDeciderCaseResults: vi.fn(),
    listLaneFailures: vi.fn(),
    recordLaneFailure: vi.fn(),
    existsNewerCompletedRun: vi.fn(),
    getCaseResults: vi.fn(),
    getExistingCaseResultIds: vi.fn(),
    getPendingDeciderOutput: vi.fn(),
    claimDeciderGrading: vi.fn(),
    releaseDeciderGrading: vi.fn(),
    deletePendingDeciderOutput: vi.fn(),
    needsPendingOutputRecovery: vi.fn(),
    listPendingOutputRecoveries: vi.fn(),
    savePendingDeciderOutput: vi.fn(),
    getRunWithModels: vi.fn(),
    getSummaries: vi.fn(),
    syncPlatformRegistryRows: vi.fn(),
    getLatestRoutingTable: vi.fn(),
    countCurrentProfilesByStatus: vi.fn(),
    listCurrentPlatformProfileStatuses: vi.fn(),
    getSummariesForRuns: vi.fn(),
    getRoutingCaseResultsForEntries: vi.fn().mockResolvedValue([]),
    listReadyCurrentProfilesForEntries: vi.fn(),
    markRunCompleted: vi.fn(),
    markRunFailed: vi.fn(),
    releaseProfileClaims: vi.fn(),
    replaceModelSummaries: vi.fn(),
    saveRoutingTable: vi.fn(),
    upsertCaseResult: vi.fn(),
    listPendingCurrentProfiles: vi.fn(),
    listQueuedRemeasures: vi.fn().mockResolvedValue([]),
    settleRemeasuresForRun: vi.fn().mockResolvedValue('published'),
    listStaleRunningDeciderRuns: vi.fn(),
    markProfilesFailedForRun: vi.fn(),
    markProfilesFailedForEntries: vi.fn(),
    markProfilesReadyForRun: vi.fn(),
    markProfilesRunningForRun: vi.fn(),
    markStaleRunsFailed: vi.fn(),
    getQueueRunOccupancy: vi.fn(),
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
import { claimPaidCaseStatements, readPaidCaseRun } from './paid-case-store';
import {
  countCaseResultsByLane,
  readBenchmarkCutover,
  readOwnedCaseGeneration,
  getCaseResults,
  getSummaries,
  existsNewerCompletedRun,
  getExistingCaseResultIds,
  getPendingDeciderOutput,
  claimDeciderGrading,
  releaseDeciderGrading,
  deletePendingDeciderOutput,
  needsPendingOutputRecovery,
  listPendingOutputRecoveries,
  savePendingDeciderOutput,
  type StoredDeciderOutput,
  getRunWithModels,
  getLiveContainerLanes,
  listPendingCurrentProfiles,
  getQueueRunOccupancy,
  syncPlatformRegistryRows,
  getLatestRoutingTable,
  countCurrentProfilesByStatus,
  listCurrentPlatformProfileStatuses,
  getSummariesForRuns,
  listReadyCurrentProfilesForEntries,
  listLaneFailures,
  listStaleRunningDeciderRuns,
  markRunCompleted,
  markRunFailed,
  releaseProfileClaims,
  markProfilesFailedForEntries,
  recordLaneFailure,
  saveRoutingTable,
  upsertCaseResult,
} from './db';
import { getBenchmarkConfig } from './config';
import { DatabaseSync } from 'node:sqlite';
import { applyBenchmarkMigrations, sqliteD1 } from '../test/sqlite-d1';
import { pauseUnfundedPaidRequests } from './paid-benchmark';
import { servingSubscriptionSnapshot, syncSubscriptionSnapshot } from './subscriptions';
import {
  processJob,
  acceptContainerCaseResult,
  computeEngineIdentity,
  publishPlatformRoutingTable,
  PAID_OUTPUT_WAIT_MS,
} from './run';
import { createDeciderJudge } from './decider-judge';
import { createSystemOneClient } from './openrouter';
import type { DeciderJudge } from './grading';
import { deciderCasesForRouter, MEASUREMENT_REVISION } from './measurement-revision';
import { isProbeCase } from './datasets/probe-cases';
import { runCancellableProbeCase } from './probe/executor';
import {
  getPaidCasePromptRevision,
  claimScheduledChunks,
  clearUnbilledCase,
  cooldownCatalog,
  cooldownModel,
  deferCatalogChunk,
  deferChunk,
  deferThrottledChunk,
  failChunk,
  finishChunk,
  failScheduledEntry,
  getChunk,
  getPaidCaseStartedAt,
  hasUnsettledChunks,
  recoverChunks,
  restartPaidCase,
  scheduleRunChunks,
  startChunk,
  SCHEDULER_MAX_ATTEMPTS,
  SCHEDULER_MAX_CATALOG_DEFERRALS,
  SCHEDULER_MAX_THROTTLE_DEFERRALS,
  type SchedulerClaim,
} from './scheduler';

const tokenGet = vi.fn<() => Promise<string>>();
const queueSendBatch = vi.fn<(messages: unknown[]) => Promise<void>>();
const queueSend = vi.fn();
const schedulerFirst = vi.fn();
const schedulerAll = vi.fn();
const schedulerRun = vi.fn();
type FakeStatement = {
  sql: string;
  params: unknown[];
  first: typeof schedulerFirst;
  all: typeof schedulerAll;
  run: typeof schedulerRun;
  bind: (...values: unknown[]) => FakeStatement;
};
// The batch fixture has to tell a paid-generation grant apart from a retry restart, so
// each prepared statement keeps the SQL and bound values the caller used.
const schedulerPrepare = vi.fn((sql: string): FakeStatement => {
  const statement: FakeStatement = {
    sql,
    params: [],
    // The SQL is the only way a caller's `first` can be told apart, so the shared mock sees it.
    first: ((...args: unknown[]) => schedulerFirst(sql, ...args)) as typeof schedulerFirst,
    all: schedulerAll,
    run: schedulerRun,
    bind: (...values: unknown[]) => {
      statement.params = values;
      return statement;
    },
  };
  return statement;
});
const dbBatch = vi.fn();
const kvDelete = vi.fn();
const model = 'qwen/qwen3-coder-next';
const runId = 'decider-test-run';
const [benchCase] = DECIDER_CASES;

/**
 * The durable side of the paid fence these fixtures model, keyed by the case slot.
 *
 * `beginPaidCaseGeneration` opens a case run and its `scheduler_executions` ledger row in
 * one batch and then demands that the ledger's start be the `now` it just used: that is how
 * it tells "this invocation owns the generation" from "an earlier attempt is still in
 * flight". Every slot has its own ledger row, so this fixture keys by the same fields
 * `getPaidCaseStartedAt` reads and records the start of each claim that actually ran.
 */
const caseStartedAt = new Map<string, number>();
/** Whether the next claim actually wins the case fence (a lost fence writes nothing). */
let fixtureGrant = true;
/**
 * Whether a retry may move this generation's ledger start. A real ledger update is guarded
 * by the chunk lease and the live run, so it can report zero changes and the retry must not
 * spend; the fixture models that refusal.
 */
let fixtureRetryRestart = true;
const LEDGER_INSERT_SQL = 'INSERT INTO scheduler_executions';
const LEDGER_RESTART_SQL = 'UPDATE scheduler_executions SET started_at';
const CASE_RUN_RESTART_SQL = 'UPDATE benchmark_case_runs SET started_at';

function caseSlotKey(key: {
  runId: string;
  model: string;
  variant: string;
  rep: number;
  caseId: string;
}): string {
  return JSON.stringify([key.runId, key.model, key.variant, key.rep, key.caseId]);
}

/**
 * Real production migrations in an in-memory SQLite. The paid controller's tests observe the
 * rows it writes, so they must run against the schema that ships rather than a fixture copy.
 */
function openPaidSchema(): { sqlite: DatabaseSync; close: () => void } {
  const sqlite = new DatabaseSync(':memory:');
  applyBenchmarkMigrations(sqlite);
  return { sqlite, close: () => sqlite.close() };
}

const successfulCliResult = {
  text: 'not the expected answer',
  costUsd: null,
  inputTokens: null,
  cachedInputTokens: null,
  outputTokens: null,
  reasoningTokens: null,
  latencyMs: 25,
  exitCode: 0,
  stderrTail: '',
  eventCount: 1,
  lastEventTypes: ['session.created'],
  tools: { calls: 0, names: [], steps: 1, finalFinishReason: 'stop' },
  timedOut: false,
} satisfies CliRunResult;

const env = {
  INTERNAL_API_SECRET_PROD: { get: tokenGet },
  BOT_TOKEN_MINT_SECRET: { get: async () => 'mint-secret' },
  KILO_CLI_API_URL: 'http://host.docker.internal:3000',
  KILO_WEB_API_BASE_URL: 'http://host.docker.internal:3000',
  BENCH_RESULT_URL: 'https://bench.test/container/case-result',
  BENCH_DB: { prepare: schedulerPrepare, batch: dbBatch } as unknown as D1Database,
  BENCH_QUEUE: { send: queueSend, sendBatch: queueSendBatch },
  BENCHMARK_SCHEDULER_CONFIG: '{}',
  AUTO_ROUTING_CONFIG: { delete: kvDelete, put: vi.fn() },
} as unknown as Env;

/** The scheduler fixtures run as a live case generation under the chunk's own token. */
function paidCaseRunRow() {
  return {
    engine_identity: 'engine-test',
    model,
    variant: '',
    rep: 0,
    case_id: benchCase.id,
    status: 'running' as const,
    generation: 1,
    executor_run_id: runId,
    executor_token: 'token-1',
    platform_covered: 1,
    result_usable: 0,
    cost_microdollars: null,
    settlement_id: null,
    failure_reason: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    started_at: new Date().toISOString(),
    settled_at: null,
  };
}
function mockClaim(overrides: Partial<SchedulerClaim> = {}): SchedulerClaim {
  const claim = {
    id: 'chunk-1',
    token: 'token-1',
    run_id: runId,
    model,
    variant: '',
    rep: 0,
    chunk: 0,
    case_ids: JSON.stringify([benchCase.id]),
    slot: 7,
    attempts: 1,
    throttle_deferrals: 0,
    catalog_deferrals: 0,
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
  }> = [{ model, variant: '', enqueued: true, reasoning_effort: null }],
  measurementRevision: number = MEASUREMENT_REVISION
): void {
  vi.mocked(getRunWithModels).mockResolvedValue({
    run: {
      router: 'efficient',
      engine_identity: computeEngineIdentity('decider', 'efficient'),
      measurement_revision: measurementRevision,
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
      // Only a run the paid-flow Worker admitted may measure or migrate.
      admission_marker: '2026-06-16T00:00:00.000Z',
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

beforeEach(async () => {
  vi.clearAllMocks();
  // The cutover predates the fixture run, so its claims are post-cutover work.
  vi.mocked(readBenchmarkCutover).mockResolvedValue('2026-01-01T00:00:00.000Z');
  // `processScheduledChunk` re-checks the cutover AND that this run was admitted by the paid
  // flow (a NULL marker is an older image's run and is fenced). The fixture run is admitted.
  schedulerFirst.mockImplementation(async (sql?: string) =>
    typeof sql === 'string' && sql.includes('admission_marker')
      ? { admission_marker: 'paid' }
      : null
  );
  schedulerAll.mockResolvedValue({ results: [] });
  schedulerRun.mockResolvedValue({ meta: { changes: 0 } });
  queueSend.mockResolvedValue(undefined);
  vi.mocked(startChunk).mockResolvedValue(true);
  vi.mocked(restartPaidCase).mockResolvedValue(true);
  vi.mocked(getPaidCaseStartedAt).mockResolvedValue(null);
  vi.mocked(getPaidCasePromptRevision).mockResolvedValue(2);
  vi.mocked(claimScheduledChunks).mockResolvedValue([]);
  vi.mocked(recoverChunks).mockResolvedValue([]);
  vi.mocked(hasUnsettledChunks).mockResolvedValue(false);
  mockClaim();
  vi.mocked(getBenchmarkConfig).mockResolvedValue({
    router: 'efficient',
    accuracyNoiseBand: 0.05,
    classifierModels: ['classifier/a'],
    deciderModels: [{ id: model }],
    minAccuracy: 0.7,
    benchmarkUserId: 'bot-internal-user-1',
    benchmarkOrgId: null,
    productionTokenProfile: null,
    switchHorizonTurns: null,
    updatedAt: null,
    updatedBy: null,
  });
  const snapshot = [
    {
      model,
      pairs: [{ model, variant: 'max' }],
      servingPairs: [{ model, variant: 'max' }],
      resolutionError: null,
    },
  ];
  vi.mocked(syncSubscriptionSnapshot).mockResolvedValue(snapshot);
  vi.mocked(servingSubscriptionSnapshot).mockResolvedValue(snapshot);
  vi.mocked(listCurrentPlatformProfileStatuses).mockResolvedValue([
    { model, variant: 'max', status: 'ready', completed_at: null },
  ]);
  vi.mocked(listReadyCurrentProfilesForEntries).mockResolvedValue([]);
  vi.mocked(getSummariesForRuns).mockResolvedValue([]);
  vi.mocked(countCurrentProfilesByStatus).mockResolvedValue([]);
  vi.mocked(getLatestRoutingTable).mockResolvedValue(null);
  vi.mocked(syncPlatformRegistryRows).mockResolvedValue(undefined);
  vi.mocked(listStaleRunningDeciderRuns).mockResolvedValue([]);
  vi.mocked(listPendingCurrentProfiles).mockResolvedValue([]);
  vi.mocked(getQueueRunOccupancy).mockResolvedValue({ activeRuns: 0, startingRunId: null });
  vi.mocked(getLiveContainerLanes).mockResolvedValue(0);
  tokenGet.mockResolvedValue('internal-secret');
  queueSendBatch.mockResolvedValue(undefined);
  vi.stubGlobal(
    'fetch',
    vi.fn(async url =>
      String(url).endsWith('/models')
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
  vi.mocked(markProfilesFailedForEntries).mockResolvedValue(undefined);
  vi.mocked(failScheduledEntry).mockResolvedValue(undefined);
  vi.mocked(getExistingCaseResultIds).mockResolvedValue(new Set());
  vi.mocked(getPendingDeciderOutput).mockResolvedValue(null);
  vi.mocked(claimDeciderGrading).mockResolvedValue(true);
  vi.mocked(releaseDeciderGrading).mockResolvedValue(undefined);
  vi.mocked(deletePendingDeciderOutput).mockResolvedValue(undefined);
  vi.mocked(needsPendingOutputRecovery).mockResolvedValue(false);
  vi.mocked(listPendingOutputRecoveries).mockResolvedValue([]);
  vi.mocked(savePendingDeciderOutput).mockResolvedValue(true);
  vi.mocked(createSystemOneClient).mockResolvedValue({ apiKey: 'test', attributionHeaders: {} });
  vi.mocked(createDeciderJudge).mockReturnValue(async () => ({ probability: 0.8, costUsd: 0.001 }));
  vi.mocked(destroyDeciderCliContainer).mockResolvedValue(undefined);
  vi.mocked(warmUpCliContainer).mockResolvedValue(undefined);
  // The dead-lane fencing helper is a spy per test; a rejection injected by one test must
  // never leak into the next.

  vi.mocked(runDeciderCaseViaCli).mockResolvedValue(successfulCliResult);
  // These fixtures are platform runs, so admission needs no paid request. The claim batch is
  // the real shape: [fence insert, fence update, ledger insert, trailing row select]. The
  // ledger insert writes the start `beginPaidCaseGeneration` then reads back to prove this
  // invocation owns the generation, so the fixture derives it from the claim's own `now`
  // rather than from a canned batch index.
  vi.mocked(readPaidCaseRun).mockResolvedValue(paidCaseRunRow());
  vi.mocked(readOwnedCaseGeneration).mockResolvedValue({
    runId,
    token: 'token-1',
    generation: 1,
  });
  vi.mocked(claimPaidCaseStatements).mockImplementation(() => [
    schedulerPrepare('INSERT INTO benchmark_case_runs (engine_identity) VALUES (?)') as never,
    schedulerPrepare('UPDATE benchmark_case_runs SET status = ? WHERE rep = ?') as never,
    schedulerPrepare(LEDGER_INSERT_SQL) as never,
    schedulerPrepare('SELECT * FROM benchmark_case_runs WHERE rep = ?') as never,
  ]);
  caseStartedAt.clear();
  fixtureGrant = true;
  fixtureRetryRestart = true;
  vi.mocked(getPaidCaseStartedAt).mockImplementation(
    async (_db, key) => caseStartedAt.get(caseSlotKey(key)) ?? null
  );
  vi.mocked(clearUnbilledCase).mockImplementation(async (_db, key) => {
    caseStartedAt.delete(caseSlotKey(key));
  });
  vi.mocked(markRunFailed).mockResolvedValue(undefined);
  vi.mocked(releaseProfileClaims).mockResolvedValue(undefined);
  // `upsertCaseResult` returns one D1 result per statement it batched (the graded row, the
  // pending-output delete, and the settlement statements). The late-result check reads the
  // settlement's own result, so the fixture reports each as applied.
  vi.mocked(upsertCaseResult).mockResolvedValue(
    Array.from({ length: 3 }, () => ({
      results: [],
      success: true,
      meta: { changes: 1 },
    })) as never
  );
  dbBatch.mockImplementation(async (statements: FakeStatement[]) => {
    const claim = vi.mocked(claimPaidCaseStatements).mock.calls.at(-1)?.[1];
    const results = statements.map(statement => {
      const sql = statement.sql.trim();
      if (sql.startsWith(LEDGER_INSERT_SQL)) {
        // The claim batch opened this slot's ledger row at the start it was handed.
        if (claim && typeof claim.now === 'number') {
          caseStartedAt.set(caseSlotKey({ ...claim.key, runId: claim.executor.runId }), claim.now);
        }
        return { results: [], success: true, meta: { changes: 1 } };
      }
      if (sql.startsWith(LEDGER_RESTART_SQL)) {
        // A retry moves the same generation's ledger start to its new paid call. The
        // bound values are the new start followed by the execution key.
        const [restartedAt, runId, model, variant, rep, caseId] = statement.params;
        if (!fixtureRetryRestart) {
          return { results: [], success: true, meta: { changes: 0 } };
        }
        if (typeof restartedAt === 'number') {
          caseStartedAt.set(
            caseSlotKey({
              runId: String(runId),
              model: String(model),
              variant: String(variant),
              rep: Number(rep),
              caseId: String(caseId),
            }),
            restartedAt
          );
        }
        return { results: [], success: true, meta: { changes: 1 } };
      }
      if (sql.startsWith(CASE_RUN_RESTART_SQL)) {
        return { results: [], success: true, meta: { changes: 1 } };
      }
      if (
        sql.replace(/\s+/g, ' ').includes("SET status = 'queued', executor_run_id = NULL") &&
        sql.includes('benchmark_case_runs')
      ) {
        // The unbilled-release batch: release writes `queued`, then the ledger and
        // pending-output deletes are gated on that post-state, so they match too. Only the
        // release's own result decides `released` vs `quarantined`, and the fixture grants it.
        return { results: [], success: true, meta: { changes: 1 } };
      }
      if (sql.startsWith('DELETE FROM scheduler_executions')) {
        // The release batch's ledger delete: `run_id, model, variant, rep, case_id, token`
        // come first, so the slot has no paid attempt any more.
        const [runIdDeleted, modelDeleted, variantDeleted, repDeleted, caseIdDeleted] =
          statement.params;
        caseStartedAt.delete(
          caseSlotKey({
            runId: String(runIdDeleted),
            model: String(modelDeleted),
            variant: String(variantDeleted),
            rep: Number(repDeleted),
            caseId: String(caseIdDeleted),
          })
        );
        return { results: [], success: true, meta: { changes: 1 } };
      }
      if (sql.startsWith('SELECT * FROM benchmark_case_runs')) {
        return { results: [paidCaseRunRow()], success: true, meta: { changes: 0 } };
      }
      if (sql.startsWith('INSERT INTO benchmark_case_runs')) {
        return { results: [], success: true, meta: { changes: 1 } };
      }
      return { results: [], success: true, meta: { changes: 0 } };
    });
    // A claim that loses the fence writes nothing: every statement reports no change.
    return fixtureGrant
      ? results
      : results.map(() => ({ results: [], success: true, meta: { changes: 0 } }));
  });
});

/**
 * True when the run released this slot's unbilled generation: either the atomic release
 * batch reached D1, or — when no canonical generation was ever granted — the legacy
 * `clearUnbilledCase` fallback ran. Both mean "the attempt's claim is gone".
 */
function releasedUnbilledGeneration(): boolean {
  if (vi.mocked(clearUnbilledCase).mock.calls.length > 0) return true;
  return vi
    .mocked(dbBatch)
    .mock.calls.some(([statements]) =>
      (statements as FakeStatement[]).some(statement =>
        statement.sql.replace(/\s+/g, ' ').includes("SET status = 'queued', executor_run_id = NULL")
      )
    );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('processJob — scheduler-owned execution', () => {
  it('mints the CLI token as the run bot user and org with the dedicated mint secret', async () => {
    mockClaim();

    await processJob(env, deciderMessage());

    const mintCalls = vi
      .mocked(fetch)
      .mock.calls.filter(([url]) => (url as URL).href.includes('/api/internal/bot-token'));
    expect(mintCalls).toHaveLength(1);
    const [url, init] = mintCalls[0]!;
    expect((url as URL).href).toBe(`${env.KILO_WEB_API_BASE_URL}/api/internal/bot-token`);
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer mint-secret');
    expect(JSON.parse(init?.body as string)).toEqual({
      userId: 'benchmark-user',
      organizationId: 'benchmark-org',
    });
  });

  it('does not mint a token for a run without an org snapshot', async () => {
    const snapshot = await getRunWithModels(env.BENCH_DB, runId);
    if (!snapshot) throw new Error('Run snapshot missing');
    vi.mocked(getRunWithModels).mockResolvedValue({
      ...snapshot,
      run: { ...snapshot.run, benchmark_org_id: null },
    });
    mockClaim();

    await processJob(env, deciderMessage());
    expect(
      vi.mocked(fetch).mock.calls.some(([u]) => (u as URL).href.includes('/api/internal/bot-token'))
    ).toBe(false);
  });

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
          execution: expect.objectContaining({
            runId,
            model,
            variant: 'low',
            rep: 2,
            caseId: benchCase.id,
            token: 'token-1',
            attemptStartedAt: expect.any(Number),
          }),
        },
      })
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
      }),
      expect.anything()
    );
    expect(finishChunk).toHaveBeenCalledWith(env.BENCH_DB, 'chunk-1', 'token-1');
    expect(claimScheduledChunks).toHaveBeenCalled();
    expect(queueSendBatch).not.toHaveBeenCalled();
    expect(destroyDeciderCliContainer).not.toHaveBeenCalled();
  });

  it('carries token usage through pending output and the recorded case result', async () => {
    const result = {
      ...successfulCliResult,
      inputTokens: 12,
      cachedInputTokens: 24,
      outputTokens: 36,
      reasoningTokens: 48,
    };
    vi.mocked(runDeciderCaseViaCli).mockResolvedValueOnce(result);

    await processJob(env, deciderMessage());

    expect(savePendingDeciderOutput).toHaveBeenCalledWith(
      env.BENCH_DB,
      expect.any(Object),
      expect.objectContaining({ result })
    );
    expect(upsertCaseResult).toHaveBeenCalledWith(
      env.BENCH_DB,
      expect.objectContaining({
        input_tokens: 12,
        cached_input_tokens: 24,
        output_tokens: 36,
        reasoning_tokens: 48,
      }),
      expect.anything()
    );
  });

  describe('tool-required cases', () => {
    // Only `supp-agent-term-pwd-base` still requires a tool call at revision 3.
    const pwdBaseCase = deciderCasesForRouter('efficient', MEASUREMENT_REVISION).find(
      candidate => candidate.id === 'supp-agent-term-pwd-base'
    );
    if (!pwdBaseCase) throw new Error('dataset lacks supp-agent-term-pwd-base');

    it('scores a correct answer 0 when the turn narrated and stopped without a tool call', async () => {
      mockClaim({ case_ids: JSON.stringify([pwdBaseCase.id]) });
      vi.mocked(runDeciderCaseViaCli).mockResolvedValueOnce({
        ...successfulCliResult,
        text: 'other',
        tools: { calls: 0, names: [], steps: 1, finalFinishReason: 'stop' },
      });

      await processJob(env, deciderMessage());

      expect(upsertCaseResult).toHaveBeenCalledWith(
        env.BENCH_DB,
        expect.objectContaining({
          case_id: pwdBaseCase.id,
          score: 0,
          tool_calls: 0,
          tool_names: '[]',
          step_count: 1,
          final_finish_reason: 'stop',
          prompt_revision: MEASUREMENT_REVISION,
        }),
        expect.anything()
      );
    });

    it('grades the answer once the run made the required tool call', async () => {
      mockClaim({ case_ids: JSON.stringify([pwdBaseCase.id]) });
      vi.mocked(runDeciderCaseViaCli).mockResolvedValueOnce({
        ...successfulCliResult,
        text: 'other',
        tools: { calls: 1, names: ['bash'], steps: 2, finalFinishReason: 'stop' },
      });

      await processJob(env, deciderMessage());

      expect(upsertCaseResult).toHaveBeenCalledWith(
        env.BENCH_DB,
        expect.objectContaining({ case_id: pwdBaseCase.id, score: 1, tool_names: '["bash"]' }),
        expect.anything()
      );
    });

    it('keeps revision-2 grading for a run that started before revision 3', async () => {
      mockRunSnapshot(undefined, 2);
      mockClaim({ case_ids: JSON.stringify([pwdBaseCase.id]) });
      vi.mocked(runDeciderCaseViaCli).mockResolvedValueOnce({
        ...successfulCliResult,
        text: 'other',
      });

      await processJob(env, deciderMessage());

      expect(upsertCaseResult).toHaveBeenCalledWith(
        env.BENCH_DB,
        expect.objectContaining({ case_id: pwdBaseCase.id, score: 1, prompt_revision: 2 }),
        expect.anything()
      );
    });
  });

  describe('probe cases', () => {
    const probeCase = deciderCasesForRouter('efficient', MEASUREMENT_REVISION).find(candidate =>
      isProbeCase(candidate)
    );
    if (!probeCase) throw new Error('dataset lacks probe cases');

    it('sends the probe through the gateway without the container and scores a tool call as continuing', async () => {
      mockClaim({ case_ids: JSON.stringify([probeCase.id]) });
      vi.mocked(runCancellableProbeCase).mockResolvedValueOnce({
        ...successfulCliResult,
        text: '',
        costUsd: 0.0011,
        tools: { calls: 1, names: ['bash'], steps: 1, finalFinishReason: 'tool-calls' },
      });

      await processJob(env, deciderMessage());

      expect(runCancellableProbeCase).toHaveBeenCalledTimes(1);
      expect(runDeciderCaseViaCli).not.toHaveBeenCalled();
      expect(warmUpCliContainer).not.toHaveBeenCalled();
      expect(upsertCaseResult).toHaveBeenCalledWith(
        env.BENCH_DB,
        expect.objectContaining({
          case_id: probeCase.id,
          score: 1,
          cost_usd: 0.0011,
          tool_calls: 1,
          tool_names: '["bash"]',
          final_finish_reason: 'tool-calls',
          prompt_revision: MEASUREMENT_REVISION,
        }),
        expect.anything()
      );
    });

    it('records a billed provider error as a failed case instead of deferring it for a paid retry', async () => {
      mockClaim({ case_ids: JSON.stringify([probeCase.id]) });
      vi.mocked(runCancellableProbeCase).mockResolvedValueOnce({
        ...successfulCliResult,
        text: '',
        costUsd: 0.0008,
        inputTokens: 4000,
        outputTokens: 12,
        exitCode: 1,
        stderrTail: 'provider error: rate limit exceeded',
        lastEventTypes: ['error'],
        tools: { calls: 0, names: [], steps: 0, finalFinishReason: null },
      });

      await processJob(env, deciderMessage());

      expect(deferChunk).not.toHaveBeenCalled();
      expect(failChunk).not.toHaveBeenCalled();
      expect(clearUnbilledCase).not.toHaveBeenCalled();
      expect(upsertCaseResult).toHaveBeenCalledWith(
        env.BENCH_DB,
        expect.objectContaining({
          case_id: probeCase.id,
          score: 0,
          cost_usd: 0.0008,
          input_tokens: 4000,
          output_tokens: 12,
          error: 'provider error: rate limit exceeded',
        }),
        expect.anything()
      );
    });

    it('defers a probe whose catalog fetch fails after the paid case started', async () => {
      mockClaim({ case_ids: JSON.stringify([probeCase.id]) });
      vi.stubGlobal(
        'fetch',
        vi.fn(async url =>
          String(url).endsWith('/models')
            ? new Response('{"error":"unavailable"}', { status: 503 })
            : Response.json({
                token: 'kilo-user-token',
                expiresAt: '2026-06-16T01:00:00.000Z',
              })
        )
      );

      await processJob(env, deciderMessage());

      expect(runCancellableProbeCase).not.toHaveBeenCalled();
      expect(releasedUnbilledGeneration()).toBe(true);
      expect(deferCatalogChunk).toHaveBeenCalledWith(
        env.BENCH_DB,
        'chunk-1',
        'token-1',
        expect.any(Number)
      );
      expect(cooldownCatalog).toHaveBeenCalledWith(env.BENCH_DB, expect.any(Number));
      expect(deferChunk).not.toHaveBeenCalled();
      expect(failChunk).not.toHaveBeenCalled();
      expect(upsertCaseResult).not.toHaveBeenCalled();
    });

    it('scores a probe that narrates and stops without a tool call as zero', async () => {
      mockClaim({ case_ids: JSON.stringify([probeCase.id]) });
      vi.mocked(runCancellableProbeCase).mockResolvedValueOnce({
        ...successfulCliResult,
        text: 'I will inspect the next file.',
        tools: { calls: 0, names: [], steps: 1, finalFinishReason: 'stop' },
      });

      await processJob(env, deciderMessage());

      expect(upsertCaseResult).toHaveBeenCalledWith(
        env.BENCH_DB,
        expect.objectContaining({
          case_id: probeCase.id,
          score: 0,
          tool_calls: 0,
          final_finish_reason: 'stop',
        }),
        expect.anything()
      );
    });

    it('fails a probe lane at once when its paid reply cannot arrive', async () => {
      mockClaim({ case_ids: JSON.stringify([probeCase.id]) });
      vi.mocked(runCancellableProbeCase).mockRejectedValueOnce(
        new Error('probe stream was cut after the gateway billed for output')
      );

      await processJob(env, deciderMessage());

      // No container exists on this path, so nothing can deliver the reply later.
      expect(failChunk).toHaveBeenCalledWith(env.BENCH_DB, 'chunk-1', 'token-1');
      expect(recordLaneFailure).toHaveBeenCalledWith(
        env.BENCH_DB,
        expect.objectContaining({ failureClass: 'ambiguous_execution' })
      );
      expect(upsertCaseResult).not.toHaveBeenCalled();
      expect(deferChunk).not.toHaveBeenCalled();
      expect(queueSend).not.toHaveBeenCalledWith(
        expect.objectContaining({ claimId: 'chunk-1' }),
        expect.anything()
      );
    });

    it('fails a probe lane at once when a prior probe execution left no output', async () => {
      mockClaim({ case_ids: JSON.stringify([probeCase.id]) });
      vi.mocked(getPaidCaseStartedAt).mockResolvedValue(Date.now() - 1_000);

      await processJob(env, deciderMessage());

      expect(runCancellableProbeCase).not.toHaveBeenCalled();
      expect(failChunk).toHaveBeenCalledWith(env.BENCH_DB, 'chunk-1', 'token-1');
      expect(deferChunk).not.toHaveBeenCalled();
      expect(queueSend).not.toHaveBeenCalledWith(
        expect.objectContaining({ claimId: 'chunk-1' }),
        expect.anything()
      );
    });
  });

  describe('typed payer refusal (R17)', () => {
    /**
     * A result carrying the Worker's own trusted stop marker. The discriminator is
     * `result.stop` (originated from the route's `x-kilo-benchmark-stop` header and never
     * parsed from text), so a body that merely mentions a code is not a refusal.
     */
    function refusalResult(reason: 'no_payer' = 'no_payer') {
      return {
        ...successfulCliResult,
        text: '',
        exitCode: 1,
        costUsd: 0,
        stderrTail: JSON.stringify({
          error: { code: reason, message: 'No payer is available for this case.' },
        }),
        lastEventTypes: ['error'],
        stop: { reason, status: 402 },
      };
    }

    /**
     * The runner's own terminal signal for a refused payer, with its exact slot. The pause
     * controller in `paid-benchmark.ts` takes exactly this slot and reason as its input.
     */
    function unfundedEvent(log: { mock: { calls: unknown[][] } }, caseId: string) {
      const line = log.mock.calls
        .map(([first]) => String(first))
        .find(text => text.includes('"event":"benchmark_paid_case_unfunded"'));
      if (line === undefined) throw new Error('no benchmark_paid_case_unfunded event');
      const event = JSON.parse(line) as { code: string; caseId: string; model: string };
      expect(event).toMatchObject({ caseId, model, variant: '', rep: 0 });
      return event;
    }

    it('stops only the refused slot, never the run or a sibling lane', async () => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      vi.mocked(runDeciderCaseViaCli).mockResolvedValueOnce(refusalResult('no_payer'));

      await processJob(env, deciderMessage());

      // Nothing measured: a refused payer is not a model outcome.
      expect(upsertCaseResult).not.toHaveBeenCalled();
      expect(savePendingDeciderOutput).not.toHaveBeenCalled();
      // Not a model or lane failure either, and no retry or second paid call.
      expect(recordLaneFailure).not.toHaveBeenCalled();
      expect(failChunk).not.toHaveBeenCalled();
      expect(markProfilesFailedForEntries).not.toHaveBeenCalled();
      expect(failScheduledEntry).not.toHaveBeenCalled();
      expect(deferChunk).not.toHaveBeenCalled();
      expect(deferThrottledChunk).not.toHaveBeenCalled();
      expect(deferCatalogChunk).not.toHaveBeenCalled();
      expect(runDeciderCaseViaCli).toHaveBeenCalledTimes(1);
      // The refusal is scoped to this case: the run and its other lanes are untouched. A
      // whole-run stop would kill every funded sibling measuring in the same run.
      expect(markRunFailed).not.toHaveBeenCalled();
      expect(releaseProfileClaims).not.toHaveBeenCalled();
      // The signal carries the exact refused slot the pause controller is given.
      expect(unfundedEvent(log, benchCase.id)).toMatchObject({ code: 'no_payer' });
      log.mockRestore();
    });

    it('pauses exactly the exhausted plan from that refused slot and leaves a funded one running', async () => {
      // The runner's terminal signal is the pause controller's input; drive the real
      // controller with it against real SQLite so the resulting rows are observed, not a mock.
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      vi.mocked(runDeciderCaseViaCli).mockResolvedValueOnce(refusalResult('no_payer'));
      await processJob(env, deciderMessage());
      const refused = unfundedEvent(log, benchCase.id);
      expect(refused.code).toBe('no_payer');
      log.mockRestore();

      const { sqlite, close } = openPaidSchema();
      const db = sqliteD1(sqlite);
      const at = '2026-01-01T00:00:00.000Z';
      const engine = computeEngineIdentity('decider', 'efficient');
      // The canonical slot: one running generation on the refused case. The controller acts
      // on this exact generation, so it must exist or nothing is paused.
      sqlite
        .prepare(
          `INSERT INTO benchmark_case_runs
            (engine_identity, model, variant, rep, case_id, status, generation,
              executor_run_id, executor_token, platform_covered, result_usable,
              created_at, updated_at, started_at)
          VALUES (?, ?, '', 0, ?, 'running', 1, ?, 'token-1', 0, 0, ?, ?, ?)`
        )
        .run(engine, model, benchCase.id, runId, at, at, at);
      const seed = (requestId: string, owner: string, cases: { id: string; live: boolean }[]) => {
        sqlite
          .prepare(
            `INSERT INTO paid_benchmark_requests
              (id, owner_type, owner_id, router, router_id, pool_version, engine_identity, status,
                quote_id, estimate_microdollars, maximum_microdollars, charged_microdollars,
                plan_cases, staged_cases, actor_user_id, context, created_at, updated_at)
            VALUES (?, 'user', ?, 'efficient', ?, 'pool-v1',
              ?, 'active', 'q', 20000, 20000, 500, 2, 2, ?, '{}', ?, ?)`
          )
          .run(requestId, owner, `pool-${requestId}`, engine, owner, at, at);
        for (const entry of cases) {
          sqlite
            .prepare(
              `INSERT INTO paid_benchmark_request_cases
                (request_id, engine_identity, model, variant, rep, case_id, status,
                  covered_by_kilo, charged_microdollars, reason, updated_at)
              VALUES (?, ?, ?, '', 0, ?, ?, 0, 0, NULL, ?)`
            )
            .run(requestId, engine, model, entry.id, entry.live ? 'running' : 'reused', at);
        }
      };
      // Every live case of this plan was the refused one: it is exhausted and must pause.
      seed('request-exhausted', 'user-a', [{ id: benchCase.id, live: true }]);
      // This plan shares the refused case but still has a funded one, so the slot continues
      // and the request is kept rather than paused.
      seed('request-funded', 'user-b', [
        { id: benchCase.id, live: true },
        { id: 'other-case', live: true },
      ]);

      const outcome = await pauseUnfundedPaidRequests(
        {
          BENCH_DB: db,
          KILO_WEB_API_BASE_URL: 'https://web.test',
          INTERNAL_API_SECRET_PROD: { get: async () => 'secret' },
        } as never,
        {
          refusedCases: [
            {
              engineIdentity: engine,
              model,
              variant: '',
              rep: 0,
              caseId: benchCase.id,
              funderRequestId: 'request-exhausted',
            },
          ],
          reason: refused.code,
        }
      );

      // A funded sibling request on the same case keeps the slot alive, so the canonical
      // transition refuses and nothing is paused — that is the sharing guarantee.
      expect(outcome.paused).toEqual([]);
      expect(outcome.kept).toContain('request-funded');
      expect(
        sqlite.prepare(`SELECT status FROM benchmark_case_runs WHERE case_id = ?`).get(benchCase.id)
      ).toEqual({ status: 'running' });
      // Neither plan is paused for money while a live payer remains.
      expect(
        sqlite
          .prepare(`SELECT id, status, pause_reason FROM paid_benchmark_requests ORDER BY id`)
          .all()
      ).toEqual([
        { id: 'request-exhausted', status: 'active', pause_reason: null },
        { id: 'request-funded', status: 'active', pause_reason: null },
      ]);
      // JIT billing: the already-billed amount stays, and nothing is refunded or outboxed.
      expect(
        (
          sqlite.prepare('SELECT COUNT(*) AS c FROM paid_benchmark_billing_outbox').get() as {
            c: number;
          }
        ).c
      ).toBe(0);
      close();
    });

    it('pauses the exhausted plan when no other live case can pay the slot', async () => {
      // The unshared case: one request, one live case, nobody else. The canonical transition
      // applies and both the slot and the plan stop, with no refund under just-in-time billing.
      const { sqlite, close } = openPaidSchema();
      const db = sqliteD1(sqlite);
      const at = '2026-01-01T00:00:00.000Z';
      const engine = computeEngineIdentity('decider', 'efficient');
      sqlite
        .prepare(
          `INSERT INTO benchmark_case_runs
            (engine_identity, model, variant, rep, case_id, status, generation,
              executor_run_id, executor_token, platform_covered, result_usable,
              created_at, updated_at, started_at)
          VALUES (?, ?, '', 0, ?, 'running', 1, ?, 'token-1', 0, 0, ?, ?, ?)`
        )
        .run(engine, model, benchCase.id, runId, at, at, at);
      sqlite
        .prepare(
          `INSERT INTO paid_benchmark_requests
            (id, owner_type, owner_id, router, router_id, pool_version, engine_identity, status,
              quote_id, estimate_microdollars, maximum_microdollars, charged_microdollars,
              plan_cases, staged_cases, actor_user_id, context, created_at, updated_at)
          VALUES ('request-solo', 'user', 'user-a', 'efficient', 'pool-solo', 'pool-v1',
            ?, 'active', 'q', 20000, 20000, 500, 1, 1, 'user-a', '{}', ?, ?)`
        )
        .run(engine, at, at);
      sqlite
        .prepare(
          `INSERT INTO paid_benchmark_request_cases
            (request_id, engine_identity, model, variant, rep, case_id, status,
              covered_by_kilo, charged_microdollars, reason, updated_at)
          VALUES ('request-solo', ?, ?, '', 0, ?, 'running', 0, 0, NULL, ?)`
        )
        .run(engine, model, benchCase.id, at);

      const outcome = await pauseUnfundedPaidRequests(
        {
          BENCH_DB: db,
          KILO_WEB_API_BASE_URL: 'https://web.test',
          INTERNAL_API_SECRET_PROD: { get: async () => 'secret' },
        } as never,
        {
          refusedCases: [
            {
              engineIdentity: engine,
              model,
              variant: '',
              rep: 0,
              caseId: benchCase.id,
              funderRequestId: 'request-solo',
            },
          ],
          reason: 'no_payer',
        }
      );

      expect(outcome).toMatchObject({ paused: ['request-solo'], kept: [] });
      expect(
        sqlite
          .prepare(`SELECT status, failure_reason FROM benchmark_case_runs WHERE case_id = ?`)
          .get(benchCase.id)
        // The canonical store normalizes a billing stop to its one pause reason.
      ).toEqual({ status: 'paused', failure_reason: 'no_funds' });
      expect(
        sqlite
          .prepare(
            "SELECT status, pause_reason, charged_microdollars FROM paid_benchmark_requests WHERE id = 'request-solo'"
          )
          .get()
      ).toEqual({ status: 'paused', pause_reason: 'no_funds', charged_microdollars: 500 });
      expect(
        sqlite
          .prepare(
            "SELECT status, reason FROM paid_benchmark_request_cases WHERE request_id = 'request-solo'"
          )
          .get()
      ).toEqual({ status: 'paused', reason: 'no_funds' });
      close();
    });

    it('does not treat a raw provider 402 as a no-payer state', async () => {
      // A raw provider 402 is a provider failure with possible usage; it is never a typed
      // pre-provider money verdict, so the case is measured instead of pausing requests.
      vi.mocked(runDeciderCaseViaCli).mockResolvedValueOnce({
        ...successfulCliResult,
        text: '',
        exitCode: 1,
        costUsd: 0,
        stderrTail: 'HTTP 402 Payment Required from upstream provider',
        lastEventTypes: ['error'],
      });

      await processJob(env, deciderMessage());

      expect(markRunFailed).not.toHaveBeenCalled();
      expect(runDeciderCaseViaCli).toHaveBeenCalledTimes(1);
      // It is an ordinary measured failure for this slot, not a paused plan.
      expect(upsertCaseResult).toHaveBeenCalledWith(
        env.BENCH_DB,
        expect.objectContaining({ case_id: benchCase.id, score: 0, cost_usd: 0 }),
        expect.anything()
      );
    });

    // `gateway_jit_unavailable` is the route's 503 "billing route unavailable": emitted before
    // any payer is selected, so it says nothing about funds. The wire carries the trusted
    // `infra_unavailable` stop. Classified from that stop only. Unspent → released and
    // retried through normal admission; already billed → the ledger stands and the case ends
    // with no grade and no retry. Neither is a pause and neither scores a zero.
    it('releases an unspent infra stop and re-admits the chunk, never a no-funds pause', async () => {
      vi.mocked(runDeciderCaseViaCli).mockResolvedValueOnce({
        ...successfulCliResult,
        text: '',
        exitCode: 1,
        costUsd: 0,
        stderrTail: JSON.stringify({
          error: {
            code: 'gateway_jit_unavailable',
            message: 'Case inference billing is unavailable.',
          },
        }),
        lastEventTypes: ['error'],
        stop: { reason: 'infra_unavailable', status: 503 },
      });

      await processJob(env, deciderMessage());

      // Not a funding verdict: no run stop, no released claims, no pause.
      expect(markRunFailed).not.toHaveBeenCalled();
      expect(releaseProfileClaims).not.toHaveBeenCalled();
      // Not a measurement and not a model/lane failure: nothing reached a provider.
      expect(upsertCaseResult).not.toHaveBeenCalled();
      expect(savePendingDeciderOutput).not.toHaveBeenCalled();
      expect(recordLaneFailure).not.toHaveBeenCalled();
      expect(failChunk).not.toHaveBeenCalled();
      expect(markProfilesFailedForEntries).not.toHaveBeenCalled();
      expect(runDeciderCaseViaCli).toHaveBeenCalledTimes(1);
      // The unspent generation is released through the atomic batch, then the chunk defers.
      expect(clearUnbilledCase).not.toHaveBeenCalled();
      // Infrastructure, not the catalog: the lane backs off and re-enters normal admission
      // with no catalog cooldown and no catalog deferral kind.
      expect(deferCatalogChunk).not.toHaveBeenCalled();
      expect(cooldownCatalog).not.toHaveBeenCalled();
      expect(deferChunk).toHaveBeenCalledWith(
        env.BENCH_DB,
        'chunk-1',
        'token-1',
        expect.any(Number)
      );
      expect(queueSend).toHaveBeenCalledWith(
        { runId, kind: 'decider', model, schedulerWake: true },
        { delaySeconds: 15 }
      );
      expect(deferThrottledChunk).not.toHaveBeenCalled();
    });

    it('keeps the ledger and stops without a grade when an infra stop already billed', async () => {
      vi.mocked(runDeciderCaseViaCli).mockResolvedValueOnce({
        ...successfulCliResult,
        text: 'partial',
        exitCode: 1,
        costUsd: 0.03,
        stderrTail: 'upstream said something',
        lastEventTypes: ['text', 'error'],
        stop: { reason: 'infra_unavailable', status: 503 },
      });

      await processJob(env, deciderMessage());

      // Real usage on the attempt: never cleared, never replayed, never graded.
      expect(clearUnbilledCase).not.toHaveBeenCalled();
      expect(upsertCaseResult).not.toHaveBeenCalled();
      expect(runDeciderCaseViaCli).toHaveBeenCalledTimes(1);
      // No retry of a slot that already spent.
      expect(deferCatalogChunk).not.toHaveBeenCalled();
      expect(deferChunk).not.toHaveBeenCalled();
      expect(deferThrottledChunk).not.toHaveBeenCalled();
      // And still not a funding pause.
      expect(markRunFailed).not.toHaveBeenCalled();
    });

    it('does not pause for a text-only refusal body without the trusted stop marker', async () => {
      // The discriminator is the Worker-origin stop, never the runner's stderr text: a body
      // that only *looks* like a refusal (no `stop`) must not pause a funded plan.
      vi.mocked(runDeciderCaseViaCli).mockResolvedValueOnce({
        ...successfulCliResult,
        text: '',
        exitCode: 1,
        costUsd: 0,
        stderrTail: JSON.stringify({
          error: { code: 'insufficient_funds', message: 'No payer is available for this case.' },
        }),
        lastEventTypes: ['error'],
      });

      await processJob(env, deciderMessage());

      expect(markRunFailed).not.toHaveBeenCalled();
      expect(releaseProfileClaims).not.toHaveBeenCalled();
      expect(deferCatalogChunk).not.toHaveBeenCalled();
      expect(upsertCaseResult).toHaveBeenCalledWith(
        env.BENCH_DB,
        expect.objectContaining({ case_id: benchCase.id, score: 0 }),
        expect.anything()
      );
    });

    it('leaves a billing-unavailable slot queued with its chunk deferred, not failed', async () => {
      // Real migrations: the unspent generation must go back to `queued` with no executor, so
      // the next admission re-owns it and no already-admitted provider request is reissued.
      const { sqlite, close } = openPaidSchema();
      const db = sqliteD1(sqlite);
      const engine = computeEngineIdentity('decider', 'efficient');
      const key = { engineIdentity: engine, model, variant: '', rep: 0, caseId: benchCase.id };
      sqlite
        .prepare(
          `INSERT INTO benchmark_case_runs
            (engine_identity, model, variant, rep, case_id, status, generation,
              executor_run_id, executor_token, platform_covered, result_usable,
              created_at, updated_at, started_at)
          VALUES (?, ?, '', 0, ?, 'running', 1, ?, 'token-1', 1, 0, ?, ?, ?)`
        )
        .run(
          engine,
          model,
          benchCase.id,
          runId,
          '2026-01-01T00:00:00.000Z',
          '2026-01-01T00:00:00.000Z',
          '2026-01-01T00:00:00.000Z'
        );
      sqlite
        .prepare(
          `INSERT INTO benchmark_case_payers
            (engine_identity, model, variant, rep, case_id, generation, owner_type, owner_id,
              request_id, status, reason, created_at, updated_at)
          VALUES (?, ?, '', 0, ?, 1, 'user', 'user-a', 'request-a', 'eligible', NULL, ?, ?)`
        )
        .run(engine, model, benchCase.id, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');

      // This is exactly what the runner's unbilled-infrastructure branch executes, taken from
      // the module's real implementation (this suite mocks it only to keep sibling paths inert).
      const actual = await vi.importActual<typeof PaidStoreModule>('./paid-case-store');
      await db.batch(
        actual.releasePaidCaseGenerationStatements(db, {
          key,
          generation: { runId, token: 'token-1', generation: 1 },
        })
      );

      expect(
        sqlite
          .prepare(
            `SELECT status, executor_run_id, executor_token, started_at FROM benchmark_case_runs
            WHERE engine_identity = ? AND case_id = ?`
          )
          .get(engine, benchCase.id)
      ).toEqual({
        status: 'queued',
        executor_run_id: null,
        executor_token: null,
        started_at: null,
      });
      // Payers survive: releasing an unspent generation never detaches or charges anyone.
      expect(
        sqlite
          .prepare(
            `SELECT status, reason FROM benchmark_case_payers
            WHERE engine_identity = ? AND case_id = ?`
          )
          .get(engine, benchCase.id)
      ).toEqual({ status: 'eligible', reason: null });
      close();
    });

    it('does not treat a pending native receipt as an insufficient-funds reason', async () => {
      // A receipt-pending answer says the charge is unresolved, not that the payer is gone.
      // The runner's classifier names only the payment codes, so this is not a
      // `PaidCaseUnfundedError`: no run stop, no unfunded pause, and no `no_funds` verdict.
      vi.mocked(runDeciderCaseViaCli).mockResolvedValueOnce({
        ...successfulCliResult,
        text: '',
        exitCode: 1,
        costUsd: 0,
        stderrTail: JSON.stringify({
          error: { code: 'receipt_pending', message: 'Usage receipt has not settled yet.' },
        }),
        lastEventTypes: ['error'],
      });

      await processJob(env, deciderMessage());

      expect(markRunFailed).not.toHaveBeenCalled();
      expect(markRunFailed).not.toHaveBeenCalledWith(
        env.BENCH_DB,
        runId,
        expect.stringContaining('no_funds')
      );
    });

    it('does not pause when an upstream provider body mimics the typed refusal code', async () => {
      // The classifier reads the runner's stderr tail, so a *provider* error body that happens
      // to contain `"code":"no_payer"` must not become a money verdict. Trusting it would let
      // any upstream failure pause a funded plan. Only the worker's own route envelope counts,
      // which is why the trusted discriminator (not this text match) is the contract this test
      // guards: it must carry prior usage and check the refusal's provenance, not its bytes.
      vi.mocked(runDeciderCaseViaCli).mockResolvedValueOnce({
        ...successfulCliResult,
        text: 'partial assistant text the provider already billed',
        exitCode: 1,
        costUsd: 0.004,
        stderrTail: 'Upstream 402: {"error":{"code":"no_payer","message":"provider simulation"}}',
        lastEventTypes: ['text', 'error'],
      });

      await processJob(env, deciderMessage());

      // Prior usage proves a provider was reached: this is a paid failure, never a refusal.
      expect(markRunFailed).not.toHaveBeenCalled();
      expect(releaseProfileClaims).not.toHaveBeenCalled();
      expect(deferCatalogChunk).not.toHaveBeenCalled();
      expect(upsertCaseResult).toHaveBeenCalledWith(
        env.BENCH_DB,
        expect.objectContaining({ case_id: benchCase.id, score: 0, cost_usd: 0.004 }),
        expect.anything()
      );
    });

    // PAID THEN REFUSED, user-owned. The spend and the refusal happen inside ONE invocation:
    // the CLI already billed before the Worker stopped the call at the payer boundary
    // (`run.ts` returns any trusted stop before the empty-output retry, so no second call is
    // opened). The refusal is read from the trusted stop, never `costUsd`, so real prior
    // spend on the same call cannot hide it. The case is ungradeable, the plan pauses for
    // money, and no unrelated lane fails.
    it('pauses on a refusal after real spend inside one user-owned invocation', async () => {
      const snapshot = await getRunWithModels(env.BENCH_DB, runId);
      if (!snapshot) throw new Error('Run snapshot missing');
      vi.mocked(getRunWithModels).mockResolvedValue({
        ...snapshot,
        run: { ...snapshot.run, purpose: 'user' },
      });
      // One CLI call that really spent and then ended with no assistant text — the shape the
      // empty-output retry exists for. The stop must win over the retry: `costUsd` is 0.02
      // (admitted usage), so a check keyed on "nothing spent" could not see it.
      vi.mocked(runDeciderCaseViaCli).mockResolvedValueOnce({
        ...successfulCliResult,
        text: '',
        exitCode: 0,
        costUsd: 0.02,
        inputTokens: 900,
        outputTokens: 0,
        eventCount: 2,
        lastEventTypes: ['step_finish'],
        stderrTail: JSON.stringify({
          error: { code: 'no_payer', message: 'No payer is available for this case.' },
        }),
        stop: { reason: 'no_payer', status: 402 },
      });

      await processJob(env, deciderMessage());

      // Exactly one paid CLI invocation: the stop short-circuits before any retry, and the
      // user generation never replays a CLI call it did not start.
      expect(runDeciderCaseViaCli).toHaveBeenCalledTimes(1);
      expect(restartPaidCase).not.toHaveBeenCalled();
      expect(deletePendingDeciderOutput).not.toHaveBeenCalled();
      // Financial pause on the typed refusal, scoped to this case: the run and its other
      // lanes keep going, so a funded sibling still measures.
      expect(markRunFailed).not.toHaveBeenCalled();
      expect(releaseProfileClaims).not.toHaveBeenCalled();
      // The partial transcript is ungradeable: no case_results row carries its score.
      expect(upsertCaseResult).not.toHaveBeenCalled();
      expect(savePendingDeciderOutput).not.toHaveBeenCalled();
      // No model/lane failure and no retry/deferral for a payer stop.
      expect(recordLaneFailure).not.toHaveBeenCalled();
      expect(failChunk).not.toHaveBeenCalled();
      expect(markProfilesFailedForEntries).not.toHaveBeenCalled();
      expect(deferChunk).not.toHaveBeenCalled();
      expect(deferCatalogChunk).not.toHaveBeenCalled();
      // The spend that happened is the real one: no fabricated prior cost is passed back.
      const [invocation] = vi.mocked(runDeciderCaseViaCli).mock.calls;
      expect(invocation?.[1].resultCallback?.execution.priorCostUsd ?? null).toBeNull();
    });
    it('leaves a funded sibling lane and its chunk untouched in the same run', async () => {
      // The refusal is scoped to one case. A whole-run stop (`markRunFailed` +
      // `releaseProfileClaims`) would kill every funded sibling measuring in this run, so the
      // real rows are checked rather than the mocked call.
      const { sqlite, close } = openPaidSchema();
      const siblingModel = 'vendor/sibling';
      const at = '2026-01-01T00:00:00.000Z';
      sqlite
        .prepare(
          `INSERT INTO benchmark_runs
            (id, kind, router, engine_identity, measurement_revision, status, started_at,
              min_accuracy, switch_cost_factor, max_concurrency, benchmark_user_id, repetitions,
              purpose, admission_marker)
          VALUES (?, 'decider', 'efficient', ?, 3, 'running', ?, 0.7, 1, 4, 'bench-user', 1,
            'platform', ?)`
        )
        .run(runId, computeEngineIdentity('decider', 'efficient'), at, at);
      sqlite
        .prepare(
          `INSERT INTO benchmark_profiles
            (model, variant, engine_identity, repetitions, status, run_id, failure_reason,
              requested_at, updated_at, completed_at)
          VALUES (?, '', 'engine-sib', 1, 'running', ?, NULL, ?, ?, NULL)`
        )
        .run(siblingModel, runId, at, at);
      sqlite
        .prepare(
          `INSERT INTO scheduler_chunks
            (id, run_id, model, variant, providers, rep, chunk, case_ids, status, token, slot,
              lease_until, available_at, attempts)
          VALUES ('chunk-sibling', ?, ?, '', '[]', 0, 0, ?, 'active', 'token-sibling', 8,
            9999999999999, 0, 1)`
        )
        .run(runId, siblingModel, JSON.stringify([benchCase.id]));
      sqlite
        .prepare(
          `INSERT INTO benchmark_case_runs
            (engine_identity, model, variant, rep, case_id, status, generation,
              executor_run_id, executor_token, platform_covered, result_usable,
              created_at, updated_at, started_at)
          VALUES ('engine-sib', ?, '', 0, ?, 'running', 1, 'run-sibling', 'token-sibling', 1, 0,
            ?, ?, ?)`
        )
        .run(siblingModel, 'sibling-case', at, at, at);

      const before = sqlite
        .prepare(`SELECT status, run_id FROM benchmark_profiles WHERE model = ?`)
        .get(siblingModel);
      const chunkBefore = sqlite
        .prepare(`SELECT status, token, slot FROM scheduler_chunks WHERE id = 'chunk-sibling'`)
        .get();

      const refused = await pauseUnfundedPaidRequests(
        {
          BENCH_DB: sqliteD1(sqlite),
          KILO_WEB_API_BASE_URL: 'https://web.test',
          INTERNAL_API_SECRET_PROD: { get: async () => 'secret' },
        } as never,
        {
          refusedCases: [
            {
              engineIdentity: computeEngineIdentity('decider', 'efficient'),
              model,
              variant: '',
              rep: 0,
              caseId: benchCase.id,
              // The funder is the plan that could not pay; its own staged row must not count
              // as a competing payer.
              funderRequestId: 'request-exhausted',
            },
          ],
          reason: 'no_payer',
        }
      );

      // No live plan owns the refused slot here, so nothing is paused and nothing is kept —
      // the important part is that the write never reaches the sibling's rows.
      expect(refused).toEqual({ paused: [], kept: [] });
      expect(
        sqlite
          .prepare(`SELECT status, run_id FROM benchmark_profiles WHERE model = ?`)
          .get(siblingModel)
      ).toEqual(before);
      expect(
        sqlite
          .prepare(`SELECT status, token, slot FROM scheduler_chunks WHERE id = 'chunk-sibling'`)
          .get()
      ).toEqual(chunkBefore);
      expect(
        sqlite
          .prepare(`SELECT status, executor_token FROM benchmark_case_runs WHERE model = ?`)
          .get(siblingModel)
      ).toEqual({ status: 'running', executor_token: 'token-sibling' });
      close();
    });
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
        { model, variant: 'high' },
        { model, variant: 'low' },
      ],
      repetitions: 3,
      caseIds: deciderCasesForRouter('efficient', MEASUREMENT_REVISION).map(c => c.id),
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
    { persisted: false, costUsd: null },
    { persisted: false, costUsd: 0 },
    { persisted: true, costUsd: null },
    { persisted: true, costUsd: 0 },
  ])(
    'refunds an unbilled catalog network failure, cools dispatch and removes only its transient execution: %j',
    async ({ persisted, costUsd }) => {
      const claim = mockClaim({ variant: 'high', rep: 1 });
      mockRunSnapshot([
        { model, variant: 'high' },
        { model, variant: 'low' },
      ]);
      const snapshot = await getRunWithModels(env.BENCH_DB, runId);
      if (!snapshot) throw new Error('Run snapshot missing');
      vi.mocked(getRunWithModels).mockResolvedValue({
        ...snapshot,
        run: { ...snapshot.run, repetitions: 3 },
      });
      const result = {
        ...successfulCliResult,
        text: '',
        exitCode: 1,
        costUsd,
        stderrTail: `Failed to load Kilo model catalog: fetch failed\nModel not found: kilo/${model}`,
        unavailableModelId: `kilo/${model}`,
      };
      const persistedStartedAt = 1_729_411_200_000;
      if (persisted) {
        vi.mocked(getPendingDeciderOutput).mockResolvedValueOnce({
          result,
          retried: false,
          attemptStartedAt: persistedStartedAt,
          promptRevision: MEASUREMENT_REVISION,
        });
      } else {
        vi.mocked(runDeciderCaseViaCli).mockResolvedValueOnce(result);
      }

      await processJob(env, deciderMessage());

      const attemptStartedAt = persisted
        ? persistedStartedAt
        : vi.mocked(runDeciderCaseViaCli).mock.calls[0]?.[1].resultCallback?.execution
            .attemptStartedAt;
      expect(attemptStartedAt).toEqual(expect.any(Number));
      expect(releasedUnbilledGeneration()).toBe(true);
      expect(deletePendingDeciderOutput).toHaveBeenCalledTimes(persisted ? 1 : 0);
      expect(runDeciderCaseViaCli).toHaveBeenCalledTimes(persisted ? 0 : 1);
      expect(restartPaidCase).not.toHaveBeenCalled();
      expect(savePendingDeciderOutput).not.toHaveBeenCalled();
      expect(upsertCaseResult).not.toHaveBeenCalled();
      expect(markProfilesFailedForEntries).not.toHaveBeenCalled();
      expect(failScheduledEntry).not.toHaveBeenCalled();
      expect(failChunk).not.toHaveBeenCalled();
      expect(recordLaneFailure).not.toHaveBeenCalled();
      expect(cooldownModel).not.toHaveBeenCalled();
      expect(finishChunk).not.toHaveBeenCalled();
      expect(deferChunk).not.toHaveBeenCalled();
      expect(deferCatalogChunk).toHaveBeenCalledWith(
        env.BENCH_DB,
        claim.id,
        claim.token,
        expect.any(Number)
      );
      expect(cooldownCatalog).toHaveBeenCalledWith(env.BENCH_DB, expect.any(Number));
      expect(queueSend).toHaveBeenCalledWith(
        { runId, kind: 'decider', model, schedulerWake: true },
        { delaySeconds: 15 }
      );
    }
  );

  it('fails the lane as catalog_load once the catalog deferral budget and attempts are spent', async () => {
    const catalogFailure = {
      ...successfulCliResult,
      text: '',
      exitCode: 1,
      costUsd: 0,
      stderrTail: 'Failed to load Kilo model catalog: fetch failed',
    };
    vi.mocked(runDeciderCaseViaCli)
      .mockResolvedValueOnce(catalogFailure)
      .mockResolvedValueOnce(catalogFailure);
    mockClaim({ attempts: SCHEDULER_MAX_ATTEMPTS });
    await processJob(env, deciderMessage());
    expect(deferCatalogChunk).toHaveBeenCalled();
    expect(failChunk).not.toHaveBeenCalled();

    vi.mocked(deferCatalogChunk).mockClear();
    mockClaim({
      attempts: SCHEDULER_MAX_ATTEMPTS,
      catalog_deferrals: SCHEDULER_MAX_CATALOG_DEFERRALS,
    });
    await processJob(env, deciderMessage());
    expect(deferCatalogChunk).not.toHaveBeenCalled();
    expect(failChunk).toHaveBeenCalledWith(env.BENCH_DB, 'chunk-1', 'token-1');
    expect(recordLaneFailure).toHaveBeenCalledWith(
      env.BENCH_DB,
      expect.objectContaining({ model, failureClass: 'catalog_load' })
    );
  });

  it('defers an unbilled gateway model rejection instead of scoring it', async () => {
    const claim = mockClaim({ variant: 'high', rep: 0 });
    mockRunSnapshot([{ model, variant: 'high' }]);
    vi.mocked(runDeciderCaseViaCli).mockResolvedValueOnce({
      ...successfulCliResult,
      text: '',
      exitCode: 1,
      costUsd: 0,
      stderrTail: `\u001b[91mError: \u001b[0mUnsupported model ${model}\n`,
    });

    await processJob(env, deciderMessage());

    expect(releasedUnbilledGeneration()).toBe(true);
    expect(upsertCaseResult).not.toHaveBeenCalled();
    expect(markProfilesFailedForEntries).not.toHaveBeenCalled();
    expect(failScheduledEntry).not.toHaveBeenCalled();
    expect(recordLaneFailure).not.toHaveBeenCalled();
    expect(finishChunk).not.toHaveBeenCalled();
    expect(deferChunk).toHaveBeenCalledWith(
      env.BENCH_DB,
      claim.id,
      claim.token,
      expect.any(Number)
    );
    expect(queueSend).toHaveBeenCalledWith(
      { runId, kind: 'decider', model, schedulerWake: true },
      { delaySeconds: 15 }
    );
  });

  it.each([
    { text: 'A partial measured answer', costUsd: null, timedOut: false },
    { text: '', costUsd: 0.01, timedOut: false },
    { text: '', costUsd: null, timedOut: true },
  ])(
    'keeps nonempty, billed, or timed-out catalog diagnostics as measured results: %j',
    async failure => {
      const result = {
        ...successfulCliResult,
        exitCode: 1,
        stderrTail: 'Failed to load model catalog: network unavailable',
        ...failure,
      };
      vi.mocked(runDeciderCaseViaCli).mockResolvedValueOnce(result);

      await processJob(env, deciderMessage());

      expect(runDeciderCaseViaCli).toHaveBeenCalledTimes(1);
      expect(restartPaidCase).not.toHaveBeenCalled();
      expect(upsertCaseResult).toHaveBeenCalledWith(
        env.BENCH_DB,
        expect.objectContaining({
          score: 0,
          cost_usd: failure.costUsd,
          timed_out: failure.timedOut ? 1 : 0,
          output_prefix: failure.text,
          error: result.stderrTail,
        }),
        expect.anything()
      );
      expect(clearUnbilledCase).not.toHaveBeenCalled();
      expect(markProfilesFailedForEntries).not.toHaveBeenCalled();
      expect(failScheduledEntry).not.toHaveBeenCalled();
      expect(deferChunk).not.toHaveBeenCalled();
      expect(finishChunk).toHaveBeenCalled();
    }
  );

  it.each([
    { exitCode: 1, stderrTail: `Error: Model not found: kilo/${model}` },
    { exitCode: 0, stderrTail: '', unavailableModelId: `kilo/${model}` },
  ])(
    'fails unavailable exact entries immediately without scoring or retrying inference: %j',
    async unavailable => {
      mockClaim({ variant: 'high', rep: 1 });
      mockRunSnapshot([
        { model, variant: 'high' },
        { model, variant: 'low' },
        { model: 'other/model', variant: '' },
      ]);
      vi.mocked(hasUnsettledChunks).mockResolvedValue(true);
      vi.mocked(runDeciderCaseViaCli).mockResolvedValueOnce({
        ...successfulCliResult,
        text: '',
        ...unavailable,
      });

      await processJob(env, deciderMessage());

      expect(runDeciderCaseViaCli).toHaveBeenCalledTimes(1);
      expect(restartPaidCase).not.toHaveBeenCalled();
      expect(clearUnbilledCase).not.toHaveBeenCalled();
      expect(upsertCaseResult).not.toHaveBeenCalled();
      expect(savePendingDeciderOutput).toHaveBeenCalledTimes(1);
      expect(markProfilesFailedForEntries).toHaveBeenCalledWith(
        env.BENCH_DB,
        runId,
        [{ model, variant: 'high' }],
        {
          failureClass: 'model_not_found',
          reason: expect.stringContaining('unavailable'),
        }
      );
      // One atomic batch: the lane transition and the paid-link terminalization commit
      // together, so neither can be left stranded by the other failing.
      const fence = dbBatch.mock.calls
        .map(([statements]) => statements as FakeStatement[])
        .find(statements =>
          statements.some(statement => statement.sql.includes('run_lane_failures'))
        );
      expect(fence).toHaveLength(4);
      // Both paid statements require the caller's own active claim.
      for (const statement of (fence ?? []).slice(0, 2)) {
        expect(statement.sql).toContain('scheduler_chunks');
        expect(statement.sql).toContain("owner.status = 'active'");
      }
      // The paid statements come first and carry the same owned-claim fence, so a stale
      // claim cannot terminalize a link the lane death would refuse.
      const shapes = fence?.map(statement => statement.sql.replace(/\s+/g, ' ').trim()) ?? [];
      expect(shapes[0]).toMatch(/^UPDATE benchmark_case_runs/);
      expect(shapes[1]).toMatch(/^UPDATE paid_benchmark_request_cases/);
      expect(shapes[2]).toMatch(/^INSERT INTO run_lane_failures/);
      expect(shapes[3]).toMatch(/^WITH owned AS MATERIALIZED/);
      expect(markRunCompleted).not.toHaveBeenCalled();
      expect(deferChunk).not.toHaveBeenCalled();
      expect(queueSend).not.toHaveBeenCalled();
    }
  );

  it('commits the lane death and its paid-link fence as one batch', async () => {
    mockClaim({ variant: 'high', rep: 1 });
    mockRunSnapshot([{ model, variant: 'high' }]);
    vi.mocked(hasUnsettledChunks).mockResolvedValue(true);
    vi.mocked(runDeciderCaseViaCli).mockResolvedValueOnce({
      ...successfulCliResult,
      text: '',
      costUsd: 0,
      timedOut: false,
      unavailableModelId: `kilo/${model}`,
    });
    const fenceBatches = () =>
      dbBatch.mock.calls
        .map(([statements]) => statements as FakeStatement[])
        .filter(statements =>
          statements.some(statement => statement.sql.includes('run_lane_failures'))
        );

    await processJob(env, deciderMessage());

    // Four statements, one transaction: the two scheduler terminal-lane writes and the two
    // paid-link terminalizations commit together, so neither half can strand the other.
    expect(fenceBatches()).toHaveLength(1);
    expect(fenceBatches()[0]).toHaveLength(4);
    expect(failScheduledEntry).not.toHaveBeenCalled();
    expect(runDeciderCaseViaCli).toHaveBeenCalledTimes(1);
  });

  it.each([
    { stderrTail: 'Model not found: kilo/another/model', costUsd: null, timedOut: false },
    { stderrTail: `Model not found: kilo/${model}`, costUsd: 0.01, timedOut: false },
    { stderrTail: `Model not found: kilo/${model}`, costUsd: null, timedOut: true },
  ])(
    'keeps mismatched, billed, or timed-out CLI failures as measured results: %j',
    async failure => {
      vi.mocked(runDeciderCaseViaCli).mockResolvedValueOnce({
        ...successfulCliResult,
        text: '',
        exitCode: 1,
        ...failure,
      });
      await processJob(env, deciderMessage());
      expect(runDeciderCaseViaCli).toHaveBeenCalledTimes(1);
      expect(upsertCaseResult).toHaveBeenCalledWith(
        env.BENCH_DB,
        expect.objectContaining({
          score: 0,
          cost_usd: failure.costUsd,
          timed_out: failure.timedOut ? 1 : 0,
        }),
        expect.anything()
      );
      expect(markProfilesFailedForEntries).not.toHaveBeenCalled();
      expect(failScheduledEntry).not.toHaveBeenCalled();
    }
  );

  it('recovers terminal unavailable output after a profile write failure without paying again', async () => {
    const result = {
      ...successfulCliResult,
      text: '',
      exitCode: 1,
      stderrTail: `Model not found: kilo/${model}`,
    };
    vi.mocked(runDeciderCaseViaCli).mockResolvedValueOnce(result);
    vi.mocked(markProfilesFailedForEntries).mockRejectedValueOnce(new Error('D1 unavailable'));
    await expect(processJob(env, deciderMessage())).rejects.toThrow('D1 unavailable');
    vi.mocked(getPendingDeciderOutput).mockResolvedValueOnce({
      result,
      retried: false,
      promptRevision: MEASUREMENT_REVISION,
    });

    await processJob(env, deciderMessage());

    expect(runDeciderCaseViaCli).toHaveBeenCalledTimes(1);
    // The lane death and the paid-link fence are one batch, so neither can be left behind.
    expect(
      dbBatch.mock.calls.filter(([statements]) =>
        (statements as FakeStatement[]).some(statement =>
          statement.sql.includes('run_lane_failures')
        )
      )
    ).toHaveLength(1);
    expect(upsertCaseResult).not.toHaveBeenCalled();
  });

  it('grades unrelated entries normally after an exact model becomes unavailable', async () => {
    vi.mocked(runDeciderCaseViaCli).mockResolvedValueOnce({
      ...successfulCliResult,
      text: '',
      exitCode: 1,
      stderrTail: `Model not found: kilo/${model}`,
    });
    await processJob(env, deciderMessage());
    mockRunSnapshot([{ model: 'other/model', variant: '' }]);
    mockClaim({ id: 'other-chunk', model: 'other/model' });

    await processJob(env, { ...deciderMessage(), claimId: 'other-chunk', model: 'other/model' });

    expect(upsertCaseResult).toHaveBeenCalledTimes(1);
    expect(upsertCaseResult).toHaveBeenCalledWith(
      env.BENCH_DB,
      expect.objectContaining({ model: 'other/model', exit_code: 0 }),
      expect.anything()
    );
    expect(markProfilesFailedForEntries).toHaveBeenCalledTimes(1);
  });

  it.each([
    'container /run failed: HTTP 503 There is no Container instance available at this time. This is likely because you have reached your max concurrent instance count.',
    'container /run failed: HTTP 503 Maximum number of running container instances exceeded',
    'container /run failed: HTTP 503 There is no container instance that can be provided to this Durable Object, try again later',
  ])('defers capacity without writing a model failure: %s', async message => {
    vi.mocked(runDeciderCaseViaCli).mockRejectedValueOnce(new Error(message));
    await processJob(env, deciderMessage());
    expect(releasedUnbilledGeneration()).toBe(true);
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
    expect(runDeciderCaseViaCli).not.toHaveBeenCalled();
    expect(upsertCaseResult).not.toHaveBeenCalled();
    expect(recordLaneFailure).not.toHaveBeenCalled();
    expect(deferChunk).toHaveBeenCalled();
  });

  function schedulerWaitEvent(calls: unknown[][]): unknown {
    const line = calls
      .map(([first]) => String(first))
      .find(text => text.includes('"event":"benchmark_scheduler_wait"'));
    return line === undefined ? undefined : JSON.parse(line);
  }

  it('defers a case whose container was never reached instead of waiting on its output', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(runDeciderCaseViaCli).mockRejectedValueOnce(
      new Error(
        'container /run failed: HTTP 503 container not reached: Error proxying request to container: The container just exited'
      )
    );

    await processJob(env, deciderMessage());

    expect(releasedUnbilledGeneration()).toBe(true);
    expect(deferChunk).toHaveBeenCalledWith(env.BENCH_DB, 'chunk-1', 'token-1', expect.any(Number));
    expect(queueSend).not.toHaveBeenCalledWith(deciderMessage(), expect.anything());
    expect(failChunk).not.toHaveBeenCalled();
    expect(recordLaneFailure).not.toHaveBeenCalled();
    expect(upsertCaseResult).not.toHaveBeenCalled();
    const wait = schedulerWaitEvent(warn.mock.calls);
    expect(wait).toMatchObject({
      reason: 'container_capacity',
      errorCategory: 'container_not_reached',
      waitingForOutput: false,
    });
  });

  it('grades the first attempt when its empty-output retry never reaches the container', async () => {
    const first = { ...successfulCliResult, text: '', exitCode: 0, costUsd: 0.01 };
    vi.mocked(runDeciderCaseViaCli)
      .mockResolvedValueOnce(first)
      .mockRejectedValueOnce(
        new Error(
          'container /run failed: HTTP 503 container not reached: Error proxying request to container: The container is not running, consider calling start()'
        )
      );

    await processJob(env, deciderMessage());

    expect(runDeciderCaseViaCli).toHaveBeenCalledTimes(2);
    const retryStartedAt =
      vi.mocked(runDeciderCaseViaCli).mock.calls[1]?.[1].resultCallback?.execution.attemptStartedAt;
    expect(savePendingDeciderOutput).toHaveBeenCalledWith(
      env.BENCH_DB,
      { run_id: runId, model, variant: '', rep: 0, case_id: benchCase.id },
      {
        result: first,
        retried: false,
        attemptStartedAt: retryStartedAt,
        promptRevision: MEASUREMENT_REVISION,
      }
    );
    expect(upsertCaseResult).toHaveBeenCalledWith(
      env.BENCH_DB,
      expect.objectContaining({ score: 0, cost_usd: 0.01, retried: false, exit_code: 0 }),
      expect.anything()
    );
    expect(clearUnbilledCase).not.toHaveBeenCalled();
    expect(recordLaneFailure).not.toHaveBeenCalled();
    expect(deferChunk).not.toHaveBeenCalled();
    expect(finishChunk).toHaveBeenCalledWith(env.BENCH_DB, 'chunk-1', 'token-1');
  });

  it('clears an unstarted retry generation when the first output cannot be saved', async () => {
    vi.mocked(runDeciderCaseViaCli)
      .mockResolvedValueOnce({ ...successfulCliResult, text: '', exitCode: 0, costUsd: 0.01 })
      .mockRejectedValueOnce(
        new Error(
          'container /run failed: HTTP 503 container not reached: Error proxying request to container: The container just exited'
        )
      );
    vi.mocked(savePendingDeciderOutput).mockRejectedValueOnce(new Error('D1 DB is overloaded'));

    await processJob(env, deciderMessage());

    const retryStartedAt =
      vi.mocked(runDeciderCaseViaCli).mock.calls[1]?.[1].resultCallback?.execution.attemptStartedAt;
    expect(retryStartedAt).toEqual(expect.any(Number));
    expect(releasedUnbilledGeneration()).toBe(true);
    void {
      runId,
      model,
      variant: '',
      rep: 0,
      caseId: benchCase.id,
      token: 'token-1',
      attemptStartedAt: retryStartedAt,
    };
    expect(upsertCaseResult).not.toHaveBeenCalled();
    expect(failChunk).not.toHaveBeenCalled();
    expect(recordLaneFailure).not.toHaveBeenCalled();
    expect(deferChunk).toHaveBeenCalledWith(env.BENCH_DB, 'chunk-1', 'token-1', expect.any(Number));
    expect(queueSend).not.toHaveBeenCalledWith(deciderMessage(), expect.anything());
  });

  it('keeps grading the chunk and defers it when clearing an unstarted retry also fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const secondCase = DECIDER_CASES[1];
    mockClaim({ case_ids: JSON.stringify([benchCase.id, secondCase.id]) });
    vi.mocked(runDeciderCaseViaCli)
      .mockResolvedValueOnce({ ...successfulCliResult, text: '', exitCode: 0, costUsd: 0.01 })
      .mockRejectedValueOnce(
        new Error(
          'container /run failed: HTTP 503 container not reached: Error proxying request to container: The container just exited'
        )
      );
    vi.mocked(savePendingDeciderOutput).mockRejectedValueOnce(new Error('D1_ERROR: overloaded'));
    vi.mocked(clearUnbilledCase).mockRejectedValueOnce(new Error('D1_ERROR: overloaded'));

    await processJob(env, deciderMessage());

    expect(releasedUnbilledGeneration()).toBe(true);
    expect(upsertCaseResult).toHaveBeenCalledTimes(1);
    expect(upsertCaseResult).toHaveBeenCalledWith(
      env.BENCH_DB,
      expect.objectContaining({ case_id: secondCase.id }),
      expect.anything()
    );
    expect(failChunk).not.toHaveBeenCalled();
    expect(recordLaneFailure).not.toHaveBeenCalled();
    expect(finishChunk).not.toHaveBeenCalled();
    expect(deferChunk).toHaveBeenCalledWith(env.BENCH_DB, 'chunk-1', 'token-1', expect.any(Number));
    const events = warn.mock.calls.map(([line]) => String(line));
    expect(events).toContain(
      JSON.stringify({
        event: 'benchmark_unstarted_retry_clear_failed',
        runId,
        model,
        variant: '',
        rep: 0,
        caseId: benchCase.id,
        slot: 7,
        chunk: 0,
        attemptStartedAt:
          vi.mocked(runDeciderCaseViaCli).mock.calls[1]?.[1].resultCallback?.execution
            .attemptStartedAt,
        errorCategory: 'd1_error',
      })
    );
    expect(schedulerWaitEvent(warn.mock.calls)).toMatchObject({
      reason: 'grading',
      errorType: 'DeciderGraderRetryError',
    });
  });

  it('defers a killed-before-events case whose retry never reaches the container', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(runDeciderCaseViaCli)
      .mockResolvedValueOnce({
        ...successfulCliResult,
        text: '',
        exitCode: -1,
        eventCount: 0,
        lastEventTypes: [],
      })
      .mockRejectedValueOnce(
        new Error(
          'container /run failed: HTTP 503 container not reached: Error proxying request to container: The container just exited'
        )
      );

    await processJob(env, deciderMessage());

    expect(runDeciderCaseViaCli).toHaveBeenCalledTimes(2);
    expect(releasedUnbilledGeneration()).toBe(true);
    expect(savePendingDeciderOutput).not.toHaveBeenCalled();
    expect(upsertCaseResult).not.toHaveBeenCalled();
    expect(failChunk).not.toHaveBeenCalled();
    expect(recordLaneFailure).not.toHaveBeenCalled();
    expect(finishChunk).not.toHaveBeenCalled();
    expect(deferChunk).toHaveBeenCalledWith(env.BENCH_DB, 'chunk-1', 'token-1', expect.any(Number));
    expect(queueSend).not.toHaveBeenCalledWith(deciderMessage(), expect.anything());
    expect(schedulerWaitEvent(warn.mock.calls)).toMatchObject({
      reason: 'container_capacity',
      errorCategory: 'container_not_reached',
      waitingForOutput: false,
    });
  });

  it('releases a claim the ledger refuses without counting a lane failure', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // The claim batch writes nothing: this chunk no longer owns the case fence.
    fixtureGrant = false;

    await processJob(env, deciderMessage());

    expect(runDeciderCaseViaCli).not.toHaveBeenCalled();
    expect(deferChunk).toHaveBeenCalledWith(env.BENCH_DB, 'chunk-1', 'token-1', expect.any(Number));
    expect(failChunk).not.toHaveBeenCalled();
    expect(recordLaneFailure).not.toHaveBeenCalled();
    expect(queueSend).not.toHaveBeenCalledWith(deciderMessage(), expect.anything());
    expect(upsertCaseResult).not.toHaveBeenCalled();
    const wait = schedulerWaitEvent(warn.mock.calls);
    expect(wait).toMatchObject({ reason: 'claim_lost', waitingForOutput: false });
  });

  it('waits on the ledgered execution when another opener won the paid-case insert', async () => {
    const openedAt = Date.now() - 1_000;
    vi.mocked(getPaidCaseStartedAt).mockResolvedValueOnce(null).mockResolvedValueOnce(openedAt);

    await processJob(env, deciderMessage());

    expect(runDeciderCaseViaCli).not.toHaveBeenCalled();
    expect(deferChunk).not.toHaveBeenCalled();
    expect(recordLaneFailure).not.toHaveBeenCalled();
    expect(queueSend).toHaveBeenCalledWith(deciderMessage(), { delaySeconds: 30 });
  });

  it.each([
    { persisted: false, text: '', lastEventTypes: ['error'], stderrTail: 'HTTP 429 rate limited' },
    { persisted: true, text: '', lastEventTypes: ['error'], stderrTail: 'HTTP 429 rate limited' },
    {
      persisted: false,
      text: 'Partial step before the limit',
      lastEventTypes: ['tool_use', 'error'],
      stderrTail: 'Error: rate\u001b[0m limit reached',
    },
    {
      persisted: false,
      text: 'Partial step before the limit',
      lastEventTypes: ['tool_use', 'error'],
      stderrTail: 'HTTP 429 rate limited',
    },
    {
      persisted: true,
      text: 'Partial step before the limit',
      lastEventTypes: ['tool_use', 'error'],
      stderrTail: 'HTTP 429 rate limited',
    },
    {
      persisted: false,
      text: '',
      lastEventTypes: ['error'],
      stderrTail: '\u001b[91m\u001b[1mError: \u001b[0mInternal Server Error\n',
    },
    {
      persisted: false,
      text: '',
      lastEventTypes: ['step_start', 'error'],
      stderrTail: 'Authorization temporarily unavailable',
    },
  ])(
    'cools down unbilled provider failures and clears transient pending output (%j)',
    async ({ persisted, text, lastEventTypes, stderrTail }) => {
      const claim = mockClaim();
      const result = {
        ...successfulCliResult,
        text,
        lastEventTypes,
        exitCode: 1,
        costUsd: 0,
        stderrTail,
      };
      const persistedStartedAt = 1_729_411_200_000;
      if (persisted) {
        vi.mocked(getPendingDeciderOutput).mockResolvedValueOnce({
          result,
          retried: false,
          attemptStartedAt: persistedStartedAt,
          promptRevision: MEASUREMENT_REVISION,
        });
      } else {
        vi.mocked(runDeciderCaseViaCli).mockResolvedValueOnce(result);
      }
      await processJob(env, deciderMessage());
      const attemptStartedAt = persisted
        ? persistedStartedAt
        : vi.mocked(runDeciderCaseViaCli).mock.calls[0]?.[1].resultCallback?.execution
            .attemptStartedAt;
      expect(attemptStartedAt).toEqual(expect.any(Number));
      expect(releasedUnbilledGeneration()).toBe(true);
      expect(deletePendingDeciderOutput).toHaveBeenCalledTimes(persisted ? 1 : 0);
      expect(runDeciderCaseViaCli).toHaveBeenCalledTimes(persisted ? 0 : 1);
      expect(cooldownModel).toHaveBeenCalledWith(env.BENCH_DB, claim.model, expect.any(Number));
      expect(deferThrottledChunk).toHaveBeenCalledWith(
        env.BENCH_DB,
        'chunk-1',
        'token-1',
        expect.any(Number)
      );
      expect(deferChunk).not.toHaveBeenCalled();
      expect(failChunk).not.toHaveBeenCalled();
      expect(savePendingDeciderOutput).not.toHaveBeenCalled();
      expect(upsertCaseResult).not.toHaveBeenCalled();
      expect(recordLaneFailure).not.toHaveBeenCalled();
    }
  );

  it('keeps a throttled chunk with spent attempts alive until its throttle budget runs out', async () => {
    const throttled = {
      ...successfulCliResult,
      text: '',
      exitCode: 1,
      costUsd: 0,
      stderrTail: 'HTTP 429 rate limited',
    };
    vi.mocked(runDeciderCaseViaCli)
      .mockResolvedValueOnce(throttled)
      .mockResolvedValueOnce(throttled);
    mockClaim({ attempts: SCHEDULER_MAX_ATTEMPTS });
    await processJob(env, deciderMessage());
    expect(deferThrottledChunk).toHaveBeenCalled();
    expect(failChunk).not.toHaveBeenCalled();

    vi.mocked(deferThrottledChunk).mockClear();
    mockClaim({
      attempts: SCHEDULER_MAX_ATTEMPTS,
      throttle_deferrals: SCHEDULER_MAX_THROTTLE_DEFERRALS,
    });
    await processJob(env, deciderMessage());
    expect(deferThrottledChunk).not.toHaveBeenCalled();
    expect(failChunk).toHaveBeenCalledWith(env.BENCH_DB, 'chunk-1', 'token-1');
    expect(recordLaneFailure).toHaveBeenCalledWith(
      env.BENCH_DB,
      expect.objectContaining({ model, failureClass: 'provider_unavailable' })
    );
  });

  it.each([
    {
      name: 'a 429 after a billed step',
      costUsd: 0.02,
      timedOut: false,
      stderrTail: 'HTTP 429 rate limited',
    },
    {
      name: 'an unbilled invalid-request rejection',
      costUsd: 0,
      timedOut: false,
      stderrTail: '[Phala] The request was rejected as invalid',
    },
    {
      name: 'a timeout after an unbilled 429 error event',
      costUsd: 0,
      timedOut: true,
      stderrTail: 'HTTP 429 rate limited',
    },
  ])('keeps a graded failure for $name', async ({ costUsd, timedOut, stderrTail }) => {
    vi.mocked(runDeciderCaseViaCli).mockResolvedValueOnce({
      ...successfulCliResult,
      text: 'Partial step before the error',
      lastEventTypes: ['tool_use', 'error'],
      exitCode: timedOut ? -1 : 1,
      timedOut,
      costUsd,
      stderrTail,
    });
    await processJob(env, deciderMessage());
    expect(deferThrottledChunk).not.toHaveBeenCalled();
    expect(upsertCaseResult).toHaveBeenCalledWith(
      env.BENCH_DB,
      expect.objectContaining({ cost_usd: costUsd }),
      expect.anything()
    );
  });

  it('fails the lane without paying again once a prior paid execution can no longer deliver', async () => {
    vi.mocked(getPaidCaseStartedAt).mockResolvedValue(Date.now() - PAID_OUTPUT_WAIT_MS);
    await processJob(env, deciderMessage());
    expect(warmUpCliContainer).not.toHaveBeenCalled();
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
      failureClass: 'ambiguous_execution',
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

  it('restarts the paid start in the ledger before an empty-output retry', async () => {
    vi.mocked(runDeciderCaseViaCli)
      .mockResolvedValueOnce({ ...successfulCliResult, text: '', costUsd: 0.01 })
      .mockResolvedValueOnce({ ...successfulCliResult, costUsd: 0.02 });
    await processJob(env, deciderMessage());
    const execution = {
      runId,
      model,
      variant: '',
      rep: 0,
      caseId: benchCase.id,
      token: 'token-1',
    };
    // The retry's start moves the run ledger and the canonical case run in one batch, so a
    // ledger-only move cannot make the launch fence refuse the retry as `not_live`.
    const [firstCall, retryCall] = vi.mocked(runDeciderCaseViaCli).mock.invocationCallOrder;
    const restartInvocation = vi
      .mocked(dbBatch)
      .mock.invocationCallOrder.findIndex(order => order > firstCall && order < retryCall);
    expect(restartInvocation).toBeGreaterThanOrEqual(0);
    const restartStatements = vi.mocked(dbBatch).mock.calls[restartInvocation]?.[0] as
      | FakeStatement[]
      | undefined;
    expect(
      restartStatements?.map(statement => statement.sql.trim().split(/\s+/).slice(0, 5).join(' '))
    ).toEqual([
      'UPDATE scheduler_executions SET started_at =',
      'UPDATE benchmark_case_runs SET started_at =',
    ]);
    const [firstInvocation, retryInvocation] = vi.mocked(runDeciderCaseViaCli).mock.calls;
    const firstExecution = firstInvocation?.[1].resultCallback?.execution;
    const retryExecution = retryInvocation?.[1].resultCallback?.execution;
    expect(firstExecution?.attemptStartedAt).toEqual(expect.any(Number));
    expect(retryExecution).toEqual(
      expect.objectContaining({
        ...execution,
        attemptStartedAt: expect.any(Number),
        retried: true,
        priorCostUsd: 0.01,
      })
    );
    expect(retryExecution?.attemptStartedAt).toBeGreaterThan(firstExecution?.attemptStartedAt ?? 0);
    expect(deletePendingDeciderOutput).toHaveBeenCalledWith(env.BENCH_DB, {
      run_id: runId,
      model,
      variant: '',
      rep: 0,
      case_id: benchCase.id,
    });
    expect(upsertCaseResult).toHaveBeenCalledWith(
      env.BENCH_DB,
      expect.objectContaining({ cost_usd: 0.03, retried: true }),
      expect.anything()
    );
    expect(finishChunk).toHaveBeenCalledWith(env.BENCH_DB, 'chunk-1', 'token-1');
  });

  it('never retries a user-pool block automatically after an empty completion', async () => {
    // The same transient shape the platform lane retries once: a lone `step_finish` with
    // no assistant text and no spend. A user-owned generation must never be replayed by
    // the runner on its own — a second paid call would be a second generation nobody asked
    // for — so the empty answer is graded as-is and the block records it.
    const snapshot = await getRunWithModels(env.BENCH_DB, runId);
    if (!snapshot) throw new Error('Run snapshot missing');
    vi.mocked(getRunWithModels).mockResolvedValue({
      ...snapshot,
      run: {
        ...snapshot.run,
        purpose: 'user',
        admission_marker: '2026-06-16T00:00:00.000Z',
      },
    });
    vi.mocked(runDeciderCaseViaCli).mockResolvedValueOnce({
      ...successfulCliResult,
      text: '',
      exitCode: 0,
      costUsd: 0,
      eventCount: 2,
      lastEventTypes: ['step_finish'],
    });

    await processJob(env, deciderMessage());

    // Exactly one invocation: neither the in-process retry nor its ledger restart ran.
    expect(runDeciderCaseViaCli).toHaveBeenCalledTimes(1);
    expect(restartPaidCase).not.toHaveBeenCalled();
    expect(deletePendingDeciderOutput).not.toHaveBeenCalled();
    // What the block records instead: the empty answer is a measured zero, never retried.
    expect(upsertCaseResult).toHaveBeenCalledTimes(1);
    expect(upsertCaseResult).toHaveBeenCalledWith(
      env.BENCH_DB,
      expect.objectContaining({
        case_id: benchCase.id,
        score: 0,
        cost_usd: 0,
        retried: false,
        exit_code: 0,
      }),
      expect.anything()
    );
    expect(recordLaneFailure).not.toHaveBeenCalled();
    expect(failChunk).not.toHaveBeenCalled();
    expect(finishChunk).toHaveBeenCalledWith(env.BENCH_DB, 'chunk-1', 'token-1');
  });

  it.each([
    { name: 'a signal kill before any event', timedOut: false, eventCount: 0, calls: 2 },
    { name: 'a timeout', timedOut: true, eventCount: 0, calls: 1 },
    { name: 'a kill after events', timedOut: false, eventCount: 3, calls: 1 },
  ])(
    'retries $name only when the run said nothing about the model',
    async ({ timedOut, eventCount, calls }) => {
      const killed = {
        ...successfulCliResult,
        text: '',
        exitCode: -1,
        timedOut,
        eventCount,
        lastEventTypes: [],
      };
      for (const result of [killed, successfulCliResult].slice(0, calls)) {
        vi.mocked(runDeciderCaseViaCli).mockResolvedValueOnce(result);
      }
      await processJob(env, deciderMessage());
      expect(runDeciderCaseViaCli).toHaveBeenCalledTimes(calls);
      expect(upsertCaseResult).toHaveBeenCalledWith(
        env.BENCH_DB,
        expect.objectContaining({ retried: calls === 2 }),
        expect.anything()
      );
    }
  );

  it('keeps the original measured failure without another call when the ledger refuses a retry', async () => {
    vi.mocked(runDeciderCaseViaCli).mockResolvedValueOnce({
      ...successfulCliResult,
      text: '',
      costUsd: 0.01,
    });
    // The retry's atomic restatement is refused (its lease/live-run guard does not pass),
    // so the measured first attempt stands instead of paying for a second call.
    fixtureRetryRestart = false;
    await processJob(env, deciderMessage());
    expect(runDeciderCaseViaCli).toHaveBeenCalledTimes(1);
    expect(upsertCaseResult).toHaveBeenCalledWith(
      env.BENCH_DB,
      expect.objectContaining({ score: 0, cost_usd: 0.01, retried: false }),
      expect.anything()
    );
    expect(finishChunk).toHaveBeenCalledWith(env.BENCH_DB, 'chunk-1', 'token-1');
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
      expect.objectContaining({
        result: expect.objectContaining({ text: '42', exitCode: 0 }),
        retried: false,
        promptRevision: 2,
      }),
      execution
    );

    // The paid call was opened before this transport existed, so its output stays old.
    vi.mocked(getPaidCasePromptRevision).mockResolvedValue(1);
    await expect(
      acceptContainerCaseResult(env, { execution, outcome: { kind: 'completed', response } })
    ).resolves.toBe(true);
    expect(savePendingDeciderOutput).toHaveBeenLastCalledWith(
      env.BENCH_DB,
      expect.objectContaining({ case_id: benchCase.id }),
      expect.objectContaining({ promptRevision: 1 }),
      execution
    );

    await expect(
      acceptContainerCaseResult(env, { execution, outcome: { kind: 'not_started' } })
    ).resolves.toBe(true);
    expect(releasedUnbilledGeneration()).toBe(true);

    vi.mocked(getPaidCasePromptRevision).mockResolvedValue(null);
    await expect(
      acceptContainerCaseResult(env, { execution, outcome: { kind: 'not_started' } })
    ).resolves.toBe(false);
    expect(releasedUnbilledGeneration()).toBe(true);
  });

  it('preserves retry cost, tokens, and generation from a container callback through grading', async () => {
    const execution = {
      runId,
      model,
      variant: '',
      rep: 0,
      caseId: benchCase.id,
      token: 'token-1',
      attemptStartedAt: 1_729_411_200_001,
      retried: true,
      priorCostUsd: 0.01,
      priorUsage: {
        inputTokens: 100,
        cachedInputTokens: null,
        outputTokens: 20,
        reasoningTokens: 5,
      },
    };
    const response = {
      exitCode: 0,
      durationMs: 12,
      stdoutLines: [
        '{"type":"text","part":{"text":"42","time":{"end":1}}}',
        '{"type":"step_finish","part":{"cost":0.02,"tokens":{"input":300,"output":40,"reasoning":0,"cache":{"read":50}}}}',
      ],
      stderrTail: '',
    };
    let pending: StoredDeciderOutput | null = null;
    vi.mocked(savePendingDeciderOutput).mockImplementation(async (_db, _key, output) => {
      pending = output;
      return true;
    });
    vi.mocked(getPendingDeciderOutput).mockImplementation(async () => pending);

    await expect(
      acceptContainerCaseResult(env, { execution, outcome: { kind: 'completed', response } })
    ).resolves.toBe(true);

    expect(getPaidCasePromptRevision).toHaveBeenCalledWith(env.BENCH_DB, execution);
    expect(savePendingDeciderOutput).toHaveBeenCalledWith(
      env.BENCH_DB,
      { run_id: runId, model, variant: '', rep: 0, case_id: benchCase.id },
      expect.objectContaining({
        result: expect.objectContaining({ text: '42', costUsd: 0.03 }),
        retried: true,
        promptRevision: 2,
        attemptStartedAt: execution.attemptStartedAt,
      }),
      execution
    );

    await processJob(env, deciderMessage());

    expect(upsertCaseResult).toHaveBeenCalledWith(
      env.BENCH_DB,
      expect.objectContaining({
        cost_usd: 0.03,
        input_tokens: 400,
        cached_input_tokens: 50,
        output_tokens: 60,
        reasoning_tokens: 5,
        retried: true,
        prompt_revision: 2,
      }),
      expect.anything()
    );
    expect(runDeciderCaseViaCli).not.toHaveBeenCalled();
  });

  it.each(['completed', 'not_started'] as const)(
    'rejects a stale generation %s callback using its paid-execution proof',
    async kind => {
      const execution = {
        runId,
        model,
        variant: '',
        rep: 0,
        caseId: benchCase.id,
        token: 'token-1',
        attemptStartedAt: 1_729_411_200_000,
        retried: false,
        priorCostUsd: null,
      };
      vi.mocked(getPaidCasePromptRevision).mockResolvedValueOnce(null);
      const outcome =
        kind === 'completed'
          ? {
              kind,
              response: {
                exitCode: 0,
                durationMs: 12,
                stdoutLines: ['{"type":"text","part":{"text":"obsolete","time":{"end":1}}}'],
                stderrTail: '',
              },
            }
          : { kind };

      await expect(acceptContainerCaseResult(env, { execution, outcome })).resolves.toBe(false);

      expect(getPaidCasePromptRevision).toHaveBeenCalledWith(env.BENCH_DB, execution);
      expect(savePendingDeciderOutput).not.toHaveBeenCalled();
      expect(clearUnbilledCase).not.toHaveBeenCalled();
      expect(deletePendingDeciderOutput).not.toHaveBeenCalled();
      expect(needsPendingOutputRecovery).not.toHaveBeenCalled();
      expect(queueSend).not.toHaveBeenCalled();
      expect(upsertCaseResult).not.toHaveBeenCalled();
    }
  );

  it('stores a recovered output under the transport that produced it', async () => {
    const result = { ...successfulCliResult, text: '42' };
    vi.mocked(getPendingDeciderOutput).mockResolvedValue({
      result,
      retried: false,
      promptRevision: 1,
    });
    await processJob(env, deciderMessage());
    expect(upsertCaseResult).toHaveBeenCalledWith(
      env.BENCH_DB,
      expect.objectContaining({ case_id: benchCase.id, prompt_revision: 1 }),
      expect.anything()
    );
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
      expect.objectContaining({ result, retried: false, attemptStartedAt: expect.any(Number) })
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
      }),
      expect.anything()
    );
  });

  it('retains an ambiguous paid execution when pending-output persistence fails', async () => {
    vi.mocked(savePendingDeciderOutput).mockRejectedValueOnce(new Error('D1 unavailable'));
    await processJob(env, deciderMessage());
    expect(runDeciderCaseViaCli).toHaveBeenCalledTimes(1);
    expect(deferChunk).toHaveBeenCalled();
    expect(clearUnbilledCase).not.toHaveBeenCalled();
    expect(upsertCaseResult).not.toHaveBeenCalled();

    vi.mocked(getPaidCaseStartedAt).mockResolvedValue(Date.now() - 1_000);
    await processJob(env, deciderMessage());

    expect(runDeciderCaseViaCli).toHaveBeenCalledTimes(1);
    expect(failChunk).not.toHaveBeenCalled();
    expect(recordLaneFailure).not.toHaveBeenCalled();
    expect(queueSend).toHaveBeenCalledWith(deciderMessage(), { delaySeconds: 30 });
    expect(upsertCaseResult).not.toHaveBeenCalled();
  });
});

describe('processJob — canonical registry publication', () => {
  function mockPublishHarness(variant: string, reasoningEffort: string | null) {
    mockRunSnapshot([{ model, variant, enqueued: true, reasoning_effort: reasoningEffort }]);
    mockClaim({ variant });
    const cases = deciderCasesForRouter('efficient', MEASUREMENT_REVISION);
    vi.mocked(countCaseResultsByLane).mockResolvedValue([
      { model, variant, rep: 0, n: cases.length },
    ]);
    vi.mocked(getCaseResults).mockResolvedValue(
      cases.map(c => ({
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
        tool_calls: 1,
        tool_names: '["bash"]',
        step_count: 2,
        final_finish_reason: 'stop',
        rep: 0,
        timed_out: 0,
        prompt_revision: MEASUREMENT_REVISION,
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
        avgInputTokens: null,
        avgCachedInputTokens: null,
        avgOutputTokens: null,
        avgReasoningTokens: null,
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

describe('publishPlatformRoutingTable — a live pair that lost its measurement', () => {
  const aliasA = '~vendor/a-latest';
  const aliasB = '~vendor/b-latest';
  const steady = 'vendor/steady';
  const target = 'vendor/target';

  async function publishWithLoss(status: 'failed' | 'pending' | 'running') {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          data: [
            { id: aliasA, alias_target: steady },
            { id: steady },
            { id: aliasB, alias_target: target },
            { id: target },
          ],
        })
      )
    );
    const baseConfig = await getBenchmarkConfig(env.BENCH_DB, 'efficient');
    if (!baseConfig) throw new Error('config missing');
    vi.mocked(getBenchmarkConfig).mockResolvedValue({
      ...baseConfig,
      deciderModels: [{ id: aliasA }, { id: aliasB }],
    });
    vi.mocked(servingSubscriptionSnapshot).mockResolvedValue([
      {
        model: aliasA,
        pairs: [{ model: steady, variant: null }],
        servingPairs: [{ model: steady, variant: null }],
        resolutionError: null,
      },
      {
        model: aliasB,
        pairs: [{ model: target, variant: null }],
        servingPairs: [{ model: target, variant: null }],
        resolutionError: null,
      },
    ]);
    vi.mocked(listReadyCurrentProfilesForEntries).mockResolvedValue([
      { model: steady, variant: '', run_id: 'run-steady' },
    ]);
    vi.mocked(listCurrentPlatformProfileStatuses).mockResolvedValue([
      { model: steady, variant: null, status: 'ready', completed_at: null },
      {
        model: target,
        variant: null,
        status,
        // Only a failure that settled after the cutover is a publishable drop; a pending or
        // running row has no failure instant and must stay a hold.
        completed_at: status === 'failed' ? '2026-02-01T00:00:00.000Z' : null,
      },
    ]);
    vi.mocked(getLatestRoutingTable).mockResolvedValue({
      table: {
        version: 'previous',
        routes: {
          'implementation/code_generation': [{ model: steady }, { model: target }],
        },
      },
      publishedAt: '2026-06-01T00:00:00.000Z',
      // The live table serves the target pair, but it was published before the alias pin
      // advanced to it: the exact membership is the baseline the rebuild compares against,
      // so the newly desired pair makes this a real serving-set change.
      desiredPairs: [JSON.stringify([steady, null])],
    } as never);
    vi.mocked(getSummariesForRuns).mockResolvedValue(
      TAXONOMY_ROUTE_KEYS.map(routeKey => ({
        runId: 'run-steady',
        model: steady,
        variant: null,
        routeKey,
        accuracy: 0.9,
        avgCostUsd: 0.001,
        avgInputTokens: null,
        avgCachedInputTokens: null,
        avgOutputTokens: null,
        avgReasoningTokens: null,
        avgLatencyMs: 100,
        p50LatencyMs: 90,
        p95LatencyMs: 120,
        cases: 5,
        errors: 0,
        timeouts: 0,
        routeAccuracy: null,
      }))
    );
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const published = await publishPlatformRoutingTable(env, fetch, 'efficient');
    const events = log.mock.calls.map(([message]) => JSON.parse(String(message)));
    log.mockRestore();
    return { published, events };
  }

  it('drops a settled failed pair and publishes the rest of the table', async () => {
    const { published, events } = await publishWithLoss('failed');
    expect(published).not.toBeNull();
    expect(saveRoutingTable).toHaveBeenCalledOnce();
    expect(events).toContainEqual({
      event: 'routing_table_publish_dropped_failed_pairs',
      router: 'efficient',
      dropped: [{ model: target, variant: null, status: 'failed' }],
    });
    const table = vi.mocked(saveRoutingTable).mock.calls[0]?.[1];
    expect(
      table?.routes['implementation/code_generation'].map(candidate => candidate.model)
    ).toEqual([steady]);
  });

  it('holds the table while the loss is a measurement still in flight', async () => {
    for (const status of ['pending', 'running'] as const) {
      vi.mocked(saveRoutingTable).mockClear();
      const { published, events } = await publishWithLoss(status);
      expect(published).toBeNull();
      expect(saveRoutingTable).not.toHaveBeenCalled();
      expect(events.map(entry => entry.event)).toContain(
        'routing_table_publish_skipped_serving_pair_unready'
      );
    }
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
    let pending: StoredDeciderOutput | null = null;
    vi.mocked(savePendingDeciderOutput).mockImplementation(async (_db, _key, output) => {
      pending = output;
      return true;
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
    expect(savePendingDeciderOutput).toHaveBeenCalledTimes(1);
    expect(finishChunk).toHaveBeenCalled();
    expect(upsertCaseResult).toHaveBeenCalledWith(
      env.BENCH_DB,
      expect.objectContaining({
        score: 0.76,
        cost_usd: 0.03,
        retried: true,
        error: null,
      }),
      expect.anything()
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
    expect(recordLaneFailure).not.toHaveBeenCalled();
    expect(runDeciderCaseViaCli).not.toHaveBeenCalled();
    expect(upsertCaseResult).not.toHaveBeenCalled();
  });
});

/**
 * The R17 funding cases driven through the REAL `processJob`, real D1 (production migrations)
 * and the real paid store/controller — no mocked pause helper, no mocked `db`/`scheduler`.
 *
 * This is the end-to-end proof the unit-level R17 block above cannot give: the runner's own
 * admission, the canonical case-run transition, the store's `pausePaidUnfundedCaseStatements`
 * and the sibling lane's rows are all the production code paths. Only the two external
 * boundaries are faked: the CLI (no model is called) and the worker's own token mint.
 */
describe('processJob — R17 funding decisions on the production path (real D1)', () => {
  let sqlite: DatabaseSync;
  let db: D1Database;

  beforeEach(() => {
    sqlite = new DatabaseSync(':memory:');
    applyBenchmarkMigrations(sqlite);
    db = sqliteD1(sqlite);
  });

  afterEach(() => {
    sqlite.close();
  });

  /** The real module graph: the file-level mocks above are dropped for these cases. */
  async function realRunModule() {
    vi.resetModules();
    for (const path of [
      './db',
      './scheduler',
      './paid-case-store',
      './paid-benchmark',
      './config',
      './subscriptions',
      './probe/eligibility',
    ])
      vi.doUnmock(path);
    return import('./run');
  }

  const at = '2026-11-20T00:00:00.000Z';
  const engine = computeEngineIdentity('decider', 'efficient');
  /**
   * One platform run holding the refused slot plus a funded sibling lane, with the chunk and
   * ledger state a real claim leaves behind. The case run is `running` under this run's own
   * token, which is exactly what the launch fence granted.
   */
  function seedRun(options: { purpose?: 'platform' | 'user' } = {}) {
    const purpose = options.purpose ?? 'platform';
    sqlite
      .prepare(
        `INSERT INTO benchmark_runs
          (id, kind, router, engine_identity, measurement_revision, status, started_at,
            min_accuracy, switch_cost_factor, max_concurrency, benchmark_user_id,
            benchmark_org_id, repetitions, purpose, admission_marker)
        VALUES (?, 'decider', 'efficient', ?, 3, 'running', ?, 0.7, 1, 4, 'bench-user',
          'bench-org', 1, ?, ?)`
      )
      .run(runId, engine, at, purpose, at);
    sqlite
      .prepare(
        `INSERT INTO run_models (run_id, model, enqueued, reasoning_effort)
        VALUES (?, ?, 1, NULL)`
      )
      .run(runId, model);
    sqlite
      .prepare(`INSERT INTO benchmark_cutover (id, cutover_at) VALUES (1, ?)`)
      .run('2026-01-01T00:00:00.000Z');
    // The refused slot's canonical case run, still `queued`: the production claim batch is
    // what transitions it to `running` under this run and claim token.
    sqlite
      .prepare(
        `INSERT INTO benchmark_case_runs
          (engine_identity, model, variant, rep, case_id, status, generation,
            executor_run_id, executor_token, platform_covered, result_usable,
            created_at, updated_at, started_at)
        VALUES (?, ?, '', 0, ?, 'queued', 0, NULL, NULL, 0, 0, ?, ?, NULL)`
      )
      .run(engine, model, benchCase.id, at, at);
    // No ledger row is seeded: the production claim batch writes it with the `now` the fence
    // then reads back, which is exactly the ownership proof `beginPaidCaseGeneration` needs.
    sqlite
      .prepare(
        `INSERT INTO scheduler_chunks
          (id, run_id, model, variant, providers, rep, chunk, case_ids, status, token, slot,
            lease_until, available_at, attempts, throttle_deferrals, catalog_deferrals)
        VALUES ('chunk-1', ?, ?, '', '[]', 0, 0, ?, 'active', 'token-1', 7,
          9999999999999, 0, 1, 0, 0)`
      )
      .run(runId, model, JSON.stringify([benchCase.id]));
    // The funded sibling lane: its own pair, chunk and generation, all untouched by the stop.
    sqlite
      .prepare(
        `INSERT INTO benchmark_profiles
          (router, model, variant, engine_identity, repetitions, status, run_id, failure_reason,
            requested_at, updated_at, completed_at)
        VALUES ('efficient', ?, '', ?, 1, 'running', ?, NULL, ?, ?, NULL)`
      )
      .run('vendor/sibling', engine, runId, at, at);
    sqlite
      .prepare(
        `INSERT INTO scheduler_chunks
          (id, run_id, model, variant, providers, rep, chunk, case_ids, status, token, slot,
            lease_until, available_at, attempts)
        VALUES ('chunk-sibling', ?, 'vendor/sibling', '', '[]', 0, 0, ?, 'active',
          'token-sibling', 8, 9999999999999, 0, 1)`
      )
      .run(runId, JSON.stringify(['sibling-case']));
  }

  function realEnv() {
    return {
      INTERNAL_API_SECRET_PROD: { get: async () => 'internal-secret' },
      BOT_TOKEN_MINT_SECRET: { get: async () => 'mint-secret' },
      KILO_CLI_API_URL: 'http://host.docker.internal:3000',
      KILO_WEB_API_BASE_URL: 'http://host.docker.internal:3000',
      BENCH_RESULT_URL: 'https://bench.test/container/case-result',
      BENCH_DB: db,
      BENCH_QUEUE: { send: async () => {}, sendBatch: async () => {} },
      BENCHMARK_SCHEDULER_CONFIG: '{}',
      AUTO_ROUTING_CONFIG: { delete: async () => {}, put: async () => {} },
    } as unknown as Env;
  }

  /** The worker's own token mint, the only network call a claim needs before the CLI. */
  function stubMintOnly() {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL) =>
        String(input).includes('/api/internal/bot-token')
          ? Response.json({ token: 'kilo-user-token', expiresAt: '2026-11-20T01:00:00.000Z' })
          : Response.json({ data: [] })
      )
    );
  }

  const deciderJob = {
    runId,
    kind: 'decider' as const,
    model,
    claimId: 'chunk-1',
    claimToken: 'token-1',
  };

  it('pauses the exhausted plan and leaves the funded sibling lane running', async () => {
    seedRun();
    stubMintOnly();
    // The CLI boundary is faked before the module graph loads, so `run.ts` binds the stub.
    vi.doMock('./cli-runner', async importOriginal => {
      const actual = await importOriginal<typeof CliRunnerModule>();
      return {
        ...actual,
        runDeciderCaseViaCli: vi.fn(async () => ({
          ...successfulCliResult,
          text: '',
          exitCode: 1,
          costUsd: 0,
          stderrTail: '{"error":{"code":"no_payer","message":"no payer"}}',
          lastEventTypes: ['error'],
          stop: { reason: 'no_payer', status: 402 },
        })),
        warmUpCliContainer: vi.fn(async () => {}),
        destroyDeciderCliContainer: vi.fn(async () => {}),
      };
    });
    const { processJob: job } = await realRunModule();
    const siblingBefore = sqlite
      .prepare(`SELECT status, run_id FROM benchmark_profiles WHERE model = 'vendor/sibling'`)
      .get();
    const siblingChunkBefore = sqlite
      .prepare(`SELECT status, token, slot FROM scheduler_chunks WHERE id = 'chunk-sibling'`)
      .get();

    // Capture the worker's own output so the funding branch is proven to have run.
    const captured: string[] = [];
    const realLog = console.log;
    const realWarn = console.warn;
    console.log = (...args: unknown[]) => void captured.push(args.map(String).join(' '));
    console.warn = (...args: unknown[]) => void captured.push(args.map(String).join(' '));
    try {
      await job(realEnv(), deciderJob);
    } finally {
      console.log = realLog;
      console.warn = realWarn;
    }
    // The production unfunded branch really ran for this slot.
    const unfunded = captured.find(line => line.includes('benchmark_paid_case_unfunded'));
    expect(unfunded).toBeDefined();
    expect(JSON.parse(unfunded as string)).toMatchObject({
      caseId: benchCase.id,
      model,
      rep: 0,
      code: 'no_payer',
    });

    // Nothing was measured and no lane was failed for the refused slot.
    expect(
      (sqlite.prepare('SELECT COUNT(*) AS c FROM case_results').get() as { c: number }).c
    ).toBe(0);
    expect(
      (sqlite.prepare('SELECT COUNT(*) AS c FROM run_lane_failures').get() as { c: number }).c
    ).toBe(0);
    // The canonical slot is not paused while a funded payer still owns a live case here: the
    // store's `otherLiveCase` guard refuses, so the case run stays exactly as claimed.
    expect(
      sqlite.prepare('SELECT status FROM benchmark_case_runs WHERE case_id = ?').get(benchCase.id)
    ).toEqual({ status: 'running' });
    // The run itself is not killed by one slot's funding problem.
    expect(sqlite.prepare('SELECT status FROM benchmark_runs WHERE id = ?').get(runId)).toEqual({
      status: 'running',
    });
    // The funded sibling lane keeps its profile, its chunk and its claim untouched.
    expect(
      sqlite
        .prepare(`SELECT status, run_id FROM benchmark_profiles WHERE model = 'vendor/sibling'`)
        .get()
    ).toEqual(siblingBefore);
    expect(
      sqlite
        .prepare(`SELECT status, token, slot FROM scheduler_chunks WHERE id = 'chunk-sibling'`)
        .get()
    ).toEqual(siblingChunkBefore);
    expect(sqlite.prepare(`SELECT status FROM benchmark_runs WHERE id = ?`).get(runId)).toEqual({
      status: 'running',
    });
  });

  // Two genuinely refused accounts (both `detached` on this generation) plus an unrelated
  // funded sibling request. The store must pause the exhausted plan — the detached rows are
  // not live payers, and they are not a late join — while the sibling keeps everything.
  it('pauses when both payers of the slot are detached and an unrelated sibling is funded', async () => {
    seedRun({ purpose: 'user' });
    // The slot must be the live generation the controller acts on (readPaidCaseRun requires
    // `running` with an executor), still uncovered so the money pause is legal.
    sqlite
      .prepare(
        `UPDATE benchmark_case_runs
        SET status = 'running', generation = 1, executor_run_id = ?, executor_token = 'token-1',
          started_at = ?, platform_covered = 0
        WHERE case_id = ?`
      )
      .run(runId, at, benchCase.id);
    // Two plans staged on the refused case, both marked detached for this generation.
    for (const [requestId, owner] of [
      ['request-detached-a', 'user-a'],
      ['request-detached-b', 'user-b'],
    ] as const) {
      sqlite
        .prepare(
          `INSERT INTO paid_benchmark_requests
            (id, owner_type, owner_id, router, router_id, pool_version, engine_identity, status,
              quote_id, estimate_microdollars, maximum_microdollars, charged_microdollars,
              plan_cases, staged_cases, actor_user_id, context, created_at, updated_at)
          VALUES (?, 'user', ?, 'efficient', ?, 'pool-v1', ?, 'active', 'q', 20000, 20000, 500,
            1, 1, ?, '{}', ?, ?)`
        )
        .run(requestId, owner, `pool-${requestId}`, engine, owner, at, at);
      sqlite
        .prepare(
          `INSERT INTO paid_benchmark_request_cases
            (request_id, engine_identity, model, variant, rep, case_id, status,
              covered_by_kilo, charged_microdollars, reason, updated_at)
          VALUES (?, ?, ?, '', 0, ?, 'running', 0, 0, NULL, ?)`
        )
        .run(requestId, engine, model, benchCase.id, at);
      // The refusal: this account cannot pay this generation any more.
      sqlite
        .prepare(
          `INSERT INTO benchmark_case_payers
            (engine_identity, model, variant, rep, case_id, generation, owner_type, owner_id,
              request_id, status, reason, created_at, updated_at)
          VALUES (?, ?, '', 0, ?, 1, 'user', ?, ?, 'detached', 'no_funds', ?, ?)`
        )
        .run(engine, model, benchCase.id, owner, requestId, at, at);
    }
    // An unrelated funded request owns a different live case: it must not be touched, and it
    // is not an alternative payer for THIS slot.
    sqlite
      .prepare(
        `INSERT INTO paid_benchmark_requests
          (id, owner_type, owner_id, router, router_id, pool_version, engine_identity, status,
            quote_id, estimate_microdollars, maximum_microdollars, charged_microdollars,
            plan_cases, staged_cases, actor_user_id, context, created_at, updated_at)
        VALUES ('request-funds', 'user', 'user-c', 'efficient', 'pool-funds', 'pool-v1', ?,
          'active', 'q', 20000, 20000, 500, 1, 1, 'user-c', '{}', ?, ?)`
      )
      .run(engine, at, at);
    sqlite
      .prepare(
        `INSERT INTO paid_benchmark_request_cases
          (request_id, engine_identity, model, variant, rep, case_id, status,
            covered_by_kilo, charged_microdollars, reason, updated_at)
        VALUES ('request-funds', ?, ?, '', 0, 'unrelated-case', 'running', 0, 0, NULL, ?)`
      )
      .run(engine, model, at);

    const { pauseUnfundedPaidRequests } = await import('./paid-benchmark');
    const { sqliteD1 } = await import('../test/sqlite-d1');
    const outcome = await pauseUnfundedPaidRequests(
      {
        BENCH_DB: sqliteD1(sqlite),
        KILO_WEB_API_BASE_URL: 'https://web.test',
        INTERNAL_API_SECRET_PROD: { get: async () => 'secret' },
      } as never,
      {
        refusedCases: [
          {
            engineIdentity: engine,
            model,
            variant: '',
            rep: 0,
            caseId: benchCase.id,
            funderRequestId: 'request-detached-a',
          },
        ],
        reason: 'no_payer',
      }
    );

    // Both payers of this slot are durably detached in the current generation, so the store
    // pauses the canonical slot and every plan staged on it — an all-payers-refused stop, not
    // an ambiguity. Nothing here is a guess: no funder exclusion is needed to reach it.
    expect(outcome.paused).toEqual(['request-detached-a', 'request-detached-b']);
    expect(outcome.kept).toEqual([]);
    expect(
      sqlite.prepare('SELECT status FROM benchmark_case_runs WHERE case_id = ?').get(benchCase.id)
    ).toEqual({ status: 'paused' });
    expect(
      sqlite
        .prepare(
          `SELECT id, status, pause_reason, charged_microdollars FROM paid_benchmark_requests
          WHERE id LIKE 'request-detached-%' ORDER BY id`
        )
        .all()
    ).toEqual([
      {
        id: 'request-detached-a',
        status: 'paused',
        pause_reason: 'no_funds',
        charged_microdollars: 500,
      },
      {
        id: 'request-detached-b',
        status: 'paused',
        pause_reason: 'no_funds',
        charged_microdollars: 500,
      },
    ]);
    // Both refused slots stop too.
    expect(
      sqlite
        .prepare(
          `SELECT request_id, status, reason FROM paid_benchmark_request_cases
          WHERE request_id LIKE 'request-detached-%' ORDER BY request_id`
        )
        .all()
    ).toEqual([
      { request_id: 'request-detached-a', status: 'paused', reason: 'no_funds' },
      { request_id: 'request-detached-b', status: 'paused', reason: 'no_funds' },
    ]);
    // The unrelated funded request is never paused and never counted as a payer here.
    expect(
      sqlite
        .prepare(
          "SELECT status, pause_reason FROM paid_benchmark_requests WHERE id = 'request-funds'"
        )
        .get()
    ).toEqual({ status: 'active', pause_reason: null });
    expect(
      (sqlite.prepare('SELECT COUNT(*) AS c FROM case_results').get() as { c: number }).c
    ).toBe(0);
  });

  // Control: a third funded plan that also owns a live case on this slot is an eligible late
  // payer, so the canonical guard must keep the slot and nobody's money stops.
  it('keeps the slot live when an eligible funded plan still owns a live case', async () => {
    seedRun({ purpose: 'user' });
    sqlite
      .prepare(
        `UPDATE benchmark_case_runs
        SET status = 'running', generation = 1, executor_run_id = ?, executor_token = 'token-1',
          started_at = ?, platform_covered = 0
        WHERE case_id = ?`
      )
      .run(runId, at, benchCase.id);
    const seedPlan = (requestId: string, owner: string, status: string, payer: string | null) => {
      sqlite
        .prepare(
          `INSERT INTO paid_benchmark_requests
            (id, owner_type, owner_id, router, router_id, pool_version, engine_identity, status,
              quote_id, estimate_microdollars, maximum_microdollars, charged_microdollars,
              plan_cases, staged_cases, actor_user_id, context, created_at, updated_at)
          VALUES (?, 'user', ?, 'efficient', ?, 'pool-v1', ?, 'active', 'q', 20000, 20000, 500,
            1, 1, ?, '{}', ?, ?)`
        )
        .run(requestId, owner, `pool-${requestId}`, engine, owner, at, at);
      sqlite
        .prepare(
          `INSERT INTO paid_benchmark_request_cases
            (request_id, engine_identity, model, variant, rep, case_id, status,
              covered_by_kilo, charged_microdollars, reason, updated_at)
          VALUES (?, ?, ?, '', 0, ?, 'running', 0, 0, NULL, ?)`
        )
        .run(requestId, engine, model, benchCase.id, at);
      if (payer !== null)
        sqlite
          .prepare(
            `INSERT INTO benchmark_case_payers
              (engine_identity, model, variant, rep, case_id, generation, owner_type, owner_id,
                request_id, status, reason, created_at, updated_at)
            VALUES (?, ?, '', 0, ?, 1, 'user', ?, ?, ?, NULL, ?, ?)`
          )
          .run(engine, model, benchCase.id, owner, requestId, payer, at, at);
    };
    // Two refused (detached) plans plus a third funded plan on the same case that is not
    // detached: it can still pay, so it is an eligible late join.
    seedPlan('request-detached-a', 'user-a', 'running', 'detached');
    seedPlan('request-detached-b', 'user-b', 'running', 'detached');
    seedPlan('request-funded-late', 'user-c', 'running', 'accepted');

    const { pauseUnfundedPaidRequests } = await import('./paid-benchmark');
    const { sqliteD1 } = await import('../test/sqlite-d1');
    const outcome = await pauseUnfundedPaidRequests(
      {
        BENCH_DB: sqliteD1(sqlite),
        KILO_WEB_API_BASE_URL: 'https://web.test',
        INTERNAL_API_SECRET_PROD: { get: async () => 'secret' },
      } as never,
      {
        refusedCases: [
          {
            engineIdentity: engine,
            model,
            variant: '',
            rep: 0,
            caseId: benchCase.id,
            funderRequestId: 'request-detached-a',
          },
        ],
        reason: 'no_payer',
      }
    );

    // The funded late plan keeps the slot alive: nothing pauses, nothing is charged twice.
    expect(outcome.paused).toEqual([]);
    expect(outcome.kept).toEqual([
      'request-detached-a',
      'request-detached-b',
      'request-funded-late',
    ]);
    expect(
      sqlite.prepare('SELECT status FROM benchmark_case_runs WHERE case_id = ?').get(benchCase.id)
    ).toEqual({ status: 'running' });
    expect(
      sqlite.prepare(`SELECT id, status FROM paid_benchmark_requests ORDER BY id`).all()
    ).toEqual([
      { id: 'request-detached-a', status: 'active' },
      { id: 'request-detached-b', status: 'active' },
      { id: 'request-funded-late', status: 'active' },
    ]);
    expect(
      (sqlite.prepare('SELECT COUNT(*) AS c FROM case_results').get() as { c: number }).c
    ).toBe(0);
  });

  // The exhausted single-payer plan pauses through the store's canonical guard: one live
  // generation, one plan staged on it, nobody else able to pay. This is the all-payers-refused
  // outcome, asserted on rows rather than on the absence of harm.
  it('pauses the slot and the plan when no other payer owns a live case', async () => {
    seedRun({ purpose: 'user' });
    sqlite
      .prepare(
        `UPDATE benchmark_case_runs
        SET status = 'running', generation = 1, executor_run_id = ?, executor_token = 'token-1',
          started_at = ?, platform_covered = 0
        WHERE case_id = ?`
      )
      .run(runId, at, benchCase.id);
    sqlite
      .prepare(
        `INSERT INTO paid_benchmark_requests
          (id, owner_type, owner_id, router, router_id, pool_version, engine_identity, status,
            quote_id, estimate_microdollars, maximum_microdollars, charged_microdollars,
            plan_cases, staged_cases, actor_user_id, context, created_at, updated_at)
        VALUES ('request-solo', 'user', 'user-a', 'efficient', 'pool-solo', 'pool-v1', ?, 'active',
          'q', 20000, 20000, 500, 1, 1, 'user-a', '{}', ?, ?)`
      )
      .run(engine, at, at);
    sqlite
      .prepare(
        `INSERT INTO paid_benchmark_request_cases
          (request_id, engine_identity, model, variant, rep, case_id, status,
            covered_by_kilo, charged_microdollars, reason, updated_at)
        VALUES ('request-solo', ?, ?, '', 0, ?, 'running', 0, 0, NULL, ?)`
      )
      .run(engine, model, benchCase.id, at);

    const { pauseUnfundedPaidRequests } = await import('./paid-benchmark');
    const { sqliteD1 } = await import('../test/sqlite-d1');
    const outcome = await pauseUnfundedPaidRequests(
      {
        BENCH_DB: sqliteD1(sqlite),
        KILO_WEB_API_BASE_URL: 'https://web.test',
        INTERNAL_API_SECRET_PROD: { get: async () => 'secret' },
      } as never,
      {
        refusedCases: [
          {
            engineIdentity: engine,
            model,
            variant: '',
            rep: 0,
            caseId: benchCase.id,
            funderRequestId: 'request-solo',
          },
        ],
        reason: 'no_payer',
      }
    );

    expect(outcome).toEqual({ paused: ['request-solo'], kept: [] });
    expect(
      sqlite
        .prepare('SELECT status, failure_reason FROM benchmark_case_runs WHERE case_id = ?')
        .get(benchCase.id)
    ).toEqual({ status: 'paused', failure_reason: 'no_funds' });
    expect(
      sqlite
        .prepare(
          "SELECT status, pause_reason, charged_microdollars FROM paid_benchmark_requests WHERE id = 'request-solo'"
        )
        .get()
    ).toEqual({ status: 'paused', pause_reason: 'no_funds', charged_microdollars: 500 });
    expect(
      sqlite
        .prepare(
          "SELECT status, reason FROM paid_benchmark_request_cases WHERE request_id = 'request-solo'"
        )
        .get()
    ).toEqual({ status: 'paused', reason: 'no_funds' });
    expect(
      (sqlite.prepare('SELECT COUNT(*) AS c FROM case_results').get() as { c: number }).c
    ).toBe(0);
  });
});
