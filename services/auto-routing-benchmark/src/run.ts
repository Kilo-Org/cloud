import {
  ClassifierRunError,
  classifyWithSystemOne,
} from '@kilocode/auto-routing-contracts/classifier';
import {
  CLASSIFIER_WINNER_KV_KEY,
  routingTableKvKey,
  AUTO_ROUTERS,
  type AutoRouter,
  resolveBenchmarkIdentity,
  resolveEffectivePolicy,
  ComplexityLabelsSchema,
  type BenchmarkDeciderModel,
  type BenchmarkKind,
  type BenchmarkModelSummary,
  taxonomyRouteKey,
} from '@kilocode/auto-routing-contracts';
import { formatError } from '@kilocode/worker-utils';
import * as z from 'zod';
import { getBenchmarkConfig } from './config';
import { CLASSIFIER_CASES } from './datasets/classifier-cases';
import { DECIDER_CASES, FRONTIER_CASES } from './datasets/decider-cases';
import caseComplexity from './datasets/case-complexity.json';
import type { RunModelRow, RunRow } from './db';
import {
  countCaseResultsByLane,
  countCurrentProfilesByStatus,
  exactPairKey,
  existsNewerCompletedRun,
  getCaseResults,
  getExistingCaseResultIds,
  reuseDeciderCaseResults,
  getPendingDeciderOutput,
  savePendingDeciderOutput,
  getLatestSummariesByModel,
  getLiveContainerLanes,
  getRunningRun,
  getRunWithModels,
  getLatestRoutingTable,
  getSummaries,
  getSummariesForRuns,
  getRoutingCaseResultsForEntries,
  insertRun,
  listLaneFailures,
  listPendingCurrentProfiles,
  listReadyCurrentProfilesForEntries,
  listStaleRunningDeciderRuns,
  markProfilesFailedForEntries,
  markProfilesFailedForRun,
  markProfilesReadyForRun,
  markProfilesRunningForRun,
  releaseProfileClaims,
  markRunCompleted,
  markRunFailed,
  markStaleRunsFailed,
  failOrphanedRunningProfiles,
  recordLaneFailure,
  replaceModelSummaries,
  saveRoutingTable,
  syncPlatformRegistryRows,
  upsertCaseResult,
  type BenchmarkRunPurpose,
  type CaseResultRow,
  type PendingDeciderOutput,
  type PriorModelResult,
} from './db';
import {
  gradeClassifierOutput,
  gradeDeciderOutput,
  DeciderGraderRetryError,
  type DeciderJudge,
} from './grading';
import { createDeciderJudge } from './decider-judge';
import { createSystemOneClient } from './openrouter';
import {
  buildRoutingTable,
  computeRegistryRoutingTableVersion,
  filterSummariesByProvenance,
} from './routing-table-builder';
import {
  DECIDER_CLI_TIMEOUT_MS,
  destroyDeciderCliContainer,
  isRetryableContainerAvailabilityError,
  isExactModelUnavailableResult,
  parseContainerRunResponse,
  runDeciderCaseViaCli,
  warmUpCliContainer,
} from './cli-runner';
import { variantFromStorage, variantToStorage } from './reasoning-effort';
import {
  catalogCandidatePrices,
  catalogSupportsBenchmarkPair,
  fetchBenchmarkModelCatalog,
} from './platform-models';
import { pickClassifierWinner } from './winner';
import { fetchExecutableBenchmarkModelCatalog } from './executable-models';
import { fetchBenchmarkUserToken } from './benchmark-token';
import {
  PLATFORM_SUBSCRIPTION_OWNER,
  servingSubscriptionSnapshot,
  snapshotPairs,
  syncSubscriptionSnapshot,
} from './subscriptions';
import {
  acquireInitializationLease,
  beginPaidCase,
  claimScheduledChunks,
  clearUnbilledCase,
  hasPaidCase,
  cooldownProviders,
  deferChunk,
  failChunk,
  failScheduledEntry,
  finishChunk,
  getChunk,
  getPaidCaseStartedAt,
  getSchedulerOverrides,
  hasUnsettledChunks,
  recoverChunks,
  releaseInitializationLease,
  restartPaidCase,
  resolveSchedulerConfig,
  scheduleRunChunks,
  schedulerBackoffSeconds,
  startChunk,
  SCHEDULER_MAX_ATTEMPTS,
  type SchedulerClaim,
  type SchedulerConfig,
} from './scheduler';
import { catalogModelProviders } from './platform-models';

/** One exact Pool entry identity used throughout a decider/classifier run. */
export type RunModelEntry = {
  model: string;
  /** Canonical variant; null = default/no variant. */
  variant: string | null;
};

export type BenchmarkJobMessage = {
  runId: string;
  kind: BenchmarkKind;
  model: string;
  /** Exact-pair identity. Optional for backward-compatible old queue messages. */
  variant?: string | null;
  claimId?: string;
  claimToken?: string;
  schedulerWake?: boolean;
  caseIds?: string[];
  chunk?: number;
  shard?: number;
  shardCount?: number;
  chunkSize?: number;
  importedChunks?: number[];
  // Repetition index (0-based).
  rep?: number;
};

export const BenchmarkJobMessageSchema = z.object({
  runId: z.string().min(1),
  kind: z.enum(['classifier', 'decider']),
  model: z.string().min(1),
  variant: z.string().trim().min(1).nullable().optional(),
  caseIds: z.array(z.string().min(1)).optional(),
  chunk: z.number().int().min(0).optional(),
  shard: z.number().int().min(0).optional(),
  shardCount: z.number().int().min(1).optional(),
  chunkSize: z.number().int().min(1).max(5).optional(),
  importedChunks: z.array(z.number().int().min(0)).optional(),
  rep: z.number().int().min(0).optional(),
  claimId: z.string().min(1).optional(),
  claimToken: z.string().min(1).optional(),
  schedulerWake: z.boolean().optional(),
});

export function deciderCasesForRouter(router: AutoRouter = 'efficient') {
  return router === 'frontier' ? FRONTIER_CASES : DECIDER_CASES;
}

/**
 * Cases one model repetition runs for a run kind: the length of the dataset
 * that kind selects. Shared with run progress so a displayed total cannot
 * disagree with the count run completion waits for.
 */
export function expectedCaseCount(kind: BenchmarkKind, router: AutoRouter): number {
  return kind === 'classifier' ? CLASSIFIER_CASES.length : deciderCasesForRouter(router).length;
}

const DECIDER_CHUNK_SIZE = 1;

// Classifier calls are OpenRouter System One HTTP requests. Each queue
// invocation owns exactly one case, so a slow request cannot push a batch past
// Cloudflare Queues' 15-minute wall-clock limit.
const CLASSIFIER_CHUNK_SIZE = 1;

// Parallel OpenRouter calls per classifier job. Classifier work holds no
// containers, so it does not draw on BENCHMARK_CONTAINER_BUDGET.
export const BENCHMARK_CLASSIFIER_PARALLELISM = 80;

// Cloudflare Queues caps a single sendBatch at 100 messages. Classifier fan-out
// can exceed that because each classifier case is its own message, so dispatch
// must be sliced.
const QUEUE_SEND_BATCH_LIMIT = 100;

export function chunkArray<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

// Enqueues messages in sendBatch-sized slices. A mid-dispatch failure leaves a
// partially-enqueued run that can never reach its expected result count, so the
// run is marked failed (surfacing in the admin panel) before the throw
// propagates to the POST handler.
async function enqueueRunMessages(
  env: Env,
  runId: string,
  messages: { body: BenchmarkJobMessage }[]
): Promise<void> {
  for (let i = 0; i < messages.length; i += QUEUE_SEND_BATCH_LIMIT) {
    try {
      await env.BENCH_QUEUE.sendBatch(messages.slice(i, i + QUEUE_SEND_BATCH_LIMIT));
    } catch (error) {
      const reason = `enqueue failed after ${i} of ${messages.length} messages: ${formatError(error).error}`;
      await failRunAndDrain(env, runId, reason).catch(() => {});
      throw error;
    }
  }
}

/**
 * Mark a running run failed, fail the registry rows it claimed, then try to
 * drain both queues into whatever slot just freed up.
 */
export async function failRunAndDrain(env: Env, runId: string, error: string): Promise<void> {
  await markRunFailed(env.BENCH_DB, runId, error);
  try {
    await markProfilesFailedForRun(env.BENCH_DB, runId, error);
  } catch (profileError) {
    console.warn(
      JSON.stringify({
        event: 'benchmark_profile_fail_transition_error',
        runId,
        ...formatError(profileError),
      })
    );
  }
  for (const router of AUTO_ROUTERS) await drainQueues(env, 'both', undefined, router);
}

const STALE_RUN_MAX_AGE_MS = 6 * 3600_000;

// Fails any run still 'running' past the stale threshold (queue retries
// exhausted / dead-lettered). Called both before starting a run and when
// listing runs, so a wedged run is recovered without depending on a new run
// being started (the UI disables Start while a run shows 'running').
// Stale DECIDER runs are salvaged per entry first: entries whose lanes all
// produced results still become `ready`. Only entries with an unfinished lane
// fail, so one wedged model can't discard every other model's measurements —
// which matters because those measurements cost real money.
// Registry rows claimed by a stale run that could not be salvaged are failed so
// they do not stay stuck in `running`.
export async function sweepStaleRuns(env: Env): Promise<string[]> {
  const db = env.BENCH_DB;
  const olderThanIso = new Date(Date.now() - STALE_RUN_MAX_AGE_MS).toISOString();
  // Capture ids before the bulk status flip so profile claims can be settled.
  const stale = await listStaleRunningDeciderRuns(db, olderThanIso).catch(
    () => [] as Array<{ id: string; purpose: BenchmarkRunPurpose }>
  );
  for (const run of stale) {
    // Salvage before the bulk flip — markRunCompleted guards on status='running'.
    await salvageTimedOutDeciderRun(env, run.id).catch(error => {
      console.warn(
        JSON.stringify({
          event: 'benchmark_profile_salvage_error',
          runId: run.id,
          ...formatError(error),
        })
      );
    });
  }
  await markStaleRunsFailed(db, olderThanIso);
  // Rows a terminal run left claimed (its transition threw) are unreachable by
  // the drain, by requeue and by the stale sweep. Settle them so a pool entry
  // can never sit `running` forever.
  await failOrphanedRunningProfiles(db, PROFILE_ORPHANED_CLAIM_FAILURE_REASON, olderThanIso).catch(
    error => {
      console.warn(
        JSON.stringify({ event: 'benchmark_profile_orphan_release_error', ...formatError(error) })
      );
    }
  );
  for (const run of stale) {
    // No-ops for a salvaged run: its rows are already ready/failed.
    await markProfilesFailedForRun(db, run.id, 'timed out').catch(() => {});
  }
  return stale.map(run => run.id);
}

/**
 * Settle a timed-out decider run per entry. Every lane that never produced a
 * full set of case rows is recorded as failed, which lets the normal
 * finalization path complete the run: finished entries go `ready` with their
 * summaries, unfinished ones go `failed` and a requeue re-admits them.
 */
async function salvageTimedOutDeciderRun(env: Env, runId: string): Promise<void> {
  const state = await getRunState(env, runId);
  if (state.status !== 'running') return;

  const { unfinished, deadLaneKeys } = await loadLaneAccounting(
    env.BENCH_DB,
    runId,
    state,
    deciderCasesForRouter(state.router).length
  );
  for (const lane of unfinished) {
    if (deadLaneKeys.has(laneKey(lane.model, lane.variant, lane.rep))) continue;
    await recordLaneFailure(env.BENCH_DB, { runId, ...lane, chunk: 0, shard: 0 });
  }
  console.warn(
    JSON.stringify({
      event: 'benchmark_decider_run_salvaged',
      runId,
      unfinishedLanes: unfinished.length,
    })
  );
  await finalizeRunIfComplete(env, runId, 'decider', state);
}

/**
 * Sweep stale runs, reconcile the platform queue, then drain both registry
 * queues. Used by the scheduled handler so a failed final queue message cannot
 * strand pending work. Never throws for drain/slot contention.
 */
export async function sweepStaleRunsAndDrain(
  env: Env,
  router: AutoRouter = 'efficient'
): Promise<{
  staleRunIds: string[];
  drained: StartedQueueRun[];
}> {
  const staleRunIds = await sweepStaleRuns(env);
  // Each platform drain reconciles the catalog before claiming entries.
  const drained = await drainQueues(env, 'both', undefined, router);
  await dispatchScheduler(env);
  return { staleRunIds, drained };
}

export type StartedQueueRun = {
  router: AutoRouter;
  runId: string;
  purpose: BenchmarkRunPurpose;
  entryCount: number;
};

/**
 * Drain the selected registry queues. 'both' starts at most one run per queue —
 * they hold independent slots and share the container budget. Drain failures
 * are logged per queue, never thrown, so one wedged queue cannot block the other.
 */
export async function drainQueues(
  env: Env,
  selector: 'platform' | 'user' | 'both',
  // Filled with whatever each queue threw. The scheduled callers ignore it; an
  // admin who pressed a button needs to be told the queue is wedged instead of
  // being shown "nothing to run".
  errors?: unknown[],
  router: AutoRouter = 'efficient'
): Promise<StartedQueueRun[]> {
  if (router === 'frontier' && selector === 'user') {
    throw new BenchmarkRunConfigError('The frontier router does not support owner queues');
  }
  const queues: BenchmarkRunPurpose[] =
    selector === 'both'
      ? router === 'frontier'
        ? ['platform']
        : ['platform', 'user']
      : [selector satisfies BenchmarkRunPurpose];
  const started: StartedQueueRun[] = [];
  for (const queue of queues) {
    try {
      const drained = await drainQueue(env, queue, router);
      if (drained) started.push({ ...drained, router, purpose: queue });
    } catch (error) {
      errors?.push(error);
      console.warn(
        JSON.stringify({
          event: 'benchmark_queue_drain_error',
          queue,
          ...formatError(error),
        })
      );
    }
  }
  return started;
}

/**
 * Reconcile the platform queue with the saved decider model list. Every
 * configured exact pair ends up with a current-engine registry row; pairs that
 * already have a `ready` row (measured for an owner pool, or by an earlier
 * platform run) keep it and are not re-benchmarked.
 */
export async function syncPlatformRegistry(
  env: Env,
  fetchImpl: typeof fetch = fetch,
  router: AutoRouter = 'efficient'
): Promise<{ desiredEntries: number }> {
  const config = await getBenchmarkConfig(env.BENCH_DB, router);
  if (!config) return { desiredEntries: 0 };
  const snapshot = await syncSubscriptionSnapshot(
    env,
    config,
    PLATFORM_SUBSCRIPTION_OWNER,
    config.deciderModels.map(model => ({ model: model.id })),
    { fetchImpl }
  );
  const desired = snapshotPairs(snapshot);
  await syncPlatformRegistryRows(
    env.BENCH_DB,
    {
      router,
      engineIdentity: computeEngineIdentity('decider', router),
      repetitions: config.deciderRepetitions,
    },
    desired
  );
  return { desiredEntries: desired.length };
}

/**
 * Rebuild and publish the platform routing table from the registry. Candidates
 * come from ready+current registry rows for the configured platform pairs, each
 * bound to its own measuring run's summaries — the same provenance rule owner
 * pools use, so platform and user tables read the one shared measurement set.
 *
 * The table is published only once the platform queue has settled: no entry
 * still pending or running. Publishing mid-measurement would put a table built
 * from the handful of models measured so far in front of every user — after an
 * engine bump that can be a single model taking all routes. A permanently
 * failing model does not block publishing, because `failed` is settled.
 */
export async function publishPlatformRoutingTable(
  env: Env,
  fetchImpl: typeof fetch = fetch,
  router: AutoRouter = 'efficient'
): Promise<{ version: string } | null> {
  const config = await getBenchmarkConfig(env.BENCH_DB, router);
  if (!config) return null;

  const current = {
    router,
    engineIdentity: computeEngineIdentity('decider', router),
    repetitions: config.deciderRepetitions,
  };
  const catalog = await fetchBenchmarkModelCatalog(env, fetchImpl);
  const snapshot = await servingSubscriptionSnapshot(
    env.BENCH_DB,
    config,
    PLATFORM_SUBSCRIPTION_OWNER
  );
  if (
    snapshot.some(
      entry =>
        entry.model.startsWith('~') &&
        entry.servingPairs.length > 0 &&
        (entry.resolutionError ||
          entry.servingPairs.some(
            serving =>
              !entry.pairs.some(
                target => target.model === serving.model && target.variant === serving.variant
              )
          ))
    )
  )
    return null;
  const desired = snapshotPairs(snapshot, true);
  const prices = catalogCandidatePrices(catalog);
  const queueCounts = await countCurrentProfilesByStatus(env.BENCH_DB, current, 'platform');
  const unsettled = queueCounts
    .filter(row => row.status === 'pending' || row.status === 'running')
    .reduce((total, row) => total + row.count, 0);
  if (unsettled > 0) {
    console.log(
      JSON.stringify({ event: 'routing_table_publish_skipped_queue_unsettled', unsettled })
    );
    return null;
  }

  const readyRows = await listReadyCurrentProfilesForEntries(env.BENCH_DB, current, desired);
  const readyEntries = readyRows
    .filter((row): row is typeof row & { run_id: string } => Boolean(row.run_id))
    .map(row => ({
      entry: { model: row.model, variant: variantFromStorage(row.variant) },
      runId: row.run_id,
    }));
  if (readyEntries.length === 0) {
    console.warn(JSON.stringify({ event: 'routing_table_publish_skipped_no_ready_entries' }));
    return null;
  }

  const [summaries, perCaseResults] = await Promise.all([
    getSummariesForRuns(env.BENCH_DB, [...new Set(readyEntries.map(r => r.runId))]),
    getRoutingCaseResultsForEntries(env.BENCH_DB, readyEntries),
  ]);
  const generatedAt = new Date().toISOString();
  const deciderModels: BenchmarkDeciderModel[] = readyEntries.map(({ entry }) => ({
    id: entry.model,
    variant: entry.variant,
    reasoningEffort: null,
  }));
  const policy = resolveEffectivePolicy(config);
  const minAccuracy = Math.min(
    1,
    policy.minAccuracy + (router === 'frontier' ? policy.frontierMinAccuracyDelta : 0)
  );
  const table = buildRoutingTable({
    version: generatedAt,
    generatedAt,
    minAccuracy,
    accuracyNoiseBand: policy.accuracyNoiseBand,
    switchCostFactor: policy.switchCostFactor,
    bestAccuracySwitchThreshold: policy.bestAccuracySwitchThreshold,
    productionTokenProfile: policy.productionTokenProfile,
    switchHorizonTurns: policy.switchHorizonTurns,
    lowConfidenceThreshold: policy.lowConfidenceThreshold,
    prices,
    deciderModels,
    summaries: filterSummariesByProvenance(readyEntries, summaries),
    perCaseResults,
    complexityLabels: ComplexityLabelsSchema.parse(caseComplexity),
  });
  table.version = `${computeRegistryRoutingTableVersion(
    readyEntries.map(r => ({ runId: r.runId, model: r.entry.model, variant: r.entry.variant })),
    {
      router,
      engineIdentity: current.engineIdentity,
      accuracyNoiseBand: policy.accuracyNoiseBand,
      frontierMinAccuracyDelta: policy.frontierMinAccuracyDelta,
      minAccuracy,
      switchCostFactor: policy.switchCostFactor,
      bestAccuracySwitchThreshold: policy.bestAccuracySwitchThreshold,
      productionTokenProfile: policy.productionTokenProfile,
      switchHorizonTurns: policy.switchHorizonTurns,
      lowConfidenceThreshold: policy.lowConfidenceThreshold,
      prices,
      summaries: filterSummariesByProvenance(readyEntries, summaries),
      effortByComplexity: table.effortByComplexity,
    }
  )}-variants`;

  // The version hashes the contributing registry rows and the config knobs, so
  // an identical version means an identical table. Skip the write and the flush.
  const published = await getLatestRoutingTable(env.BENCH_DB, router).catch(() => null);
  if (published?.table.version === table.version) {
    return { version: table.version };
  }

  await saveRoutingTable(env.BENCH_DB, table, generatedAt, router);
  await env.AUTO_ROUTING_CONFIG.delete(routingTableKvKey(router));
  console.log(
    JSON.stringify({
      event: 'routing_table_published',
      version: table.version,
      readyEntries: readyEntries.length,
      desiredEntries: desired.length,
    })
  );
  return { version: table.version };
}

// Bump when grading logic, the CLI invocation/variant handling, the container
// image's pinned CLI, or any other execution input NOT captured by the dataset
// hash changes in a way that invalidates prior measurements. Forces every
// carried summary to be re-benchmarked on the next run.
const BENCHMARK_ENGINE_VERSION = 1;

function fnv1aHex(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

// Identifies the benchmark inputs that a run measured under, beyond the
// per-model reasoning_effort and run-level repetitions tracked separately:
// the dataset contents (ids + grading checks/expectations) and an engine
// version for code-level execution changes. Two runs sharing this identity
// (plus repetitions + reasoning_effort) produced comparable measurements, so a
// model's prior summaries can be carried instead of re-run.
export function computeEngineIdentity(
  kind: BenchmarkKind,
  router: AutoRouter = 'efficient'
): string {
  const selectedRouter = kind === 'classifier' ? 'efficient' : router;
  const datasetSignature =
    kind === 'classifier'
      ? { engine: 'system-one', cases: CLASSIFIER_CASES }
      : deciderCasesForRouter(selectedRouter);
  return `${selectedRouter}:v${BENCHMARK_ENGINE_VERSION}:${fnv1aHex(JSON.stringify(datasetSignature))}`;
}

function normalizeRunModelEntries(models: readonly (string | RunModelEntry)[]): RunModelEntry[] {
  return models.map(entry => (typeof entry === 'string' ? { model: entry, variant: null } : entry));
}

export function getDeciderContainerInstanceName(
  message: Pick<BenchmarkJobMessage, 'runId' | 'model' | 'variant' | 'rep' | 'chunk' | 'shard'>
): string {
  // Include variant so two variants of one model in one run get distinct lanes.
  // Empty string for null keeps names stable and filesystem/DO-name safe.
  const variantPart = variantToStorage(message.variant);
  return `${message.runId}:${message.model}:${variantPart}:${message.rep ?? 0}:${message.shard ?? 0}`;
}

export function buildClassifierMessages(
  runId: string,
  models: readonly (string | RunModelEntry)[],
  repetitions: number,
  chunks: readonly (readonly { id: string }[])[]
): { body: BenchmarkJobMessage }[] {
  const entries = normalizeRunModelEntries(models);
  return entries.flatMap(entry =>
    Array.from({ length: repetitions }, (_, rep) =>
      chunks.map((chunkCases, chunk) => ({
        body: {
          runId,
          kind: 'classifier',
          model: entry.model,
          variant: entry.variant,
          chunk,
          rep,
          caseIds: chunkCases.map(c => c.id),
        } satisfies BenchmarkJobMessage,
      }))
    ).flat()
  );
}

// Thrown when a run of the same kind is already active. The admin route maps
// it to HTTP 409 so automated callers can distinguish it from a 5xx fault.
export class RunAlreadyActiveError extends Error {
  constructor(
    readonly kind: BenchmarkKind,
    readonly activeRunId: string
  ) {
    super(`a ${kind} benchmark run is already in progress (${activeRunId})`);
    this.name = 'RunAlreadyActiveError';
  }
}

/**
 * Thrown when every entry of a batch was already claimed by the other queue's
 * run. Not a fault: the pairs are being measured, just not by this run.
 */
export class NoEntriesClaimedError extends Error {
  constructor(readonly runId: string) {
    super(`no registry entries left to claim for ${runId}`);
    this.name = 'NoEntriesClaimedError';
  }
}

// Thrown when the saved benchmark config would exceed a hard runtime limit.
// The admin route maps it to HTTP 400 so operators can fix config instead of
// starting a run that will immediately hit platform capacity.
export class BenchmarkRunConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BenchmarkRunConfigError';
  }
}

export type StartRunOptions = {
  router?: AutoRouter;
  /** Classifier only: re-measure models that already have current results. */
  force?: boolean;
  /** Which registry queue this run drains. Classifier runs are always 'platform'. */
  purpose?: BenchmarkRunPurpose;
  /**
   * Registry entry snapshot to measure. Required for decider runs — every
   * decider measurement now comes from the registry queue, never from the saved
   * config list. Ignored for classifier runs.
   */
  entries?: readonly RunModelEntry[];
};

export async function startRun(
  env: Env,
  kind: BenchmarkKind,
  options: StartRunOptions = {}
): Promise<{ runId: string; enqueuedModels: number; skippedModels: string[] }> {
  const router = kind === 'classifier' ? 'efficient' : (options.router ?? 'efficient');
  const purpose: BenchmarkRunPurpose = options.purpose ?? 'platform';
  if (router === 'frontier' && purpose === 'user') {
    throw new BenchmarkRunConfigError('The frontier router does not support owner queues');
  }
  if (kind === 'decider' && (!options.entries || options.entries.length === 0)) {
    throw new BenchmarkRunConfigError('decider runs require a non-empty registry entry snapshot');
  }

  // Stale-run sweeper: fail dead 'running' runs first so a wedged run can't
  // block new ones and the admin panel shows the truth.
  await sweepStaleRuns(env);

  const config = await getBenchmarkConfig(env.BENCH_DB, router);
  if (!config) {
    throw new Error('benchmark config not set: save it in the admin panel before starting a run');
  }

  // One active run per (kind, purpose). The unique partial index is the atomic
  // backstop; this pre-check turns the common case (a run already going) into a
  // clean RunAlreadyActiveError instead of an insert-constraint failure.
  // The platform and user queues hold independent slots and can run at once.
  const activeRun = await getRunningRun(env.BENCH_DB, kind, purpose, router);
  if (activeRun) {
    throw new RunAlreadyActiveError(kind, activeRun.id);
  }
  const repetitions =
    kind === 'classifier' ? config.classifierRepetitions : config.deciderRepetitions;

  // Decider entries always come from the registry queue snapshot (which may
  // include two variants of one model). Classifier still measures its own list.
  const modelEntries: RunModelEntry[] =
    kind === 'decider'
      ? normalizeRunModelEntries(options.entries ?? [])
      : config.classifierModels.map(model => ({ model, variant: null }));

  const engineIdentity = computeEngineIdentity(kind, router);

  // Classifier entries with prior results are skipped (their latest summaries
  // are carried into this run's aggregate) unless the admin forces a re-run. A
  // prior result is only carried when it was measured under the SAME benchmark
  // identity — engine identity (dataset + grading version) and repetitions — so
  // a config/dataset change re-benchmarks instead of pairing current serving
  // config with stale numbers.
  // Decider runs never carry: the registry already dedupes across runs, and
  // registry provenance must point at a run that actually graded these entries.
  const priorByPair =
    options.force || kind === 'decider'
      ? new Map<string, PriorModelResult>()
      : await getLatestSummariesByModel(env.BENCH_DB, kind, router);
  const isCarryable = (entry: RunModelEntry): boolean => {
    const prior = priorByPair.get(exactPairKey(entry.model, entry.variant));
    return (
      prior !== undefined &&
      prior.engineIdentity === engineIdentity &&
      prior.repetitions === repetitions &&
      (prior.variant ?? null) === (entry.variant ?? null)
    );
  };
  const enqueuedEntries = modelEntries.filter(e => !isCarryable(e));
  const skippedEntries = modelEntries.filter(e => isCarryable(e));
  const skippedModels = skippedEntries.map(e => e.model);
  const carriedSummaries = skippedEntries.flatMap(
    e => priorByPair.get(exactPairKey(e.model, e.variant))?.summaries ?? []
  );

  const benchmarkIdentity = resolveBenchmarkIdentity(config);

  const laneBudget = kind === 'classifier' ? BENCHMARK_CLASSIFIER_PARALLELISM : 0;

  const startedAt = new Date().toISOString();
  // Distinguish user-queue run ids so ops logs and D1 rows are easy to filter.
  // The nonce matters: two drains of one queue can reach here in the same
  // millisecond, and a shared id makes each one's claim match the other's rows —
  // the loser's release would then hand back rows the winner is measuring.
  const runId =
    (router === 'frontier' ? 'frontier-' : '') +
    (purpose === 'user' ? 'user' : kind) +
    `-${startedAt.replace(/[:.]/g, '-')}-${crypto.randomUUID().slice(0, 8)}`;

  // Claim the registry rows BEFORE writing the run. Both queues drain from the
  // same registry and their drains can overlap (cron, admin, run completion), so
  // whichever claim lands first owns the pair; the loser drops it instead of
  // paying to benchmark it a second time and then discarding the result.
  let claimedEntries: RunModelEntry[] = modelEntries;
  if (kind === 'decider') {
    try {
      claimedEntries = await markProfilesRunningForRun(env.BENCH_DB, runId, modelEntries, {
        router,
        engineIdentity,
        repetitions,
      });
    } catch (error) {
      // The claim walks entries one statement at a time, so a failure part-way
      // leaves earlier rows claimed by a run that will never be written. Give
      // them straight back rather than leaving them for the orphan sweep.
      await releaseProfileClaims(env.BENCH_DB, runId).catch(releaseError => {
        console.warn(
          JSON.stringify({
            event: 'benchmark_profile_claim_release_error',
            runId,
            ...formatError(releaseError),
          })
        );
      });
      throw error;
    }
    if (claimedEntries.length === 0) {
      throw new NoEntriesClaimedError(runId);
    }
  }
  const claimedPairKeys = new Set(claimedEntries.map(e => exactPairKey(e.model, e.variant)));
  const runEntries = modelEntries.filter(e =>
    claimedPairKeys.has(exactPairKey(e.model, e.variant))
  );
  const enqueuedRunEntries = enqueuedEntries.filter(e =>
    claimedPairKeys.has(exactPairKey(e.model, e.variant))
  );

  // Build run_models rows for ALL exact entries of this run. reasoning_effort is
  // a legacy mirror of the variant, kept for provenance and rollback.
  const enqueuedPairKeys = new Set(enqueuedRunEntries.map(e => exactPairKey(e.model, e.variant)));
  const runModelRows: RunModelRow[] = runEntries.map(entry => ({
    run_id: runId,
    model: entry.model,
    variant: variantToStorage(entry.variant),
    enqueued: enqueuedPairKeys.has(exactPairKey(entry.model, entry.variant)),
    reasoning_effort: entry.variant,
  }));

  try {
    await insertRun(
      env.BENCH_DB,
      {
        id: runId,
        router,
        accuracy_noise_band: config.accuracyNoiseBand,
        frontier_min_accuracy_delta: config.frontierMinAccuracyDelta,
        kind,
        startedAt,
        min_accuracy: config.minAccuracy,
        switch_cost_factor: config.switchCostFactor,
        best_accuracy_switch_threshold: config.bestAccuracySwitchThreshold,
        max_concurrency: laneBudget,
        benchmark_user_id: benchmarkIdentity.benchmarkUserId,
        benchmark_org_id: benchmarkIdentity.benchmarkOrgId,
        repetitions,
        classifier_max_p95_latency_ms:
          kind === 'classifier' ? config.classifierMaxP95LatencyMs : null,
        engine_identity: engineIdentity,
        purpose,
      },
      runModelRows,
      carriedSummaries
    );
  } catch (error) {
    // The claim is already made, so hand the rows back to the queue — otherwise
    // they sit `running` under a run that was never written and nothing can
    // reach them.
    if (kind === 'decider') {
      await releaseProfileClaims(env.BENCH_DB, runId).catch((releaseError: unknown) => {
        console.warn(
          JSON.stringify({
            event: 'benchmark_profile_claim_release_error',
            runId,
            ...formatError(releaseError),
          })
        );
      });
    }
    const winner = await getRunningRun(env.BENCH_DB, kind, purpose, router).catch(() => undefined);
    if (winner && winner.id !== runId) {
      throw new RunAlreadyActiveError(kind, winner.id);
    }
    throw error;
  }
  if (kind === 'decider') {
    try {
      await reuseDeciderCaseResults(env.BENCH_DB, {
        runId,
        router,
        engineIdentity,
        repetitions,
        entries: enqueuedRunEntries,
      });
    } catch (error) {
      const reason = `case reuse failed: ${formatError(error).error}`;
      await markRunFailed(env.BENCH_DB, runId, reason);
      await markProfilesFailedForRun(env.BENCH_DB, runId, reason);
      throw error;
    }
  }

  console.log(
    JSON.stringify({
      event: 'benchmark_run_started',
      runId,
      kind,
      purpose,
      enqueuedModels: enqueuedRunEntries.map(e => e.model),
      skippedModels,
    })
  );

  if (enqueuedRunEntries.length === 0) {
    // Everything already has results: complete immediately and republish the
    // aggregate so config-only changes (model removed, threshold tweaked)
    // take effect without re-running any model. The state mirrors the rows
    // insertRun just wrote, so no re-read is needed.
    await finalizeRunIfComplete(env, runId, kind, {
      router,
      status: 'running',
      minAccuracy: config.minAccuracy,
      switchCostFactor: config.switchCostFactor,
      bestAccuracySwitchThreshold: config.bestAccuracySwitchThreshold,
      benchmarkUserId: benchmarkIdentity.benchmarkUserId,
      benchmarkOrgId: benchmarkIdentity.benchmarkOrgId,
      models: runModelRows,
      repetitions,
      classifierMaxP95LatencyMs: kind === 'classifier' ? config.classifierMaxP95LatencyMs : null,
      startedAt,
      purpose,
    });
    return { runId, enqueuedModels: 0, skippedModels };
  }

  if (kind === 'classifier') {
    const chunks = chunkArray(CLASSIFIER_CASES, CLASSIFIER_CHUNK_SIZE);
    const messages = buildClassifierMessages(runId, enqueuedRunEntries, repetitions, chunks);
    await enqueueRunMessages(env, runId, messages);
    return { runId, enqueuedModels: enqueuedRunEntries.length, skippedModels };
  }

  try {
    await initializeScheduledRun(env, runId);
    await dispatchScheduler(env);
    await finalizeRunIfComplete(env, runId, kind, await getRunState(env, runId));
  } catch (error) {
    const reason = `scheduler initialization failed: ${formatError(error).error}`;
    await markRunFailed(env.BENCH_DB, runId, reason);
    await markProfilesFailedForRun(env.BENCH_DB, runId, reason);
    throw error;
  }
  return { runId, enqueuedModels: enqueuedRunEntries.length, skippedModels };
}

export async function drainQueue(
  env: Env,
  queue: BenchmarkRunPurpose,
  router: AutoRouter = 'efficient'
): Promise<{ runId: string; entryCount: number } | null> {
  if (router === 'frontier' && queue === 'user') {
    throw new BenchmarkRunConfigError('The frontier router does not support owner queues');
  }
  const config = await getBenchmarkConfig(env.BENCH_DB, router);
  if (!config) return null;

  const active = await getRunningRun(env.BENCH_DB, 'decider', queue, router);
  if (active) {
    console.log(
      JSON.stringify({
        event: 'benchmark_queue_drain_skipped_slot_occupied',
        queue,
        activeRunId: active.id,
      })
    );
    return null;
  }

  // Reconcile saved snapshots, not the live alias targets.
  if (queue === 'platform') await syncPlatformRegistry(env, fetch, router);

  const engineIdentity = computeEngineIdentity('decider', router);
  const repetitions = config.deciderRepetitions;
  const maxEntries = 100;

  const current = { router, engineIdentity, repetitions };
  const pending = await listPendingCurrentProfiles(env.BENCH_DB, current, queue);
  if (pending.length === 0) return null;
  const catalog = await fetchExecutableBenchmarkModelCatalog(env, resolveBenchmarkIdentity(config));
  const unavailable = pending.filter(
    row =>
      !catalogSupportsBenchmarkPair(catalog, {
        model: row.model,
        variant: variantFromStorage(row.variant),
      })
  );
  if (unavailable.length > 0) {
    await env.BENCH_DB.batch(
      unavailable.map(row =>
        env.BENCH_DB.prepare(
          "UPDATE benchmark_profiles SET status = 'failed', failure_reason = ?, updated_at = ? WHERE router = ? AND model = ? AND variant = ? AND engine_identity = ? AND repetitions = ? AND status = 'pending'"
        ).bind(
          'Model or variant is unavailable in the executable benchmark catalog.',
          new Date().toISOString(),
          router,
          row.model,
          row.variant,
          engineIdentity,
          repetitions
        )
      )
    );
  }
  const available = pending.filter(row =>
    catalogSupportsBenchmarkPair(catalog, {
      model: row.model,
      variant: variantFromStorage(row.variant),
    })
  );
  if (available.length === 0) return null;

  const batch = available.slice(0, maxEntries);
  const entries: RunModelEntry[] = batch.map(row => ({
    model: row.model,
    variant: variantFromStorage(row.variant),
  }));

  try {
    const result = await startRun(env, 'decider', { router, purpose: queue, entries });
    console.log(
      JSON.stringify({
        event: 'benchmark_queue_drain_started',
        queue,
        runId: result.runId,
        entryCount: result.enqueuedModels,
        models: entries.map(e => e.model),
      })
    );
    // The claimed count, not the requested one — the other queue may have taken
    // part of this batch between the read and the claim.
    return { runId: result.runId, entryCount: result.enqueuedModels };
  } catch (error) {
    if (error instanceof RunAlreadyActiveError) {
      console.log(
        JSON.stringify({
          event: 'benchmark_queue_drain_skipped_slot_occupied',
          queue,
          activeRunId: error.activeRunId,
        })
      );
      return null;
    }
    if (error instanceof NoEntriesClaimedError) {
      // The other queue claimed this whole batch between our read and our
      // claim. The pairs are being measured; nothing to do.
      console.log(JSON.stringify({ event: 'benchmark_queue_drain_batch_already_claimed', queue }));
      return null;
    }
    throw error;
  }
}

async function initializeScheduledRun(env: Env, runId: string): Promise<boolean> {
  const initialized = await env.BENCH_DB.prepare(
    'SELECT run_id FROM scheduler_runs WHERE run_id = ?'
  )
    .bind(runId)
    .first();
  if (initialized) return true;
  const { run, models } = (await getRunWithModels(env.BENCH_DB, runId)) ?? {};
  if (!run || !models || run.status !== 'running') return false;
  if (!run.benchmark_user_id) {
    throw new BenchmarkRunConfigError('Benchmark run is missing its execution identity.');
  }
  const catalog = await fetchExecutableBenchmarkModelCatalog(env, {
    benchmarkUserId: run.benchmark_user_id,
    benchmarkOrgId: run.benchmark_org_id,
  });
  return scheduleRunChunks(env.BENCH_DB, {
    runId,
    entries: models
      .filter(model => model.enqueued)
      .map(model => ({
        model: model.model,
        variant: variantFromStorage(model.variant),
        providers: catalogModelProviders(catalog, model.model),
      })),
    repetitions: run.repetitions,
    caseIds: deciderCasesForRouter(run.router).map(benchCase => benchCase.id),
    chunkSize: DECIDER_CHUNK_SIZE,
  });
}

/**
 * Advances every uninitialized running decider run by one bounded materialization
 * pass and reports whether any of them finished initializing.
 */
async function initializeScheduledRuns(env: Env): Promise<boolean> {
  const uninitialized = await env.BENCH_DB.prepare(`
    SELECT id FROM benchmark_runs WHERE kind = 'decider' AND status = 'running'
      AND NOT EXISTS (SELECT 1 FROM scheduler_runs WHERE run_id = benchmark_runs.id) LIMIT 3
  `).all<{ id: string }>();
  if (uninitialized.results.length === 0) return false;
  const token = crypto.randomUUID();
  if (!(await acquireInitializationLease(env.BENCH_DB, token, Date.now()))) return false;
  try {
    let initialized = false;
    for (const run of uninitialized.results) {
      if (await initializeScheduledRun(env, run.id)) initialized = true;
    }
    return initialized;
  } finally {
    await releaseInitializationLease(env.BENCH_DB, token);
  }
}

async function dispatchClaims(env: Env, config: SchedulerConfig): Promise<number> {
  const claims = await claimScheduledChunks(env.BENCH_DB, config, Date.now(), crypto.randomUUID());
  for (const [index, claim] of claims.entries()) {
    try {
      await env.BENCH_QUEUE.send({
        runId: claim.run_id,
        kind: 'decider',
        model: claim.model,
        claimId: claim.id,
        claimToken: claim.token,
      });
    } catch (error) {
      for (const unsent of claims.slice(index)) {
        await deferChunk(env.BENCH_DB, unsent.id, unsent.token, Date.now());
      }
      throw error;
    }
  }
  return claims.length;
}

/**
 * Claims for initialized runs before materializing uninitialized ones, so a large run
 * that takes several passes to initialize never holds back other runs' dispatch. A
 * pass that completes a run's initialization claims again to start its chunks.
 */
export async function dispatchScheduler(env: Env): Promise<void> {
  const { config } = resolveSchedulerConfig(
    env.BENCHMARK_SCHEDULER_CONFIG,
    (await getSchedulerOverrides(env.BENCH_DB)).overrides
  );
  const failed = await recoverChunks(env.BENCH_DB, Date.now());
  for (const claim of failed) {
    await recordLaneFailure(env.BENCH_DB, {
      runId: claim.run_id,
      model: claim.model,
      variant: claim.variant,
      rep: claim.rep,
      chunk: claim.chunk,
      shard: 0,
    });
    await finalizeRunIfComplete(env, claim.run_id, 'decider', await getRunState(env, claim.run_id));
  }
  const settled = await env.BENCH_DB.prepare(`
    SELECT id FROM benchmark_runs WHERE kind = 'decider' AND status = 'running'
      AND EXISTS (SELECT 1 FROM scheduler_runs WHERE run_id = benchmark_runs.id)
      AND NOT EXISTS (SELECT 1 FROM scheduler_chunks WHERE run_id = benchmark_runs.id
        AND status IN ('pending', 'queued', 'active')) LIMIT 3
  `).all<{ id: string }>();
  for (const run of settled.results) {
    await finalizeRunIfComplete(env, run.id, 'decider', await getRunState(env, run.id));
  }
  let claimed = await dispatchClaims(env, config);
  if (await initializeScheduledRuns(env)) claimed += await dispatchClaims(env, config);
  console.log(
    JSON.stringify({
      event: 'benchmark_scheduler_dispatched',
      activeSlots: await getLiveContainerLanes(env.BENCH_DB),
      slots: config.slots,
      claimed,
    })
  );
}

// A container that loses its caller still finishes the paid case, then posts the outcome
// to /container/case-result. Delivery covers the container's own start (at most ~30s)
// and three timed post attempts (at most ~36s), with headroom.
const CONTAINER_DELIVERY_WINDOW_MS = 90_000;
export const PAID_OUTPUT_WAIT_MS = DECIDER_CLI_TIMEOUT_MS + CONTAINER_DELIVERY_WINDOW_MS;
const PAID_OUTPUT_RECHECK_MS = 30_000;

class AmbiguousBenchmarkExecutionError extends Error {
  /**
   * Until this time the container may still deliver the paid call's output, so the
   * chunk keeps its slot and provider lease and rechecks instead of failing its lane.
   * Null when no ledger row remains to wait on.
   */
  readonly outputDeadline: number | null;

  constructor(paidStartedAt: number | null, options?: ErrorOptions) {
    super(
      'Previous paid execution has no recoverable output; refusing automatic duplicate inference',
      options
    );
    this.outputDeadline = paidStartedAt === null ? null : paidStartedAt + PAID_OUTPUT_WAIT_MS;
  }
}

class BenchmarkThrottleError extends Error {}

class BenchmarkModelUnavailableError extends Error {}

export const PROFILE_MODEL_UNAVAILABLE_FAILURE_REASON =
  'Exact benchmark model or variant is unavailable to the benchmark CLI; retry after availability is restored.';

const ContainerCaseResultSchema = z.object({
  execution: z.object({
    runId: z.string(),
    model: z.string(),
    variant: z.string(),
    rep: z.number().int(),
    caseId: z.string(),
    token: z.string(),
  }),
  outcome: z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('completed'),
      response: z.object({
        exitCode: z.number(),
        durationMs: z.number(),
        stdoutLines: z.array(z.string()),
        stderrTail: z.string(),
        timedOut: z.boolean().optional(),
      }),
    }),
    z.object({ kind: z.literal('not_started') }),
  ]),
});

/**
 * Accepts an outcome a container posted after losing its caller. Only the claim
 * token that opened the paid execution can record it: a completed run becomes
 * recoverable output, and a case that never started releases its ledger entry.
 */
export async function acceptContainerCaseResult(env: Env, body: unknown): Promise<boolean> {
  const parsed = ContainerCaseResultSchema.safeParse(body);
  if (!parsed.success) return false;
  const { execution, outcome } = parsed.data;
  if (!(await hasPaidCase(env.BENCH_DB, execution))) return false;
  if (outcome.kind === 'not_started') {
    await clearUnbilledCase(env.BENCH_DB, execution);
  } else {
    await savePendingDeciderOutput(
      env.BENCH_DB,
      {
        run_id: execution.runId,
        model: execution.model,
        variant: execution.variant,
        case_id: execution.caseId,
        rep: execution.rep,
      },
      {
        result: parseContainerRunResponse(outcome.response, Date.now(), execution.model),
        retried: false,
      }
    );
  }
  console.log(
    JSON.stringify({
      event: 'benchmark_container_result_recovered',
      runId: execution.runId,
      model: execution.model,
      outcome: outcome.kind,
    })
  );
  return true;
}

async function processScheduledChunk(env: Env, id: string, token: string): Promise<void> {
  const claim = await getChunk(env.BENCH_DB, id, token);
  if (!claim) return;
  if (!(await startChunk(env.BENCH_DB, id, token, Date.now()))) return;
  let state: RunState | undefined;
  try {
    state = await getRunState(env, claim.run_id);
    await processDeciderJob(
      env,
      {
        runId: claim.run_id,
        kind: 'decider',
        model: claim.model,
        variant: variantFromStorage(claim.variant),
        rep: claim.rep,
        chunk: claim.chunk,
        caseIds: z.array(z.string()).parse(JSON.parse(claim.case_ids)),
      },
      state,
      claim
    );
    await finishChunk(env.BENCH_DB, id, token);
  } catch (error) {
    const outputDeadline =
      error instanceof AmbiguousBenchmarkExecutionError ? error.outputDeadline : null;
    const awaitingOutput = outputDeadline !== null && Date.now() < outputDeadline;
    if (error instanceof BenchmarkModelUnavailableError) {
      await markProfilesFailedForEntries(
        env.BENCH_DB,
        claim.run_id,
        [{ model: claim.model, variant: claim.variant }],
        PROFILE_MODEL_UNAVAILABLE_FAILURE_REASON
      );
      await failScheduledEntry(env.BENCH_DB, claim);
    } else if (awaitingOutput) {
      await env.BENCH_QUEUE.send(
        {
          runId: claim.run_id,
          kind: 'decider',
          model: claim.model,
          claimId: id,
          claimToken: token,
        },
        {
          delaySeconds: Math.ceil(
            Math.min(PAID_OUTPUT_RECHECK_MS, outputDeadline - Date.now()) / 1000
          ),
        }
      );
    } else if (
      error instanceof AmbiguousBenchmarkExecutionError ||
      claim.attempts >= SCHEDULER_MAX_ATTEMPTS
    ) {
      await failChunk(env.BENCH_DB, id, token);
      await recordLaneFailure(env.BENCH_DB, {
        runId: claim.run_id,
        model: claim.model,
        variant: claim.variant,
        rep: claim.rep,
        chunk: claim.chunk,
        shard: 0,
      });
    } else {
      const delaySeconds = schedulerBackoffSeconds(claim.attempts);
      await deferChunk(env.BENCH_DB, id, token, Date.now() + delaySeconds * 1000);
      if (error instanceof BenchmarkThrottleError) {
        await cooldownProviders(env.BENCH_DB, claim, Date.now() + delaySeconds * 1000);
      }
      await env.BENCH_QUEUE.send(
        {
          runId: claim.run_id,
          kind: 'decider',
          model: claim.model,
          schedulerWake: true,
        },
        { delaySeconds }
      );
    }
    console.warn(
      JSON.stringify({
        event: 'benchmark_scheduler_wait',
        runId: claim.run_id,
        model: claim.model,
        attempt: claim.attempts,
        reason:
          error instanceof BenchmarkModelUnavailableError
            ? 'model_unavailable'
            : awaitingOutput
              ? 'awaiting_output'
              : error instanceof AmbiguousBenchmarkExecutionError
                ? 'ambiguous_execution'
                : error instanceof DeciderGraderRetryError
                  ? 'grading'
                  : isRetryableContainerAvailabilityError(error)
                    ? 'container_capacity'
                    : error instanceof BenchmarkThrottleError
                      ? 'provider_throttle'
                      : 'infrastructure',
        ...formatError(error),
      })
    );
  }
  await dispatchScheduler(env);
  // Run accounting reads every case result of the run, so it only runs once the
  // run's scheduled work has settled. Dispatch's settled-run sweep and the
  // dead-letter path stay responsible for settling runs that never complete.
  if (state && !(await hasUnsettledChunks(env.BENCH_DB, claim.run_id))) {
    await finalizeRunIfComplete(env, claim.run_id, 'decider', state);
  }
}

export async function processJob(env: Env, rawMessage: unknown): Promise<void> {
  // Validate the message shape; malformed messages are logged and dropped
  // rather than retried forever.
  const parsed = BenchmarkJobMessageSchema.safeParse(rawMessage);
  if (!parsed.success) {
    console.warn(
      JSON.stringify({
        event: 'benchmark_job_invalid_message',
        error: parsed.error.message,
        raw: JSON.stringify(rawMessage).slice(0, 200),
      })
    );
    return;
  }

  const message = parsed.data;
  if (message.kind === 'decider') {
    if (message.schedulerWake) {
      await dispatchScheduler(env);
      return;
    }
    if (message.claimId && message.claimToken) {
      await processScheduledChunk(env, message.claimId, message.claimToken);
    } else {
      const legacyState = await getRunState(env, message.runId);
      if (legacyState.status === 'running') await initializeScheduledRun(env, message.runId);
      const legacyVariants =
        message.variant !== undefined
          ? [message.variant]
          : legacyState.models
              .filter(row => row.model === message.model)
              .map(row => variantFromStorage(row.variant));
      for (const variant of legacyVariants) {
        await destroyDeciderCliContainer(env, {
          instanceName: getDeciderContainerInstanceName({ ...message, variant }),
        }).catch(error => {
          console.warn(
            JSON.stringify({
              event: 'benchmark_legacy_container_destroy_failed',
              runId: message.runId,
              ...formatError(error),
            })
          );
        });
      }
      await dispatchScheduler(env);
    }
    return;
  }
  const state = await getRunState(env, message.runId);
  if (state.status !== 'running') {
    if (message.kind === 'classifier' && state.status === 'completed') {
      await finalizeRunIfComplete(env, message.runId, message.kind, state);
      return;
    }
    return;
  }

  if (message.kind === 'classifier') {
    if (!message.caseIds?.length || message.rep === undefined) {
      console.warn(
        JSON.stringify({
          event: 'benchmark_classifier_job_missing_chunk',
          runId: message.runId,
          model: message.model,
        })
      );
      return;
    }

    // Create the System One client inside processJob — no module-scope transport clients.
    const client = await createSystemOneClient(env);
    const caseIds = new Set(message.caseIds);
    const rep = message.rep;
    const expandedItems = CLASSIFIER_CASES.filter(benchCase => caseIds.has(benchCase.id)).map(
      benchCase => ({ benchCase, rep })
    );
    const classifierVariant = variantToStorage(message.variant);
    await runCasesWithConcurrency(
      expandedItems,
      BENCHMARK_CLASSIFIER_PARALLELISM,
      async ({ benchCase, rep }) => {
        const startedAt = performance.now();
        try {
          const { cost, classification } = await classifyWithSystemOne(
            client,
            benchCase.input,
            message.model
          );
          await upsertCaseResult(env.BENCH_DB, {
            run_id: message.runId,
            model: message.model,
            variant: classifierVariant,
            case_id: benchCase.id,
            route_key: null,
            score: gradeClassifierOutput(benchCase.expected, classification),
            latency_ms: Math.round(performance.now() - startedAt),
            cost_usd: cost,
            error: null,
            fallback_reason: null,
            route_hit:
              classification.taskType === benchCase.expected.taskType &&
              classification.subtaskType === benchCase.expected.subtaskType,
            retried: null,
            exit_code: null,
            output_prefix: null,
            event_count: null,
            last_event_types: null,
            rep,
            timed_out: 0,
          });
        } catch (error) {
          await upsertCaseResult(
            env.BENCH_DB,
            failedRow(message, benchCase.id, null, startedAt, error, rep)
          );
        }
      }
    );
  }

  await finalizeRunIfComplete(env, message.runId, message.kind, state);
}

/**
 * Handle a dead-lettered benchmark job: record the lane death, then attempt
 * finalization so a single dead lane cannot wedge its run. Malformed messages
 * and terminal runs are settled cases and return normally; transient failures
 * (e.g. D1) throw so the DLQ consumer retries — a death recorded without a
 * completed finalization must be re-attempted, not acked away.
 */
export async function processDeadLetter(env: Env, rawMessage: unknown): Promise<void> {
  const parsed = BenchmarkJobMessageSchema.safeParse(rawMessage);
  if (!parsed.success) {
    console.warn(
      JSON.stringify({
        event: 'benchmark_deadletter_invalid_message',
        error: parsed.error.message,
        raw: JSON.stringify(rawMessage).slice(0, 200),
      })
    );
    return;
  }

  const message = parsed.data;
  if (message.kind === 'decider') {
    if (message.claimId && message.claimToken) {
      await deferChunk(env.BENCH_DB, message.claimId, message.claimToken, Date.now(), true);
    }
    if (!message.claimId && !message.schedulerWake) {
      const state = await getRunState(env, message.runId).catch(() => null);
      if (state?.status === 'running') await initializeScheduledRun(env, message.runId);
    }
    await dispatchScheduler(env);
    return;
  }
  const state = await getRunState(env, message.runId).catch(() => undefined);
  if (!state || state.status !== 'running') {
    // Run already completed/failed/swept — its lane accounting is settled.
    console.warn(
      JSON.stringify({ event: 'benchmark_deadletter_run_not_running', runId: message.runId })
    );
    return;
  }

  // Resolve the exact-pair variant like processDeciderJob does: an explicit
  // message variant wins; a legacy variant-less message maps to the model's
  // sole snapshot row.
  const rowsForModel = state.models.filter(m => m.model === message.model);
  const soleVariant = rowsForModel.length === 1 ? rowsForModel[0]?.variant : undefined;
  const storedVariant =
    message.variant !== undefined
      ? variantToStorage(message.variant)
      : (soleVariant ?? variantToStorage(null));

  await recordLaneFailure(env.BENCH_DB, {
    runId: message.runId,
    model: message.model,
    variant: storedVariant,
    rep: message.rep ?? 0,
    chunk: message.chunk ?? 0,
    shard: message.shard ?? 0,
  });
  console.warn(
    JSON.stringify({
      event: 'benchmark_lane_dead',
      runId: message.runId,
      kind: message.kind,
      model: message.model,
      variant: variantFromStorage(storedVariant),
      rep: message.rep ?? 0,
      chunk: message.chunk ?? 0,
    })
  );
  await finalizeRunIfComplete(env, message.runId, message.kind, state);
}

type RunState = {
  router: AutoRouter;
  status: RunRow['status'];
  minAccuracy: number;
  switchCostFactor: number;
  bestAccuracySwitchThreshold: number;
  benchmarkUserId: string | null;
  benchmarkOrgId: string | null;
  models: RunModelRow[];
  repetitions: number;
  classifierMaxP95LatencyMs: number | null;
  startedAt: string;
  purpose: BenchmarkRunPurpose;
};

async function getRunState(env: Env, runId: string): Promise<RunState> {
  // Snapshots taken at startRun time so a mid-run admin edit can't skew them.
  const result = await getRunWithModels(env.BENCH_DB, runId);
  if (!result) throw new Error(`unknown run ${runId}`);
  const { run, models } = result;
  return {
    router: run.router ?? 'efficient',
    status: run.status,
    minAccuracy: run.min_accuracy,
    switchCostFactor: run.switch_cost_factor,
    bestAccuracySwitchThreshold: run.best_accuracy_switch_threshold,
    benchmarkUserId: run.benchmark_user_id,
    benchmarkOrgId: run.benchmark_org_id,
    models,
    repetitions: run.repetitions,
    classifierMaxP95LatencyMs: run.classifier_max_p95_latency_ms,
    startedAt: run.started_at,
    purpose: run.purpose === 'user' ? 'user' : 'platform',
  };
}

async function processDeciderJob(
  env: Env,
  message: BenchmarkJobMessage,
  state: RunState,
  claim: SchedulerClaim
): Promise<void> {
  if (!message.caseIds?.length) throw new Error('Scheduler chunk has no cases');
  const caseIds = new Set(message.caseIds);
  const cases = deciderCasesForRouter(state.router).filter(c => caseIds.has(c.id));
  if (cases.length !== message.caseIds.length) throw new Error('Scheduler chunk has unknown cases');

  const { benchmarkUserId } = state;
  if (!benchmarkUserId) {
    // startRun snapshots the effective default/override identity, so this only
    // happens if the run row was tampered with; throwing lets the queue retry.
    throw new Error(`run ${message.runId} has no benchmarkUserId`);
  }

  const rep = message.rep ?? 0;
  const chunk = message.chunk ?? 0;

  // Resolve the run-snapshot row for this message's exact pair.
  // - Explicit message.variant (including null): require exact (model, variant).
  //   A missing pair is corrupt — throw so the queue retries then dead-letters;
  //   never grade with a CLI variant taken from a non-matching row.
  // - Legacy pre-deploy messages (variant undefined): model-only fallback only
  //   when the snapshot has exactly one row for that model; otherwise throw.
  const modelRowsForModel = state.models.filter(m => m.model === message.model);
  let modelRow: RunModelRow;
  if (message.variant !== undefined) {
    const messageVariant = message.variant ?? null;
    const exact = modelRowsForModel.find(m => variantFromStorage(m.variant) === messageVariant);
    if (!exact) {
      throw new Error(
        `run ${message.runId} has no snapshot row for model ${message.model} variant ${JSON.stringify(messageVariant)}`
      );
    }
    modelRow = exact;
  } else {
    const sole = modelRowsForModel.length === 1 ? modelRowsForModel[0] : undefined;
    if (!sole) {
      throw new Error(
        `run ${message.runId}: legacy decider message for model ${message.model} requires exactly one snapshot row, found ${modelRowsForModel.length}`
      );
    }
    modelRow = sole;
  }
  const entryVariant =
    message.variant !== undefined
      ? (message.variant ?? null)
      : variantFromStorage(modelRow.variant);
  const storedVariant = variantToStorage(entryVariant);
  // Canonical variant passed to the CLI — derived only from the resolved pair.
  const cliVariant = entryVariant ?? modelRow.reasoning_effort ?? null;

  const instanceName = `benchmark-slot:${claim.slot}`;

  const existingCaseIds = await getExistingCaseResultIds(env.BENCH_DB, {
    runId: message.runId,
    model: message.model,
    variant: entryVariant,
    rep,
    caseIds: cases.map(c => c.id),
  });
  const casesToRun = cases.filter(c => !existingCaseIds.has(c.id));
  let graderCostUsd = 0;
  let graderFailure: DeciderGraderRetryError | null = null;

  if (casesToRun.length > 0) {
    let judge: DeciderJudge | null = null;
    if (casesToRun.some(c => c.check.kind === 'judged')) {
      try {
        judge = createDeciderJudge(await createSystemOneClient(env));
      } catch {
        throw new DeciderGraderRetryError('Decider judge client initialization failed');
      }
    }
    // A short-lived user token is minted at most once per queue message and never
    // logged. Fresh container instances run the CLI's one-time sqlite migration; the
    // container owns that via its /warmup endpoint so the first real case doesn't
    // burn its timeout on it. Ordinary warmup failures are non-fatal: the first case
    // absorbs whatever warmup work remains. Container capacity failures are
    // infrastructure pressure, so the queue retries the message. Both wait for the
    // first case that needs a paid call, so rechecking awaited output stays in D1.
    let cli: Promise<string> | undefined;
    const cliToken = () =>
      (cli ??= (async () => {
        const kiloToken = await fetchBenchmarkUserToken(env, benchmarkUserId, state.benchmarkOrgId);
        await warmUpCliContainer(env, {
          instanceName,
          model: message.model,
          kiloToken,
          kiloApiUrl: env.KILO_CLI_API_URL,
          orgId: state.benchmarkOrgId,
        }).catch(error => {
          if (isRetryableContainerAvailabilityError(error)) throw error;
        });
        return kiloToken;
      })());

    // Concurrency 1: the CLI's sqlite state in the container is not safe under
    // concurrent sessions (partial-migration crashes); the container serializes
    // too, so higher concurrency here would only hold HTTP requests open.
    await runCasesWithConcurrency(casesToRun, 1, async benchCase => {
      const pendingKey = {
        run_id: message.runId,
        model: message.model,
        variant: storedVariant,
        case_id: benchCase.id,
        rep,
      };
      const execution = {
        runId: message.runId,
        model: message.model,
        variant: storedVariant,
        rep,
        caseId: benchCase.id,
        token: claim.token,
      };
      const runPaidCase = async (): Promise<PendingDeciderOutput> => {
        const priorStartedAt = await getPaidCaseStartedAt(env.BENCH_DB, execution);
        if (priorStartedAt !== null) throw new AmbiguousBenchmarkExecutionError(priorStartedAt);
        const kiloToken = await cliToken();
        let startedAt = Date.now();
        if (!(await beginPaidCase(env.BENCH_DB, execution, startedAt))) {
          throw new AmbiguousBenchmarkExecutionError(
            await getPaidCaseStartedAt(env.BENCH_DB, execution)
          );
        }
        const invokeCli = () =>
          runDeciderCaseViaCli(env, {
            instanceName,
            model: message.model,
            benchCase,
            kiloToken,
            kiloApiUrl: env.KILO_CLI_API_URL,
            orgId: state.benchmarkOrgId,
            variant: cliVariant,
            resultCallback: { url: env.BENCH_RESULT_URL, execution },
          }).catch(error => {
            if (isRetryableContainerAvailabilityError(error)) throw error;
            throw new AmbiguousBenchmarkExecutionError(startedAt, { cause: error });
          });
        const first = await invokeCli();
        // The CLI occasionally ends a session with no assistant text at all
        // (transient empty completion: a lone step_finish with cost 0). Mirror
        // the production classifier's policy and retry once.
        if (
          isExactModelUnavailableResult(first, message.model) ||
          first.exitCode !== 0 ||
          first.text.length > 0 ||
          /(?:\b429\b|rate.?limit|throttl)/i.test(first.stderrTail)
        ) {
          return { result: first, retried: false };
        }
        startedAt = Date.now();
        if (!(await restartPaidCase(env.BENCH_DB, execution, startedAt))) {
          return { result: first, retried: false };
        }
        const retry = await invokeCli();
        retry.costUsd =
          retry.costUsd === null && first.costUsd === null
            ? null
            : (retry.costUsd ?? 0) + (first.costUsd ?? 0);
        return { result: retry, retried: true };
      };
      try {
        const pending = await getPendingDeciderOutput(env.BENCH_DB, pendingKey).catch(() => {
          throw new DeciderGraderRetryError('Pending decider output could not be read');
        });
        const { result, retried } = pending ?? (await runPaidCase());
        if (
          result.text.length === 0 &&
          (result.costUsd ?? 0) === 0 &&
          /(?:\b429\b|rate.?limit|throttl)/i.test(result.stderrTail)
        ) {
          await clearUnbilledCase(env.BENCH_DB, execution);
          throw new BenchmarkThrottleError('Provider throttled an unbilled benchmark request');
        }
        if (!pending) {
          await savePendingDeciderOutput(env.BENCH_DB, pendingKey, { result, retried }).catch(
            () => {
              throw new DeciderGraderRetryError('Pending decider output could not be saved');
            }
          );
        }
        if (isExactModelUnavailableResult(result, message.model)) {
          throw new BenchmarkModelUnavailableError(PROFILE_MODEL_UNAVAILABLE_FAILURE_REASON);
        }
        const grade =
          result.exitCode === 0 && result.text.length > 0
            ? await gradeDeciderOutput(benchCase.check, {
                userPrompt: benchCase.userPrompt,
                output: result.text,
                judge,
              })
            : { score: 0, costUsd: 0, graderError: null };
        graderCostUsd += grade.costUsd;
        if (grade.score === null) {
          throw new DeciderGraderRetryError(grade.graderError ?? 'Decider judge failed');
        }
        await upsertCaseResult(env.BENCH_DB, {
          run_id: message.runId,
          model: message.model,
          variant: storedVariant,
          case_id: benchCase.id,
          route_key: taxonomyRouteKey(benchCase),
          score: grade.score,
          latency_ms: result.latencyMs,
          cost_usd: result.costUsd,
          error: result.exitCode !== 0 ? result.stderrTail.slice(0, 500) : null,
          fallback_reason: null,
          route_hit: null,
          retried,
          exit_code: result.exitCode,
          output_prefix: result.text.slice(0, 200),
          event_count: result.eventCount,
          last_event_types: result.lastEventTypes.join(' '),
          rep,
          timed_out: result.timedOut ? 1 : 0,
        });
      } catch (error) {
        if (error instanceof DeciderGraderRetryError) {
          graderFailure = error;
          return;
        }
        if (isRetryableContainerAvailabilityError(error)) {
          await clearUnbilledCase(env.BENCH_DB, execution);
        }
        throw error;
      }
    });
  }
  console.log(
    JSON.stringify({
      event: 'benchmark_decider_grader_cost',
      runId: message.runId,
      model: message.model,
      variant: entryVariant,
      rep,
      chunk,
      graderCostUsd,
    })
  );
  if (graderFailure) throw graderFailure;

  return;
}

function failedRow(
  message: BenchmarkJobMessage,
  caseId: string,
  routeKey: string | null,
  startedAt: number,
  error: unknown,
  rep: number = 0
): CaseResultRow {
  return {
    run_id: message.runId,
    model: message.model,
    variant: variantToStorage(message.variant),
    case_id: caseId,
    route_key: routeKey,
    score: 0,
    latency_ms: Math.round(performance.now() - startedAt),
    cost_usd: error instanceof ClassifierRunError ? error.cost : null,
    error: JSON.stringify(formatError(error)).slice(0, 500),
    fallback_reason: null,
    // A failed classification missed its route; decider rows carry no route hit.
    route_hit: message.kind === 'classifier' ? false : null,
    retried: null,
    exit_code: null,
    output_prefix: null,
    event_count: null,
    last_event_types: null,
    rep,
    timed_out: 0,
  };
}

export async function runCasesWithConcurrency<T>(
  cases: readonly T[],
  concurrency: number,
  fn: (item: T) => Promise<void>
): Promise<void> {
  const queue = [...cases];
  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    for (let item = queue.shift(); item !== undefined; item = queue.shift()) {
      await fn(item);
    }
  });
  await Promise.all(workers);
}

// Lane identity for completion accounting: one (model, variant, rep) chain of
// chunk messages. JSON tuple keys (storage-form variant) so model/variant
// values can never collide across concatenation.
function laneKey(model: string, variant: string, rep: number): string {
  return JSON.stringify([model, variant, rep]);
}

/** Failure reason for rows a terminal run left claimed. */
export const PROFILE_ORPHANED_CLAIM_FAILURE_REASON =
  'Benchmark run ended without settling this entry; requeue to re-measure.';

/** Failure reason written to profile entries whose lane never finished. */
export const PROFILE_LANE_DEAD_FAILURE_REASON =
  'Benchmark lane did not finish (queue retries exhausted or run timed out); retry to re-measure.';

type Lane = { model: string; variant: string; rep: number };

/**
 * Lane accounting for a run: a lane is done when all its case rows exist, dead
 * when one of its chunk messages dead-lettered (rows win — a message can die
 * after its writes landed). `unfinished` is every lane without a full set of
 * rows; the caller decides whether an unfinished lane is fatal or just missing.
 */
async function loadLaneAccounting(
  db: D1Database,
  runId: string,
  state: RunState,
  caseCount: number
): Promise<{ unfinished: Lane[]; deadLaneKeys: Set<string> }> {
  const [laneCounts, laneFailures] = await Promise.all([
    countCaseResultsByLane(db, runId),
    listLaneFailures(db, runId),
  ]);
  const countByLane = new Map(laneCounts.map(r => [laneKey(r.model, r.variant, r.rep), r.n]));
  const lanes: Lane[] = state.models
    .filter(m => m.enqueued)
    .flatMap(m =>
      Array.from({ length: state.repetitions }, (_, rep) => ({
        model: m.model,
        variant: m.variant,
        rep,
      }))
    );
  return {
    unfinished: lanes.filter(
      lane => (countByLane.get(laneKey(lane.model, lane.variant, lane.rep)) ?? 0) < caseCount
    ),
    deadLaneKeys: new Set(laneFailures.map(f => laneKey(f.model, f.variant, f.rep))),
  };
}

async function finalizeRunIfComplete(
  env: Env,
  runId: string,
  kind: BenchmarkKind,
  // Run snapshot already loaded by the caller (startRun / processJob / processDeadLetter).
  state: RunState
): Promise<void> {
  const enqueuedModels = state.models.filter(m => m.enqueued);
  const caseCount = expectedCaseCount(kind, state.router);

  // The run finalizes once every lane is accounted for, so one dead lane no
  // longer wedges the run until the stale sweep.
  const { unfinished: deadLanes, deadLaneKeys } = await loadLaneAccounting(
    env.BENCH_DB,
    runId,
    state,
    caseCount
  );
  if (deadLanes.some(lane => !deadLaneKeys.has(laneKey(lane.model, lane.variant, lane.rep)))) {
    return;
  }

  // A classifier run derives one winner from a single comparable set, and its
  // models are not registry-tracked, so a dead lane fails the whole run. Decider
  // runs settle per entry below — one dead model never discards the rest.
  if (deadLanes.length > 0 && kind === 'classifier') {
    const [first, ...rest] = deadLanes;
    await failRunAndDrain(
      env,
      runId,
      `lane dead-lettered: ${first.model} variant ${variantFromStorage(first.variant) ?? 'default'} rep ${first.rep}` +
        (rest.length > 0 ? ` (+${rest.length} more)` : '')
    );
    return;
  }

  // Two consumers may both see completion and both aggregate — harmless:
  // identical deterministic inputs → identical summaries; replaceModelSummaries
  // is a batched delete+insert; markRunCompleted and the per-entry profile
  // transitions guard on status='running'.
  const rows = await getCaseResults(env.BENCH_DB, runId);
  // Fresh results (enqueued models). Carried summaries (skipped models) stay in
  // model_summaries with carried=true and are included via getSummaries below.
  const freshSummaries = summarize(rows, kind);
  await replaceModelSummaries(env.BENCH_DB, runId, freshSummaries);

  // Every decider run feeds the one global registry — the platform routing table
  // and every owner's custom table are assembled from it, so no decider run
  // publishes an artifact of its own.
  if (kind === 'decider') {
    // Entries whose lanes all completed become ready; entries with a dead lane
    // fail (a requeue re-admits them) without taking down the rest of the batch.
    // Fail first so the ready sweep only catches survivors; both statements keep
    // the run_id + status='running' no-clobber guard.
    const failedEntryKeys = new Set(deadLanes.map(l => JSON.stringify([l.model, l.variant])));
    const failedEntries = enqueuedModels
      .filter(m => failedEntryKeys.has(JSON.stringify([m.model, m.variant])))
      .map(m => ({ model: m.model, variant: m.variant }));
    // One try block, fail-first. `markProfilesReadyForRun` has no entry filter —
    // it readies every row still `running` under this run — so it must not run
    // when the per-entry failure did not complete, or a dead lane's partial
    // measurements would be published as a real result. If this throws, the
    // rows stay `running` and the orphan sweep settles them.
    //
    // This runs BEFORE `markRunCompleted`. The orphan reaper spares rows whose
    // run is still in the running set, so settling first leaves it no window:
    // completing first would expose a run older than the stale age — its rows
    // carry claim-time `updated_at`, so the age guard does not cover them — and
    // a sweep landing in between would fail entries that are fully measured.
    try {
      if (failedEntries.length > 0) {
        await markProfilesFailedForEntries(
          env.BENCH_DB,
          runId,
          failedEntries,
          PROFILE_LANE_DEAD_FAILURE_REASON
        );
      }
      await markProfilesReadyForRun(env.BENCH_DB, runId);
    } catch (error) {
      console.warn(
        JSON.stringify({
          event: 'benchmark_profile_transition_error',
          runId,
          ...formatError(error),
        })
      );
    }
    await markRunCompleted(env.BENCH_DB, runId);
    console.log(
      JSON.stringify({
        event: 'benchmark_decider_run_completed',
        runId,
        purpose: state.purpose,
        readyEntries: enqueuedModels.length - failedEntries.length,
        failedEntries: failedEntries.length,
      })
    );
    // Fresh registry rows may complete the platform model list, so republish.
    await publishPlatformRoutingTable(env, fetch, state.router).catch(error => {
      console.warn(
        JSON.stringify({
          event: 'routing_table_publish_skipped',
          runId,
          ...formatError(error),
        })
      );
    });
    // Both queues: this run's slot just freed, and a pair it just measured may
    // have been the only pending work the other queue was waiting on.
    await drainQueues(env, 'both', undefined, state.router);
    return;
  }

  // Classifier runs own no registry rows, so there is nothing to settle first.
  await markRunCompleted(env.BENCH_DB, runId);

  // Read back all summaries (fresh + carried) for publishing.
  const allSummaries = await getSummaries(env.BENCH_DB, runId);

  // Don't let a slow older run overwrite a newer run's already-published table
  // or classifier winner. Publication is selected by publish time, so an older
  // run finishing last would otherwise win. The run is still marked completed
  // above (it did finish); only its publication is suppressed.
  const supersededByNewer = await existsNewerCompletedRun(
    env.BENCH_DB,
    kind,
    state.startedAt,
    runId,
    state.router
  );
  if (supersededByNewer) {
    console.warn(JSON.stringify({ event: 'benchmark_publish_skipped_superseded', runId, kind }));
  }

  if (kind === 'classifier' && !supersededByNewer) {
    const winner = pickClassifierWinner(
      allSummaries,
      state.minAccuracy,
      state.classifierMaxP95LatencyMs
    );
    if (winner) {
      console.log(
        JSON.stringify({ event: 'classifier_winner_published', runId, model: winner.model })
      );
    } else {
      console.warn(JSON.stringify({ event: 'classifier_winner_skipped', runId }));
    }
    // Clear KV so the auto-routing worker repopulates from D1 on next request.
    await env.AUTO_ROUTING_CONFIG.delete(CLASSIFIER_WINNER_KV_KEY);
  }

  console.log(
    JSON.stringify({
      event: 'benchmark_run_completed',
      runId,
      kind,
      purpose: state.purpose,
      summaries: allSummaries,
    })
  );
}

export function summarize(rows: CaseResultRow[], kind: BenchmarkKind): BenchmarkModelSummary[] {
  // Group by (model, variant, routeKey). Classifier rows use '*' because
  // classification has no decider taxonomy route. variant '' → null on emit.
  const groups = new Map<string, CaseResultRow[]>();
  for (const row of rows) {
    const routeKey = kind === 'classifier' ? '*' : (row.route_key ?? '*');
    const storedVariant = row.variant ?? '';
    const key = `${row.model}\0${storedVariant}\0${routeKey}`;
    const existing = groups.get(key);
    if (existing) {
      existing.push(row);
    } else {
      groups.set(key, [row]);
    }
  }

  return [...groups.entries()].map(([key, group]) => {
    const [model, storedVariant, routeKey] = key.split('\0');
    const latencies = group.map(r => r.latency_ms).toSorted((a, b) => a - b);
    const costs = group.filter(r => r.cost_usd !== null);
    // Only classifier rows carry route_hit; decider groups stay null.
    const routeGraded = group.filter(r => r.route_hit !== null);
    const p95LatencyMs =
      latencies.length > 0
        ? (latencies[Math.min(latencies.length - 1, Math.ceil(0.95 * latencies.length) - 1)] ??
          null)
        : null;
    return {
      model,
      variant: variantFromStorage(storedVariant),
      routeKey: routeKey as BenchmarkModelSummary['routeKey'],
      accuracy: Number((group.reduce((a, r) => a + r.score, 0) / group.length).toFixed(4)),
      avgCostUsd: costs.length
        ? Number((costs.reduce((a, r) => a + (r.cost_usd ?? 0), 0) / costs.length).toFixed(8))
        : null,
      avgLatencyMs: Math.round(group.reduce((a, r) => a + r.latency_ms, 0) / group.length),
      p50LatencyMs: latencies[Math.floor(latencies.length / 2)] ?? null,
      p95LatencyMs,
      cases: group.length,
      errors: group.filter(r => r.error !== null).length,
      timeouts: group.filter(r => r.timed_out).length,
      routeAccuracy: routeGraded.length
        ? Number((routeGraded.filter(r => r.route_hit).length / routeGraded.length).toFixed(4))
        : null,
    };
  });
}
